// Token-saver methods per agent session (spec: agent session usage and token
// saver). Branchwork owns both methods; no external service is involved.
// RTK-style compression runs through the `branchwork-saver` PreToolUse hook,
// Caveman-style brevity through a session-scoped system-prompt addition.
// Only Claude Code exposes both integration points today.
import type { CliId } from "./registry";

export type SaverId = "rtk" | "caveman";
export type SaverState = "active" | "off" | "unavailable" | "unsupported";
export type SessionSavers = Record<SaverId, SaverState>;

export const SAVER_IDS: SaverId[] = ["rtk", "caveman"];

/** Limited to answer length: it must never relax correctness or user requirements. */
export const CAVEMAN_PROMPT =
  "Answer tersely: drop filler, pleasantries and hedging; fragments are fine. " +
  "Keep code, commands, paths, identifiers and error text exact. " +
  "Brevity never overrides correctness, security, validation, or explicit user instructions.";

const CAVEMAN_FLAG = "--append-system-prompt";

function quoteArg(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function saverSupport(cliId: CliId): Record<SaverId, boolean> {
  const claude = cliId === "claude";
  return { rtk: claude, caveman: claude };
}

/**
 * Per-session saver state. `rtkReady` is true only when the hook sidecar
 * confirmed installation for this session's profile.
 */
export function sessionSavers(cliId: CliId, enabled: boolean, rtkReady: boolean): SessionSavers {
  const support = saverSupport(cliId);
  const state = (id: SaverId, ready: boolean): SaverState =>
    !support[id] ? "unsupported" : !enabled ? "off" : ready ? "active" : "unavailable";
  return { rtk: state("rtk", rtkReady), caveman: state("caveman", true) };
}

/** Launch argv with the concise-answer instruction (Claude only). */
export function withCaveman(cliId: CliId, argv: string[]): string[] {
  return saverSupport(cliId).caveman ? [...argv, CAVEMAN_FLAG, CAVEMAN_PROMPT] : argv;
}

/** Raw resume line with the instruction on the resume and its fallback. */
export function cavemanResumeLine(cliId: CliId, line: string): string {
  if (!saverSupport(cliId).caveman) return line;
  const flag = `${CAVEMAN_FLAG} ${quoteArg(CAVEMAN_PROMPT)}`;
  return line
    .split(" || ")
    .map((part) => `${part} ${flag}`)
    .join(" || ");
}
