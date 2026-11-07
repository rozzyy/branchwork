import { commands, type StatusSummary } from "./bindings";

export type { StatusEntry, StatusSummary } from "./bindings";

export function readStatus(worktreePath: string): Promise<StatusSummary> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return Promise.reject(new Error("Reading worktree status requires the desktop app"));
  }
  return commands.status(worktreePath);
}
