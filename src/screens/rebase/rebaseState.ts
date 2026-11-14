import { create } from "zustand";
import type { RebasePlan } from "../../ipc/rebase";
import type { RebaseStep } from "../../ipc/bindings";

export type RowAction = "pick" | "reword" | "squash" | "fixup" | "drop";

export interface RebaseRow {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  action: RowAction;
  /** The reword message (prefilled with the subject). */
  message: string;
}

interface RebaseUi {
  /** The commit "Rebase from here" was chosen on, for the worktree it was chosen in. */
  base: { worktree: string; sha: string } | null;
  /** Worktrees whose running rebase rewrites an already-pushed branch (kept for Continue). */
  pushed: Record<string, true>;
  /** Worktrees whose pushed branch finished rebasing: offer the force-with-lease push. */
  needsLeasePush: Record<string, true>;
  setBase(worktree: string, sha: string): void;
  started(worktree: string, pushed: boolean): void;
  /** Start failed or the rebase was aborted: nothing to push. */
  forget(worktree: string): void;
  /** A rebase (Start or Continue) reached done in `worktree`. */
  finished(worktree: string): void;
  clearLeasePush(worktree: string): void;
}

export const useRebaseUi = create<RebaseUi>((set, get) => ({
  base: null,
  pushed: {},
  needsLeasePush: {},
  setBase: (worktree, sha) => {
    const { [worktree]: _offer, ...needsLeasePush } = get().needsLeasePush;
    set({ base: { worktree, sha }, needsLeasePush });
  },
  started: (worktree, pushed) => {
    const { [worktree]: _previous, ...rest } = get().pushed;
    set({ pushed: pushed ? { ...rest, [worktree]: true } : rest });
  },
  forget: (worktree) => {
    const { [worktree]: _pushed, ...pushed } = get().pushed;
    set({ pushed });
  },
  finished: (worktree) => {
    const { base, needsLeasePush } = get();
    const { [worktree]: wasPushed, ...pushed } = get().pushed;
    set({
      base: base?.worktree === worktree ? null : base,
      needsLeasePush: wasPushed ? { ...needsLeasePush, [worktree]: true } : needsLeasePush,
      pushed,
    });
  },
  clearLeasePush: (worktree) => {
    const { [worktree]: _offer, ...needsLeasePush } = get().needsLeasePush;
    set({ needsLeasePush });
  },
}));

export function rowsFromPlan(plan: RebasePlan): RebaseRow[] {
  return plan.commits.map((commit) => ({
    sha: commit.sha,
    shortSha: commit.shortSha,
    subject: commit.subject,
    author: commit.authorName ?? commit.authorEmail ?? "",
    action: "pick",
    message: commit.subject,
  }));
}

/** `fixup! squash! x` → { kind: "fixup", target: "x" } (git's outermost prefix wins). */
function squashTarget(subject: string): { kind: "fixup" | "squash"; target: string } | null {
  const first = /^(fixup|squash)! /.exec(subject);
  if (!first) return null;
  let target = subject;
  while (/^(fixup|squash)! /.test(target)) target = target.replace(/^(fixup|squash)! /, "");
  return { kind: first[1] as "fixup" | "squash", target };
}

/** Moves each `fixup! X` / `squash! X` row right after the row whose subject is X, like git's
 * --autosquash. Rows without a target stay in place; rows the user dropped stay dropped. */
export function autoSquash(rows: RebaseRow[]): RebaseRow[] {
  const melds = new Map<RebaseRow, "fixup" | "squash">();
  for (const row of rows) {
    const found = squashTarget(row.subject);
    if (found && row.action !== "drop" && rows.some((other) => other !== row && other.action !== "drop" && !squashTarget(other.subject) && other.subject === found.target)) {
      melds.set(row, found.kind);
    }
  }
  const result = rows.filter((row) => !melds.has(row));
  for (const [row, kind] of melds) {
    const target = result.findIndex((other) => other.action !== "drop" && other.subject === squashTarget(row.subject)!.target);
    // After the target and any rows already melded into it.
    let at = target + 1;
    while (at < result.length && melds.has(result[at])) at++;
    result.splice(at, 0, { ...row, action: kind });
  }
  return result;
}

export type StartBlock = "truncated" | "merge" | "firstSquash" | "allDropped" | "emptyMessage";

/** Why Start is disabled, or null when the plan can run. */
export function startBlock(plan: RebasePlan, rows: RebaseRow[]): StartBlock | null {
  if (plan.truncated) return "truncated";
  if (plan.commits.some((commit) => commit.isMerge)) return "merge";
  const kept = rows.filter((row) => row.action !== "drop");
  if (kept.length === 0) return "allDropped";
  if (kept[0].action === "squash" || kept[0].action === "fixup") return "firstSquash";
  if (rows.some((row) => row.action === "reword" && !row.message.trim())) return "emptyMessage";
  return null;
}

/** Commits that remain after the rebase (pick + reword). */
export function resultCount(rows: RebaseRow[]): number {
  return rows.filter((row) => row.action === "pick" || row.action === "reword").length;
}

export function toSteps(rows: RebaseRow[]): RebaseStep[] {
  return rows.map((row) => ({
    sha: row.sha,
    action: row.action === "reword" ? { kind: "reword", message: row.message } : { kind: row.action },
  }));
}
