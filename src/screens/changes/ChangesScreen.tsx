import { useEffect, useState } from "react";
import { t } from "../../i18n/t";
import { screenById } from "../registry";
import { useWorktrees } from "../../state/worktrees";
import { useChanges, type ChangesSelection } from "../../state/changes";
import { onGitChanged } from "../../ipc/worktrees";
import type { DiffArea } from "../../ipc/diff";
import type { StatusEntry } from "../../ipc/status";
import { DiffRenderer } from "../../diff/DiffRenderer";
import { Button } from "../../ui/Button";
import { Segmented } from "../../ui/controls";
import { FileIcon } from "../../ui/fileIcon";
import "./changes.css";

const def = screenById("changes");

const STATUS_COLORS: Record<string, string> = { M: "var(--yel)", A: "var(--grn)", U: "var(--grn)", D: "var(--red)" };

function statusColor(letter: string): string {
  return STATUS_COLORS[letter] ?? "var(--fg3)";
}

function statusLetter(entry: StatusEntry, area: DiffArea): string {
  const code = area === "staged" ? entry.indexStatus : entry.worktreeStatus;
  return code.trim() || "?";
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
      <div className="changes-toolbar-actions">
        <Segmented
          label={t("changes.viewMode")}
          onChange={setDiffMode}
          options={[
            { value: "split", label: `◫ ${t("changes.modeSplit")}` },
            { value: "inline", label: `☰ ${t("changes.modeInline")}` },
          ]}
          value={dmode}
        />
        <Button disabled title={t("changes.terminalDeferred")}>
          ❯_ {t("changes.terminal")}
        </Button>
      </div>
    </>
  );
}

function FileRow({
  area,
  entry,
  onSelect,
  selected,
}: {
  area: DiffArea;
  entry: StatusEntry;
  onSelect(): void;
  selected: boolean;
}) {
  const letter = statusLetter(entry, area);
  const color = statusColor(letter);
  const parts = entry.path.split("/");
  const name = parts.pop() ?? entry.path;
  const dir = parts.join("/");
  return (
    <div className={"changes-file-row" + (selected ? " on" : "")} onClick={onSelect}>
      <FileIcon path={entry.path} />
      <span className="changes-file-name" style={{ color, textDecoration: letter === "D" ? "line-through" : undefined }}>
        {name}
      </span>
      <span className="changes-file-dir">{dir}</span>
      <span className="changes-file-actions">
        <button aria-label={t("changes.openFile")} className="ib2" disabled title={t("changes.openFile")} type="button">
          ▤
        </button>
        {area === "staged" ? (
          <button aria-label={t("changes.unstage")} className="ib2" disabled title={t("changes.unstage")} type="button">
            −
          </button>
        ) : (
          <>
            <button aria-label={t("changes.discard")} className="ib2" disabled title={t("changes.discard")} type="button">
              ↶
            </button>
            <button aria-label={t("changes.stage")} className="ib2" disabled title={t("changes.stage")} type="button">
              ＋
            </button>
          </>
        )}
      </span>
      <span className="changes-file-status" style={{ color }}>
        {letter}
      </span>
    </div>
  );
}

