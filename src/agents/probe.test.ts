import { describe, expect, it } from "vitest";
import { parseClaudeAuth, parseMuseUsage, PROBED_CLIS } from "./probe";

// Fixtures below are shape-only examples (redacted): they lock the parser
// against the verified vendor output without recording any real account.

describe("parseClaudeAuth", () => {
  it("reads the logged-in account", () => {
    expect(
      parseClaudeAuth(
        JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "you@example.com" }),
      ),
    ).toEqual({ loggedIn: true, email: "you@example.com" });
  });

  it("reports logged out without an email", () => {
    expect(parseClaudeAuth(JSON.stringify({ loggedIn: false, authMethod: "none" }))).toEqual({
      loggedIn: false,
      email: null,
    });
  });

  it("rejects garbage and wrong shapes", () => {
    expect(parseClaudeAuth("not json")).toBeNull();
    expect(parseClaudeAuth("[]")).toBeNull();
    expect(parseClaudeAuth(JSON.stringify({ loggedIn: "yes" }))).toBeNull();
    expect(parseClaudeAuth(JSON.stringify({ email: "you@example.com" }))).toBeNull();
  });
});

describe("parseMuseUsage", () => {
  it("reads the vendor percent and labels the reset window", () => {
    const asOfMs = 1794231822000;
    const raw = JSON.stringify({
      schemaVersion: 1,
      allowance: {
        tier: "Example Tier",
        window: { usedPercent: 72, resetsAtMs: asOfMs + (19 * 60 + 12) * 60000 },
        asOfMs,
      },
    });
    expect(parseMuseUsage(raw)).toEqual({ window: "resets in 19h 12m", percent: 72 });
  });

  it("clamps and rounds the percent and handles sub-hour windows", () => {
    const asOfMs = 1000000;
    const raw = JSON.stringify({
      allowance: { window: { usedPercent: 140.6, resetsAtMs: asOfMs + 12 * 60000 }, asOfMs },
    });
    expect(parseMuseUsage(raw)).toEqual({ window: "resets in 12m", percent: 100 });
  });

  it("rejects logged-out and unknown shapes", () => {
    expect(parseMuseUsage(JSON.stringify({ reason: "logged out", hint: "run login" }))).toBeNull();
    expect(parseMuseUsage("not json")).toBeNull();
    expect(parseMuseUsage(JSON.stringify({ allowance: { window: { usedPercent: "72" } } }))).toBeNull();
    expect(parseMuseUsage(JSON.stringify({ allowance: {} }))).toBeNull();
  });
});

describe("PROBED_CLIS", () => {
  it("covers exactly the CLIs with a verified probe", () => {
    expect(PROBED_CLIS).toEqual(["claude", "muse"]);
  });
});
