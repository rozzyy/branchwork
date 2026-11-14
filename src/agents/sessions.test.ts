import { beforeEach, describe, expect, it, vi } from "vitest";
import { switchTiming, useSessions } from "./sessions";
import { ensureProfileDir, probeCli, profileHasCredentials, resolveCliBinary, seedClaudeOnboarding } from "../ipc/cli";
import { ensureAgentHooks, ensureSaverHook, notifySocketPath, onAgentStatus } from "../ipc/notify";
import { copyConversation, findCodexConversation } from "../ipc/conversations";
import {
  closeTerminal,
  onTerminalExit,
  onTerminalOutput,
  spawnTerminal,
  stopTerminal,
  waitTerminalReady,
  writeTerminal,
} from "../ipc/pty";
import { loadSetting, saveSetting } from "../ipc/settings";
import { ask } from "../ui/dialog";
import { useToasts } from "../ui/toast";
import { useProfiles } from "./profiles";
import { useSettings } from "../state/settings";
import { useWorktrees } from "../state/worktrees";
import { waitForTerminalAttach } from "../terminal/attachReady";

vi.mock("../ipc/cli", () => ({
  ensureProfileDir: vi.fn(),
  probeCli: vi.fn(),
  resolveCliBinary: vi.fn(),
  profileHasCredentials: vi.fn(),
  seedClaudeOnboarding: vi.fn(),
}));

vi.mock("../ipc/pty", () => ({
  waitTerminalReady: vi.fn(async () => true),
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
  ensureSaverHook: vi.fn(),
  onAgentStatus: vi.fn(),
  notifyWhenUnfocused: vi.fn().mockResolvedValue(false),
}));

