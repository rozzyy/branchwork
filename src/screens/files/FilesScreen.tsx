import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { t } from "../../i18n/t";
import { screenById } from "../registry";
import { useWorktrees } from "../../state/worktrees";
import { useRepos } from "../../state/repos";
import { useFiles } from "../../state/files";
import type { FilesIntent } from "../../state/filesIntents";
import { useStage } from "../../state/stage";
import {
  fsCreate,
  fsDelete,
  fsRead,
  fsRename,
  fsTree,
  fsWrite,
  revealInFinder,
  type FsEntry,
} from "../../ipc/fs";
import { discardPaths } from "../../ipc/changes";
import { undoLast } from "../../ipc/undo";
import { readDiff, type DiffModel } from "../../ipc/diff";
import { readStatus } from "../../ipc/status";
import { onGitChanged } from "../../ipc/worktrees";
import { errorMessage } from "../../ipc/errors";
import { rank } from "../../palette/fuzzy";
import { DiffRenderer } from "../../diff/DiffRenderer";
import { EditorHost } from "../../editor/EditorHost";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/controls";
import { FileIcon } from "../../ui/fileIcon";
import { Menu, type MenuItem } from "../../ui/Menu";
import { ask } from "../../ui/dialog";
import { toast } from "../../ui/toast";
import "./files.css";

const def = screenById("files");

function statusClass(letter: string | null | undefined): string {
  if (!letter) return "";
  return ["M", "A", "U", "D", "R", "C"].includes(letter) ? `files-status-${letter}` : "files-status-other";
}

type TreeMap = Record<string, FsEntry[]>;

/** Walks every directory of the worktree (the `fs_tree` IPC only lists one directory at a time).
 * The tree view itself never calls this — it loads one directory per expand — but ⌘P needs an
 * index of every path to search, so this runs once, lazily, the first time the search field is
 * focused (see `ensureSearchIndex`), not on every mount/reload. */
async function loadFullTree(worktreePath: string, showIgnored: boolean): Promise<TreeMap> {
  const map: TreeMap = {};
  async function walk(path: string): Promise<void> {
    const { entries } = await fsTree(worktreePath, { path, showIgnored });
    map[path] = entries;
    await Promise.all(
      entries.filter((entry) => entry.isDir).map((entry) => walk(path ? `${path}/${entry.name}` : entry.name)),
    );
  }
  await walk("");
  return map;
}

function flattenFiles(map: TreeMap): { path: string; entry: FsEntry }[] {
  const files: { path: string; entry: FsEntry }[] = [];
  for (const [dir, entries] of Object.entries(map)) {
    for (const entry of entries) {
      if (!entry.isDir) files.push({ path: dir ? `${dir}/${entry.name}` : entry.name, entry });
    }
  }
  return files;
}

export function FilesToolbar() {
  const activePath = useWorktrees((s) => s.activePath);
  const branch = useWorktrees((s) => s.worktrees.find((w) => w.path === s.activePath)?.branch ?? null);
  const mode = useFiles((s) => s.mode);
  const setMode = useFiles((s) => s.setMode);
  const current = useFiles((s) => s.current);
  const [openInAt, setOpenInAt] = useState<{ x: number; y: number } | null>(null);

  const revealCurrent = async () => {
    if (!activePath) return;
    try {
      await revealInFinder(activePath, current ?? "");
    } catch (error) {
      toast({ title: errorMessage(error), icon: "⚠" });
    }
  };

  const openInItems: MenuItem[] = [
    { kind: "item", label: t("files.finder"), icon: "↗", onSelect: () => void revealCurrent() },
    { kind: "separator" },
    {
      kind: "item",
      label: t("files.externalEditors"),
      icon: "↗",
      disabled: true,
      title: t("ui.deferred_m4"),
      onSelect: () => {},
    },
  ];

  return (
    <>
      <h1 className="pane-title">
        {t("files.title")}
        {activePath && (
          <span className="files-subtitle" aria-hidden="true">
            {branch ?? activePath}
          </span>
        )}
      </h1>
      <div className="files-toolbar-actions pane-actions">
        <Segmented
          label={t("files.viewMode")}
          onChange={setMode}
          options={[
            { value: "editor", label: t("files.modeEditor") },
            { value: "diff", label: t("files.modeDiff") },
          ]}
          value={mode}
        />
        <Button
          disabled={!activePath}
          onClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            setOpenInAt({ x: bounds.right - 230, y: bounds.bottom + 6 });
          }}
        >
          {t("files.openIn")}
        </Button>
        {openInAt && <Menu items={openInItems} onClose={() => setOpenInAt(null)} x={openInAt.x} y={openInAt.y} />}
        <Button disabled title={t("ui.deferred_m3")}>
          ❯_ {t("files.terminal")}
        </Button>
      </div>
    </>
  );
}

