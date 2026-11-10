import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSessions } from "./sessions";
import { ensureProfileDir, probeCli, profileHasCredentials, resolveCliBinary, seedClaudeOnboarding } from "../ipc/cli";
import { ensureAgentHooks, notifySocketPath, onAgentStatus } from "../ipc/notify";
import {
  closeTerminal,
  onTerminalExit,
  onTerminalOutput,
  spawnTerminal,
  stopTerminal,
  writeTerminal,
} from "../ipc/pty";
import { loadSetting, saveSetting } from "../ipc/settings";
import { ask } from "../ui/dialog";
import { useToasts } from "../ui/toast";
import { useProfiles } from "./profiles";
import { useSettings } from "../state/settings";
import { useWorktrees } from "../state/worktrees";

vi.mock("../ipc/cli", () => ({
  ensureProfileDir: vi.fn(),
  probeCli: vi.fn(),
  resolveCliBinary: vi.fn(),
  profileHasCredentials: vi.fn(),
  seedClaudeOnboarding: vi.fn(),
}));

vi.mock("../ipc/pty", () => ({
  spawnTerminal: vi.fn(),
  writeTerminal: vi.fn(),
  stopTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  onTerminalExit: vi.fn(),
  onTerminalOutput: vi.fn(),
}));

vi.mock("../ipc/settings", () => ({
  loadSetting: vi.fn(),
  saveSetting: vi.fn(),
}));

vi.mock("../ipc/notify", () => ({
  notifySocketPath: vi.fn(),
  ensureAgentHooks: vi.fn(),
  onAgentStatus: vi.fn(),
  notifyWhenUnfocused: vi.fn().mockResolvedValue(false),
}));

vi.mock("../ui/dialog", () => ({
  ask: vi.fn(),
}));

const adoptExisting = vi.fn();
vi.mock("../terminal/dock", () => ({
  useDock: {
    getState: () => ({ adoptExisting }),
  },
}));

type ExitEvent = { sessionId: string; exitCode: number | null; signal: string | null };
type OutputEvent = { sessionId: string; data: number[] };
type StatusEvent = { sessionId: string; event: "waiting" | "done" };

let exitHandler: ((event: ExitEvent) => void) | null = null;
let outputHandler: ((event: OutputEvent) => void) | null = null;
let statusHandler: ((event: StatusEvent) => void) | null = null;
let sessionCounter = 0;

function emitOutput(sessionId: string, text: string) {
  outputHandler?.({ sessionId, data: Array.from(new TextEncoder().encode(text)) });
}

function resetSessions() {
  useSessions.setState({ sessions: [], layoutMode: "grid", loaded: false });
}

async function seedProfile() {
  await useProfiles.getState().createProfile("codex", "Work");
  return { cliId: "codex" as const, slug: "work" };
}

beforeEach(async () => {
  sessionCounter = 0;
  vi.mocked(resolveCliBinary).mockReset().mockResolvedValue("/usr/local/bin/codex");
  vi.mocked(ensureProfileDir).mockReset().mockImplementation(async (cliId, slug) => `/profiles/${cliId}-${slug}`);
  vi.mocked(probeCli).mockReset().mockRejectedValue(new Error("no probe"));
  vi.mocked(profileHasCredentials).mockReset().mockResolvedValue(true);
  vi.mocked(seedClaudeOnboarding).mockReset().mockResolvedValue(true);
  vi.mocked(spawnTerminal)
    .mockReset()
    .mockImplementation(async () => ({ sessionId: `pty-${(sessionCounter += 1)}` }));
  vi.mocked(writeTerminal).mockReset().mockResolvedValue(undefined);
  vi.mocked(stopTerminal).mockReset().mockResolvedValue(true);
  vi.mocked(closeTerminal).mockReset().mockResolvedValue(undefined);
  vi.mocked(onTerminalExit).mockReset().mockImplementation((callback: (event: ExitEvent) => void) => {
    exitHandler = callback;
    return Promise.resolve(() => {});
  });
  vi.mocked(onTerminalOutput).mockReset().mockImplementation((callback: (event: OutputEvent) => void) => {
    outputHandler = callback;
    return Promise.resolve(() => {});
  });
  vi.mocked(notifySocketPath).mockReset().mockResolvedValue("/sock/notify.sock");
  vi.mocked(ensureAgentHooks).mockReset().mockResolvedValue(true);
  vi.mocked(onAgentStatus).mockReset().mockImplementation((callback: (event: StatusEvent) => void) => {
    statusHandler = callback;
    return Promise.resolve(() => {});
  });
  vi.mocked(loadSetting).mockReset().mockResolvedValue(null);
  vi.mocked(saveSetting).mockReset().mockResolvedValue(undefined);
  vi.mocked(ask).mockReset().mockResolvedValue(true);
  adoptExisting.mockReset();
  useToasts.setState({ toasts: [] });
  useSettings.setState({ agentAutoSwitch: true });
  useWorktrees.setState({ activePath: "/wt/a" });
  useProfiles.setState({
    profiles: [],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: {},
    cliProbes: {},
    profileProbes: {},
    loginPending: {},
  });
  resetSessions();
  await useSessions.getState().load();
});

