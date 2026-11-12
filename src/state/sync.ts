import { t } from "../i18n/t";
import { gitFetch, gitPull, gitPush } from "../ipc/sync";
import { toast } from "../ui/toast";
import { beginGitWrite, endGitWrite, reloadWorktreesFor, showGitDone, showGitError, useGitBusy } from "./gitActions";

export type SyncOperation = "fetch" | "pull" | "push";

const labelKeys = { fetch: "sync.fetch", pull: "sync.pull", push: "sync.push" } as const;

/** Runs fetch / pull / push; refused while another git write runs in the same worktree. */
export async function runSync(worktreePath: string, operation: SyncOperation): Promise<boolean> {
  if (!beginGitWrite(worktreePath, operation)) return false;
  const action = t(labelKeys[operation]);
  try {
    if (operation === "pull") {
      const undoable = await gitPull(worktreePath);
      if (undoable) showGitDone(worktreePath, action, true);
      else toast({ title: t("sync.upToDate"), icon: "✓" });
    } else {
      await (operation === "fetch" ? gitFetch(worktreePath) : gitPush(worktreePath));
      showGitDone(worktreePath, action);
    }
    return true;
  } catch (error) {
    showGitError(worktreePath, action, error);
    return false;
  } finally {
    endGitWrite(worktreePath);
    reloadWorktreesFor(worktreePath);
  }
}

/** The git write running in `worktreePath`, if any. */
export function useGitRunning(worktreePath: string | null): string | undefined {
  return useGitBusy((state) => (worktreePath ? state.running[worktreePath] : undefined));
}
