// Typed wrappers for agent profile quota and measured saver savings.
import { commands, type ProfileQuota, type SaverStats } from "./bindings";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Provider-reported quota windows for one profile, from the CLI's local state. */
export function readProfileQuota(cliId: string, profileDir: string): Promise<ProfileQuota> {
  if (!inTauri()) return Promise.reject(new Error("Usage requires the desktop app"));
  return commands.agentProfileQuota(cliId, profileDir);
}

/** Measured RTK-style byte savings recorded for one agent session. */
export function readSaverStats(agentId: string): Promise<SaverStats> {
  if (!inTauri()) return Promise.reject(new Error("Saver stats require the desktop app"));
  return commands.agentSaverStats(agentId);
}