describe("startSession", () => {
  it("spawns an isolated shell and writes the launch argv", async () => {
    const profile = await seedProfile();
    const id = await useSessions.getState().startSession({ cliId: "codex", profile, worktreePath: "/wt/a" });
    expect(id).toBeTruthy();
    expect(ensureProfileDir).toHaveBeenCalledWith("codex", "work");
    expect(ensureAgentHooks).toHaveBeenCalledWith("codex", "/profiles/codex-work");
    expect(spawnTerminal).toHaveBeenCalledWith(
      "/wt/a",
      80,
      24,
      expect.objectContaining({
        CODEX_HOME: "/profiles/codex-work",
        BRANCHWORK_AGENT_SESSION: expect.stringMatching(/^agent-/),
        BRANCHWORK_NOTIFY_SOCKET: "/sock/notify.sock",
      }),
    );
    expect(writeTerminal).toHaveBeenCalledWith("pty-1", new TextEncoder().encode("'codex'\n"));
    const session = useSessions.getState().sessions[0];
    expect(session).toMatchObject({ cliId: "codex", worktreePath: "/wt/a", sessionId: "pty-1", slot: "auto" });
  });

  it("refuses to start on a profile that never completed login", async () => {
    const profile = await seedProfile();
    vi.mocked(profileHasCredentials).mockResolvedValue(false);
    const id = await useSessions.getState().startSession({ cliId: "codex", profile, worktreePath: "/wt/a" });
    expect(id).toBeNull();
    expect(profileHasCredentials).toHaveBeenCalledWith("codex", "work", ["auth.json"]);
    // No shell is burned on a doomed onboarding.
    expect(spawnTerminal).not.toHaveBeenCalled();
    expect(writeTerminal).not.toHaveBeenCalled();
    expect(useSessions.getState().sessions).toHaveLength(0);
    // The toast offers one-click login instead.
    const toast = useToasts.getState().toasts[0];
    expect(toast.title).toMatch(/Log in to .* first/);
    expect(toast.action?.label).toBe("Log in");
  });

  it("refuses Claude when the selected profile probe reports logged out", async () => {
    await useProfiles.getState().createProfile("claude", "Personal");
    vi.mocked(probeCli).mockResolvedValueOnce(JSON.stringify({ loggedIn: false }));
    const id = await useSessions.getState().startSession({
      cliId: "claude",
      profile: { cliId: "claude", slug: "personal" },
      worktreePath: "/wt/a",
    });
    expect(id).toBeNull();
    expect(probeCli).toHaveBeenCalledWith("claude", {
      CLAUDE_CONFIG_DIR: "/profiles/claude-personal",
    });
    expect(spawnTerminal).not.toHaveBeenCalled();
    expect(useSessions.getState().sessions).toHaveLength(0);
  });

  it("starts Claude with the same profile environment used by the login probe", async () => {
    await useProfiles.getState().createProfile("claude", "Personal");
    vi.mocked(probeCli).mockResolvedValueOnce(JSON.stringify({ loggedIn: true }));
    await useSessions.getState().startSession({
      cliId: "claude",
      profile: { cliId: "claude", slug: "personal" },
      worktreePath: "/wt/a",
    });
    expect(spawnTerminal).toHaveBeenCalledWith(
      "/wt/a",
      80,
      24,
      expect.objectContaining({ CLAUDE_CONFIG_DIR: "/profiles/claude-personal" }),
    );
  });

  it("sends an optional prompt as the first input line after launch", async () => {
    const profile = await seedProfile();
    const id = await useSessions
      .getState()
      .startSession({ cliId: "codex", profile, worktreePath: "/wt/a", prompt: "Fix the login bug" });
    expect(id).toBeTruthy();
    const writes = vi.mocked(writeTerminal).mock.calls.map(([, data]) => new TextDecoder().decode(data as Uint8Array));
    expect(writes).toEqual(["Fix the login bug\n", "'codex'\n"]);
  });

  it("falls back to the default profile and refuses without worktree or binary", async () => {
    await seedProfile();
    const id = await useSessions.getState().startSession({ cliId: "codex" });
    expect(id).toBeTruthy();
    expect(useSessions.getState().sessions[0].profile).toEqual({ cliId: "codex", slug: "work" });

    useWorktrees.setState({ activePath: null });
    expect(await useSessions.getState().startSession({ cliId: "codex" })).toBeNull();

    useWorktrees.setState({ activePath: "/wt/a" });
    vi.mocked(resolveCliBinary).mockRejectedValueOnce(new Error("missing"));
    expect(await useSessions.getState().startSession({ cliId: "codex" })).toBeNull();
    expect(spawnTerminal).toHaveBeenCalledTimes(1);
  });

  it("keeps the record with an error when spawning fails", async () => {
    const profile = await seedProfile();
    vi.mocked(spawnTerminal).mockRejectedValueOnce(new Error("denied"));
    const id = await useSessions.getState().startSession({ cliId: "codex", profile });
    expect(id).toBeTruthy();
    const session = useSessions.getState().sessions[0];
    expect(session.sessionId).toBeNull();
    expect(session.error).toBe("denied");
  });
});

