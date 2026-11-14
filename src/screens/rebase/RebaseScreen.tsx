import { useEffect, useState, type DragEvent } from "react";
import { t } from "../../i18n/t";
import { errorMessage } from "../../ipc/errors";
import {
  gitPushForceWithLease,
  onRebaseProgress,
  rebaseAbort,
  rebaseContinue,
  rebaseInteractive,
  rebasePlan,
  type RebaseOutcome,
  type RebasePlan,
} from "../../ipc/rebase";
import { undoLast } from "../../ipc/undo";
import { beginGitWrite, endGitWrite, reloadWorktreesFor, runGitAction, showGitError } from "../../state/gitActions";
import { useStage } from "../../state/stage";
import { openHistory } from "../../state/history";
import { useWorktrees } from "../../state/worktrees";
import { ask } from "../../ui/dialog";
import { ScreenLoader } from "../../ui/ScreenLoader";
import { toast } from "../../ui/toast";
import { useConflicts } from "../conflicts/conflictsState";
import {
  autoSquash,
  resultCount,
  rowsFromPlan,
  startBlock,
  toSteps,
  useRebaseUi,
  type RebaseRow,
  type RowAction,
  type StartBlock,
} from "./rebaseState";
import "./rebase.css";
import { BasePicker } from "./BasePicker";

const ACTIONS: RowAction[] = ["pick", "reword", "squash", "fixup", "drop"];
/** Only our own row drags reorder (text dragged in from elsewhere is ignored). */
const ROW_DRAG_TYPE = "application/x-branchwork-rebase-row";
const blockKeys: Record<StartBlock, `rebase.block.${StartBlock}`> = {
  truncated: "rebase.block.truncated",
  merge: "rebase.block.merge",
  firstSquash: "rebase.block.firstSquash",
  allDropped: "rebase.block.allDropped",
  emptyMessage: "rebase.block.emptyMessage",
};

/** Toasts and state for a Start or Continue outcome. Returns whether the rebase finished. */
export function announce(worktree: string, outcome: RebaseOutcome): boolean {
  if (outcome.status === "conflict") {
    toast({
      title: t("rebase.conflictToast"),
      icon: "!",
      action: { label: t("conflicts.resolveAction"), run: () => useStage.getState().go("conflicts") },
    });
    return false;
  }
  toast(outcome.undoable
    ? { title: t("rebase.doneToast"), icon: "↕", action: { label: t("toast.undo"), undo: true, enabled: true, run: () => undoLast(worktree) } }
    : { title: t("rebase.doneToast"), icon: "↕" });
  // Shared by Start and Continue: clear the base; a pushed branch gets the lease-push offer.
  useRebaseUi.getState().finished(worktree);
  return true;
}

export function RebaseToolbar() {
  const branch = useWorktrees((state) => state.worktrees.find((item) => item.path === state.activePath)?.branch ?? null);
  return (
    <h1 className="pane-title">
      {t("rebase.title")}
      {branch && <span className="rebase-subtitle mono">{branch}</span>}
    </h1>
  );
}

function InProgress({ worktree, conflicted }: { worktree: string; conflicted: number }) {
  const [busy, setBusy] = useState(false);
  const continueRebase = async () => {
    if (!beginGitWrite(worktree, "rebase")) return;
    setBusy(true);
    try {
      announce(worktree, await rebaseContinue(worktree));
    } catch (error) {
      showGitError(worktree, t("rebase.continue"), error);
    } finally {
      endGitWrite(worktree);
      reloadWorktreesFor(worktree);
      void useConflicts.getState().load(worktree);
      setBusy(false);
    }
  };
  const abort = async () => {
    const confirmed = await ask({ title: t("rebase.abortTitle"), body: t("rebase.abortBody"), ok: t("rebase.abort"), danger: true, icon: "↶" });
    if (confirmed !== true) return;
    if (await runGitAction(worktree, t("rebase.abort"), () => rebaseAbort(worktree))) useRebaseUi.getState().forget(worktree);
    void useConflicts.getState().load(worktree);
  };
  return (
    <div className="rebase-state" role="status">
      <h2>{t("rebase.inProgress")}</h2>
      <p className="rebase-muted">{conflicted > 0 ? t("rebase.inProgressConflicts", { count: conflicted }) : t("rebase.inProgressBody")}</p>
      <div className="rebase-actions">
        {conflicted > 0 && <button className="btn" onClick={() => useStage.getState().go("conflicts")}>{t("conflicts.resolveAction")}</button>}
        <button className="btn primary" disabled={busy || conflicted > 0} onClick={() => void continueRebase()}>{t("rebase.continue")}</button>
        <button className="btn" disabled={busy} onClick={() => void abort()}>{t("rebase.abort")}</button>
      </div>
    </div>
  );
}