vi.mock("../ipc/conversations", () => ({
  copyConversation: vi.fn(),
  findCodexConversation: vi.fn(),
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

// Store tests do not render CliPane; model its successful attach handshake.
vi.mock("../terminal/attachReady", () => ({
  waitForTerminalAttach: vi.fn().mockResolvedValue(undefined),
}));

type ExitEvent = { sessionId: string; exitCode: number | null; signal: string | null };
type OutputEvent = { sessionId: string; data: number[] };
type StatusEvent = { sessionId: string; event: "waiting" | "done" | "start"; conversationId?: string | null };

const CONV_A = "42abbe75-0d00-4c98-9fcf-dcc6ef22bf2b";
const CONV_B = "01a1d5e6-eae0-7e90-847c-778bb00e80eb";

function writes(): string[] {
  return vi.mocked(writeTerminal).mock.calls.map(([, data]) => new TextDecoder().decode(data as Uint8Array));
}

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
  vi.mocked(ensureSaverHook).mockReset().mockResolvedValue(true);
  vi.mocked(onAgentStatus).mockReset().mockImplementation((callback: (event: StatusEvent) => void) => {
    statusHandler = callback;
    return Promise.resolve(() => {});
  });
  vi.mocked(loadSetting).mockReset().mockResolvedValue(null);
  vi.mocked(saveSetting).mockReset().mockResolvedValue(undefined);
  vi.mocked(ask).mockReset().mockResolvedValue(true);
  vi.mocked(copyConversation).mockReset().mockResolvedValue(true);
  vi.mocked(findCodexConversation).mockReset().mockResolvedValue(null);
  switchTiming.settleMs = 0;
  adoptExisting.mockReset();
  useToasts.setState({ toasts: [] });
  useSettings.setState({ agentAutoSwitch: true, agentTokenSaver: true, agentSaverProtected: [] });
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

  // Issue #3: in a Finder-launched app, shell wrappers (Kiro CLI without `Q_TERM`) discard
  // typeahead until the prompt is up, so the launch line must wait for shell readiness.
  it("writes the launch line only after the shell reports ready", async () => {
    const profile = await seedProfile();
    let ready: (value: boolean) => void = () => {};
    vi.mocked(waitTerminalReady).mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));

    const started = useSessions.getState().startSession({ cliId: "codex", profile, worktreePath: "/wt/a" });
    await vi.waitFor(() => expect(waitTerminalReady).toHaveBeenCalledWith("pty-1"));
    expect(writeTerminal).not.toHaveBeenCalled();

    ready(true);
    await started;
    expect(writeTerminal).toHaveBeenCalledWith("pty-1", new TextEncoder().encode("'codex'\n"));
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

describe("session restore", () => {
  it("waits for saved profiles when a screen requests restore before app bootstrap", async () => {
    resetSessions();
    useProfiles.setState({ loaded: false, profiles: [], globalDefault: null, cliDefaults: {} });
    vi.mocked(loadSetting).mockImplementation(async (key) => {
      if (key === "agentProfiles") {
        return {
          profiles: [{ cliId: "codex", slug: "work", name: "Work", createdAt: 1 }],
          globalDefault: { cliId: "codex", slug: "work" },
          cliDefaults: {},
        };
      }
      if (key === "agentSessions") {
        return {
          sessions: [{
            id: "agent-startup-race",
            cliId: "codex",
            profile: { cliId: "codex", slug: "work" },
            worktreePath: "/wt/a",
            slot: "right",
          }],
        };
      }
      return null;
    });

    await useSessions.getState().load();

    expect(useProfiles.getState().loaded).toBe(true);
    expect(useSessions.getState().sessions).toHaveLength(1);
    expect(useSessions.getState().sessions[0]).toMatchObject({
      id: "agent-startup-race",
      profile: { cliId: "codex", slug: "work" },
      sessionId: "pty-1",
      status: "running",
      error: null,
    });
    expect(writeTerminal).toHaveBeenCalledWith("pty-1", new TextEncoder().encode("codex resume --last || codex\n"));
  });

  it("recreates saved agent panes and resumes their conversations on app startup", async () => {
    const profile = await seedProfile();
    vi.mocked(loadSetting).mockResolvedValueOnce({
      sessions: [{
        id: "agent-saved-1",
        cliId: "codex",
        profile,
        worktreePath: "/wt/a",
        slot: "right",
      }],
      layoutMode: "full",
    });
    resetSessions();

    await useSessions.getState().load();

    expect(useSessions.getState()).toMatchObject({ loaded: true, layoutMode: "full" });
    expect(useSessions.getState().sessions).toHaveLength(1);
    expect(useSessions.getState().sessions[0]).toMatchObject({
      id: "agent-saved-1",
      cliId: "codex",
      profile,
      worktreePath: "/wt/a",
      slot: "right",
      sessionId: "pty-1",
      status: "running",
    });
    expect(writeTerminal).toHaveBeenCalledWith("pty-1", new TextEncoder().encode("codex resume --last || codex\n"));
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

  it("marks waiting on a hook event without a toast", async () => {
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile });
    useSessions.getState().notifySessionEvent("pty-1", "waiting");
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
    const titles = useToasts.getState().toasts.map((item) => item.title);
    expect(titles.some((title) => title.includes("needs input"))).toBe(false);
  });

  it("marks waiting on a permission pattern and recovers on sustained output", async () => {
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile });
    emitOutput("pty-1", "working on it\n");
    expect(useSessions.getState().sessions[0].status).toBe("running");
    emitOutput("pty-1", "Do you want to proceed? (y/n)\n");
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
    // A small confirmation echo alone must not fake "running".
    emitOutput("pty-1", "proceeding\n");
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
    emitOutput("pty-1", "proceeding with the plan\n".repeat(120));
    expect(useSessions.getState().sessions[0].status).toBe("running");
  });

  it("keeps waiting through tiny redraw bursts and flips running on real output", async () => {
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile });
    useSessions.getState().notifySessionEvent("pty-1", "waiting");
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
    // Cursor blink / spinner redraws are tiny and must not fake "running".
    emitOutput("pty-1", "\x1b[6n\x1b[?25l\x1b[?25h");
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
    // Real streamed output clears the wait.
    emitOutput("pty-1", "x".repeat(1100));
    expect(useSessions.getState().sessions[0].status).toBe("running");
  });

  it("never raises a waiting toast no matter how often the loop cycles", async () => {
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile });
    const waitingToasts = () =>
      useToasts.getState().toasts.filter((item) => item.title.includes("needs input"));
    emitOutput("pty-1", "Do you want to proceed? (y/n)\n");
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
    expect(waitingToasts()).toHaveLength(0);
    // Real streamed output flips back to running; no toast ever appears.
    emitOutput("pty-1", "thinking…\n".repeat(120));
    expect(useSessions.getState().sessions[0].status).toBe("running");
    emitOutput("pty-1", "Do you want to proceed? (y/n)\n");
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
    expect(waitingToasts()).toHaveLength(0);
    // A repeated hook event does not re-ping either.
    useSessions.getState().notifySessionEvent("pty-1", "waiting");
    expect(waitingToasts()).toHaveLength(0);
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
    expect(useToasts.getState().toasts.map((item) => item.title)).toContain("Codex stopped");
  });

  it("marks waiting on a socket event addressed by record id", async () => {
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile });
    const id = useSessions.getState().sessions[0].id;
    statusHandler?.({ sessionId: id, event: "waiting" });
    expect(useSessions.getState().sessions[0].status).toBe("waiting");
  });

  it("reports a done hook event once", async () => {
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile });
    const id = useSessions.getState().sessions[0].id;
    statusHandler?.({ sessionId: id, event: "done" });
    statusHandler?.({ sessionId: id, event: "done" });

    expect(useSessions.getState().sessions[0].status).toBe("done");
    expect(useToasts.getState().toasts.map((item) => item.title)).toContain("Codex stopped");
    expect(useToasts.getState().toasts.filter((item) => item.title === "Codex stopped")).toHaveLength(1);
  });

  it("hook start event updates conversationId without changing status", async () => {
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile });
    const id = useSessions.getState().sessions[0].id;
    statusHandler?.({ sessionId: id, event: "start", conversationId: CONV_B });
    expect(useSessions.getState().sessions[0]).toMatchObject({ conversationId: CONV_B, status: "running" });
    statusHandler?.({ sessionId: id, event: "waiting", conversationId: "../bad" });
    expect(useSessions.getState().sessions[0].conversationId).toBe(CONV_B);
  });

  it("returns from a hook done to running when substantial output follows", async () => {
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile });
    const id = useSessions.getState().sessions[0].id;
    statusHandler?.({ sessionId: id, event: "done" });
    expect(useSessions.getState().sessions[0].status).toBe("done");
    emitOutput("pty-1", "x".repeat(2048));
    expect(useSessions.getState().sessions[0].status).toBe("running");
  });
});