describe("closeSession", () => {
  it("confirms while running, stops gracefully, and offers resume undo", async () => {
    const profile = await seedProfile();
    const id = await useSessions.getState().startSession({ cliId: "codex", profile });
    vi.mocked(ask).mockResolvedValueOnce(null);
    await useSessions.getState().closeSession(id!);
    expect(stopTerminal).not.toHaveBeenCalled();
    expect(useSessions.getState().sessions).toHaveLength(1);

    await useSessions.getState().closeSession(id!);
    expect(stopTerminal).toHaveBeenCalledWith("pty-1", 3000);
    expect(useSessions.getState().sessions).toHaveLength(0);

    const undo = useToasts.getState().toasts[useToasts.getState().toasts.length - 1]?.action;
    expect(undo?.undo).toBe(true);
    undo?.run();
    await vi.waitFor(() => expect(spawnTerminal).toHaveBeenCalledTimes(2));
    const resumeWrite = vi.mocked(writeTerminal).mock.calls[1][1];
    expect(new TextDecoder().decode(resumeWrite)).toContain("resume");
  });

  it("auto-closes on clean exit without asking or stopping", async () => {
    const profile = await seedProfile();
    const id = await useSessions.getState().startSession({ cliId: "codex", profile });
    exitHandler?.({ sessionId: "pty-1", exitCode: 0, signal: null });
    await vi.waitFor(() => expect(useSessions.getState().sessions).toHaveLength(0));
    expect(ask).not.toHaveBeenCalled();
    expect(stopTerminal).not.toHaveBeenCalled();
    // A later manual close is a no-op.
    await useSessions.getState().closeSession(id!);
    expect(stopTerminal).not.toHaveBeenCalled();
  });

  it("keeps the pane on abnormal exit so the error stays visible", async () => {
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile });
    exitHandler?.({ sessionId: "pty-1", exitCode: 1, signal: null });
    await vi.waitFor(() => expect(useSessions.getState().isExited("pty-1")).toBe(true));
    expect(useSessions.getState().sessions).toHaveLength(1);
    expect(stopTerminal).not.toHaveBeenCalled();
  });

  it("detaches without stopping a dock-shared session", async () => {
    const profile = await seedProfile();
    const id = await useSessions.getState().startSession({ cliId: "codex", profile });
    useSessions.getState().moveToDock(id!);
    expect(adoptExisting).toHaveBeenCalledWith("/wt/a", "pty-1");
    await useSessions.getState().closeSession(id!);
    expect(stopTerminal).not.toHaveBeenCalled();
    expect(useSessions.getState().sessions).toHaveLength(0);
  });
});

