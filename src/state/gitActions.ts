import { create } from "zustand";
import { t } from "../i18n/t";
import { errorMessage, type AppError } from "../ipc/errors";
import { undoLast } from "../ipc/undo";
import { useDock } from "../terminal/dock";
import { useStage } from "./stage";
import { toast } from "../ui/toast";
import { useRepos } from "./repos";
import { useWorktrees } from "./worktrees";

/** The git write in flight per worktree path (a sync operation name, or "local"). One write per
 * worktree at a time keeps the oplog's latest entry the one the visible Undo refers to. */
export const useGitBusy = create<{ running: Record<string, string> }>(() => ({ running: {} }));

export function beginGitWrite(worktreePath: string, operation: string): boolean {
  const { running } = useGitBusy.getState();
  if (running[worktreePath]) return false;
  useGitBusy.setState({ running: { ...running, [worktreePath]: operation } });
  return true;
}

export function endGitWrite(worktreePath: string): void {
  const { [worktreePath]: _done, ...rest } = useGitBusy.getState().running;
  useGitBusy.setState({ running: rest });
}

function asAppError(error: unknown): Partial<AppError> {
  return typeof error === "object" && error !== null ? (error as Partial<AppError>) : {};
}

/** Failure toast for a git CLI write: stderr behind "Show details", and a terminal for auth. */
export function showGitError(worktreePath: string, action: string, error: unknown): void {
  const appError = asAppError(error);
  toast({
    title: t("git.actionFailed", { action, message: errorMessage(error) }),
    icon: "!",
    details: appError.detail ?? undefined,
    action: appError.kind === "gitAuth"
      ? { label: t("sync.openTerminalAuth"), run: () => void useDock.getState().openHere(worktreePath) }
      : appError.kind === "gitConflict"
        ? { label: t("conflicts.resolveAction"), run: () => useStage.getState().go("conflicts") }
        : undefined,
  });
}

/** Success toast; `undoable` adds an Undo action for the worktree's latest oplog entry. */
export function showGitDone(worktreePath: string, action: string, undoable = false): void {
  toast(undoable
    ? {
        title: t("git.actionDone", { action }),
        icon: "✓",
        action: { label: t("toast.undo"), undo: true, enabled: true, run: () => undoLast(worktreePath) },
      }
    : { title: t("git.actionDone", { action }), icon: "✓" });
}

/** Branch and ahead/behind live on the worktree list; refetch it once after a write. */
export function reloadWorktreesFor(worktreePath: string): void {
  const repos = useRepos.getState();
  const project = repos.projects.find((item) => item.id === repos.activeProjectId) ?? null;
  const worktrees = useWorktrees.getState();
  if (project && worktrees.projectId === project.id && worktrees.worktrees.some((item) => item.path === worktreePath)) {
    void worktrees.load(project);
  }
}

/** Runs a local git write (checkout, branch, cherry-pick, revert) with the shared toasts. */
export async function runGitAction(
  worktreePath: string,
  action: string,
  write: () => Promise<boolean | void>,
  /** Called with the typed error after the failure toast (not when another write is running). */
  onError?: (error: Partial<AppError>) => void,
): Promise<boolean> {
  if (!beginGitWrite(worktreePath, "local")) return false;
  try {
    const undoable = await write();
    showGitDone(worktreePath, action, undoable === true);
    return true;
  } catch (error) {
    showGitError(worktreePath, action, error);
    onError?.(asAppError(error));
    return false;
  } finally {
    endGitWrite(worktreePath);
    reloadWorktreesFor(worktreePath);
  }
}