interface SectionAction {
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
  title,
}: {
  actions?: SectionAction[];
  closed: boolean;
  count: number;
  onToggle(): void;
  title: string;
}) {
  const hasActions = !!actions?.length;
  return (
    <div
      aria-expanded={!closed}
      className="changes-section-header"
      onClick={onToggle}
      onKeyDown={(event) => {
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
              disabled
              key={action.label}
              onClick={(event) => event.stopPropagation()}
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
  select,
  selection,
  title,
}: {
  actions?: SectionAction[];
  area: DiffArea;
  closed: boolean;
  entries: StatusEntry[];
  onToggle(): void;
  select(selection: ChangesSelection): void;
  selection: ChangesSelection | null;
  title: string;
}) {
  return (
    <>
      <SectionHeader actions={actions} closed={closed} count={entries.length} onToggle={onToggle} title={title} />
      {!closed &&
        entries.map((entry) => (
          <FileRow
            area={area}
            entry={entry}
            key={entry.path}
            onSelect={() => select({ path: entry.path, area })}
            selected={selection?.area === area && selection.path === entry.path}
          />
        ))}
    </>
  );
}

export function ChangesView() {
  const activePath = useWorktrees((s) => s.activePath);
  const activeWorktree = useWorktrees((s) => s.worktrees.find((w) => w.path === s.activePath) ?? null);
  const entries = useChanges((s) => s.entries);
  const loading = useChanges((s) => s.loading);
  const error = useChanges((s) => s.error);
  const selection = useChanges((s) => s.selection);
  const diff = useChanges((s) => s.diff);
  const dmode = useChanges((s) => s.dmode);
  const refresh = useChanges((s) => s.refresh);
  const handleGitChanged = useChanges((s) => s.handleGitChanged);
  const select = useChanges((s) => s.select);

  const [message, setMessage] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const toggle = (id: string) => setClosed((previous) => ({ ...previous, [id]: !previous[id] }));

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
          <button aria-label={t("changes.treeView")} className="ib2" disabled title={t("changes.treeView")} type="button">
            ⊞
          </button>
          <button aria-label={t("changes.refresh")} className="ib2" onClick={() => void refresh(activePath)} title={t("changes.refresh")} type="button">
            ⟳
          </button>
          <button aria-label={t("changes.more")} className="ib2" disabled title={t("changes.more")} type="button">
            ⋯
          </button>
        </div>
        <div className="changes-commit-box">
          <div className="changes-commit-input">
            <textarea
              className="input"
              onChange={(event) => setMessage(event.target.value)}
              placeholder={commitPlaceholder}
              rows={3}
              value={message}
            />
            <button aria-label={t("changes.generateMessage")} className="ib2 changes-commit-generate" disabled title={t("changes.generateMessage")} type="button">
              ✦
            </button>
          </div>
          <div className="changes-commit-count">
            {message && <span style={{ color: counterColor }}>{firstLineLength}/72</span>}
          </div>
          <div className="changes-split-button">
            <Button disabled variant="primary">✓ {t("changes.commit")}</Button>
            <Button aria-label={t("changes.commitMenu")} disabled variant="primary">▾</Button>
          </div>
          {activeWorktree && (
            <div className="changes-branch-row">
              <span>⎇ {activeWorktree.branch ?? activePath}</span>
              <span>
                ↑{activeWorktree.ahead} ↓{activeWorktree.behind}
              </span>
              <span className="changes-branch-spacer" />
              <Button disabled size="sm" variant="ghost">⟳ {t("changes.sync")}</Button>
            </div>
          )}
        </div>
        <div className="changes-scroll">
          {entries.staged.length > 0 && (
            <ChangesSection
              actions={[{ icon: "−", label: t("changes.unstageAll") }]}
              area="staged"
              closed={!!closed.staged}
              entries={entries.staged}
              onToggle={() => toggle("staged")}
              select={select}
              selection={selection}
              title={t("changes.sectionStaged")}
            />
          )}
          <ChangesSection
            actions={[
              { icon: "↶", label: t("changes.discardAll") },
              { icon: "＋", label: t("changes.stageAll") },
            ]}
            area="unstaged"
            closed={!!closed.unstaged}
            entries={entries.unstaged}
            onToggle={() => toggle("unstaged")}
            select={select}
            selection={selection}
            title={t("changes.sectionChanges")}
          />
          <SectionHeader closed={!!closed.stashes} count={0} onToggle={() => toggle("stashes")} title={t("changes.sectionStashes")} />
        </div>
      </div>
      <div className="changes-diff-pane">
        {empty ? (
          <div className="changes-empty">{t("changes.empty")}</div>
        ) : diff && selection ? (
          <DiffRenderer
            area={selection.area}
            fileName={selection.path}
            hunkAreas={diff.hunks.map(() => selection.area)}
            key={`${selection.area}:${selection.path}`}
            mode={dmode}
            model={diff}
          />
        ) : (
          <div className="changes-empty">{t("changes.noSelection")}</div>
        )}
      </div>
    </div>
  );
}
