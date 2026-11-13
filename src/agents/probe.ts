import type { CliId } from "./registry";

/**
 * Vendor status probes (spec §6.6.4, "best effort ... shown only when the
 * CLI exposes them"). Shapes below were verified against the real CLIs on
 * the dev host; every field is validated and anything else yields null —
 * Branchwork never fabricates usage numbers or account labels.
 */

/** CLIs with a verified machine-readable probe command. */
export const PROBED_CLIS: CliId[] = ["claude", "muse"];

export interface ClaudeAuth {
  loggedIn: boolean;
  email: string | null;
}

/** Parse `claude auth status --json`. Null when the shape is unknown. */
export function parseClaudeAuth(raw: string): ClaudeAuth | null {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof root !== "object" || root === null) return null;
  const loggedIn = (root as Record<string, unknown>).loggedIn;
  if (typeof loggedIn !== "boolean") return null;
  const email = (root as Record<string, unknown>).email;
  return { loggedIn, email: typeof email === "string" && email.length > 0 ? email : null };
}

/** "resets in 2h 5m" / "resets in 12m" for a remaining duration in ms. */
export function resetLabel(remainingMs: number): string {
  const minutes = Math.floor(Math.max(0, remainingMs) / 60000);
  const hours = Math.floor(minutes / 60);
  return hours >= 1 ? `resets in ${hours}h ${minutes % 60}m` : `resets in ${minutes}m`;
}

export interface MuseUsage {
  /** Human window label derived from the probe, e.g. "resets in 19h 12m". */
  window: string;
  /** 0–100 from the vendor's own `usedPercent`. */
  percent: number;
}

/** Parse `muse usage --json`. Null when logged out or on unknown shapes. */
export function parseMuseUsage(raw: string): MuseUsage | null {
  let root: unknown;
  try {
    root = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof root !== "object" || root === null) return null;
  const allowance = (root as Record<string, unknown>).allowance;
  if (typeof allowance !== "object" || allowance === null) return null;
  const fields = allowance as Record<string, unknown>;
  const windowValue = fields.window;
  if (typeof windowValue !== "object" || windowValue === null) return null;
  const windowFields = windowValue as Record<string, unknown>;
  const percent = windowFields.usedPercent;
  const resetsAt = windowFields.resetsAtMs;
  if (typeof percent !== "number" || !Number.isFinite(percent)) return null;
  if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt)) return null;
  const asOf = typeof fields.asOfMs === "number" ? fields.asOfMs : Date.now();
  return {
    window: resetLabel(resetsAt - asOf),
    percent: Math.min(100, Math.max(0, Math.round(percent))),
  };
}
