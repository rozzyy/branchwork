import { useState } from "react";
import { t } from "../../i18n/t";
import {
  conflictAbort,
  conflictContinue,
  conflictResolve,
  type ConflictFile,
  type ConflictOperation,
  type ConflictRegion,
  type ConflictSummaryReason,
  type RegionChoice,
} from "../../ipc/conflicts";
import { runGitAction } from "../../state/gitActions";
import { useStage } from "../../state/stage";
import { useWorktrees } from "../../state/worktrees";
import { useDock } from "../../terminal/dock";
import { ask } from "../../ui/dialog";
import { ScreenLoader } from "../../ui/ScreenLoader";
import { useConflictWatch, useConflicts } from "./conflictsState";
import "./conflicts.css";

type Region = Extract<ConflictRegion, { kind: "conflict" }>;

const operationKeys = {
  merge: "conflicts.operation.merge",
  cherryPick: "conflicts.operation.cherryPick",
  revert: "conflicts.operation.revert",
  rebase: "conflicts.operation.rebase",
  none: "conflicts.operation.merge",
} as const;

const summaryKeys = {
  binary: "conflicts.summary.binary",
  tooLarge: "conflicts.summary.tooLarge",
  deletedByUs: "conflicts.summary.deletedByUs",
  deletedByThem: "conflicts.summary.deletedByThem",
  tooManyConflicts: "conflicts.summary.tooManyConflicts",
  symlink: "conflicts.summary.symlink",
  submodule: "conflicts.summary.submodule",
  notUtf8: "conflicts.summary.notUtf8",
  markerLike: "conflicts.summary.markerLike",
} as const satisfies Record<ConflictSummaryReason, string>;

/** Operations this screen can finish or abort (rebase belongs to the Rebase screen). */
const finishable = (operation: ConflictOperation | undefined) =>
  operation === "merge" || operation === "cherryPick" || operation === "revert";

