// Typed wrappers for carrying an agent conversation across profiles (M8).
import { commands } from "./bindings";

const inTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * Copy one transcript from `fromSlug` to `toSlug` (same CLI). False when a
 * Claude pane has no transcript yet; a missing Codex rollout rejects.
 */
export function copyConversation(
  cliId: "claude" | "codex",
  fromSlug: string,
  toSlug: string,
  conversationId: string,
): Promise<boolean> {
  if (!inTauri()) {
    return Promise.reject(new Error("Copying conversations requires the desktop app"));
  }
  return commands.agentCopyConversation(cliId, fromSlug, toSlug, conversationId);
}

/** The one Codex rollout for `worktreePath` touched since `sinceMs`, or null. */
export function findCodexConversation(
  slug: string,
  worktreePath: string,
  sinceMs: number,
  exclude: string[],
): Promise<string | null> {
  if (!inTauri()) {
    return Promise.reject(new Error("Finding Codex conversations requires the desktop app"));
  }
  return commands.agentFindCodexConversation(slug, worktreePath, Math.max(0, Math.floor(sinceMs)), exclude);
}
