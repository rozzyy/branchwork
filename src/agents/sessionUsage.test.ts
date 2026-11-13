import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatTokens, useSessionUsage } from "./sessionUsage";
import { readSaverStats, readSessionUsage } from "../ipc/sessionUsage";
import { ensureProfileDir } from "../ipc/cli";
import { useProfiles } from "./profiles";
import type { AgentSession } from "./sessions";

vi.mock("../ipc/sessionUsage", () => ({
  readSessionUsage: vi.fn(),
  readSaverStats: vi.fn(),
}));

vi.mock("../ipc/cli", () => ({
  ensureProfileDir: vi.fn(),
}));

function session(patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "agent-1",
    cliId: "claude",
    profile: { cliId: "claude", slug: "work" },
    worktreePath: "/wt/a",
    sessionId: "pty-1",
    slot: "auto",
    error: null,
    sharedWithDock: false,
    status: "running",
    limitHit: false,
    savers: { rtk: "active", caveman: "active" },
    startedAt: 1000,
    ...patch,
  };
}

const okReport = {
  state: "ok" as const,
  tokens: { input: 10_100, output: 2_200, total: 12_300 },
  contextUsed: null,
  contextLimit: null,
  quota: null,
};

beforeEach(() => {
  useSessionUsage.setState({ views: {}, savings: {} });
  useProfiles.setState({ usage: {} });
  vi.mocked(ensureProfileDir).mockReset().mockImplementation(async (cliId, slug) => `/profiles/${cliId}-${slug}`);
  vi.mocked(readSessionUsage).mockReset().mockResolvedValue(okReport);
  vi.mocked(readSaverStats).mockReset().mockResolvedValue({ runs: 0, bytesBefore: 0, bytesAfter: 0 });
});

describe("formatTokens", () => {
  it("abbreviates thousands and millions", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(3_699_548)).toBe("3.7M");
  });
});

describe("useSessionUsage.poll", () => {
  it("ok usage maps percent only with a limit", async () => {
    await useSessionUsage.getState().poll([session()]);
    expect(readSessionUsage).toHaveBeenCalledWith("claude", "/profiles/claude-work", "/wt/a", 1000);
    expect(useSessionUsage.getState().views["agent-1"]).toEqual({
      kind: "ok",
      tokens: okReport.tokens,
      percent: null,
      stale: false,
    });
    vi.mocked(readSessionUsage).mockResolvedValue({ ...okReport, contextUsed: 99_112, contextLimit: 258_400 });
    await useSessionUsage.getState().poll([session()]);
    expect(useSessionUsage.getState().views["agent-1"]).toMatchObject({ kind: "ok", percent: 38 });
  });

  it("maps unsupported and missing logs to their own states", async () => {
    await useSessionUsage.getState().poll([session({ id: "agent-2", cliId: "gemini", profile: { cliId: "gemini", slug: "x" } })]);
    expect(useSessionUsage.getState().views["agent-2"]).toEqual({ kind: "unsupported" });
    expect(readSessionUsage).not.toHaveBeenCalled();
    vi.mocked(readSessionUsage).mockResolvedValue({ state: "noData" });
    await useSessionUsage.getState().poll([session()]);
    expect(useSessionUsage.getState().views["agent-1"]).toEqual({ kind: "none" });
  });

  it("ambiguous panes show unavailable", async () => {
    await useSessionUsage.getState().poll([session(), session({ id: "agent-2", sessionId: "pty-2" })]);
    expect(useSessionUsage.getState().views["agent-1"]).toEqual({ kind: "unavailable" });
    expect(useSessionUsage.getState().views["agent-2"]).toEqual({ kind: "unavailable" });
    expect(readSessionUsage).not.toHaveBeenCalled();
  });

  it("error keeps last value as stale", async () => {
    vi.mocked(readSessionUsage).mockRejectedValueOnce(new Error("boom"));
    await useSessionUsage.getState().poll([session()]);
    expect(useSessionUsage.getState().views["agent-1"]).toEqual({ kind: "unavailable" });
    await useSessionUsage.getState().poll([session()]);
    vi.mocked(readSessionUsage).mockRejectedValueOnce(new Error("boom"));
    await useSessionUsage.getState().poll([session()]);
    expect(useSessionUsage.getState().views["agent-1"]).toMatchObject({ kind: "ok", stale: true });
  });

  it("codex quota feeds the profile chip", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_797_183_951_000 - (2 * 60 + 5) * 60_000);
    vi.mocked(readSessionUsage).mockResolvedValue({
      ...okReport,
      quota: { percent: 4, windowMinutes: 43_200, resetsAt: 1_797_183_951 },
    });
    const codex = session({ cliId: "codex", profile: { cliId: "codex", slug: "work" }, savers: { rtk: "unsupported", caveman: "unsupported" } });
    await useSessionUsage.getState().poll([codex]);
    expect(useProfiles.getState().usage["codex:work"]).toEqual({ percent: 4, window: "resets in 2h 5m" });
    vi.mocked(Date.now).mockRestore();
  });

  it("reads measured savings only for active rtk sessions", async () => {
    vi.mocked(readSaverStats).mockResolvedValue({ runs: 4, bytesBefore: 20_000, bytesAfter: 7_700 });
    await useSessionUsage.getState().poll([session()]);
    expect(readSaverStats).toHaveBeenCalledWith("agent-1");
    expect(useSessionUsage.getState().savings["agent-1"]).toEqual({ runs: 4, bytesBefore: 20_000, bytesAfter: 7_700 });
    vi.mocked(readSaverStats).mockClear();
    await useSessionUsage.getState().poll([session({ savers: { rtk: "off", caveman: "off" } })]);
    expect(readSaverStats).not.toHaveBeenCalled();
  });

  it("forgets sessions that are no longer live", async () => {
    await useSessionUsage.getState().poll([session()]);
    await useSessionUsage.getState().poll([]);
    expect(useSessionUsage.getState().views).toEqual({});
  });
});