describe("conversation ids", () => {
  it("launches new claude sessions with a pinned --session-id", async () => {
    await useProfiles.getState().createProfile("claude", "Personal");
    await useSessions.getState().startSession({ cliId: "claude", profile: { cliId: "claude", slug: "personal" } });
    const session = useSessions.getState().sessions[0];
    expect(session.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(writes().join("")).toContain(`'claude' '--session-id' '${session.conversationId}'`);
  });

  it("persists conversationId and restores claude by id with a fresh fallback", async () => {
    await useProfiles.getState().createProfile("claude", "Personal");
    vi.mocked(loadSetting).mockResolvedValueOnce({
      sessions: [{
        id: "agent-saved-c",
        cliId: "claude",
        profile: { cliId: "claude", slug: "personal" },
        worktreePath: "/wt/a",
        slot: "auto",
        conversationId: CONV_A,
      }],
    });
    resetSessions();
    await useSessions.getState().load();
    expect(useSessions.getState().sessions[0].conversationId).toBe(CONV_A);
    expect(writes().join("")).toMatch(
      new RegExp(`^'claude' '--resume' '${CONV_A}' .*\\|\\| 'claude' '--session-id' '${CONV_A}' .*\n$`),
    );
    await vi.waitFor(() => expect(saveSetting).toHaveBeenCalled());
    const saved = vi.mocked(saveSetting).mock.calls.slice(-1)[0]?.[1] as { sessions: Array<{ conversationId: string }> };
    expect(saved.sessions[0].conversationId).toBe(CONV_A);
  });

  it("restores codex by id when known", async () => {
    const profile = await seedProfile();
    vi.mocked(loadSetting).mockResolvedValueOnce({
      sessions: [{ id: "agent-saved-x", cliId: "codex", profile, worktreePath: "/wt/a", slot: "auto", conversationId: CONV_B }],
    });
    resetSessions();
    await useSessions.getState().load();
    expect(writes()).toContain(`'codex' 'resume' '${CONV_B}' || 'codex'\n`);
  });
});

describe("profile switching", () => {
  beforeEach(() => {
    vi.mocked(findCodexConversation).mockResolvedValue(CONV_A);
  });

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
    // The pane's exact rollout is copied, then resumed by id with no
    // fresh-launch fallback; no decorative line is typed into the shell.
    expect(findCodexConversation).toHaveBeenCalledWith("work", "/wt/a", expect.any(Number), []);
    expect(copyConversation).toHaveBeenCalledWith("codex", "work", "home", CONV_A);
    expect(writes()).toContain(`'codex' 'resume' '${CONV_A}' || exit\n`);
    expect(writes().every((text) => !text.includes("↻") && !text.includes("--last"))).toBe(true);
    const session = useSessions.getState().sessions[0];
    expect(session).toMatchObject({
      profile: home,
      sessionId: "pty-2",
      status: "running",
      limitHit: false,
      conversationId: CONV_A,
    });
  });

  it("waits for the replacement pane to attach before writing the resume command", async () => {
    const { work, home } = await twoProfiles();
    const id = await useSessions.getState().startSession({ cliId: "codex", profile: work });
    let releaseAttach!: () => void;
    vi.mocked(waitForTerminalAttach).mockImplementationOnce(() =>
      new Promise<void>((resolve) => { releaseAttach = resolve; }),
    );

    const switching = useSessions.getState().switchProfile(id!, home);
    await vi.waitFor(() => expect(waitForTerminalAttach).toHaveBeenCalledWith("pty-2"));
    expect(useSessions.getState().sessions[0].sessionId).toBe("pty-2");
    expect(writeTerminal).toHaveBeenCalledTimes(1); // initial launch only

    releaseAttach();
    expect(await switching).toBe(id);
    expect(writeTerminal).toHaveBeenCalledTimes(2);
    expect(new TextDecoder().decode(vi.mocked(writeTerminal).mock.calls[1][1])).toContain(
      `'codex' 'resume' '${CONV_A}'`,
    );
  });

  it("refuses a switch to a logged-out profile without killing the running session", async () => {
    const { work, home } = await twoProfiles();
    const id = await useSessions.getState().startSession({ cliId: "codex", profile: work });
    vi.mocked(profileHasCredentials).mockResolvedValue(false);
    expect(await useSessions.getState().switchProfile(id!, home)).toBeNull();
    // The login gate fires before the old terminal is touched: a refused
    // switch must leave the running session untouched.
    expect(stopTerminal).not.toHaveBeenCalled();
    expect(closeTerminal).not.toHaveBeenCalled();
    expect(spawnTerminal).toHaveBeenCalledTimes(1);
    expect(useSessions.getState().sessions[0]).toMatchObject({
      profile: work,
      sessionId: "pty-1",
      status: "running",
    });
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

  it("copies the claude transcript and resumes it by id", async () => {
    await useProfiles.getState().createProfile("claude", "Work");
    await useProfiles.getState().createProfile("claude", "Home");
    const id = await useSessions.getState().startSession({ cliId: "claude", profile: { cliId: "claude", slug: "work" } });
    const conversationId = useSessions.getState().sessions[0].conversationId!;
    expect(await useSessions.getState().switchProfile(id!, { cliId: "claude", slug: "home" })).toBe(id);
    expect(findCodexConversation).not.toHaveBeenCalled();
    expect(copyConversation).toHaveBeenCalledWith("claude", "work", "home", conversationId);
    expect(writes().slice(-1)[0]).toMatch(new RegExp(`^'claude' '--resume' '${conversationId}' .* \\|\\| exit\n$`));
    expect(useSessions.getState().sessions[0]).toMatchObject({ profile: { cliId: "claude", slug: "home" }, conversationId });
  });

  it("launches claude fresh with the same id when no transcript exists", async () => {
    useSettings.setState({ agentTokenSaver: false });
    await useProfiles.getState().createProfile("claude", "Work");
    await useProfiles.getState().createProfile("claude", "Home");
    const id = await useSessions.getState().startSession({ cliId: "claude", profile: { cliId: "claude", slug: "work" } });
    const conversationId = useSessions.getState().sessions[0].conversationId!;
    vi.mocked(copyConversation).mockResolvedValueOnce(false);
    expect(await useSessions.getState().switchProfile(id!, { cliId: "claude", slug: "home" })).toBe(id);
    expect(writes().slice(-1)[0]).toBe(`'claude' '--session-id' '${conversationId}'\n`);
    expect(useSessions.getState().sessions[0].profile).toEqual({ cliId: "claude", slug: "home" });
  });

  it("refuses an ambiguous codex switch without stopping", async () => {
    const { work, home } = await twoProfiles();
    const id = await useSessions.getState().startSession({ cliId: "codex", profile: work });
    vi.mocked(findCodexConversation).mockResolvedValue(null);
    expect(await useSessions.getState().switchProfile(id!, home)).toBeNull();
    expect(stopTerminal).not.toHaveBeenCalled();
    expect(copyConversation).not.toHaveBeenCalled();
    expect(useSessions.getState().sessions[0]).toMatchObject({ profile: work, sessionId: "pty-1", status: "running" });
    expect(useToasts.getState().toasts.slice(-1)[0]?.title).toContain("Couldn't find this pane's Codex conversation");
  });

  it("rolls back to the source profile when the target exits during the settle window", async () => {
    switchTiming.settleMs = 60_000;
    const { work, home } = await twoProfiles();
    const id = await useSessions.getState().startSession({ cliId: "codex", profile: work });
    const switching = useSessions.getState().switchProfile(id!, home);
    await vi.waitFor(() => expect(writes()).toContain(`'codex' 'resume' '${CONV_A}' || exit\n`));
    expect(useSessions.getState().sessions[0].profile).toEqual(work);
    exitHandler?.({ sessionId: "pty-2", exitCode: 1, signal: null });
    expect(await switching).toBeNull();
    expect(writes().slice(-1)[0]).toBe(`'codex' 'resume' '${CONV_A}' || 'codex'\n`);
    expect(ensureProfileDir).toHaveBeenLastCalledWith("codex", "work");
    expect(useSessions.getState().sessions[0]).toMatchObject({ profile: work, sessionId: "pty-3", status: "running" });
    const titles = useToasts.getState().toasts.map((item) => item.title);
    expect(titles.some((title) => title.startsWith("Switching to Home failed, so the pane went back to Work"))).toBe(true);
    expect(titles).not.toContain("Codex stopped");
  });

  it("rolls back when the copy fails", async () => {
    const { work, home } = await twoProfiles();
    const id = await useSessions.getState().startSession({ cliId: "codex", profile: work });
    vi.mocked(copyConversation).mockRejectedValueOnce(new Error("disk full"));
    expect(await useSessions.getState().switchProfile(id!, home)).toBeNull();
    expect(writes().slice(-1)[0]).toBe(`'codex' 'resume' '${CONV_A}' || 'codex'\n`);
    expect(useSessions.getState().sessions[0]).toMatchObject({ profile: work, sessionId: "pty-2" });
    expect(useToasts.getState().toasts.slice(-1)[0]?.title).toContain("disk full");
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
  it("does not infer a Codex quota limit from usage and reset status", async () => {
    await useProfiles.getState().createProfile("codex", "Work");
    await useSessions.getState().startSession({ cliId: "codex", profile: { cliId: "codex", slug: "work" } });
    emitOutput("pty-1", "Usage limit · resets in 4h 12m\n");
    expect(useSessions.getState().sessions[0]).toMatchObject({ status: "running", limitHit: false });
    expect(useToasts.getState().toasts).toEqual([]);
  });

  it("marks waiting with a banner and offers a switch toast", async () => {
    useSettings.setState({ agentAutoSwitch: false });
    await useProfiles.getState().createProfile("claude", "Work");
    await useProfiles.getState().createProfile("claude", "Home");
    const profile = { cliId: "claude" as const, slug: "work" };
    await useSessions.getState().startSession({ cliId: "claude", profile });
    emitOutput("pty-1", "You've hit your weekly limit · resets Nov 12\n");
    const session = useSessions.getState().sessions[0];
    expect(session).toMatchObject({ status: "waiting", limitHit: true });
    const action = useToasts.getState().toasts[useToasts.getState().toasts.length - 1]?.action;
    expect(action?.label).toBe("Switch");

    action?.run();
    await vi.waitFor(() =>
      expect(useSessions.getState().sessions[0].profile).toEqual({ cliId: "claude", slug: "home" }),
    );
    expect(useSessions.getState().sessions[0].limitHit).toBe(false);
  });

  it("auto-switches without asking when enabled", async () => {
    await useProfiles.getState().createProfile("claude", "Work");
    await useProfiles.getState().createProfile("claude", "Home");
    const profile = { cliId: "claude" as const, slug: "work" };
    const id = await useSessions.getState().startSession({ cliId: "claude", profile });
    emitOutput("pty-1", "You've hit your weekly limit · resets Nov 12\n");
    await vi.waitFor(() =>
      expect(useSessions.getState().sessions[0].profile).toEqual({ cliId: "claude", slug: "home" }),
    );
    expect(ask).not.toHaveBeenCalled();
    expect(id).toBeTruthy();
    // Same by-id flow as a manual switch.
    const conversationId = useSessions.getState().sessions[0].conversationId!;
    expect(copyConversation).toHaveBeenCalledWith("claude", "work", "home", conversationId);
  });

  it("dismisses the banner without switching", async () => {
    useSettings.setState({ agentAutoSwitch: false });
    await useProfiles.getState().createProfile("claude", "Work");
    await useSessions.getState().startSession({ cliId: "claude", profile: { cliId: "claude", slug: "work" } });
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

describe("token saver", () => {
  async function startClaude() {
    await useProfiles.getState().createProfile("claude", "Personal");
    await useSessions.getState().startSession({
      cliId: "claude",
      profile: { cliId: "claude", slug: "personal" },
      worktreePath: "/wt/a",
    });
    const written = vi.mocked(writeTerminal).mock.calls.map(([, data]) => new TextDecoder().decode(data as Uint8Array));
    const env = vi.mocked(spawnTerminal).mock.calls[0]?.[3] as Record<string, string>;
    return { written: written.join(""), env, session: useSessions.getState().sessions[0] };
  }

  it("saver enabled launches claude with caveman and rtk env", async () => {
    useSettings.setState({ agentSaverProtected: ["git diff", "pytest"] });
    const { written, env, session } = await startClaude();
    expect(ensureSaverHook).toHaveBeenCalledWith("claude", "/profiles/claude-personal");
    expect(written).toContain("'--append-system-prompt'");
    expect(env).toMatchObject({ BRANCHWORK_SAVER: "rtk", BRANCHWORK_SAVER_PROTECT: "git diff,pytest" });
    expect(session.savers).toEqual({ rtk: "active", caveman: "active" });
  });

  it("saver disabled launches plain argv", async () => {
    useSettings.setState({ agentTokenSaver: false });
    const { written, env, session } = await startClaude();
    expect(written).toBe(`'claude' '--session-id' '${session.conversationId}'\n`);
    expect(env.BRANCHWORK_SAVER).toBeUndefined();
    expect(ensureSaverHook).not.toHaveBeenCalled();
    expect(session.savers).toEqual({ rtk: "off", caveman: "off" });
  });

  it("rtk unavailable when the hook cannot install", async () => {
    vi.mocked(ensureSaverHook).mockResolvedValue(false);
    const { env, session } = await startClaude();
    expect(env.BRANCHWORK_SAVER).toBeUndefined();
    expect(session.savers).toEqual({ rtk: "unavailable", caveman: "active" });
  });

  it("marks savers unsupported on CLIs without an integration", async () => {
    const profile = await seedProfile();
    await useSessions.getState().startSession({ cliId: "codex", profile, worktreePath: "/wt/a" });
    expect(useSessions.getState().sessions[0].savers).toEqual({ rtk: "unsupported", caveman: "unsupported" });
    expect(writeTerminal).toHaveBeenCalledWith("pty-1", new TextEncoder().encode("'codex'\n"));
  });

  it("resumes restored claude sessions with the concise flag on both sides", async () => {
    await useProfiles.getState().createProfile("claude", "Personal");
    await useSessions.getState().startSession({
      cliId: "claude",
      profile: { cliId: "claude", slug: "personal" },
      worktreePath: "/wt/a",
      resume: true,
    });
    const written = vi.mocked(writeTerminal).mock.calls.map(([, data]) => new TextDecoder().decode(data as Uint8Array)).join("");
    expect(written).toMatch(/^claude --continue --append-system-prompt '.+' \|\| claude --append-system-prompt '.+'\n$/);
  });
});