/** True when any changed path lives inside `folderPath` (prototype's yellow folder dot). */
function folderHasChanges(folderPath: string, changedPaths: Set<string>): boolean {
  const prefix = `${folderPath}/`;
  for (const path of changedPaths) {
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

function TreeNode({
  changedPaths,
  current,
  depth,
  dirty,
  entry,
  expanded,
  loadingFolders,
  onContext,
  onOpen,
  onToggle,
  path,
  treeMap,
}: {
  changedPaths: Set<string>;
  current: string | null;
  depth: number;
  dirty: Record<string, true>;
  entry: FsEntry;
  expanded: Record<string, true>;
  loadingFolders: Record<string, true>;
  onContext(event: ReactMouseEvent, path: string, isDir: boolean): void;
  onOpen(path: string): void;
  onToggle(path: string): void;
  path: string;
  treeMap: TreeMap;
}) {
  if (entry.isDir) {
    const isOpen = !!expanded[path];
    const children = treeMap[path];
    return (
      <>
        <div
          className="files-tree-node"
          onClick={() => onToggle(path)}
          onContextMenu={(event) => onContext(event, path, true)}
          style={{ paddingLeft: 6 + depth * 14 }}
        >
          <span aria-hidden className="files-tree-arrow">{isOpen ? "▾" : "▸"}</span>
          <span className="files-tree-name">{entry.name}</span>
          {folderHasChanges(path, changedPaths) && <span aria-hidden className="files-tree-folder-dot">●</span>}
        </div>
        {isOpen && children === undefined && loadingFolders[path] && (
          <div className="files-tree-loading" style={{ paddingLeft: 20 + depth * 14 }}>
            {t("files.folderLoading")}
          </div>
        )}
        {isOpen &&
          (children ?? []).map((child) => (
            <TreeNode
              changedPaths={changedPaths}
              current={current}
              depth={depth + 1}
              dirty={dirty}
              entry={child}
              expanded={expanded}
              key={child.name}
              loadingFolders={loadingFolders}
              onContext={onContext}
              onOpen={onOpen}
              onToggle={onToggle}
              path={path ? `${path}/${child.name}` : child.name}
              treeMap={treeMap}
            />
          ))}
      </>
    );
  }
  return (
    <div
      className={"files-tree-node" + (path === current ? " on" : "")}
      onClick={() => onOpen(path)}
      onContextMenu={(event) => onContext(event, path, false)}
      style={{ paddingLeft: 20 + depth * 14 }}
    >
      <FileIcon path={path} />
      <span className={"files-tree-name " + statusClass(entry.status)}>{entry.name}</span>
      {dirty[path] && <span aria-hidden className="files-dirty-dot" />}
      {entry.status && <span className={"files-tree-status " + statusClass(entry.status)}>{entry.status}</span>}
    </div>
  );
}

export function FilesView() {
  const activePath = useWorktrees((s) => s.activePath);
  const activeWorktree = useWorktrees((s) => s.worktrees.find((w) => w.path === s.activePath) ?? null);
  const worktrees = useWorktrees((s) => s.worktrees);
  const projectName = useRepos((s) => s.projects.find((p) => p.id === s.activeProjectId)?.name);
  const open = useFiles((s) => s.open);
  const current = useFiles((s) => s.current);
  const dirty = useFiles((s) => s.dirty);
  const expanded = useFiles((s) => s.expanded);
  const fuzzyQuery = useFiles((s) => s.fuzzyQuery);
  const showIgnored = useFiles((s) => s.showIgnored);
  const mode = useFiles((s) => s.mode);
  const openFileAction = useFiles((s) => s.openFile);
  const closeFileAction = useFiles((s) => s.closeFile);
  const toggleExpandedAction = useFiles((s) => s.toggleExpanded);
  const collapseAllAction = useFiles((s) => s.collapseAll);
  const setFuzzyQueryAction = useFiles((s) => s.setFuzzyQuery);
  const setShowIgnoredAction = useFiles((s) => s.setShowIgnored);

  const [treeMap, setTreeMap] = useState<TreeMap>({});
  const [loadingFolders, setLoadingFolders] = useState<Record<string, true>>({});
  const [treeError, setTreeError] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; path: string; isDir: boolean } | null>(null);
  const [diffModel, setDiffModel] = useState<DiffModel | null>(null);
  // Every changed path (staged or unstaged), used to mark a folder containing changes (AC3's
  // folder dot) — fs_tree's own per-entry `status` is null for directories.
  const [changedPaths, setChangedPaths] = useState<Set<string>>(new Set());
  // The full-tree index for ⌘P (see `loadFullTree`'s doc). `null` means "not built yet" —
  // built lazily on first search-field focus, dropped whenever the tree reloads so it can't
  // serve stale results.
  const [searchIndex, setSearchIndex] = useState<TreeMap | null>(null);
  const searchIndexLoadingRef = useRef(false);
  // R9: a reload marks the index stale instead of clearing it, so an open ⌘P keeps its results
  // until the rebuild lands. `searchStale` bumps to trigger that rebuild while a query is active.
  const searchStaleRef = useRef(false);
  const [searchStale, setSearchStale] = useState(0);

  // R4: `treeMap` mirrored into a ref so `reloadTree` (a stable useCallback) can read which
  // folders are already loaded without taking `treeMap` as a dependency — that would recreate
  // the callback (and its `git:changed` subscription) on every fetch.
  const treeMapRef = useRef<TreeMap>({});
  useEffect(() => {
    treeMapRef.current = treeMap;
  }, [treeMap]);

  // R4: bumped at the start of every reload and worktree switch. An in-flight fetch that resolves
  // after a newer one started drops its result instead of overwriting fresher data.
  const generationRef = useRef(0);

  const reloadTree = useCallback(async () => {
    generationRef.current += 1;
    const gen = generationRef.current;
    searchStaleRef.current = true;
    setSearchStale((n) => n + 1);
    if (!activePath) {
      setTreeMap({});
      setChangedPaths(new Set());
      setLoadingFolders({});
      return;
    }
    // I7/R4: never walk the whole tree. Re-fetch the root plus only the folders already loaded
    // (expanding one caches it — see `handleToggle` — and it stays cached, expanded or not,
    // until the next reload) so a folder's status letters/dot stay fresh once re-opened.
    const folders = [...new Set(["", ...Object.keys(treeMapRef.current), ...Object.keys(useFiles.getState().expanded)])];
    try {
      const [results, status] = await Promise.all([
        Promise.all(
          folders.map(async (path) => {
            try {
              return [path, (await fsTree(activePath, { path, showIgnored })).entries] as const;
            } catch {
              // The folder may have been renamed/deleted by whatever triggered this reload —
              // drop it from the map instead of failing the whole refresh.
              return null;
            }
          }),
        ),
        readStatus(activePath).catch(() => ({ staged: [], unstaged: [] })),
      ]);
      if (generationRef.current !== gen) return;
      const map: TreeMap = {};
      for (const result of results) if (result) map[result[0]] = result[1];
      setTreeMap(map);
      setChangedPaths(new Set([...status.staged, ...status.unstaged].map((entry) => entry.path)));
      setTreeError(null);
    } catch (error) {
      if (generationRef.current !== gen) return;
      setTreeError(errorMessage(error));
    }
  }, [activePath, showIgnored]);

  useEffect(() => {
    void reloadTree();
  }, [reloadTree]);

  const handleToggle = useCallback(
    (path: string) => {
      const wasExpanded = !!useFiles.getState().expanded[path];
      toggleExpandedAction(path);
      if (wasExpanded || !activePath || treeMapRef.current[path] !== undefined) return;
      const gen = generationRef.current;
      setLoadingFolders((prev) => ({ ...prev, [path]: true }));
      void fsTree(activePath, { path, showIgnored })
        .then((tree) => {
          if (generationRef.current !== gen) return;
          setTreeMap((prev) => ({ ...prev, [path]: tree.entries }));
        })
        .catch((error) => {
          if (generationRef.current !== gen) return;
          toast({ title: errorMessage(error), icon: "⚠" });
        })
        .finally(() => {
          if (generationRef.current !== gen) return;
          setLoadingFolders((prev) => {
            const next = { ...prev };
            delete next[path];
            return next;
          });
        });
    },
    [activePath, showIgnored, toggleExpandedAction],
  );

  // ⌘P needs every path to search, which `loadFullTree` builds in one lazy walk the first time
  // the search field is focused (not on mount/reload — see I7). Reusing `readStatus` or the
  // already-loaded folders instead would miss clean files inside collapsed folders, so a full
  // (but lazy, cached-until-reload) walk is the smaller-and-correct option here.
  const searchKey = `${activePath ?? ""}\0${showIgnored}`;
  const searchKeyRef = useRef(searchKey);
  searchKeyRef.current = searchKey;
  const ensureSearchIndex = useCallback(() => {
    if (!activePath || searchIndexLoadingRef.current) return;
    if (searchIndex !== null && !searchStaleRef.current) return;
    searchIndexLoadingRef.current = true;
    searchStaleRef.current = false;
    const key = searchKey;
    void loadFullTree(activePath, showIgnored)
      .then((map) => {
        // Only a worktree / show-ignored change makes a finished walk unusable.
        if (searchKeyRef.current === key) setSearchIndex(map);
      })
      .catch(() => {})
      .finally(() => {
        searchIndexLoadingRef.current = false;
        // A reload landed mid-walk: run once more so the index catches up.
        if (searchStaleRef.current) setSearchStale((n) => n + 1);
      });
  }, [activePath, showIgnored, searchIndex, searchKey]);

  // A different worktree or show-ignored setting is a different tree: drop the old index.
  useEffect(() => {
    setSearchIndex(null);
  }, [searchKey]);

  // Rebuild in the background after a reload while the user is searching.
  useEffect(() => {
    if (searchStale > 0 && useFiles.getState().fuzzyQuery.trim()) ensureSearchIndex();
  }, [searchStale, ensureSearchIndex]);

  // I6: an external edit, an agent, or ⌘S in the editor fires `git:changed`. Refresh the tree so
  // status letters and folder dots stay current (same pattern as ChangesScreen's own listener).
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let subscription: Promise<() => void>;
    try {
      subscription = onGitChanged((event) => {
        if (event.worktree === activePath) void reloadTree();
      });
    } catch {
      return;
    }
    void subscription
      .then((stop) => {
        if (disposed) void stop();
        else unlisten = stop;
      })
      // `listen` is itself an async fn: a missing Tauri runtime (tests, or a future non-Tauri
      // host) rejects this promise instead of throwing synchronously, so the `try/catch` above
      // can't see it. Swallow it the same way the `catch` block does.
      .catch(() => {});
    return () => {
      disposed = true;
      if (unlisten) void unlisten();
    };
  }, [activePath, reloadTree]);

  // AC6: a double-click on a Changes file row dispatches this intent and routes here.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<FilesIntent>).detail;
      if (detail?.type === "files.open") useFiles.getState().openFile(detail.path);
    };
    window.addEventListener("branchwork:files-intent", handler);
    return () => window.removeEventListener("branchwork:files-intent", handler);
  }, []);

  // AC6's "Diff vs HEAD": a true working-tree-vs-HEAD diff (combines staged + unstaged hunks
  // for the file), via the `head` DiffArea added for this.
  useEffect(() => {
    if (mode !== "diff" || !activePath || !current) {
      setDiffModel(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const model = await readDiff(activePath, current, "head");
        if (!cancelled) setDiffModel(model);
      } catch (error) {
        if (!cancelled) {
          setDiffModel(null);
          toast({ title: errorMessage(error), icon: "⚠" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, activePath, current]);

  const entryStatus = (path: string): string | null => {
    const parts = path.split("/");
    const name = parts.pop() ?? path;
    const dir = parts.join("/");
    return treeMap[dir]?.find((entry) => entry.name === name)?.status ?? null;
  };

  const handleNewFile = async (base: string) => {
    if (!activePath) return;
    const result = await ask({
      title: t("files.newFileTitle"),
      body: t("files.newFileBody", { worktree: activeWorktree?.branch ?? activePath }),
      ok: t("files.newFileOk"),
      icon: "＋",
      input: base ? `${base}/new-file.ts` : "new-file.ts",
    });
    if (typeof result !== "string" || !result) return;
    try {
      await fsCreate(activePath, result, "file");
      await reloadTree();
      openFileAction(result);
      toast({ title: t("files.created", { path: result }), icon: "＋" });
    } catch (error) {
      toast({ title: errorMessage(error), icon: "⚠" });
    }
  };

  const handleNewFolder = async (base: string) => {
    if (!activePath) return;
    const result = await ask({
      title: t("files.newFolderTitle"),
      ok: t("files.newFolderOk"),
      icon: "▸",
      input: base ? `${base}/new-folder` : "new-folder",
    });
    if (typeof result !== "string" || !result) return;
    try {
      await fsCreate(activePath, result, "folder");
      await reloadTree();
      toast({ title: t("files.created", { path: result }), icon: "▸" });
    } catch (error) {
      toast({ title: errorMessage(error), icon: "⚠" });
    }
  };

  const handleRename = async (path: string, isDir: boolean) => {
    if (!activePath) return;
    // I9: renaming a dirty open file (or a folder containing one) would move the file on disk
    // out from under its buffer, which still targets the old path, silently losing the edits.
    const prefix = `${path}/`;
    const isDirty = isDir
      ? Object.keys(dirty).some((p) => p.startsWith(prefix))
      : !!dirty[path];
    if (isDirty) {
      toast({ title: t("files.renameDirtyBlocked", { name: path.split("/").pop() ?? path }), icon: "⚠" });
      return;
    }
    const result = await ask({
      title: t("files.renameTitle", { name: path.split("/").pop() ?? path }),
      ok: t("files.renameOk"),
      icon: "✎",
      input: path,
    });
    if (typeof result !== "string" || !result || result === path) return;
    try {
      await fsRename(activePath, path, result);
      if (open.includes(path)) {
        closeFileAction(path);
        openFileAction(result);
      }
      await reloadTree();
      toast({ title: t("files.renamed", { from: path, to: result }), icon: "✎" });
    } catch (error) {
      toast({ title: errorMessage(error), icon: "⚠" });
    }
  };

  const handleDuplicate = async (path: string) => {
    if (!activePath) return;
    const match = /^(.*?)(\.[^./]+)?$/.exec(path);
    const copyPath = match?.[2] ? `${match[1]}.copy${match[2]}` : `${path}.copy`;
    try {
      const file = await fsRead(activePath, path);
      // `fs_read` returns only the first 8 KiB of a binary file; copying that would write a
      // truncated file. ponytail: refuse; add a Rust-side `fs_copy` if binary duplicate matters.
      if (file.encoding === "binary") {
        toast({ title: t("files.duplicateBinaryBlocked"), icon: "⚠" });
        return;
      }
      // `fsWrite` with `expected_mtime: 0` already creates a new file via O_EXCL (see fs.rs); an
      // extra `fsCreate` first would make this call see the just-created file and fail as a
      // Conflict (I4).
      await fsWrite(activePath, copyPath, file.bytes, 0);
      await reloadTree();
      toast({ title: t("files.duplicated", { path: copyPath }), icon: "⧉" });
    } catch (error) {
      toast({ title: errorMessage(error), icon: "⚠" });
    }
  };

  const handleDelete = async (path: string, isDir: boolean) => {
    if (!activePath) return;
    const name = path.split("/").pop() ?? path;
    const confirmed = await ask({
      title: t(isDir ? "files.deleteFolderTitle" : "files.deleteFileTitle", { name }),
      body: t(isDir ? "files.deleteFolderBody" : "files.deleteFileBody", { path }),
      ok: t("files.deleteOk"),
      danger: true,
      icon: "🗑",
    });
    if (confirmed !== true) return;
    try {
      const undoable = await fsDelete(activePath, path);
      const prefix = `${path}/`;
      for (const openPath of open.filter((p) => p === path || (isDir && p.startsWith(prefix)))) {
        closeFileAction(openPath);
      }
      await reloadTree();
      toast({
        title: t("files.deleted", { path }),
        icon: "🗑",
        action: {
          label: t("toast.undo"),
          undo: true,
          enabled: undoable,
          run: () => undoLast(activePath),
        },
      });
    } catch (error) {
      toast({ title: errorMessage(error), icon: "⚠" });
    }
  };

  const handleDiscard = async (path: string) => {
    if (!activePath) return;
    const confirmed = await ask({
      title: t("files.discardTitle", { name: path.split("/").pop() ?? path }),
      body: t("files.discardBody", { path }),
      ok: t("files.discardOk"),
      danger: true,
      icon: "↶",
    });
    if (confirmed !== true) return;
    try {
      const undoable = await discardPaths(activePath, [path], false);
      await reloadTree();
      toast({
        title: t("files.discarded", { path }),
        icon: "↶",
        action: {
          label: t("toast.undo"),
          undo: true,
          enabled: undoable,
          run: () => undoLast(activePath),
        },
      });
    } catch (error) {
      toast({ title: errorMessage(error), icon: "⚠" });
    }
  };

  const handleReveal = async (path: string) => {
    if (!activePath) return;
    try {
      await revealInFinder(activePath, path);
    } catch (error) {
      toast({ title: errorMessage(error), icon: "⚠" });
    }
  };

  const handleCopyPath = (path: string) => {
    void navigator.clipboard?.writeText(path);
    toast({ title: t("files.copied", { path }), icon: "⧉" });
  };

  const goToBlame = (path: string) => {
    openFileAction(path);
    useStage.getState().go("blame");
  };

  const contextMenuItems = (path: string, isDir: boolean): MenuItem[] => {
    const base = isDir ? path : path.split("/").slice(0, -1).join("/");
    const items: MenuItem[] = [
      { kind: "item", label: t("files.newFile"), kbd: "⌘N", icon: "＋", onSelect: () => void handleNewFile(base) },
      { kind: "item", label: t("files.newFolder"), icon: "▸", onSelect: () => void handleNewFolder(base) },
    ];
    items.push({ kind: "item", label: t("files.rename"), kbd: "F2", icon: "✎", onSelect: () => void handleRename(path, isDir) });
    if (!isDir) {
      items.push({ kind: "item", label: t("files.duplicate"), icon: "⧉", onSelect: () => void handleDuplicate(path) });
    }
    items.push({ kind: "item", label: t("files.delete"), icon: "🗑", danger: true, onSelect: () => void handleDelete(path, isDir) });
    items.push({ kind: "separator" });
    items.push({
      kind: "item",
      label: t("files.openTerminalHere"),
      icon: "❯_",
      disabled: true,
      title: t("ui.deferred_m3"),
      onSelect: () => {},
    });
    items.push({ kind: "item", label: t("files.revealInFinder"), icon: "⌘", onSelect: () => void handleReveal(path) });
    items.push({ kind: "item", label: t("files.copyPath"), icon: "⧉", onSelect: () => handleCopyPath(path) });
    items.push({ kind: "separator" });
    if (!isDir) {
      items.push({ kind: "item", label: t("files.blame"), icon: "≡", onSelect: () => goToBlame(path) });
      items.push({ kind: "item", label: t("files.fileHistory"), icon: "⟲", onSelect: () => goToBlame(path) });
      if (entryStatus(path)) {
        items.push({ kind: "item", label: t("files.discardChanges"), icon: "↶", onSelect: () => void handleDiscard(path) });
      }
    }
    items.push({
      kind: "item",
      label: t("files.askAgent"),
      icon: "✦",
      disabled: true,
      title: t("ui.deferred_m3"),
      onSelect: () => {},
    });
    return items;
  };

  const searchCandidates = useMemo(() => flattenFiles(searchIndex ?? {}), [searchIndex]);
  const searchResults = fuzzyQuery.trim() ? rank(searchCandidates, fuzzyQuery, (c) => c.path) : [];

  if (!activePath) {
    return (
      <div className="placeholder">
        <div className="placeholder-icon" aria-hidden>{def.icon}</div>
        <h2>{t(def.label)}</h2>
        <p>{t("files.noWorktree")}</p>
      </div>
    );
  }

  return (
    <div className="files-screen">
      <div className="files-side">
        <div className="files-top">
          <select
            aria-label={t("sidebar.selectWorktree", { branch: activeWorktree?.branch ?? activePath })}
            className="input files-worktree-select"
            onChange={(event) => useWorktrees.getState().select(event.target.value)}
            value={activePath}
          >
            {worktrees.map((worktree) => (
              <option key={worktree.path} value={worktree.path}>
                {worktree.branch ?? worktree.path}
              </option>
            ))}
          </select>
          <input
            aria-label={t("files.searchLabel")}
            className="input files-search"
            onChange={(event) => setFuzzyQueryAction(event.target.value)}
            onFocus={ensureSearchIndex}
            placeholder={t("files.searchPlaceholder")}
            value={fuzzyQuery}
          />
        </div>
        <div className="files-section-label">{t("files.openEditors")}</div>
        <div className="files-open-editors">
          {open.map((path) => (
            <div
              className={"files-tree-node" + (path === current ? " on" : "")}
              key={path}
              onClick={() => openFileAction(path)}
            >
              <FileIcon path={path} />
              <span className="files-tree-name">{path.split("/").pop()}</span>
              {dirty[path] && <span aria-hidden className="files-dirty-dot" />}
            </div>
          ))}
        </div>
        <div className="files-section-label files-tree-label">
          {projectName ?? t("files.treeHeader")}
          <span className="files-tree-actions">
            <button aria-label={t("files.newFile")} className="ib2" onClick={() => void handleNewFile("")} title={t("files.newFile")} type="button">＋</button>
            <button aria-label={t("files.collapseAll")} className="ib2" onClick={() => collapseAllAction()} title={t("files.collapseAll")} type="button">⊟</button>
          </span>
        </div>
        <div className="files-tree">
          {treeError ? (
            <p className="files-tree-error" role="alert">{t("files.loadError", { message: treeError })}</p>
          ) : fuzzyQuery.trim() ? (
            searchResults.length > 0 ? (
              searchResults.map(({ path }) => (
                <div
                  className={"files-tree-node" + (path === current ? " on" : "")}
                  key={path}
                  onClick={() => openFileAction(path)}
                >
                  <FileIcon path={path} />
                  <span className="files-tree-name">{path.split("/").pop()}</span>
                  <span className="files-tree-dir">{path.split("/").slice(0, -1).join("/")}</span>
                </div>
              ))
            ) : (
              <div className="files-tree-empty">{t("files.noMatches")}</div>
            )
          ) : (
            (treeMap[""] ?? []).map((entry) => (
              <TreeNode
                changedPaths={changedPaths}
                current={current}
                depth={0}
                dirty={dirty}
                entry={entry}
                expanded={expanded}
                key={entry.name}
                loadingFolders={loadingFolders}
                onContext={(event, path, isDir) => {
                  event.preventDefault();
                  setMenu({ x: event.clientX, y: event.clientY, path, isDir });
                }}
                onOpen={openFileAction}
                onToggle={handleToggle}
                path={entry.name}
                treeMap={treeMap}
              />
            ))
          )}
        </div>
        <label className="files-show-ignored">
          <input
            checked={showIgnored}
            onChange={(event) => setShowIgnoredAction(event.target.checked)}
            type="checkbox"
          />
          {t("files.showIgnored")}
        </label>
      </div>
      <div className="files-editor-pane">
        {mode === "editor" ? (
          <EditorHost />
        ) : !current ? (
          <div className="files-diff-empty">{t("files.noFileSelected")}</div>
        ) : diffModel && diffModel.hunks.length > 0 ? (
          <DiffRenderer area="head" fileName={current} mode="split" model={diffModel} />
        ) : (
          <div className="files-diff-empty">{t("files.noChanges")}</div>
        )}
      </div>
      {menu && (
        <Menu items={contextMenuItems(menu.path, menu.isDir)} onClose={() => setMenu(null)} x={menu.x} y={menu.y} />
      )}
    </div>
  );
}
