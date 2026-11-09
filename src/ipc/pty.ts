import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  commands,
  type PtyErrorEvent,
  type PtyExit,
  type PtyOutput,
  type PtySession,
} from "./bindings";

export type { PtyErrorEvent, PtyExit, PtyOutput, PtySession } from "./bindings";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function spawnTerminal(
  worktreePath: string,
  columns: number,
  rows: number,
  env?: Record<string, string>,
): Promise<PtySession> {
  if (!inTauri()) {
    return Promise.reject(new Error("Starting a terminal requires the desktop app"));
  }
  return commands.ptySpawn(worktreePath, columns, rows, env ?? null);
}

export function writeTerminal(sessionId: string, data: Uint8Array): Promise<void> {
  if (!inTauri()) {
    return Promise.reject(new Error("Writing to a terminal requires the desktop app"));
  }
  return commands.ptyWrite(sessionId, Array.from(data)).then(() => undefined);
}

export function resizeTerminal(
  sessionId: string,
  columns: number,
  rows: number,
): Promise<void> {
  if (!inTauri()) {
    return Promise.reject(new Error("Resizing a terminal requires the desktop app"));
  }
  return commands.ptyResize(sessionId, columns, rows).then(() => undefined);
}

export function attachTerminal(sessionId: string, attachmentId: number): Promise<void> {
  if (!inTauri()) {
    return Promise.reject(new Error("Attaching a terminal requires the desktop app"));
  }
  return commands.ptyAttach(sessionId, attachmentId).then(() => undefined);
}

export function detachTerminal(sessionId: string, attachmentId: number): Promise<void> {
  if (!inTauri()) {
    return Promise.reject(new Error("Detaching a terminal requires the desktop app"));
  }
  return commands.ptyDetach(sessionId, attachmentId).then(() => undefined);
}

export function closeTerminal(sessionId: string): Promise<void> {
  if (!inTauri()) {
    return Promise.reject(new Error("Closing a terminal requires the desktop app"));
  }
  return commands.ptyClose(sessionId).then(() => undefined);
}

/**
 * Stop a session gracefully: SIGINT, wait up to `graceMs`, then force-close.
 * Resolves true when the process exited on its own in time.
 */
export function stopTerminal(sessionId: string, graceMs: number): Promise<boolean> {
  if (!inTauri()) {
    return Promise.reject(new Error("Stopping a terminal requires the desktop app"));
  }
  return commands.ptyStop(sessionId, graceMs);
}

export function onTerminalOutput(callback: (event: PtyOutput) => void): Promise<UnlistenFn> {
  return listen<PtyOutput>("pty:output", (event) => callback(event.payload));
}

export function onTerminalExit(callback: (event: PtyExit) => void): Promise<UnlistenFn> {
  return listen<PtyExit>("pty:exit", (event) => callback(event.payload));
}

export function onTerminalError(callback: (event: PtyErrorEvent) => void): Promise<UnlistenFn> {
  return listen<PtyErrorEvent>("pty:error", (event) => callback(event.payload));
}
