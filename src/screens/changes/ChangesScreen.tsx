import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";
import { t } from "../../i18n/t";
import { screenById } from "../registry";
import { useWorktrees } from "../../state/worktrees";
import { useChanges, type ChangesSelection } from "../../state/changes";
import { useFiles } from "../../state/files";
import { useStage } from "../../state/stage";
import { onGitChanged } from "../../ipc/worktrees";
import { useDock } from "../../terminal/dock";
import { useTerminalScreen } from "../../terminal/screen";
import { undoLast } from "../../ipc/undo";
import { runSync, useGitRunning, type SyncOperation } from "../../state/sync";
import { runGitAction } from "../../state/gitActions";
import { gitCheckout } from "../../ipc/gitops";
import type { DiffArea } from "../../ipc/diff";
import type { CommitOptions } from "../../ipc/changes";
import type { StatusEntry } from "../../ipc/status";
import { DiffRenderer } from "../../diff/DiffRenderer";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/controls";
import { FileIcon } from "../../ui/fileIcon";
import { Menu, type MenuItem } from "../../ui/Menu";
import { ask } from "../../ui/dialog";
import { ScreenLoader } from "../../ui/ScreenLoader";
import "./changes.css";

const def = screenById("changes");

function statusLetter(entry: StatusEntry, area: DiffArea): string {
  const code = area === "staged" ? entry.indexStatus : entry.worktreeStatus;
  return code.trim() || "?";
}

function statusClass(letter: string): string {
  return ["M", "A", "U", "D", "R", "C"].includes(letter) ? `changes-status-${letter}` : "changes-status-other";
}

type MenuPosition = { x: number; y: number; kind: "commit" | "more" };
type CommitKind = "commit" | "amend" | "push" | "sync" | "all";

// Opens `path` in the Files store directly (not via a window event) because the Files screen's
// own listener doesn't exist until it mounts, which drops the event (I5).
function filesOpen(path: string): void {
  useFiles.getState().openFile(path);
  useStage.getState().go("files");
}

export function ChangesToolbar() {
  const activePath = useWorktrees((s) => s.activePath);
  const branch = useWorktrees((s) => s.worktrees.find((w) => w.path === s.activePath)?.branch ?? null);
  const dmode = useChanges((s) => s.dmode);
  const setDiffMode = useChanges((s) => s.setDiffMode);
  return (
    <>
      <h1 className="pane-title">
        {t(def.label)}
        {activePath && (
          <span className="changes-subtitle" aria-hidden="true">
            {branch ?? activePath}
          </span>
        )}
      </h1>
      <div className="changes-toolbar-actions pane-actions">
        <Segmented
          label={t("changes.viewMode")}
          onChange={setDiffMode}
          options={[
            { value: "split", label: `◫ ${t("changes.modeSplit")}` },
            { value: "inline", label: `☰ ${t("changes.modeInline")}` },
          ]}
          value={dmode}
        />
        <Button disabled={!activePath} onClick={() => { if (activePath) void useDock.getState().openHere(activePath); }}>
          ❯_ {t("changes.terminal")}
        </Button>
      </div>
    </>
  );
}

interface SectionAction {
  id: string;
  icon: string;
  label: string;
}

/** The fold/chevron/title header shared by Staged Changes, Changes, and Stashes. Prototype's
 * `scmSec`: the count chip sits right next to the title (small gap) when the section has hover
 * actions, since those actions occupy the push-right slot instead; with no actions, the chip
 * itself takes that slot and sits flush right. */
function SectionHeader({
  actions,
  closed,
  count,
  onToggle,
  onAction,
  title,
}: {
  actions?: SectionAction[];
  closed: boolean;
  count: number;
  onToggle(): void;
  onAction?(action: SectionAction): void;
  title: string;
}) {
  const hasActions = !!actions?.length;
  return (
    <div
      aria-expanded={!closed}
      className="changes-section-header"
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggle();
        }
      }}
      role="button"
      tabIndex={0}
    >
      <span aria-hidden>{closed ? "▸" : "▾"}</span>
      {title}
      {hasActions && (
        <span className="changes-section-actions">
          {actions.map((action) => (
            <button
              aria-label={action.label}
              className="ib2"
              key={action.label}
              onClick={(event) => {
                event.stopPropagation();
                onAction?.(action);
              }}
              title={action.label}
              type="button"
            >
              {action.icon}
            </button>
          ))}
        </span>
      )}
      <span className={"chip" + (hasActions ? " chip-near" : "")}>{count}</span>
    </div>
  );
}