describe("pane layout", () => {
  it("moves conflicting panes to the other side and toggles back to auto", async () => {
    const profile = await seedProfile();
    const a = await useSessions.getState().startSession({ cliId: "codex", profile });
    const b = await useSessions.getState().startSession({ cliId: "codex", profile });
    const store = () => useSessions.getState();
    store().toggleSlot(a!, "left");
    store().toggleSlot(b!, "left");
    const byId = Object.fromEntries(store().sessions.map((s) => [s.id, s.slot]));
    expect(byId[a!]).toBe("right");
    expect(byId[b!]).toBe("left");
    store().toggleSlot(b!, "left");
    expect(store().sessions.find((s) => s.id === b)?.slot).toBe("auto");
    store().toggleSlot(a!, "full");
    expect(store().sessions.find((s) => s.id === a)?.slot).toBe("full");
    store().setLayoutMode("full");
    expect(store().layoutMode).toBe("full");
  });

  it("tracks exited sessions for the status display", async () => {
    const profile = await seedProfile();
    const id = await useSessions.getState().startSession({ cliId: "codex", profile });
    expect(useSessions.getState().isExited("pty-1")).toBe(false);
    expect(useSessions.getState().isExited(null)).toBe(false);
    exitHandler?.({ sessionId: "pty-1", exitCode: 0, signal: null });
    expect(useSessions.getState().isExited("pty-1")).toBe(true);
    expect(id).toBeTruthy();
  });

  it("refuses a custom CLI without a launch override", async () => {
    await useProfiles.getState().createProfile("custom", "Mine");
    const id = await useSessions.getState().startSession({
      cliId: "custom",
      profile: { cliId: "custom", slug: "mine" },
    });
    expect(id).toBeNull();
    expect(spawnTerminal).not.toHaveBeenCalled();
  });

  it("resolves binary availability per CLI", async () => {
    vi.mocked(resolveCliBinary).mockImplementation(async (binary: string) => {
      if (binary === "gemini") throw new Error("missing");
      return `/bin/${binary}`;
    });
    const availability = await useSessions.getState().checkBinaries();
    expect(availability.codex).toBe("/bin/codex");
    expect(availability.gemini).toBeNull();
  });
});

