import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsToolbar, AgentsView } from "./AgentsScreen";
import { useSessions } from "../../agents/sessions";
import { useProfiles } from "../../agents/profiles";
import { useRepos } from "../../state/repos";
import { useWorktrees } from "../../state/worktrees";
import { readStatus } from "../../ipc/status";
import { createUnpinnedWorktree, createWorktree, listWorktrees, removeWorktree } from "../../ipc/worktrees";
import { listPins, type Project } from "../../ipc/catalog";
import { ensureProfileDir, probeCli, profileHasCredentials, resolveCliBinary } from "../../ipc/cli";
import { spawnTerminal, writeTerminal } from "../../ipc/pty";
import { ask } from "../../ui/dialog";
import { markTerminalAttached } from "../../terminal/attachReady";
import type { Worktree } from "../../ipc/worktrees";

export const cliPaneProps: Array<{ sessionId: string; interceptInput?: (data: string) => boolean }> = [];
vi.mock("../../terminal/CliPane", () => ({
  CliPane: (props: { sessionId: string; interceptInput?: (data: string) => boolean }) => {
    cliPaneProps.push(props);
    markTerminalAttached(props.sessionId);
    return <div data-testid={`agent-${props.sessionId}`} />;
  },
}));

vi.mock("../../ipc/cli", () => ({
  ensureProfileDir: vi.fn(),
  probeCli: vi.fn(),
  resolveCliBinary: vi.fn(() => Promise.reject(new Error("missing"))),
  profileHasCredentials: vi.fn(),
  seedClaudeOnboarding: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../../ipc/pty", () => ({
  waitTerminalReady: vi.fn(async () => true),
  spawnTerminal: vi.fn(),
  writeTerminal: vi.fn(() => Promise.resolve()),
  stopTerminal: vi.fn(() => Promise.resolve()),
  closeTerminal: vi.fn(() => Promise.resolve()),
  onTerminalExit: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../../ipc/settings", () => ({
  loadSetting: vi.fn(),
  saveSetting: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../ipc/status", () => ({
  readStatus: vi.fn(),
}));

vi.mock("../../ipc/worktrees", () => ({
  createWorktree: vi.fn(),
  listWorktrees: vi.fn(),
  createUnpinnedWorktree: vi.fn(),
  removeWorktree: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../ipc/catalog", () => ({
  listPins: vi.fn(() => Promise.resolve([])),
  unpinWorktree: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../../ipc/handover", () => ({
  writeHandoverNote: vi.fn(),
  readHandoverDiff: vi.fn(),
}));

vi.mock("../../ui/dialog", () => ({
  ask: vi.fn(),
}));

vi.mock("../../ui/toast", () => ({
  toast: vi.fn(),
}));

function seed() {
  useProfiles.setState({
    profiles: [{ cliId: "codex", slug: "work", name: "Work", createdAt: 1 }],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
    usage: {},
    cliProbes: {},
  });
  useSessions.setState({
    sessions: [
      {
        id: "a1",
        cliId: "codex",
        profile: { cliId: "codex", slug: "work" },
        worktreePath: "/wt/a",
        sessionId: "pty-1",
        slot: "left",
        error: null,
        sharedWithDock: false,
        status: "running",
        limitHit: false,
      },
      {
        id: "a2",
        cliId: "claude",
        profile: { cliId: "claude", slug: "main" },
        worktreePath: "/wt/b",
        sessionId: null,
        slot: "auto",
        error: "denied",
        sharedWithDock: false,
        status: "idle",
        limitHit: false,
      },
    ],
    layoutMode: "grid",
    newAgentOpen: false,
    handoverFor: null,
    handoverTarget: null,
    loaded: true,
  });
}

beforeEach(() => {
  seed();
  useWorktrees.setState({
    projectId: null,
    worktrees: [],
    pinnedPaths: [],
    activePath: null,
    loading: false,
    error: null,
  });
  vi.mocked(resolveCliBinary).mockRejectedValue(new Error("missing"));
  vi.mocked(ensureProfileDir).mockReset().mockImplementation(async (cliId, slug) => `/profiles/${cliId}-${slug}`);
  vi.mocked(probeCli).mockReset().mockRejectedValue(new Error("no probe"));
  vi.mocked(profileHasCredentials).mockReset().mockResolvedValue(true);
  vi.mocked(spawnTerminal).mockReset();
  vi.mocked(createWorktree).mockReset();
  vi.mocked(createUnpinnedWorktree).mockReset();
  vi.mocked(removeWorktree).mockReset().mockImplementation(() => Promise.resolve());
  vi.mocked(ask).mockReset();
  vi.mocked(readStatus).mockReset().mockResolvedValue({ staged: [], unstaged: [] });
  vi.mocked(listWorktrees).mockReset();
  vi.mocked(listPins).mockResolvedValue([]);
});