function ChangesSection({
  actions,
  area,
  closed,
  entries,
  onToggle,
  onAction,
  onFileAction,
  select,
  selection,
  title,
  treeView,
  onOpenFile,
}: {
  actions?: SectionAction[];
  area: DiffArea;
  closed: boolean;
  entries: StatusEntry[];
  onToggle(): void;
  onAction?(action: SectionAction): void;
  onFileAction(action: "discard" | "stage" | "unstage", entry: StatusEntry): void;
  select(selection: ChangesSelection): void;
  selection: ChangesSelection | null;
  title: string;
  treeView: boolean;
  onOpenFile(path: string): void;
}) {
  return (
    <>
      <SectionHeader actions={actions} closed={closed} count={entries.length} onAction={onAction} onToggle={onToggle} title={title} />
      {!closed &&
        <FileEntries
          area={area}
          entries={entries}
          onOpenFile={onOpenFile}
          onSelect={(entry) => select({ path: entry.path, area })}
          selection={selection}
          treeView={treeView}
          onAction={onFileAction}
        />}
    </>
  );
}

function FileEntries({
  area,
  entries,
  onAction,
  onOpenFile,
  onSelect,
  selection,
  treeView,
}: {
  area: DiffArea;
  entries: StatusEntry[];
  onAction(action: "discard" | "stage" | "unstage", entry: StatusEntry): void;
  onOpenFile(path: string): void;
  onSelect(entry: StatusEntry): void;
  selection: ChangesSelection | null;
  treeView: boolean;
}) {
  const renderFile = (entry: StatusEntry, nested: boolean) => (
    <FileRow
      area={area}
      entry={entry}
      key={entry.path}
      nested={nested}
      onAction={onAction}
      onOpenFile={() => onOpenFile(entry.path)}
      onSelect={() => onSelect(entry)}
      selected={selection?.area === area && selection.path === entry.path}
      treeView={treeView}
    />
  );
  if (!treeView) return <>{entries.map((entry) => renderFile(entry, false))}</>;

  const groups = new Map<string, StatusEntry[]>();
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    const directory = entry.path.split("/").slice(0, -1).join("/");
    const group = groups.get(directory) ?? [];
    group.push(entry);
    groups.set(directory, group);
  }
  return (
    <>
      {[...groups].map(([directory, groupedEntries]) => (
        <div className="changes-tree-group" key={directory || "root"}>
          {directory && (
            <div className="changes-tree-directory">
              <span aria-hidden>▾</span>
              {directory}
            </div>
          )}
          {groupedEntries.map((entry) => renderFile(entry, !!directory))}
        </div>
      ))}
    </>
  );
}