function Row({ row, index, count, update, move }: {
  row: RebaseRow;
  index: number;
  count: number;
  update(patch: Partial<RebaseRow>): void;
  move(from: number, to: number): void;
}) {
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    const data = event.dataTransfer.getData(ROW_DRAG_TYPE);
    if (data !== "" && Number.isInteger(Number(data))) move(Number(data), index);
  };
  return (
    <li
      className={"rebase-row" + (row.action === "drop" ? " dropped" : "")}
      draggable
      onDragStart={(event) => event.dataTransfer.setData(ROW_DRAG_TYPE, String(index))}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      aria-label={row.subject}
    >
      <span className="rebase-handle" aria-hidden>⋮⋮</span>
      <select
        className={`input rebase-action act-${row.action}`}
        aria-label={t("rebase.actionFor", { sha: row.shortSha })}
        value={row.action}
        onChange={(event) => update({ action: event.target.value as RowAction })}
      >
        {ACTIONS.map((action) => <option key={action} value={action}>{t(`rebase.action.${action}`)}</option>)}
      </select>
      <div className="rebase-msg">
        {row.action === "reword" ? (
          <input className="input" aria-label={t("rebase.messageFor", { sha: row.shortSha })} value={row.message} onChange={(event) => update({ message: event.target.value })} />
        ) : row.subject}
      </div>
      <span className="rebase-who">{row.author}</span>
      <span className="rebase-sha mono">{row.shortSha}</span>
      <span className="rebase-move">
        <button type="button" className="icon-btn" aria-label={t("rebase.moveUp", { sha: row.shortSha })} disabled={index === 0} onClick={() => move(index, index - 1)}>↑</button>
        <button type="button" className="icon-btn" aria-label={t("rebase.moveDown", { sha: row.shortSha })} disabled={index === count - 1} onClick={() => move(index, index + 1)}>↓</button>
      </span>
    </li>
  );
}

