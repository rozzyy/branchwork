import { describe, expect, it } from "vitest";
import { isInboxItemHidden, normalizeInboxState, pruneDismissedAgents } from "./inboxState";

describe("inbox state", () => {
  it("drops malformed, expired, and excessively distant snoozes", () => {
    const now = 1_800_000_000_000;
    expect(normalizeInboxState({
      dismissed: ["agent:agent-1:waiting", "invalid", 4],
      snoozedUntil: {
        "github:octocat:123": now + 60_000,
        "github:octocat:124": now - 1,
        "github:octocat:125": now + 31 * 24 * 60 * 60 * 1000,
        "github:octocat:126": "later",
      },
    }, now)).toEqual({
      dismissed: ["agent:agent-1:waiting"],
      snoozedUntil: { "github:octocat:123": now + 60_000 },
    });
  });

  it("hides snoozed or dismissed items and clears old agent-event dismissals", () => {
    const now = 1_800_000_000_000;
    const state = normalizeInboxState({
      dismissed: ["agent:agent-1:waiting"],
      snoozedUntil: { "github:octocat:123": now + 60_000 },
    }, now);
    expect(isInboxItemHidden("agent:agent-1:waiting", state, now)).toBe(true);
    expect(isInboxItemHidden("github:octocat:123", state, now)).toBe(true);
    expect(pruneDismissedAgents(state, new Set()).dismissed).toEqual([]);
  });
});
