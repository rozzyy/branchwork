// Typed wrappers for the handover backend commands (spec §6.6.5).
import { commands } from "./bindings";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Write `.branchwork/handover.md` and ensure the git-exclude entry. */
export function writeHandoverNote(worktreePath: string, note: string): Promise<boolean> {
  if (!inTauri()) {
    return Promise.reject(new Error("Writing handover notes requires the desktop app"));
  }
  return commands.agentWriteHandover(worktreePath, note);
}

/** Capped `git diff HEAD` text of the worktree for handover notes. */
export function readHandoverDiff(worktreePath: string): Promise<string> {
  if (!inTauri()) {
    return Promise.reject(new Error("Reading handover diffs requires the desktop app"));
  }
  return commands.agentHandoverDiff(worktreePath);
}
