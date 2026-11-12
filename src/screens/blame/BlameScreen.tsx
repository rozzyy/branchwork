import { useCallback, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/t";
import { readBlame, readFileHistory, type AgeBucket, type BlameResult, type FileHistoryEntry } from "../../ipc/blame";
import { errorMessage } from "../../ipc/errors";
import { fsRead, fsTree, type FsEntry } from "../../ipc/fs";
import { useFiles } from "../../state/files";
import { useStage } from "../../state/stage";
import { useWorktrees } from "../../state/worktrees";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/controls";
import { FileIcon } from "../../ui/fileIcon";
import { ScreenLoader } from "../../ui/ScreenLoader";
import { useGraphUi } from "../graph/graphState";
import { useBlameUi } from "./blameState";
import "./blame.css";

/** Age heat stripe color per Task 12 `age_bucket`. There is no orange token, so `hours`
 * uses `--red` (the warmest status token); `weeks` is the prototype's yellow tint;
 * `months`/`older` fall back to neutral surface tokens. */
export function heatStripeColor(bucket: AgeBucket): string {
  switch (bucket) {
    case "hours": return "var(--red)";
    case "days": return "var(--yel)";
    case "weeks": return "color-mix(in oklch, var(--yel) 40%, transparent)";
    case "months": return "var(--s3)";
    case "older": return "var(--s4)";
  }
}

export function authorInitials(author: string): string {
  const parts = author.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

const AVATAR_PALETTE = ["var(--acc)", "var(--blu)", "var(--grn)", "var(--yel)", "var(--pur)", "var(--red)"];

function avatarColor(seed: string): string {
  let hash = 5381;
  for (let i = 0; i < seed.length; i++) hash = ((hash * 33) ^ seed.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

function Avatar({ author, size = 20 }: { author: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="blame-avatar"
      style={{ background: avatarColor(author), width: size, height: size, fontSize: size * 0.45 }}
    >
      {authorInitials(author)}
    </span>
  );
}

/** Short relative age, mirroring GraphScreen's `relativeTime` (reuses `graph.time*` strings). */
export function relativeAge(time: number, now: number = Math.floor(Date.now() / 1000)): string {
  const seconds = now - time;
  const absolute = Math.abs(seconds);
  if (absolute < 60) return t("graph.timeNow");
  const units = [
    [31_536_000, "graph.timeUnit.years"],
    [2_592_000, "graph.timeUnit.months"],
    [604_800, "graph.timeUnit.weeks"],
    [86_400, "graph.timeUnit.days"],
    [3_600, "graph.timeUnit.hours"],
    [60, "graph.timeUnit.minutes"],
  ] as const;
  const [divisor, key] = units.find(([d]) => absolute >= d) ?? [60, "graph.timeUnit.minutes" as const];
  const short = t("graph.timeShort", { amount: Math.max(1, Math.round(absolute / divisor)), unit: t(key) });
  return seconds >= 0 ? short : `+${short}`;
}

function scrollToHistory(): void {
  document.querySelector("[data-blame-history]")?.scrollIntoView({ block: "start" });
}

export function BlameToolbar() {
  const current = useFiles((s) => s.current);
  const setMode = useFiles((s) => s.setMode);
  const go = useStage((s) => s.go);

  const onSegment = (value: string) => {
    if (value === "history") scrollToHistory();
    else if (value === "diff") {
      setMode("diff");
      go("files");
    }
  };

  return (
    <>
      <h1 className="pane-title">
        {t("blame.title")}
        {current && <span className="blame-subtitle mono" aria-hidden="true">{current}</span>}
      </h1>
      <div className="blame-toolbar-actions pane-actions">
        <Segmented
          label={t("blame.viewMode")}
          onChange={onSegment}
          options={[
            { value: "blame", label: t("blame.modeBlame") },
            { value: "history", label: t("blame.modeHistory") },
            { value: "diff", label: t("blame.modeDiff") },
          ]}
          value="blame"
        />
        <Button
          disabled={!current}
          onClick={() => {
            setMode("editor");
            go("files");
          }}
        >
          {"▤ "}{t("blame.openInEditor")}
        </Button>
      </div>
    </>
  );
}

type TreeMap = Record<string, FsEntry[]>;

function CompactTreeNode({
  depth, entry, expanded, onOpen, onToggle, path, treeMap,
}: {
  depth: number; entry: FsEntry; expanded: Record<string, true>;
  onOpen(path: string): void; onToggle(path: string): void; path: string; treeMap: TreeMap;
}) {
  const current = useFiles((s) => s.current);
  if (entry.isDir) {
    const isOpen = !!expanded[path];
    const children = treeMap[path];
    return (
      <>
        <div className="files-tree-node" onClick={() => onToggle(path)} style={{ paddingLeft: 6 + depth * 14 }}>
          <span aria-hidden className="files-tree-arrow">{isOpen ? "▾" : "▸"}</span>
          <span className="files-tree-name">{entry.name}</span>
        </div>
        {isOpen && (children ?? []).map((child) => (
          <CompactTreeNode
            depth={depth + 1} entry={child} expanded={expanded} key={child.name}
            onOpen={onOpen} onToggle={onToggle}
            path={path ? `${path}/${child.name}` : child.name} treeMap={treeMap}
          />
        ))}
      </>
    );
  }
  return (
    <div
      className={"files-tree-node" + (path === current ? " on" : "")}
      onClick={() => onOpen(path)}
      style={{ paddingLeft: 20 + depth * 14 }}
    >
      <FileIcon path={path} />
      <span className="files-tree-name">{entry.name}</span>
    </div>
  );
}

function BlameTree() {
  const activePath = useWorktrees((s) => s.activePath);
  const openFile = useFiles((s) => s.openFile);
  const [treeMap, setTreeMap] = useState<TreeMap>({});
  const [expanded, setExpanded] = useState<Record<string, true>>({});

  useEffect(() => {
    if (!activePath) { setTreeMap({}); return; }
    let cancelled = false;
    void fsTree(activePath, { path: "", showIgnored: false, includeStatus: true })
      .then((tree) => { if (!cancelled) setTreeMap({ "": tree.entries }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activePath]);

  const onToggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = { ...prev };
      if (next[path]) delete next[path]; else next[path] = true;
      return next;
    });
    if (!activePath || treeMap[path] !== undefined) return;
    void fsTree(activePath, { path, showIgnored: false, includeStatus: true })
      .then((tree) => setTreeMap((prev) => ({ ...prev, [path]: tree.entries })))
      .catch(() => {});
  }, [activePath, treeMap]);

  return (
    <div className="blame-tree files-tree">
      {(treeMap[""] ?? []).map((entry) => (
        <CompactTreeNode
          depth={0} entry={entry} expanded={expanded} key={entry.name}
          onOpen={openFile} onToggle={onToggle} path={entry.name} treeMap={treeMap}
        />
      ))}
    </div>
  );
}

export function BlameView() {
  const activePath = useWorktrees((s) => s.activePath);
  const worktreesLoading = useWorktrees((s) => s.loading);
  const current = useFiles((s) => s.current);
  const go = useStage((s) => s.go);
  const selectedLine = useBlameUi((s) => s.selectedLine);
  const selectLine = useBlameUi((s) => s.selectLine);
  const [blame, setBlame] = useState<BlameResult | null>(null);
  const [history, setHistory] = useState<FileHistoryEntry[]>([]);
  const [codeLines, setCodeLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!activePath || !current) {
      setBlame(null); setHistory([]); setCodeLines([]); setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const [result, entries, file] = await Promise.all([
          readBlame(activePath, current),
          readFileHistory(activePath, current, { limit: 50 }),
          fsRead(activePath, current).catch(() => null),
        ]);
        if (cancelled) return;
        setBlame(result);
        setHistory(entries);
        setCodeLines(
          file && file.encoding !== "binary"
            ? new TextDecoder().decode(new Uint8Array(file.bytes)).split("\n")
            : [],
        );
        selectLine(result.lines[0]?.line ?? null);
      } catch (err) {
        if (!cancelled) { setBlame(null); setHistory([]); setError(errorMessage(err)); }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activePath, current, selectLine]);

  if (!activePath && worktreesLoading) {
    return <ScreenLoader>{t("blame.loading")}</ScreenLoader>;
  }

  if (!activePath || !current) {
    return (
      <div className="placeholder">
        <div className="placeholder-icon" aria-hidden>{"≡"}</div>
        <h2>{t("blame.emptyTitle")}</h2>
        <p>{activePath ? t("blame.emptyBody") : t("blame.noWorktree")}</p>
        <Button onClick={() => go("files")}>{t("blame.pickFile")}</Button>
      </div>
    );
  }

  const lineByNumber = new Map((blame?.lines ?? []).map((line) => [line.line, line]));
  const groupStartByLine = new Map((blame?.groups ?? []).map((g) => [g.start, g]));
  const selected = selectedLine != null ? lineByNumber.get(selectedLine) ?? null : null;
  const selectedHistory = selected ? history.find((h) => h.sha === selected.sha) ?? null : null;
  // Blame `summary` and history `message` are both first-line only (Task 12); show the
  // history message when present since it is the same commit's canonical subject.
  const selectedMessage = selectedHistory?.message ?? selected?.summary ?? "";

  const viewCommit = (sha: string) => {
    useGraphUi.getState().select({ kind: "commit", sha });
    go("graph");
  };

  const jumpToHistory = (entry: FileHistoryEntry) => {
    const group = blame?.groups.find((g) => g.sha === entry.sha);
    if (!group) return;
    selectLine(group.start);
    codeRef.current
      ?.querySelector(`[data-blame-line="${group.start}"]`)
      ?.scrollIntoView({ block: "center" });
  };

  return (
    <div className="blame-screen">
      <BlameTree />
      <div className="blame-code" ref={codeRef} role="listbox" aria-label={t("blame.codeLabel", { path: current })}>
        {loading && <div className="blame-state">{t("blame.loading")}</div>}
        {error && <div className="blame-state" role="alert">{t("blame.loadError", { message: error })}</div>}
        {!loading && !error && (blame?.lines ?? []).map((line) => {
          const group = groupStartByLine.get(line.line);
          const first = group ? lineByNumber.get(group.start) : undefined;
          return (
            <div
              className={"blame-line" + (selectedLine === line.line ? " on" : "")}
              data-blame-line={line.line}
              key={line.line}
              onClick={() => selectLine(line.line)}
              role="option"
              aria-selected={selectedLine === line.line}
            >
              <span
                aria-hidden
                className="blame-heat"
                data-age-bucket={line.ageBucket}
                style={{ background: heatStripeColor(line.ageBucket) }}
              />
              {group && first ? (
                <span className="blame-gutter" data-testid="blame-gutter">
                  <Avatar author={first.author} />
                  <span className="blame-gutter-author">{first.author}</span>
                  <span className="blame-gutter-age">{relativeAge(first.time)}</span>
                  <span className="blame-gutter-summary">{first.summary}</span>
                </span>
              ) : (
                <span aria-hidden className="blame-gutter blame-gutter-cont" />
              )}
              <span className="blame-lineno mono">{line.line}</span>
              <span className="blame-code-text mono">{codeLines[line.line - 1] ?? ""}</span>
            </div>
          );
        })}
      </div>
      <div className="blame-detail">
        {selected ? (
          <div className="blame-commit-card">
            <div className="blame-h4">{t("blame.lineLastChanged", { line: selected.line })}</div>
            <div className="blame-commit-message">{selectedMessage}</div>
            <div className="blame-who">
              <Avatar author={selected.author} />
              <span>{selected.author}</span>
              <span>{relativeAge(selected.time)}</span>
              <span className="mono">{selected.sha.slice(0, 7)}</span>
            </div>
            <div className="blame-commit-actions">
              <Button size="sm" onClick={() => viewCommit(selected.sha)}>{t("blame.viewCommit")}</Button>
              <Button size="sm" disabled title={t("ui.deferred_m4")}>{t("blame.viewPr")}</Button>
            </div>
          </div>
        ) : (
          <div className="blame-commit-card"><p>{t("blame.selectLine")}</p></div>
        )}
        <div className="blame-h4 blame-history-heading" data-blame-history>{t("blame.fileHistory")}</div>
        <div className="blame-history" aria-label={t("blame.historyLabel")}>
          {history.length === 0 && !loading && <p className="blame-no-history">{t("blame.noHistory")}</p>}
          {history.map((entry) => (
            <div
              className={"blame-history-item" + (selected?.sha === entry.sha ? " on" : "")}
              key={entry.sha}
              onClick={() => jumpToHistory(entry)}
            >
              <Avatar author={entry.author} />
              <div className="blame-history-text">
                <div className="blame-history-message">{entry.message}</div>
                <div className="blame-history-meta">
                  {entry.author} · {relativeAge(entry.time)} · <span className="mono">{entry.sha.slice(0, 7)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
