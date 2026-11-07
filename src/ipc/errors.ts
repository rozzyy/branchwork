import type { AppError_Serialize } from "./bindings";

export type AppError = AppError_Serialize;

/** Reads a human-readable message out of a rejected IPC call: a typed `AppError` from a
 * command, a plain `Error` (e.g. a browser-fallback rejection), or anything else. */
export function errorMessage(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    const message = (e as { message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return e instanceof Error ? e.message : String(e);
}