describe("session status", () => {
  it("starts idle, runs after spawn, and ignores unknown notify events", async () => {
    const profile = await seedProfile();
    const id = await useSessions.getState().startSession({ cliId: "codex", profile });
    expect(useSessions.getState().sessions[0]).toMatchObject({ status: "running" });
    useSessions.getState().notifySessionEvent("pty-unknown", "waiting");
    expect(id).toBeTruthy();
  });

  it("marks waiting on a hook event with a toast", async () => {
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile });
    useSessions.getState().notifySessionEvent("pty-1", "waiting");
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
    const titles = useToasts.getState().toasts.map((item) => item.title);
    expect(titles.some((title) => title.includes("needs input"))).toBe(true);
  });

  it("marks waiting on a permission pattern and recovers on new output", async () => {
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile });
    emitOutput("pty-1", "working on it\n");
    expect(useSessions.getState().sessions[0].status).toBe("running");
    emitOutput("pty-1", "Do you want to proceed? (y/n)\n");
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
    emitOutput("pty-1", "proceeding\n");
    expect(useSessions.getState().sessions[0].status).toBe("running");
  });

  it("raises the waiting toast only once no matter how often the loop cycles", async () => {
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile });
    const waitingToasts = () =>
      useToasts.getState().toasts.filter((item) => item.title.includes("needs input"));
    emitOutput("pty-1", "Do you want to proceed? (y/n)\n");
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
    expect(waitingToasts()).toHaveLength(1);
    // Agent chatter flips back to running, then the heuristic fires again —
    // status still cycles, but the user is not re-pinged.
    emitOutput("pty-1", "thinking…\n");
    expect(useSessions.getState().sessions[0].status).toBe("running");
    emitOutput("pty-1", "Do you want to proceed? (y/n)\n");
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
    expect(waitingToasts()).toHaveLength(1);
    // A repeated hook event does not re-ping either.
    useSessions.getState().notifySessionEvent("pty-1", "waiting");
    expect(waitingToasts()).toHaveLength(1);
  });

  it("matches a pattern split across two chunks", async () => {
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile });
    emitOutput("pty-1", "Do you want to pro");
    expect(useSessions.getState().sessions[0].status).toBe("running");
    emitOutput("pty-1", "ceed? (y/n)\n");
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
  });

  it("marks waiting after 4 s without output", async () => {
    vi.useFakeTimers();
    try {
      const profile = await seedProfile();
      await useSessions.getState().startSession({ cliId: "codex", profile });
      expect(useSessions.getState().sessions[0].status).toBe("running");
      await vi.advanceTimersByTimeAsync(4000);
      expect(useSessions.getState().sessions[0].status).toBe("waiting");
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks done on abnormal exit and keeps the record", async () => {
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile });
    exitHandler?.({ sessionId: "pty-1", exitCode: 1, signal: null });
    expect(useSessions.getState().sessions[0].status).toBe("done");
    expect(useSessions.getState().sessions).toHaveLength(1);
  });

  it("marks waiting on a socket event addressed by record id", async () => {
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile });
    const id = useSessions.getState().sessions[0].id;
    statusHandler?.({ sessionId: id, event: "waiting" });
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
  });
});

describe("profile switching", () => {
  async function twoProfiles() {
    const work = await useProfiles.getState().createProfile("codex", "Work");
    const home = await useProfiles.getState().createProfile("codex", "Home");
    return { work: { cliId: "codex" as const, slug: work!.slug }, home: { cliId: "codex" as const, slug: home!.slug } };
  }

  it("relaunches with the new profile env and resume argv after confirming", async () => {
    const { work, home } = await twoProfiles();
    const id = await useSessions.getState().startSession({ cliId: "codex", profile: work });
    const switched = await useSessions.getState().switchProfile(id!, home);
    expect(switched).toBe(id);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(stopTerminal).toHaveBeenCalledWith("pty-1", 3000);
    expect(closeTerminal).toHaveBeenCalledWith("pty-1");
    expect(ensureProfileDir).toHaveBeenCalledWith("codex", "home");
    expect(spawnTerminal).toHaveBeenCalledTimes(2);
    const writes = vi.mocked(writeTerminal).mock.calls.map(([, data]) => new TextDecoder().decode(data));
    expect(writes.some((text) => text.includes("↻ Account Work → Home"))).toBe(true);
    expect(writes.some((text) => text.includes("'resume' '--last'"))).toBe(true);
    const session = useSessions.getState().sessions[0];
    expect(session).toMatchObject({ profile: home, sessionId: "pty-2", status: "running", limitHit: false });
  });

  it("skips confirmation when the session is not running", async () => {
    const { work, home } = await twoProfiles();
    vi.mocked(spawnTerminal).mockRejectedValueOnce(new Error("denied"));
    const id = await useSessions.getState().startSession({ cliId: "codex", profile: work });
    const switched = await useSessions.getState().switchProfile(id!, home);
    expect(switched).toBe(id);
    expect(ask).not.toHaveBeenCalled();
    expect(stopTerminal).not.toHaveBeenCalled();
  });

  it("cancels on declined confirmation and refuses dock-shared sessions", async () => {
    const { work, home } = await twoProfiles();
    const id = await useSessions.getState().startSession({ cliId: "codex", profile: work });
    vi.mocked(ask).mockResolvedValueOnce(null);
    expect(await useSessions.getState().switchProfile(id!, home)).toBeNull();
    expect(stopTerminal).not.toHaveBeenCalled();

    useSessions.getState().moveToDock(id!);
    expect(await useSessions.getState().switchProfile(id!, home)).toBeNull();
    expect(stopTerminal).not.toHaveBeenCalled();
  });

  it("cycles to the next profile and toasts when alone", async () => {
    const profile = await seedProfile();
    const id = await useSessions.getState().startSession({ cliId: "codex", profile });
    expect(await useSessions.getState().switchToNextProfile(id!)).toBeNull();
    expect(useToasts.getState().toasts[useToasts.getState().toasts.length - 1]?.title).toContain("Add another");

    await useProfiles.getState().createProfile("codex", "Home");
    const next = await useSessions.getState().switchToNextProfile(id!);
    expect(next).toBe(id);
    expect(useSessions.getState().sessions[0].profile).toEqual({ cliId: "codex", slug: "home" });
  });
});