function FileRow({
  area,
  entry,
  nested,
  onAction,
  onOpenFile,
  onSelect,
  selected,
  treeView,
}: {
  area: DiffArea;
  entry: StatusEntry;
  nested: boolean;
  onAction(action: "discard" | "stage" | "unstage", entry: StatusEntry): void;
  onOpenFile(): void;
  onSelect(): void;
  selected: boolean;
  treeView: boolean;
}) {
  const letter = statusLetter(entry, area);
  const parts = entry.path.split("/");
  const name = parts.pop() ?? entry.path;
  const dir = parts.join("/");
  const style = nested ? { paddingLeft: 36 } : undefined;
  return (
    <div
      className={"changes-file-row" + (selected ? " on" : "")}
      onClick={onSelect}
      onDoubleClick={onOpenFile}
      style={style}
    >
      <FileIcon path={entry.path} />
      <span className={`changes-file-name ${statusClass(letter)}${letter === "D" ? " changes-file-deleted" : ""}`}>
        {name}
      </span>
      {!treeView && <span className="changes-file-dir">{dir}</span>}
      <span className="changes-file-actions">
        <button aria-label={t("changes.openFile")} className="ib2" onClick={(event) => { event.stopPropagation(); onOpenFile(); }} title={t("changes.openFile")} type="button">
          ▤
        </button>
        {area === "staged" ? (
          <button aria-label={t("changes.unstage")} className="ib2" onClick={(event) => { event.stopPropagation(); onAction("unstage", entry); }} title={t("changes.unstage")} type="button">
            −
          </button>
        ) : (
          <>
            <button aria-label={t("changes.discard")} className="ib2" onClick={(event) => { event.stopPropagation(); onAction("discard", entry); }} title={t("changes.discard")} type="button">
              ↶
            </button>
            <button aria-label={t("changes.stage")} className="ib2" onClick={(event) => { event.stopPropagation(); onAction("stage", entry); }} title={t("changes.stage")} type="button">
              ＋
            </button>
          </>
        )}
      </span>
      <span className={`changes-file-status ${statusClass(letter)}`}>{letter}</span>
    </div>
  );
}

async function checkoutBranch(worktreePath: string) {
  const name = await ask({
    title: t("changes.checkoutTitle"),
    body: t("changes.checkoutBody"),
    input: "",
    placeholder: t("graph.newBranchPlaceholder"),
    ok: t("changes.checkoutOk"),
    icon: "⎇",
  });
  if (typeof name !== "string") return;
  await runGitAction(worktreePath, t("graph.action.checkout"), () => gitCheckout(worktreePath, { kind: "branch", name }));
}

