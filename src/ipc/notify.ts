// Typed wrappers for the agent status notification path (spec §6.6.3).
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { commands } from "./bindings";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Status event forwarded by hooks through the notify socket sidecar. */
export interface AgentStatusEvent {
  sessionId: string;
  event: "waiting" | "done";
}

/** Absolute path of the notify socket hook sidecars should dial. */
export function notifySocketPath(): Promise<string> {
  if (!inTauri()) {
    return Promise.reject(new Error("Agent notifications require the desktop app"));
  }
  return commands.notifySocketPath();
}

/** Merge agent hook entries into the isolated profile dir (best-effort). */
export function ensureAgentHooks(cliId: string, profileDir: string): Promise<boolean> {
  if (!inTauri()) {
    return Promise.reject(new Error("Agent hooks require the desktop app"));
  }
  return commands.cliEnsureHooks(cliId, profileDir);
}

/** Subscribe to hook-reported agent status events. */
export function onAgentStatus(callback: (event: AgentStatusEvent) => void): Promise<UnlistenFn> {
  return listen<AgentStatusEvent>("agent:status", (event) => callback(event.payload));
}

/**
 * Fire a macOS notification, but only while the app is unfocused. Focused
 * sessions already surface the in-app toast. Never throws.
 */
export async function notifyWhenUnfocused(title: string, body?: string): Promise<boolean> {
  if (typeof document !== "undefined" && document.hasFocus()) return false;
  try {
    if (!(await isPermissionGranted())) {
      if ((await requestPermission()) !== "granted") return false;
    }
    sendNotification({ title, body });
    return true;
  } catch {
    return false;
  }
}
