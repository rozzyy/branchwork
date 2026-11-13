// Typed wrappers for agent session usage and measured saver savings.
import { commands, type SaverStats, type SessionUsage } from "./bindings";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Token usage for one pane from the CLI's local session log (numbers only). */
export function readSessionUsage(
  cliId: string,
  profileDir: string,
  worktreePath: string,
  sinceMs: number,
): Promise<SessionUsage> {
  if (!inTauri()) return Promise.reject(new Error("Session usage requires the desktop app"));
  return commands.agentSessionUsage(cliId, profileDir, worktreePath, sinceMs);
}

/** Measured RTK-style byte savings recorded for one agent session. */
export function readSaverStats(agentId: string): Promise<SaverStats> {
  if (!inTauri()) return Promise.reject(new Error("Saver stats require the desktop app"));
  return commands.agentSaverStats(agentId);
}