export function ChangesView() {
  const activePath = useWorktrees((s) => s.activePath);
  const worktreesLoading = useWorktrees((s) => s.loading);
  const activeWorktree = useWorktrees((s) => s.worktrees.find((w) => w.path === s.activePath) ?? null);
  const entries = useChanges((s) => s.entries);
  const stashes = useChanges((s) => s.stashes);
  const loading = useChanges((s) => s.loading);
  const error = useChanges((s) => s.error);
  const selection = useChanges((s) => s.selection);
  const diff = useChanges((s) => s.diff);
  const dmode = useChanges((s) => s.dmode);
  const selectedLineIds = useChanges((s) => s.selectedLineIds);
  const refresh = useChanges((s) => s.refresh);
  const handleGitChanged = useChanges((s) => s.handleGitChanged);
  const select = useChanges((s) => s.select);
  const dispatch = useChanges((s) => s.dispatch);
  const toggleLine = useChanges((s) => s.toggleLine);
  const syncRunning = useGitRunning(activePath);

  const [message, setMessage] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [treeView, setTreeView] = useState(false);
  const [menu, setMenu] = useState<MenuPosition | null>(null);
  const toggle = (id: string) => setClosed((previous) => ({ ...previous, [id]: !previous[id] }));
  const showMenu = (kind: MenuPosition["kind"], event: ReactMouseEvent<HTMLButtonElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    setMenu({ x: bounds.right - 240, y: bounds.bottom + 6, kind });
  };

  const runCommit = async (kind: CommitKind, useTypedMessage = true) => {
    const options: CommitOptions = {
      message: useTypedMessage ? message : "",
      amend: kind === "amend",
      stageAll: kind === "all",
    };
    const command =
      kind === "push"
        ? { type: "commit-and-push" as const, options }
        : kind === "sync"
          ? { type: "commit-and-sync" as const, options }
          : { type: "commit" as const, options };
    const succeeded = await dispatch(command);
    if (succeeded && useTypedMessage) setMessage("");
  };

  const commitMenuItems: MenuItem[] = [
    {
      kind: "item",
      label: t("changes.commit"),
      icon: "✓",
      kbd: "⌘↵",
      disabled: !message.trim(),
      onSelect: () => void runCommit("commit"),
    },
    {
      kind: "item",
      label: t("changes.commitAmend"),
      icon: "✓",
      onSelect: () => void runCommit("amend"),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: t("changes.commitPush"),
      icon: "↑",
      disabled: !message.trim(),
      onSelect: () => void runCommit("push"),
    },
    {
      kind: "item",
      label: t("changes.commitSync"),
      icon: "⟳",
      onSelect: () => void runCommit("sync"),
    },
    { kind: "separator" },
    {
      kind: "item",
      label: t("changes.commitAll"),
      icon: "⊕",
      disabled: !message.trim(),
      onSelect: () => void runCommit("all"),
    },
    {
      kind: "item",
      label: t("changes.undoCommit"),
      icon: "↶",
      kbd: "⌘Z",
      disabled: !activePath,
      onSelect: () => {
        if (activePath) undoLast(activePath);
      },
    },
  ];

  const syncItem = (operation: SyncOperation, label: string, icon: string): MenuItem => ({
    kind: "item",
    label,
    icon,
    disabled: !activePath || syncRunning !== undefined,
    onSelect: () => { if (activePath) void runSync(activePath, operation); },
  });

  const moreMenuItems: MenuItem[] = [
    syncItem("pull", t("sync.pull"), "↓"),
    syncItem("push", t("sync.push"), "↑"),
    syncItem("fetch", t("sync.fetch"), "⟳"),
    {
      kind: "item",
      label: t("changes.checkoutMenu"),
      icon: "⎇",
      disabled: !activePath,
      onSelect: () => { if (activePath) void checkoutBranch(activePath); },
    },
    { kind: "separator" },
    {
      kind: "item",
      label: t("changes.popLatestStash"),
      icon: "⊞",
      disabled: stashes.length === 0,
      onSelect: () => void dispatch({ type: "stash-pop", index: 0 }),
    },
    {
      kind: "item",
      label: t("changes.stashAll"),
      icon: "⊟",
      onSelect: () => void dispatch({ type: "stash-push", options: { includeUntracked: true } }),
    },
    {
      kind: "item",
      label: t("changes.openTerminal"),
      icon: "❯_",
      disabled: !activePath,
      onSelect: () => { if (activePath) void useDock.getState().openHere(activePath); },
    },
    {
      kind: "item",
      label: t("changes.openTerminalScreen"),
      icon: "❯_",
      disabled: !activePath,
      onSelect: () => { if (activePath) void useTerminalScreen.getState().openHere(activePath); },
    },
  ];

  const onFileAction = (action: "discard" | "stage" | "unstage", entry: StatusEntry) => {
    if (action === "stage") void dispatch({ type: "stage-paths", paths: [entry.path] });
    else if (action === "unstage") void dispatch({ type: "unstage-paths", paths: [entry.path] });
    else void dispatch({ type: "discard-paths", paths: [entry.path], discardUntracked: true });
  };

  const onSectionAction = async (action: SectionAction) => {
    if (action.id === "stageAll") {
      void dispatch({ type: "stage-paths", paths: entries.unstaged.map((entry) => entry.path) });
      return;
    }
    if (action.id === "unstageAll") {
      void dispatch({ type: "unstage-paths", paths: entries.staged.map((entry) => entry.path) });
      return;
    }
    if (action.id === "discardAll") {
      const confirmed = await ask({
        title: t("changes.discardAllTitle"),
        body: t("changes.discardAllBody"),
        ok: t("changes.discardAllOk"),
        danger: true,
        icon: "↶",
        meta: entries.unstaged.map((entry) => `${statusLetter(entry, "unstaged")}  ${entry.path}`).join("\n"),
      });
      if (confirmed !== true) return;
      void dispatch({
        type: "discard-paths",
        paths: entries.unstaged.map((entry) => entry.path),
        discardUntracked: true,
      });
    }
  };

  const onStashAction = (action: "apply" | "pop" | "drop", index: number) => {
    if (action === "apply") void dispatch({ type: "stash-apply", index });
    else if (action === "pop") void dispatch({ type: "stash-pop", index });
    else void dispatch({ type: "stash-drop", index });
  };

  useEffect(() => {
    void useChanges.getState().load();
  }, []);

  useEffect(() => {
    if (activePath) void refresh(activePath);
  }, [activePath, refresh]);

  useEffect(() => {
    if (!activePath || typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let subscription: Promise<() => void>;
    try {
      subscription = onGitChanged((event) => {
        if (event.worktree === activePath) handleGitChanged(activePath);
      });
    } catch {
      return;
    }
    void subscription.then((stop) => {
      if (disposed) void stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      if (unlisten) void unlisten();
    };
  }, [activePath, handleGitChanged]);

  if (!activePath && worktreesLoading) {
    return <ScreenLoader>{t("changes.loading")}</ScreenLoader>;
  }

  if (!activePath) {
    return (
      <div className="placeholder">
        <div className="placeholder-icon" aria-hidden>{def.icon}</div>
        <h2>{t(def.label)}</h2>
        <p>{t("changes.noWorktree")}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="placeholder">
        <h2>{t(def.label)}</h2>
        <p role="alert">{t("changes.error", { message: error })}</p>
      </div>
    );
  }

  const empty = !loading && entries.staged.length === 0 && entries.unstaged.length === 0;
  const firstLineLength = message.split("\n")[0].length;
  const counterColor = firstLineLength > 72 ? "var(--red)" : firstLineLength > 50 ? "var(--yel)" : "var(--fg3)";
  const commitPlaceholder = t("changes.commitPlaceholder", { branch: activeWorktree?.branch ?? activePath });

  return (
    <div className="changes-screen">
      <div className="changes-list-panel">
        <div className="changes-list-header">
          <span className="changes-list-title">{t("changes.sourceControl")}</span>
          <button
            aria-label={t(treeView ? "changes.listView" : "changes.treeView")}
            aria-pressed={treeView}
            className="ib2"
            onClick={() => setTreeView((value) => !value)}
            title={t(treeView ? "changes.listView" : "changes.treeView")}
            type="button"
          >
            {treeView ? "☰" : "⊞"}
          </button>
          <button aria-label={t("changes.refresh")} className="ib2" onClick={() => void refresh(activePath)} title={t("changes.refresh")} type="button">
            ⟳
          </button>
          <button aria-label={t("changes.more")} className="ib2" onClick={(event) => showMenu("more", event)} title={t("changes.more")} type="button">
            ⋯
          </button>
        </div>
        <div className="changes-commit-box">
          <div className="changes-commit-input">
            <textarea
              className="input"
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && message.trim()) {
                  event.preventDefault();
                  void runCommit("commit");
                }
              }}
              placeholder={commitPlaceholder}
              rows={3}
              value={message}
            />
            <button aria-label={t("changes.generateMessage")} className="ib2 changes-commit-generate" disabled title={t("ui.deferred_m7")} type="button">
              ✦
            </button>
          </div>
          <div className="changes-commit-count">
            {message && <span style={{ color: counterColor }}>{firstLineLength}/72</span>}
          </div>
          <div className="changes-split-button">
            <Button disabled={!message.trim()} onClick={() => void runCommit("commit")} variant="primary">✓ {t("changes.commit")}</Button>
            <Button aria-label={t("changes.commitMenu")} onClick={(event) => showMenu("commit", event)} variant="primary">▾</Button>
          </div>
          {activeWorktree && (
            <div className="changes-branch-row">
              <span>⎇ {activeWorktree.branch ?? activePath}</span>
              <span>
                ↑{activeWorktree.ahead} ↓{activeWorktree.behind}
              </span>
              <span className="changes-branch-spacer" />
              <Button onClick={() => void runCommit("sync", false)} size="sm" variant="ghost">⟳ {t("changes.sync")}</Button>
            </div>
          )}
        </div>
        <div className="changes-scroll">
          <ChangesSection
            actions={entries.staged.length > 0 ? [{ id: "unstageAll", icon: "−", label: t("changes.unstageAll") }] : undefined}
            onAction={(action) => void onSectionAction(action)}
            onFileAction={onFileAction}
            area="staged"
            closed={!!closed.staged}
            entries={entries.staged}
            onToggle={() => toggle("staged")}
            select={select}
            selection={selection}
            title={t("changes.sectionStaged")}
            treeView={treeView}
            onOpenFile={filesOpen}
          />
          <ChangesSection
            actions={[
              { id: "discardAll", icon: "↶", label: t("changes.discardAll") },
              { id: "stageAll", icon: "＋", label: t("changes.stageAll") },
            ]}
            onAction={(action) => void onSectionAction(action)}
            onFileAction={onFileAction}
            area="unstaged"
            closed={!!closed.unstaged}
            entries={entries.unstaged}
            onToggle={() => toggle("unstaged")}
            select={select}
            selection={selection}
            title={t("changes.sectionChanges")}
            treeView={treeView}
            onOpenFile={filesOpen}
          />
          <SectionHeader closed={!!closed.stashes} count={stashes.length} onToggle={() => toggle("stashes")} title={t("changes.sectionStashes")} />
          {!closed.stashes &&
            stashes.map((stash) => (
              <div className="changes-stash-row" key={stash.index}>
                <span aria-hidden className="changes-stash-icon">⊟</span>
                <span className="changes-stash-ref">{`stash@{${stash.index}}`}</span>
                <span className="changes-stash-message" title={stash.branch ? `${stash.branch}: ${stash.message}` : stash.message}>
                  {stash.message}
                </span>
                <span className="changes-file-actions">
                  <button aria-label={t("changes.stashApply")} className="ib2" onClick={() => onStashAction("apply", stash.index)} title={t("changes.stashApply")} type="button">
                    ↓
                  </button>
                  <button aria-label={t("changes.stashPop")} className="ib2" onClick={() => onStashAction("pop", stash.index)} title={t("changes.stashPop")} type="button">
                    ⇪
                  </button>
                  <button aria-label={t("changes.stashDrop")} className="ib2" onClick={() => onStashAction("drop", stash.index)} title={t("changes.stashDrop")} type="button">
                    ×
                  </button>
                </span>
              </div>
            ))}
        </div>
      </div>
      <div className="changes-diff-pane">
        {loading ? (
          <div className="changes-empty" role="status">
            <span className="spin" aria-hidden="true" /> {t("changes.loading")}
          </div>
        ) : empty ? (
          <div className="changes-empty">{t("changes.empty")}</div>
        ) : diff && selection ? (
          <DiffRenderer
            area={selection.area}
            fileName={selection.path}
            hunkAreas={diff.hunks.map(() => selection.area)}
            key={`${selection.area}:${selection.path}`}
            mode={dmode}
            model={diff}
            onOpenFile={() => filesOpen(selection.path)}
            onRequestHunkAction={(_hunk, action, hunkIndex) => {
              if (action === "stage") {
                void dispatch({
                  type: "stage-hunks",
                  path: selection.path,
                  hunkIndices: [hunkIndex],
                  area: selection.area,
                });
              } else if (action === "unstage") {
                void dispatch({
                  type: "unstage-hunks",
                  path: selection.path,
                  hunkIndices: [hunkIndex],
                });
              } else {
                void dispatch({
                  type: "revert-hunk",
                  path: selection.path,
                  hunkIndex,
                });
              }
            }}
            onStageSelectedLines={() => {
              void dispatch({
                type: "stage-lines",
                path: selection.path,
                lineIds: selectedLineIds,
                area: selection.area,
              });
            }}
            onToggleLine={(_hunk, lineId) => toggleLine(lineId)}
            selectedLineIds={selectedLineIds}
          />
        ) : (
          <div className="changes-empty">{t("changes.noSelection")}</div>
        )}
      </div>
      {menu && (
        <Menu
          items={menu.kind === "commit" ? commitMenuItems : moreMenuItems}
          onClose={() => setMenu(null)}
          width={250}
          x={menu.x}
          y={menu.y}
        />
      )}
    </div>
  );
}