describe("usage limits", () => {
  it("marks waiting with a banner and offers a switch toast", async () => {
    useSettings.setState({ agentAutoSwitch: false });
    const profile = await seedProfile();
    await useProfiles.getState().createProfile("codex", "Home");
    await useSessions.getState().startSession({ cliId: "codex", profile });
    emitOutput("pty-1", "You've hit your weekly limit · resets Nov 12\n");
    const session = useSessions.getState().sessions[0];
    expect(session).toMatchObject({ status: "waiting", limitHit: true });
    const action = useToasts.getState().toasts[useToasts.getState().toasts.length - 1]?.action;
    expect(action?.label).toBe("Switch");

    action?.run();
    await vi.waitFor(() =>
      expect(useSessions.getState().sessions[0].profile).toEqual({ cliId: "codex", slug: "home" }),
    );
    expect(useSessions.getState().sessions[0].limitHit).toBe(false);
  });

  it("auto-switches without asking when enabled", async () => {
    const profile = await seedProfile();
    await useProfiles.getState().createProfile("codex", "Home");
    const id = await useSessions.getState().startSession({ cliId: "codex", profile });
    emitOutput("pty-1", "rate limit reached, try later\n");
    await vi.waitFor(() =>
      expect(useSessions.getState().sessions[0].profile).toEqual({ cliId: "codex", slug: "home" }),
    );
    expect(ask).not.toHaveBeenCalled();
    expect(id).toBeTruthy();
  });

  it("dismisses the banner without switching", async () => {
    useSettings.setState({ agentAutoSwitch: false });
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile });
    emitOutput("pty-1", "quota exceeded\n");
    expect(useSessions.getState().sessions[0].limitHit).toBe(true);
    useSessions.getState().dismissLimit(useSessions.getState().sessions[0].id);
    expect(useSessions.getState().sessions[0].limitHit).toBe(false);
  });
});

describe("handover output tail", () => {
  it("keeps the last lines per session for notes", async () => {
    const profile = await seedProfile();
    const id = await useSessions.getState().startSession({ cliId: "codex", profile });
    emitOutput("pty-1", "first\nsecond\nthird\n");
    expect(useSessions.getState().getOutputTail(id!, 2)).toEqual(["second", "third"]);
    expect(useSessions.getState().getOutputTail(id!)).toHaveLength(3);
  });

  it("closes a running session without asking when told to", async () => {
    const profile = await seedProfile();
    const id = await useSessions.getState().startSession({ cliId: "codex", profile });
    await useSessions.getState().closeSession(id!, { confirm: false });
    expect(ask).not.toHaveBeenCalled();
    expect(stopTerminal).toHaveBeenCalledWith("pty-1", 3000);
  });
});