function lines(text: string): string[] {
  if (!text) return [];
  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function chosenText(region: Region, choice: RegionChoice | undefined): string | null {
  switch (choice?.kind) {
    case "ours":
      return region.ours;
    case "theirs":
      return region.theirs;
    case "both":
      return region.ours + region.theirs;
    case "manual":
      return choice.text;
    default:
      return null;
  }
}

function Lines({ text, start }: { text: string; start: number }) {
  return (
    <>
      {lines(text).map((line, offset) => (
        <div className="conf-line" key={offset}>
          <i aria-hidden>{start + offset}</i>
          <span>{line}</span>
        </div>
      ))}
    </>
  );
}

/** Mounted once by App: keeps the active worktree's conflict list (sidebar badge) fresh. */
export function ConflictWatcher() {
  useConflictWatch();
  return null;
}

export function ConflictsToolbar() {
  const activePath = useWorktrees((state) => state.activePath);
  const branch = useWorktrees((state) => state.worktrees.find((item) => item.path === state.activePath)?.branch ?? null);
  const list = useConflicts((state) => (state.worktree === activePath ? state.list : null));
  const operation = list?.operation;
  const abort = async () => {
    if (!activePath || !finishable(operation)) return;
    const name = t(operationKeys[operation!]).toLowerCase();
    const confirmed = await ask({
      title: t("conflicts.abortTitle", { operation: name }),
      body: t("conflicts.abortBody", { operation: name }),
      ok: t("conflicts.abort"),
      danger: true,
      icon: "↶",
    });
    if (confirmed !== true) return;
    await runGitAction(activePath, t("conflicts.abort"), () => conflictAbort(activePath));
    void useConflicts.getState().load(activePath);
  };
  return (
    <>
      <h1 className="pane-title">
        {t("conflicts.title")}
        {branch && (
          <span className="conf-subtitle mono">
            {branch}
            {operation && operation !== "none" ? ` · ${t(operationKeys[operation])}` : ""}
          </span>
        )}
      </h1>
      <div className="pane-actions conf-toolbar-actions">
        {list && list.files.length > 0 && (
          <span className="chip conf-remaining" role="status">
            {t(list.truncated ? "conflicts.remainingMore" : "conflicts.remaining", { count: list.files.length })}
          </span>
        )}
        <button className="btn sm" disabled={!activePath} onClick={() => { if (activePath) void useDock.getState().openHere(activePath); }}>
          {t("conflicts.terminal")}
        </button>
        {finishable(operation) && (
          <button className="btn sm" onClick={() => void abort()}>{t("conflicts.abort")}</button>
        )}
      </div>
    </>
  );
}

function SummaryPanel({ worktree, file }: { worktree: string; file: ConflictFile }) {
  const summary = file.summary!;
  const deleted = file.kind === "deletedByUs" || file.kind === "deletedByThem";
  const resolveFile = (side: "ours" | "theirs" | "delete") =>
    void runGitAction(
      worktree,
      t("conflicts.saveAction"),
      () => conflictResolve(worktree, file.path, file.stamp, { kind: "file", side }),
      (error) => { if (error.kind === "conflict") void useConflicts.getState().select(file.path); },
    ).then((ok) => { if (ok) void useConflicts.getState().load(worktree); });
  const size = (bytes: number | null | undefined) => (bytes == null ? t("conflicts.deleted") : t("conflicts.bytes", { count: bytes }));
  return (
    <div className="conf-summary">
      <h2>{t(summaryKeys[summary.reason])}</h2>
      <p className="conf-muted">{t("conflicts.summarySizes", { ours: size(summary.oursBytes), theirs: size(summary.theirsBytes) })}</p>
      <div className="conf-summary-actions">
        {file.kind !== "deletedByUs" && <button className="btn" onClick={() => resolveFile("ours")}>{t("conflicts.useOursFile")}</button>}
        {file.kind !== "deletedByThem" && <button className="btn" onClick={() => resolveFile("theirs")}>{t("conflicts.useTheirsFile")}</button>}
        {deleted && <button className="btn" onClick={() => resolveFile("delete")}>{t("conflicts.acceptDeletion")}</button>}
      </div>
    </div>
  );
}

function ResultBlock({ region, choice, start }: { region: Region; choice: RegionChoice | undefined; start: number }) {
  const choose = useConflicts((state) => state.choose);
  const [editing, setEditing] = useState<string | null>(null);
  const text = chosenText(region, choice);
  if (editing !== null) {
    return (
      <div className="conf-hunk res">
        <textarea
          className="conf-edit mono"
          aria-label={t("conflicts.editLabel", { index: region.index + 1 })}
          value={editing}
          onChange={(event) => setEditing(event.target.value)}
          rows={Math.max(3, lines(editing).length + 1)}
        />
        <div className="conf-hunk-actions">
          <button className="btn sm primary" onClick={() => { choose(region.index, { kind: "manual", text: editing }); setEditing(null); }}>{t("conflicts.apply")}</button>
          <button className="btn sm" onClick={() => setEditing(null)}>{t("dialog.cancel")}</button>
        </div>
      </div>
    );
  }
  return (
    <div className={"conf-hunk " + (text === null ? "pend" : "res")} data-testid={`result-${region.index}`}>
      {text === null ? <div className="conf-pending">{t("conflicts.pending")}</div> : <Lines text={text} start={start} />}
      <div className="conf-hunk-actions">
        <button className="btn sm" onClick={() => choose(region.index, { kind: "ours" })}>{t("conflicts.useOurs")}</button>
        <button className="btn sm" onClick={() => choose(region.index, { kind: "both" })}>{t("conflicts.both")}</button>
        <button className="btn sm" onClick={() => choose(region.index, { kind: "theirs" })}>{t("conflicts.useTheirs")}</button>
        <button className="btn sm" onClick={() => setEditing(text ?? region.ours)}>{t("conflicts.edit")}</button>
      </div>
    </div>
  );
}

function Columns({ file }: { file: ConflictFile }) {
  const choices = useConflicts((state) => state.choices);
  const choose = useConflicts((state) => state.choose);
  let ours = 1;
  let theirs = 1;
  let result = 1;
  const rows = file.regions.map((region, key) => {
    if (region.kind === "context") {
      const start = { ours, theirs, result };
      const count = lines(region.text).length;
      ours += count;
      theirs += count;
      result += count;
      return (
        <div className="conf-row" key={key}>
          <div><Lines text={region.text} start={start.ours} /></div>
          <div><Lines text={region.text} start={start.result} /></div>
          <div><Lines text={region.text} start={start.theirs} /></div>
        </div>
      );
    }
    const choice = choices[region.index];
    const start = { ours, theirs, result };
    ours += lines(region.ours).length;
    theirs += lines(region.theirs).length;
    result += lines(chosenText(region, choice) ?? "").length;
    return (
      <div className="conf-row" key={key}>
        <div>
          <button
            type="button"
            className={"conf-hunk o" + (choice?.kind === "ours" ? " chosen" : "")}
            aria-label={t("conflicts.chooseOurs", { index: region.index + 1 })}
            onClick={() => choose(region.index, { kind: "ours" })}
          >
            <Lines text={region.ours} start={start.ours} />
          </button>
        </div>
        <div><ResultBlock region={region} choice={choice} start={start.result} /></div>
        <div>
          <button
            type="button"
            className={"conf-hunk t" + (choice?.kind === "theirs" ? " chosen" : "")}
            aria-label={t("conflicts.chooseTheirs", { index: region.index + 1 })}
            onClick={() => choose(region.index, { kind: "theirs" })}
          >
            <Lines text={region.theirs} start={start.theirs} />
          </button>
        </div>
      </div>
    );
  });
  return <div className="conf-columns">{rows}</div>;
}

export function ConflictsView() {
  const activePath = useWorktrees((state) => state.activePath);
  const { worktree, list, selected, file, choices, history, error } = useConflicts();
  const select = useConflicts((state) => state.select);
  const undo = useConflicts((state) => state.undo);

  if (!activePath) return <div className="conf-state"><p>{t("conflicts.noWorktree")}</p></div>;
  if (worktree !== activePath || !list) {
    return error ? <div className="conf-state" role="alert"><p>{error}</p></div> : <ScreenLoader>{t("conflicts.loading")}</ScreenLoader>;
  }

  const finish = () =>
    void runGitAction(activePath, t("conflicts.commitAction"), () => conflictContinue(activePath)).then((ok) => {
      void useConflicts.getState().load(activePath);
      if (ok) useStage.getState().go("graph");
    });
  const footer = (
    <div className="conf-footer">
      <button className="btn sm" disabled title={t("ui.deferred_m7")}>{t("conflicts.explain")}</button>
      {list.operation === "rebase" && <span className="conf-muted">{t("conflicts.rebaseNote")}</span>}
      <button className="btn primary" disabled={list.files.length > 0 || !finishable(list.operation)} onClick={finish}>
        {t("conflicts.markResolved")}
      </button>
    </div>
  );

  if (list.files.length === 0) {
    return (
      <div className="conf">
        <div className="conf-state">
          <h2>{list.operation === "none" ? t("conflicts.none") : t("conflicts.allResolved")}</h2>
          <p className="conf-muted">
            {list.operation === "none"
              ? t("conflicts.noneBody")
              : list.operation === "rebase"
                ? t("conflicts.rebaseNote")
                : t("conflicts.allResolvedBody", { operation: t(operationKeys[list.operation]).toLowerCase() })}
          </p>
        </div>
        {list.operation !== "none" && footer}
      </div>
    );
  }

  const conflictCount = file?.regions.filter((region) => region.kind === "conflict").length ?? 0;
  const unresolved = conflictCount - Object.keys(choices).length;
  const save = () => {
    if (!file) return;
    const ordered = file.regions
      .filter((region): region is Region => region.kind === "conflict")
      .map((region) => choices[region.index]!);
    // Only a stale stamp re-reads the file; other failures keep the user's choices.
    void runGitAction(
      activePath,
      t("conflicts.saveAction"),
      () => conflictResolve(activePath, file.path, file.stamp, { kind: "regions", choices: ordered }),
      (error) => { if (error.kind === "conflict") void select(file.path); },
    ).then((ok) => { if (ok) void useConflicts.getState().load(activePath); });
  };

  return (
    <div className="conf">
      <div className="conf-head">
        <div className="conf-tabs" role="tablist" aria-label={t("conflicts.files")}>
          {list.files.map((entry) => (
            <button
              key={entry.path}
              role="tab"
              aria-selected={entry.path === selected}
              className={"conf-tab" + (entry.path === selected ? " on" : "")}
              onClick={() => void select(entry.path)}
            >
              <span className="mono">{entry.path}</span>
              {entry.path === selected && file && !file.summary && unresolved > 0 && (
                <span className="chip conf-count">{t("conflicts.unresolvedCount", { count: unresolved })}</span>
              )}
            </button>
          ))}
        </div>
        <span className="conf-muted conf-hint">{t("conflicts.hint")}</span>
      </div>
      {!file ? (
        error ? <div className="conf-state" role="alert"><p>{error}</p></div> : <ScreenLoader>{t("conflicts.loading")}</ScreenLoader>
      ) : file.summary ? (
        <SummaryPanel worktree={activePath} file={file} />
      ) : (
        <>
          <div className="conf-captions">
            <div><span className="conf-dot o" aria-hidden />{t(list.operation === "rebase" ? "conflicts.oursRebase" : "conflicts.ours")}</div>
            <div><span className="conf-dot r" aria-hidden />{t("conflicts.result")}<span className="conf-muted mono">{file.path}</span></div>
            <div><span className="conf-dot t" aria-hidden />{t(list.operation === "rebase" ? "conflicts.theirsRebase" : "conflicts.theirs")}</div>
          </div>
          <div className="conf-body"><Columns file={file} /></div>
          <div className="conf-savebar">
            <span className="conf-muted">{t("conflicts.overwriteNote")}</span>
            <button className="btn sm" disabled={history.length === 0} onClick={undo}>{t("conflicts.undo")}</button>
            <button className="btn sm primary" disabled={unresolved > 0} onClick={save}>{t("conflicts.save")}</button>
          </div>
        </>
      )}
      {footer}
    </div>
  );
}
