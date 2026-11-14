import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatReset, tightestWindow, useAgentMeters, windowLabel } from "./quota";
import { readProfileQuota, readSaverStats } from "../ipc/quota";
import { ensureProfileDir } from "../ipc/cli";
import { useProfiles } from "./profiles";
import type { AgentSession } from "./sessions";

vi.mock("../ipc/quota", () => ({
  readProfileQuota: vi.fn(),
  readSaverStats: vi.fn(),
}));

vi.mock("../ipc/cli", () => ({
  ensureProfileDir: vi.fn(),
}));

const NOW = 1_800_000_000_000;
const H = 3_600_000;

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
    ...patch,
  };
}

const fiveHour = { minutes: 300, scope: null, percent: 42, resetsAtMs: NOW + 2 * H + 5 * 60_000 };
const weekly = { minutes: 10_080, scope: null, percent: 35, resetsAtMs: NOW + 50 * H };

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  useAgentMeters.setState({ quotas: {}, savings: {} });
  useProfiles.setState({ usage: {} });
  vi.mocked(ensureProfileDir).mockReset().mockImplementation(async (cliId, slug) => `/profiles/${cliId}-${slug}`);
  vi.mocked(readProfileQuota)
    .mockReset()
    .mockResolvedValue({ state: "ok", windows: [fiveHour, weekly], fetchedAtMs: NOW - 12 * 60_000 });
  vi.mocked(readSaverStats).mockReset().mockResolvedValue({ runs: 0, bytesBefore: 0, bytesAfter: 0 });
});

describe("quota helpers", () => {
  it("labels windows like Orca", () => {
    expect(windowLabel(fiveHour)).toBe("5h");
    expect(windowLabel(weekly)).toBe("Weekly");
    expect(windowLabel({ ...weekly, scope: "opus" })).toBe("Weekly · Opus");
    expect(windowLabel({ ...weekly, minutes: 43_200 })).toBe("30d");
    expect(windowLabel({ ...weekly, minutes: 120 })).toBe("2h");
  });

  it("formats reset countdowns", () => {
    expect(formatReset(NOW + 2 * H + 5 * 60_000, NOW)).toBe("2h 5m");
    expect(formatReset(NOW + 50 * H, NOW)).toBe("2d 2h");
    expect(formatReset(NOW + 30_000, NOW)).toBe("<1m");
  });

  it("picks the tightest window that has not reset yet", () => {
    expect(tightestWindow([fiveHour, weekly], NOW)).toEqual(fiveHour);
    const expired = { ...fiveHour, percent: 100, resetsAtMs: NOW - 1 };
    expect(tightestWindow([expired, weekly], NOW)).toEqual(weekly);
    expect(tightestWindow([expired], NOW)).toBeNull();
  });
});

describe("useAgentMeters.poll", () => {
  it("reads quota once per profile and feeds the tightest window to the chip", async () => {
    await useAgentMeters.getState().poll([session(), session({ id: "agent-2", sessionId: "pty-2", worktreePath: "/wt/b" })]);
    expect(readProfileQuota).toHaveBeenCalledTimes(1);
    expect(readProfileQuota).toHaveBeenCalledWith("claude", "/profiles/claude-work");
    expect(useAgentMeters.getState().quotas["claude:work"]).toEqual({
      kind: "ok",
      windows: [fiveHour, weekly],
      fetchedAtMs: NOW - 12 * 60_000,
      stale: false,
    });
    expect(useProfiles.getState().usage["claude:work"]).toEqual({ percent: 42, window: "5h" });
  });

  it("maps unsupported and missing quota to their own states", async () => {
    await useAgentMeters.getState().poll([session({ cliId: "gemini", profile: { cliId: "gemini", slug: "x" } })]);
    expect(useAgentMeters.getState().quotas["gemini:x"]).toEqual({ kind: "unsupported" });
    expect(readProfileQuota).not.toHaveBeenCalled();
    vi.mocked(readProfileQuota).mockResolvedValue({ state: "noData" });
    await useAgentMeters.getState().poll([session()]);
    expect(useAgentMeters.getState().quotas["claude:work"]).toEqual({ kind: "none" });
  });

  it("error keeps last value as stale", async () => {
    vi.mocked(readProfileQuota).mockRejectedValueOnce(new Error("boom"));
    await useAgentMeters.getState().poll([session()]);
    expect(useAgentMeters.getState().quotas["claude:work"]).toEqual({ kind: "unavailable" });
    await useAgentMeters.getState().poll([session()]);
    vi.mocked(readProfileQuota).mockRejectedValueOnce(new Error("boom"));
    await useAgentMeters.getState().poll([session()]);
    expect(useAgentMeters.getState().quotas["claude:work"]).toMatchObject({ kind: "ok", stale: true });
  });

  it("reads measured savings only for active rtk sessions", async () => {
    vi.mocked(readSaverStats).mockResolvedValue({ runs: 4, bytesBefore: 20_000, bytesAfter: 7_700 });
    await useAgentMeters.getState().poll([session()]);
    expect(readSaverStats).toHaveBeenCalledWith("agent-1");
    expect(useAgentMeters.getState().savings["agent-1"]).toEqual({ runs: 4, bytesBefore: 20_000, bytesAfter: 7_700 });
    vi.mocked(readSaverStats).mockClear();
    await useAgentMeters.getState().poll([session({ savers: { rtk: "off", caveman: "off" } })]);
    expect(readSaverStats).not.toHaveBeenCalled();
  });
});