describe("AgentsView", () => {
  it("shows loading feedback while agent sessions are being restored", () => {
    useSessions.setState({ loaded: false });
    render(<AgentsView />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading agents…");
  });
  it("renders the session grid with headers and panes", () => {
    render(<AgentsView />);
    expect(screen.getByLabelText("Codex session in a")).toBeInTheDocument();
    const switchers = screen.getAllByRole("combobox", { name: "Switch agent" });
    expect(switchers).toHaveLength(2);
    expect(switchers[0]).toHaveValue("codex");
    expect(switchers[1]).toHaveValue("claude");
    expect(screen.getByTitle("Profile Work")).toBeInTheDocument();
    expect(screen.getByTitle("/wt/a")).toBeInTheDocument();
    expect(screen.getByTestId("agent-pty-1")).toBeInTheDocument();
    // Failed session shows its error with a close action, no terminal.
    expect(screen.getByText("denied")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-null")).not.toBeInTheDocument();
  });

  it("toggles pane slots and layout mode", () => {
    render(
      <>
        <AgentsToolbar />
        <AgentsView />
      </>,
    );
    const rightButtons = screen.getAllByRole("button", { name: "Pin pane right" });
    fireEvent.click(rightButtons[0]);
    expect(useSessions.getState().sessions.find((s) => s.id === "a1")?.slot).toBe("right");

    fireEvent.click(screen.getByRole("button", { name: "▭ Full width layout" }));
    expect(useSessions.getState().layoutMode).toBe("full");
    expect(document.querySelector(".agent-screen")).toHaveClass("agent-full");
  });

  it("fills the view when a lone session uses the default slot", () => {
    useSessions.setState({ sessions: useSessions.getState().sessions.slice(0, 1) });
    useSessions.getState().toggleSlot("a1", "left");
    render(<AgentsView />);
    expect(document.querySelector(".agent-screen")).toHaveClass("agent-solo");
  });

  it("shows status dots and chips from live session state", () => {
    render(<AgentsView />);
    // a1 has a live session, a2 failed to spawn: running vs idle.
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("idle")).toBeInTheDocument();
    expect(screen.getByTitle("/wt/a")).toBeInTheDocument();
  });

  it("marks a waiting pane with the waiting outline and chip", () => {
    useSessions.setState({
      sessions: [
        {
          ...useSessions.getState().sessions[0],
          id: "a1",
          slot: "auto",
          status: "waiting",
          limitHit: false,
        },
      ],
    });
    render(<AgentsView />);
    expect(document.querySelector(".agent-pane")).toHaveClass("st-waiting");
    expect(screen.getByText("waiting")).toBeInTheDocument();
  });

  it("opens the profile menu with the current profile checked", async () => {
    render(<AgentsView />);
    fireEvent.click(screen.getByRole("button", { name: /Profile Work/ }));
    expect(await screen.findByRole("menuitem", { name: /Work/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Add account/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Manage accounts/ })).toBeInTheDocument();
  });

  it("shows the live usage bar on the profile chip only when reported", async () => {
    const { unmount } = render(<AgentsView />);
    expect(document.querySelector(".agent-profile .ubar")).toBeNull();
    unmount();
    useProfiles.getState().setProfileUsage({ cliId: "codex", slug: "work" }, { window: "5h", percent: 72 });
    render(<AgentsView />);
    expect(document.querySelector(".agent-profile .ubar")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Profile Work/ }));
    expect(await screen.findByRole("menuitem", { name: /Work.*72%/ })).toBeInTheDocument();
  });

  it("shows the usage-limit banner with Switch and Dismiss", () => {
    useSessions.setState({
      sessions: [{
        ...useSessions.getState().sessions[0],
        cliId: "claude",
        profile: { cliId: "claude", slug: "work" },
        limitHit: true,
      }],
    });
    render(<AgentsView />);
    expect(screen.getByText("Usage limit reached")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("does not show a login hint just because a verified Claude profile is waiting", () => {
    useProfiles.setState({
      profiles: [{ cliId: "claude", slug: "personal", name: "Personal", createdAt: 1 }],
      globalDefault: null,
      cliDefaults: {},
      loaded: true,
      usage: {},
      cliProbes: {},
      profileProbes: { "claude:personal": { linked: true, identity: null } },
      loginPending: {},
    });
    useSessions.setState({
      sessions: [
        {
          id: "c1",
          cliId: "claude",
          profile: { cliId: "claude", slug: "personal" },
          worktreePath: "/wt/b",
          sessionId: "pty-9",
          slot: "auto",
          error: null,
          sharedWithDock: false,
          status: "waiting",
          limitHit: false,
        },
      ],
    });
    render(<AgentsView />);
    expect(screen.queryByText(/already logged in/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Open login terminal" })).toBeNull();
  });

  it("hides the login hint when the profile is not verified", () => {
    useProfiles.setState({
      profiles: [{ cliId: "claude", slug: "personal", name: "Personal", createdAt: 1 }],
      globalDefault: null,
      cliDefaults: {},
      loaded: true,
      usage: {},
      cliProbes: {},
      profileProbes: { "claude:personal": { linked: false, identity: null } },
      loginPending: {},
    });
    useSessions.setState({
      sessions: [
        {
          id: "c1",
          cliId: "claude",
          profile: { cliId: "claude", slug: "personal" },
          worktreePath: "/wt/b",
          sessionId: "pty-9",
          slot: "auto",
          error: null,
          sharedWithDock: false,
          status: "waiting",
          limitHit: false,
        },
      ],
    });
    render(<AgentsView />);
    expect(screen.queryByText(/already logged in/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Open login terminal" })).toBeNull();
  });

  it("intercepts a lone /account line instead of sending it", () => {
    cliPaneProps.length = 0;
    render(<AgentsView />);
    const pane = cliPaneProps.find((props) => props.sessionId === "pty-1");
    expect(pane?.interceptInput).toBeDefined();
    // Ordinary typing passes through untouched.
    expect(pane?.interceptInput?.("hello")).toBe(false);
    expect(pane?.interceptInput?.(" world\r")).toBe(false);
    // A lone /account line is consumed for the profile switch.
    expect(pane?.interceptInput?.("/account")).toBe(false);
    expect(pane?.interceptInput?.("\r")).toBe(true);
  });

  it("opens the handover dialog with the switcher CLI preset", async () => {
    render(<AgentsView />);
    fireEvent.change(screen.getAllByRole("combobox", { name: "Switch agent" })[0], {
      target: { value: "opencode" },
    });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    // The preset target is checked instead of the first-non-source default.
    expect(screen.getByRole("radio", { name: /opencode/i })).toBeChecked();
    expect(screen.queryByRole("radio", { name: /custom/i })).not.toBeInTheDocument();
    expect(useSessions.getState().handoverTarget).toBe("opencode");
    // No session starts or stops from selecting alone.
    expect(useSessions.getState().sessions).toHaveLength(2);
  });

  it("ignores re-selecting the session's own CLI in the switcher", () => {
    render(<AgentsView />);
    fireEvent.change(screen.getAllByRole("combobox", { name: "Switch agent" })[0], {
      target: { value: "codex" },
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables the switcher while its handover dialog is open", async () => {
    render(<AgentsView />);
    fireEvent.click(screen.getAllByRole("button", { name: "Hand over to another agent" })[0]);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getAllByRole("combobox", { name: "Switch agent" })[0]).toBeDisabled();
    // The other session's switcher stays usable.
    expect(screen.getAllByRole("combobox", { name: "Switch agent" })[1]).toBeEnabled();
  });

  it("opens the handover dialog prefilled from the session", async () => {
    vi.mocked(readStatus).mockResolvedValue({
      staged: [
        { path: "a.ts", oldPath: null, indexStatus: "M", worktreeStatus: " ", bytes: 10, large: false },
      ],
      unstaged: [],
    });
    render(<AgentsView />);
    fireEvent.click(screen.getAllByRole("button", { name: "Hand over to another agent" })[0]);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/Handover from Codex/)).toBeInTheDocument();
    // The source CLI cannot be the target.
    expect(screen.getByRole("radio", { name: /codex/ })).toBeDisabled();
    // Note prefills status plus the changed file list.
    const note = screen.getByLabelText("Handover note") as HTMLTextAreaElement;
    await waitFor(() => expect(note.value).toContain("a.ts"));
    expect(note.value).toContain("Status: running");
    // Target profile name is empty: Start stays disabled.
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    // Preview shows the launch command plus the fixed note path.
    expect(screen.getByText(/note: \.branchwork\/handover\.md/)).toBeInTheDocument();
  });

  it("prefills a handover branch for a new worktree", async () => {
    vi.mocked(readStatus).mockResolvedValue({ staged: [], unstaged: [] });
    render(<AgentsView />);
    fireEvent.click(screen.getAllByRole("button", { name: "Hand over to another agent" })[0]);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("New worktree"));
    const branch = screen.getByLabelText("Branch") as HTMLInputElement;
    expect(branch.value).toMatch(/^handover\//);
    fireEvent.change(branch, { target: { value: "" } });
    // Empty branch invalidates the target even with a valid profile slug.
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  });

  it("keeps every session mounted but shows only the active worktree's", () => {
    useWorktrees.setState({
      projectId: "p1",
      activePath: "/wt/a",
      worktrees: [{ path: "/wt/a" } as Worktree, { path: "/wt/b" } as Worktree],
    });
    render(<AgentsView />);
    // Both terminals stay mounted so switching projects never replays output
    // or storms the PTY with resizes; only visibility changes.
    expect(screen.getByTestId("agent-pty-1")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Codex session in a").closest(".agent-pane"),
    ).not.toHaveClass("agent-off");
    expect(
      screen.getByLabelText("Claude Code session in b").closest(".agent-pane"),
    ).toHaveClass("agent-off");
    expect(screen.queryByText("＋ New agent")).not.toBeInTheDocument();

    act(() => {
      useWorktrees.setState({ activePath: "/wt/b" });
    });
    expect(
      screen.getByLabelText("Codex session in a").closest(".agent-pane"),
    ).toHaveClass("agent-off");
    expect(
      screen.getByLabelText("Claude Code session in b").closest(".agent-pane"),
    ).not.toHaveClass("agent-off");
  });

  it("shows the empty state when the active worktree has no session yet", () => {
    useWorktrees.setState({
      projectId: "p1",
      activePath: "/wt/new",
      worktrees: [{ path: "/wt/a" } as Worktree, { path: "/wt/new" } as Worktree],
    });
    render(<AgentsView />);
    // Other worktrees keep their mounted panes hidden; this one is empty.
    expect(screen.getByText("＋ New agent")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Codex session in a").closest(".agent-pane"),
    ).toHaveClass("agent-off");
    expect(document.querySelector(".agent-grid")).toHaveClass("agent-grid-empty");
  });

  it("switches to the created worktree after a new-worktree handover", async () => {
    const project = { id: "p1", localPath: "/repo" } as Project;
    useRepos.setState({ projects: [project], activeProjectId: "p1" });
    useWorktrees.setState({
      projectId: "p1",
      activePath: "/wt/a",
      worktrees: [{ path: "/wt/a" } as Worktree, { path: "/wt/b" } as Worktree],
    });
    vi.mocked(readStatus).mockResolvedValue({ staged: [], unstaged: [] });
    vi.mocked(resolveCliBinary).mockResolvedValue("/usr/local/bin/cli");
    vi.mocked(listWorktrees).mockResolvedValue([
      { path: "/wt/a" } as Worktree,
      { path: "/wt/new" } as Worktree,
    ]);
    vi.mocked(createUnpinnedWorktree).mockResolvedValue({ path: "/wt/new" } as Worktree);
    vi.mocked(spawnTerminal).mockResolvedValue({ sessionId: "pty-9" });
    render(<AgentsView />);
    fireEvent.click(screen.getAllByRole("button", { name: "Hand over to another agent" })[0]);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("New worktree"));
    fireEvent.change(screen.getByLabelText("Profile name"), { target: { value: "Target" } });
    const start = screen.getByRole("button", { name: "Start" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(useWorktrees.getState().activePath).toBe("/wt/new"));
    expect(
      useSessions.getState().sessions.some((s) => s.worktreePath === "/wt/new"),
    ).toBe(true);
  });

  it("shows the empty state and opens the New Agent dialog", async () => {
    useSessions.setState({ sessions: [] });
    render(<AgentsView />);
    fireEvent.click(screen.getByRole("button", { name: "＋ New agent" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(6);
    expect(screen.queryByRole("radio", { name: /custom/i })).not.toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /codex/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Profile")).toBeInTheDocument();
    expect(screen.getByLabelText("Worktree")).toBeInTheDocument();
    expect(screen.getByText("Run a CLI agent in an isolated worktree. The agent stays its original CLI.")).toBeInTheDocument();
    // No worktrees and no binary: Start stays disabled.
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  });

  it("preselects the resolved profile so a Settings login is reused", async () => {
    useProfiles.setState({
      profiles: [{ cliId: "claude", slug: "personal", name: "Personal", createdAt: 1 }],
      globalDefault: null,
      cliDefaults: {},
      loaded: true,
      usage: {},
      cliProbes: {},
      profileProbes: {},
      loginPending: {},
    });
    useWorktrees.setState({
      projectId: "p1",
      worktrees: [{ path: "/wt/a" } as Worktree],
      pinnedPaths: [],
      activePath: "/wt/a",
      loading: false,
      error: null,
    });
    vi.mocked(resolveCliBinary).mockResolvedValue("/usr/local/bin/claude");
    vi.mocked(probeCli).mockResolvedValue(JSON.stringify({ loggedIn: true }));
    useSessions.setState({ sessions: [] });
    render(<AgentsView />);
    fireEvent.click(screen.getByRole("button", { name: "＋ New agent" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    await waitFor(() => expect(screen.getByLabelText("Profile")).toHaveValue("personal"));
    expect(await screen.findByText("Logged in")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeEnabled();
  });

  it("blocks Start and offers inline login for a logged-out profile", async () => {
    useProfiles.setState({
      profiles: [{ cliId: "claude", slug: "personal", name: "Personal", createdAt: 1 }],
      globalDefault: null,
      cliDefaults: {},
      loaded: true,
      usage: {},
      cliProbes: {},
      profileProbes: {},
      loginPending: {},
    });
    useWorktrees.setState({
      projectId: "p1",
      worktrees: [{ path: "/wt/a" } as Worktree],
      pinnedPaths: [],
      activePath: "/wt/a",
      loading: false,
      error: null,
    });
    vi.mocked(resolveCliBinary).mockResolvedValue("/usr/local/bin/claude");
    vi.mocked(probeCli).mockResolvedValue(JSON.stringify({ loggedIn: false }));
    useSessions.setState({ sessions: [] });
    render(<AgentsView />);
    fireEvent.click(screen.getByRole("button", { name: "＋ New agent" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    const profileSelect = screen.getByLabelText("Profile");
    await waitFor(() => expect(profileSelect).toHaveValue("personal"));
    expect(await screen.findByText("Not logged in")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  });

  it("gates the race start on prompt, agents, binaries, and profiles", async () => {
    render(
      <>
        <AgentsToolbar />
        <AgentsView />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "⚑ Race" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    const start = screen.getByRole("button", { name: "Start race" });
    expect(start).toBeDisabled();

    // A selected CLI without any profile blocks Start with a message.
    vi.mocked(resolveCliBinary).mockResolvedValue("/usr/local/bin/cli");
    fireEvent.click(screen.getByRole("checkbox", { name: /OpenCode/ }));
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Fix it" } });
    await waitFor(() => expect(start).toBeDisabled());
    expect(screen.getByText(/OpenCode has no profile yet/)).toBeInTheDocument();
  });

  it("starts a race in unpinned worktrees and sends the prompt first", async () => {
    const project = { id: "p1", localPath: "/repo" } as Project;
    useRepos.setState({ projects: [project], activeProjectId: "p1" });
    useProfiles.setState({
      profiles: [
        { cliId: "codex", slug: "work", name: "Work", createdAt: 1 },
        { cliId: "claude", slug: "main", name: "Main", createdAt: 2 },
      ],
      globalDefault: null,
      cliDefaults: {},
      loaded: true,
    });
    useWorktrees.setState({
      projectId: "p1",
      activePath: "/wt/a",
      worktrees: [{ path: "/wt/a" } as Worktree, { path: "/wt/b" } as Worktree],
    });
    vi.mocked(readStatus).mockResolvedValue({ staged: [], unstaged: [] });
    vi.mocked(resolveCliBinary).mockResolvedValue("/usr/local/bin/cli");
    vi.mocked(listWorktrees).mockResolvedValue([
      { path: "/wt/a" } as Worktree,
      { path: "/fix-it-codex" } as Worktree,
      { path: "/fix-it-claude" } as Worktree,
    ]);
    const createdPaths: string[] = [];
    vi.mocked(createUnpinnedWorktree).mockImplementation(async (_projectId, destination, _branch) => {
      createdPaths.push(destination);
      return { path: destination } as Worktree;
    });
    let ptyCounter = 0;
    vi.mocked(spawnTerminal).mockImplementation(async () => ({ sessionId: `pty-race-${(ptyCounter += 1)}` }));
    render(
      <>
        <AgentsToolbar />
        <AgentsView />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "⚑ Race" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Fix it" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Codex/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Claude Code/ }));
    const start = screen.getByRole("button", { name: "Start race" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);

    await waitFor(() => expect(useSessions.getState().raceEntries).toHaveLength(2));
    expect(createdPaths).toEqual(["/fix-it-codex", "/fix-it-claude"]);
    const sessions = useSessions.getState().sessions;
    expect(
      sessions.filter((s) => s.worktreePath === "/fix-it-codex" || s.worktreePath === "/fix-it-claude"),
    ).toHaveLength(2);
    // The prompt goes out before the launch argv in each new shell.
    const writes = vi
      .mocked(writeTerminal)
      .mock.calls.map(([, data]) => new TextDecoder().decode(data as Uint8Array));
    expect(writes.filter((text) => text === "Fix it\n")).toHaveLength(2);
    expect(screen.getByText("Contestants")).toBeInTheDocument();
  });

  it("discards a race entry with confirmation, branch, and worktree", async () => {
    const project = { id: "p1", localPath: "/repo" } as Project;
    useRepos.setState({ projects: [project], activeProjectId: "p1" });
    useWorktrees.setState({
      projectId: "p1",
      activePath: "/wt/a",
      worktrees: [
        { path: "/wt/a" } as Worktree,
        { path: "/wt/fix-it-codex", branch: "race/fix-it-codex" } as Worktree,
      ],
    });
    useSessions.setState({
      sessions: [
        {
          id: "race-1",
          cliId: "codex",
          profile: { cliId: "codex", slug: "work" },
          worktreePath: "/wt/fix-it-codex",
          sessionId: "pty-race-1",
          slot: "auto",
          error: null,
          sharedWithDock: false,
          status: "running",
          limitHit: false,
        },
      ],
      raceEntries: [{ id: "race-1", cliId: "codex", worktreePath: "/wt/fix-it-codex" }],
    });
    vi.mocked(ask).mockResolvedValue(true);
    vi.mocked(listWorktrees).mockResolvedValue([{ path: "/wt/a" } as Worktree]);
    render(<AgentsView />);
    act(() => {
      useSessions.getState().setRaceOpen(true);
    });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() =>
      expect(vi.mocked(removeWorktree)).toHaveBeenCalledWith("p1", "/wt/fix-it-codex", true),
    );
    await waitFor(() => expect(useSessions.getState().raceEntries).toEqual([]));
  });

  it("refuses to discard a race entry with no project open", async () => {
    useWorktrees.setState({ projectId: null, activePath: null, worktrees: [] });
    useSessions.setState({
      sessions: [],
      raceEntries: [{ id: "race-1", cliId: "codex", worktreePath: "/wt/fix-it-codex" }],
    });
    vi.mocked(ask).mockResolvedValue(true);
    render(<AgentsView />);
    act(() => {
      useSessions.getState().setRaceOpen(true);
    });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() => expect(vi.mocked(ask)).toHaveBeenCalled());
    expect(vi.mocked(removeWorktree)).not.toHaveBeenCalled();
    expect(useSessions.getState().raceEntries).toHaveLength(1);
  });
});