export function RebaseView() {
  const worktree = useWorktrees((state) => state.activePath);
  const chosen = useRebaseUi((state) => state.base);
  const base = chosen && chosen.worktree === worktree ? chosen.sha : null;
  const needsLeasePush = useRebaseUi((state) => worktree !== null && state.needsLeasePush[worktree] === true);
  const operation = useConflicts((state) => (state.worktree === worktree ? state.list?.operation : undefined));
  const conflicted = useConflicts((state) => (state.worktree === worktree ? state.list?.files.length ?? 0 : 0));
  const [plan, setPlan] = useState<RebasePlan | null>(null);
  const [rows, setRows] = useState<RebaseRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ step: number; total: number } | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    setPlan(null);
    setRows([]);
    setError(null);
    if (!worktree || !base) return;
    let live = true;
    rebasePlan(worktree, base)
      .then((loaded) => { if (live) { setPlan(loaded); setRows(rowsFromPlan(loaded)); } })
      .catch((reason: unknown) => { if (live) setError(errorMessage(reason)); });
    return () => { live = false; };
  }, [worktree, base]);

  useEffect(() => {
    if (!worktree) return;
    let stop: (() => void) | undefined;
    let disposed = false;
    void onRebaseProgress((event) => {
      if (event.worktreePath === worktree) setProgress({ step: event.step, total: event.total });
    }).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; }).catch(() => undefined);
    return () => { disposed = true; stop?.(); };
  }, [worktree]);

  if (!worktree) return <div className="rebase-state"><p>{t("rebase.noWorktree")}</p></div>;
  if (operation === "rebase") return <InProgress worktree={worktree} conflicted={conflicted} />;
  if (needsLeasePush) {
    const pushLease = async () => {
      const confirmed = await ask({ title: t("rebase.leaseTitle"), body: t("rebase.leaseBody"), ok: t("rebase.leaseOk"), danger: true, icon: "↑" });
      if (confirmed !== true) return;
      if (await runGitAction(worktree, t("rebase.leaseOk"), () => gitPushForceWithLease(worktree))) {
        useRebaseUi.getState().clearLeasePush(worktree);
      }
    };
    return (
      <div className="rebase-state" role="status">
        <h2>{t("rebase.doneToast")}</h2>
        <p className="rebase-muted">{t("rebase.pushedAfter")}</p>
        <div className="rebase-actions">
          <button className="btn primary" onClick={() => void pushLease()}>{t("rebase.leaseOk")}</button>
          <button className="btn" onClick={() => { useRebaseUi.getState().clearLeasePush(worktree); openHistory("graph"); }}>{t("rebase.openGraph")}</button>
        </div>
      </div>
    );
  }
  if (!base) return <BasePicker worktree={worktree} />;
  if (error) return <div className="rebase-state" role="alert"><p>{error}</p></div>;
  if (!plan) return <ScreenLoader>{t("rebase.loading")}</ScreenLoader>;

  const block = startBlock(plan, rows);
  const update = (index: number) => (patch: Partial<RebaseRow>) =>
    setRows((current) => current.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  const move = (from: number, to: number) =>
    setRows((current) => {
      if (to < 0 || to >= current.length || from === to) return current;
      const next = [...current];
      const [row] = next.splice(from, 1);
      next.splice(to, 0, row);
      return next;
    });
  const start = async () => {
    if (!beginGitWrite(worktree, "rebase")) return;
    setRunning(true);
    useRebaseUi.getState().started(worktree, plan.pushed);
    try {
      announce(worktree, await rebaseInteractive(worktree, { base: plan.base, steps: toSteps(rows) }));
    } catch (reason) {
      useRebaseUi.getState().forget(worktree);
      showGitError(worktree, t("rebase.start"), reason);
    } finally {
      endGitWrite(worktree);
      reloadWorktreesFor(worktree);
      void useConflicts.getState().load(worktree);
      setRunning(false);
      setProgress(null);
    }
  };

  return (
    <div className="rebase">
      <div className="rebase-list-pane">
        <div className="rebase-bar">
          <span className="rebase-muted">{t("rebase.hint")}</span>
          <button className="btn sm" onClick={() => setRows(autoSquash(rows))}>{t("rebase.autoSquash")}</button>
          <button className="btn sm" disabled title={t("ui.deferred_m7")}>{t("rebase.aiAutoSquash")}</button>
          <button className="btn primary" disabled={block !== null || running} title={block ? t(blockKeys[block]) : undefined} onClick={() => void start()}>
            {running ? t("rebase.running", { step: progress?.step ?? 1, total: progress?.total ?? rows.length }) : t("rebase.start")}
          </button>
        </div>
        {block && <p className="rebase-block" role="status">{t(blockKeys[block])}</p>}
        <ol className="rebase-list">
          {rows.map((row, index) => (
            <Row key={row.sha} row={row} index={index} count={rows.length} update={update(index)} move={move} />
          ))}
        </ol>
      </div>
      <aside className="rebase-side" aria-label={t("rebase.summary")}>
        <h4>{t("rebase.result")}</h4>
        <div className="rebase-count">{t("rebase.resultCount", { count: resultCount(rows), total: rows.length })}</div>
        <h4>{t("rebase.preview")}</h4>
        <ul className="rebase-preview">
          {rows.filter((row) => row.action !== "drop").map((row) => (
            <li key={row.sha} className={row.action === "squash" || row.action === "fixup" ? "melded" : ""}>
              {row.action === "squash" || row.action === "fixup" ? t("rebase.melded") : row.action === "reword" ? row.message : row.subject}
            </li>
          ))}
        </ul>
        {plan.pushed && <p className="rebase-warning" role="note">{t("rebase.pushedWarning")}</p>}
        <p className="rebase-muted">{t("rebase.backupNote")}</p>
      </aside>
    </div>
  );
}
