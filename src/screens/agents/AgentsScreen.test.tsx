import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { AgentsView } from "./AgentsScreen";
import { useSessions } from "../../agents/sessions";
import { useProfiles } from "../../agents/profiles";
import { useRepos } from "../../state/repos";
import { useWorktrees } from "../../state/worktrees";
import { readStatus } from "../../ipc/status";
import { createUnpinnedWorktree, createWorktree, listWorktrees, removeWorktree } from "../../ipc/worktrees";
import { listPins, type Project } from "../../ipc/catalog";
import { ensureProfileDir, probeCli, profileHasCredentials, resolveCliBinary } from "../../ipc/cli";
import { spawnTerminal, writeTerminal } from "../../ipc/pty";
import { readProfileQuota, readSaverStats } from "../../ipc/quota";
import { ask } from "../../ui/dialog";
import { markTerminalAttached } from "../../terminal/attachReady";
import { PaneChromeProvider } from "../../stage/PaneHeader";
import type { Worktree } from "../../ipc/worktrees";
import agentsCss from "./agents.css?raw";

/** `AgentsView` owns its pane header (`ownsHeader`) and reads its split
 * controls from `PaneChromeContext`, which only `Pane` provides outside
 * tests. Every render in this file goes through this helper instead of a
 * bare `render`. */
function renderAgents(node: ReactNode) {
  return render(
    <PaneChromeProvider value={{ index: 0, active: true, controls: <div data-testid="pane-controls" /> }}>
      {node}
    </PaneChromeProvider>,
  );
}

/** Opens a session's merged status chip popover (spec G2/AC5) by its
 * composed accessible name (contains the RTK state text, which is always
 * present and unique enough per test fixture). */
function openStatusChip(nameRe: RegExp) {
  fireEvent.click(screen.getByRole("button", { name: nameRe }));
}

/** "Hand over to another agent" now lives in the tile's ⋯ menu (spec G2,
 * AC3) instead of a standalone button; open it and click the menu item. */
function handOverFromTile(index = 0) {
  fireEvent.click(screen.getAllByRole("button", { name: "Session actions" })[index]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Hand over to another agent" }));
}

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

vi.mock("../../ipc/quota", () => ({
  readProfileQuota: vi.fn(() =>
    Promise.resolve({
      state: "ok",
      windows: [
        { minutes: 300, scope: null, percent: 42, resetsAtMs: Date.now() + (2 * 60 + 5) * 60_000 + 30_000 },
        { minutes: 10_080, scope: null, percent: 35, resetsAtMs: Date.now() + 50 * 3_600_000 + 30_000 },
      ],
      fetchedAtMs: Date.now() - 12 * 60_000,
    }),
  ),
  readSaverStats: vi.fn(() => Promise.resolve({ runs: 4, bytesBefore: 20_000, bytesAfter: 7_700 })),
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
        conversationId: null,
        savers: { rtk: "unsupported", caveman: "unsupported" },
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
        conversationId: null,
        savers: { rtk: "unsupported", caveman: "unsupported" },
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
  it("merged status chip shows the tightest quota window's percent, RTK saving and account; its popover carries the rest (AC5)", async () => {
    useSessions.setState({
      sessions: useSessions.getState().sessions.map((session) =>
        session.id === "a1"
          ? { ...session, id: "agent-a1", savers: { rtk: "active", caveman: "off" } }
          : session,
      ),
    });
    renderAgents(<AgentsView />);
    const chip = await screen.findByRole("button", {
      name: /Usage 5h 42%, resets in 2h 5m.*RTK −12\.3k.*Work/,
    });
    expect(chip).toHaveTextContent("42%");
    expect(chip).toHaveTextContent("RTK −12.3k");
    expect(chip).toHaveTextContent("Work");
    fireEvent.click(chip);
    const panel = screen.getByRole("dialog", { name: "Session details" });
    // Usage section: today's quota popover content, unchanged.
    expect(panel).toHaveTextContent("Weekly");
    expect(panel).toHaveTextContent("35%");
    expect(panel).toHaveTextContent("resets in 2d 2h");
    expect(panel).toHaveTextContent("Updated 12m ago");
    // Token savers section: a real number, not only "on" (spec G4).
    expect(panel).toHaveTextContent("RTK −12.3k");
    expect(panel).toHaveTextContent("RTK-style compression");
    expect(panel).toHaveTextContent("Saved 12.3k chars in 4 runs");
    expect(panel).toHaveTextContent("Supported commands");
    expect(panel).toHaveTextContent("Active in this session");
    expect(panel).toHaveTextContent("Caveman off");
    // Account section: today's profile switch list, same store call.
    expect(within(panel).getByRole("button", { name: /Work/ })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /Add account/ })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /Manage accounts/ })).toBeInTheDocument();
    // The failed Claude pane (no PTY, unsupported fixture) still reads so on
    // its own chip face — "unavailable" and "unsupported" both read as
    // "RTK n/a" now (spec G4) — without needing to open its popover.
    expect(screen.getByText("RTK n/a")).toBeInTheDocument();
  });

  it("merges identity and the status chip into one header row per tile; no .agent-phm strip remains", async () => {
    useSessions.setState({
      sessions: useSessions.getState().sessions.map((session) =>
        session.id === "a1" ? { ...session, savers: { rtk: "active", caveman: "off" } } : session,
      ),
    });
    renderAgents(<AgentsView />);
    const chip = await screen.findByRole("button", { name: /Usage 5h 42%.*RTK −12\.3k.*Work/ });
    const close = screen.getAllByRole("button", { name: "Stop session" })[0];
    expect(document.querySelector(".agent-phm")).toBeNull();
    const row = close.closest(".agent-phd");
    expect(row).not.toBeNull();
    expect(chip.closest(".agent-phd")).toBe(row);
  });

  it("a 5-hour window past its reset still shows the weekly window as the tightest percent", async () => {
    vi.mocked(readProfileQuota).mockResolvedValueOnce({
      state: "ok",
      windows: [
        { minutes: 300, scope: null, percent: 100, resetsAtMs: Date.now() - 3 * 3_600_000 },
        { minutes: 10_080, scope: null, percent: 35, resetsAtMs: Date.now() + 50 * 3_600_000 + 30_000 },
      ],
      fetchedAtMs: Date.now() - 26 * 3_600_000,
    });
    renderAgents(<AgentsView />);
    const chip = await screen.findByRole("button", {
      name: /Usage 5h 0%, reset, no new report yet; Weekly 35%, resets in 2d 2h/,
    });
    expect(chip).toHaveTextContent("35%");
    fireEvent.click(chip);
    const panel = screen.getByRole("dialog", { name: "Session details" });
    expect(panel).toHaveTextContent("Reset 3h ago · last report 100%");
    expect(panel).toHaveTextContent("Updated 1d ago");
  });

  it("shows loading feedback while agent sessions are being restored", () => {
    useSessions.setState({ loaded: false });
    renderAgents(<AgentsView />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading agents…");
  });
  it("renders the session grid with headers and panes", () => {
    renderAgents(<AgentsView />);
    expect(screen.getByLabelText("Codex session in a")).toBeInTheDocument();
    const switchers = screen.getAllByRole("combobox", { name: "Switch agent" });
    expect(switchers).toHaveLength(2);
    expect(switchers[0]).toHaveValue("codex");
    expect(switchers[1]).toHaveValue("claude");
    expect(screen.getByRole("button", { name: /Work$/ })).toHaveTextContent("Work");
    expect(screen.getByTitle("/wt/a")).toBeInTheDocument();
    expect(screen.getByTestId("agent-pty-1")).toBeInTheDocument();
    // Failed session shows its error with a close action, no terminal.
    expect(screen.getByText("denied")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-null")).not.toBeInTheDocument();
  });

  it("toggles the page's layout mode directly from the page header", () => {
    renderAgents(<AgentsView />);
    fireEvent.click(screen.getByRole("button", { name: "Full width layout" }));
    expect(useSessions.getState().layoutMode).toBe("full");
    expect(document.querySelector(".agent-screen")).toHaveClass("agent-full");
  });

  it("pins a session's pane slot through its tile's ⋯ menu (AC3's Session section, reused)", () => {
    renderAgents(<AgentsView />);
    fireEvent.click(screen.getAllByRole("button", { name: "Session actions" })[0]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin pane right" }));
    expect(useSessions.getState().sessions.find((s) => s.id === "a1")?.slot).toBe("right");
  });

  it("fills the view when a lone session uses the default slot, with no .agent-phd tile header", () => {
    useSessions.setState({ sessions: useSessions.getState().sessions.slice(0, 1) });
    useSessions.getState().toggleSlot("a1", "left");
    renderAgents(<AgentsView />);
    expect(document.querySelector(".agent-screen")).toHaveClass("agent-solo");
    expect(document.querySelectorAll(".pane-header")).toHaveLength(1);
    expect(document.querySelector(".agent-phd")).toBeNull();
  });

  it("shows status dots and chips from live session state", () => {
    renderAgents(<AgentsView />);
    // a1 has a live session, a2 failed to spawn: running vs idle.
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("Idle")).toBeInTheDocument();
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
          savers: { rtk: "unsupported", caveman: "unsupported" },
        },
      ],
    });
    renderAgents(<AgentsView />);
    expect(document.querySelector(".agent-pane")).toHaveClass("st-waiting");
    expect(screen.getByText("Waiting for you")).toBeInTheDocument();
  });

  it("opens the status chip's Account section with the current profile checked (spec G2/AC5)", async () => {
    renderAgents(<AgentsView />);
    fireEvent.click(screen.getByRole("button", { name: /Work$/ }));
    const panel = await screen.findByRole("dialog", { name: "Session details" });
    expect(within(panel).getByRole("button", { name: /Work/ })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /Add account/ })).toBeInTheDocument();
    expect(within(panel).getByRole("button", { name: /Manage accounts/ })).toBeInTheDocument();
  });

  it("shows the live usage bar on the account row only when reported", async () => {
    const { unmount } = renderAgents(<AgentsView />);
    fireEvent.click(screen.getByRole("button", { name: /Work$/ }));
    expect(document.querySelector(".status-chip-accounts .ubar")).toBeNull();
    unmount();
    useProfiles.getState().setProfileUsage({ cliId: "codex", slug: "work" }, { window: "5h", percent: 72 });
    renderAgents(<AgentsView />);
    fireEvent.click(screen.getByRole("button", { name: /Work$/ }));
    expect(document.querySelector(".status-chip-accounts .ubar")).not.toBeNull();
    const panel = screen.getByRole("dialog", { name: "Session details" });
    expect(within(panel).getByRole("button", { name: /Work.*72%/ })).toBeInTheDocument();
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
    renderAgents(<AgentsView />);
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
          conversationId: null,
          savers: { rtk: "unsupported", caveman: "unsupported" },
        },
      ],
    });
    renderAgents(<AgentsView />);
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
          conversationId: null,
          savers: { rtk: "unsupported", caveman: "unsupported" },
        },
      ],
    });
    renderAgents(<AgentsView />);
    expect(screen.queryByText(/already logged in/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Open login terminal" })).toBeNull();
  });

  it("intercepts a lone /account line instead of sending it", () => {
    cliPaneProps.length = 0;
    renderAgents(<AgentsView />);
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
    renderAgents(<AgentsView />);
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
    renderAgents(<AgentsView />);
    fireEvent.change(screen.getAllByRole("combobox", { name: "Switch agent" })[0], {
      target: { value: "codex" },
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("disables the switcher while its handover dialog is open", async () => {
    renderAgents(<AgentsView />);
    handOverFromTile();
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
    renderAgents(<AgentsView />);
    handOverFromTile();
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
    renderAgents(<AgentsView />);
    handOverFromTile();
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
    renderAgents(<AgentsView />);
    // Both terminals stay mounted so switching projects never replays output
    // or storms the PTY with resizes; only visibility changes.
    expect(screen.getByTestId("agent-pty-1")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Codex session in a").closest(".agent-pane"),
    ).not.toHaveClass("agent-off");
    expect(
      screen.getByLabelText("Claude Code session in b").closest(".agent-pane"),
    ).toHaveClass("agent-off");
    // A visible session means no "no sessions yet" empty state (the page
    // header's own New agent button is unconditional now that it owns the
    // header — spec G1/G2 — so the absence is checked on the empty state).
    expect(document.querySelector(".agent-empty")).toBeNull();

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
    renderAgents(<AgentsView />);
    // Other worktrees keep their mounted panes hidden; this one is empty.
    // Both the page header and the empty state offer "＋ New agent" now.
    expect(within(document.querySelector(".agent-empty")!).getByText("＋ New agent")).toBeInTheDocument();
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
    renderAgents(<AgentsView />);
    handOverFromTile();
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
    renderAgents(<AgentsView />);
    fireEvent.click(within(document.querySelector(".agent-empty")!).getByRole("button", { name: "＋ New agent" }));
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
    renderAgents(<AgentsView />);
    fireEvent.click(within(document.querySelector(".agent-empty")!).getByRole("button", { name: "＋ New agent" }));
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
    renderAgents(<AgentsView />);
    fireEvent.click(within(document.querySelector(".agent-empty")!).getByRole("button", { name: "＋ New agent" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    const profileSelect = screen.getByLabelText("Profile");
    await waitFor(() => expect(profileSelect).toHaveValue("personal"));
    expect(await screen.findByText("Not logged in")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Sign in again" })).toBeInTheDocument();
  });

  it("gates the race start on prompt, agents, binaries, and profiles", async () => {
    renderAgents(<AgentsView />);
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
    renderAgents(<AgentsView />);
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
          conversationId: null,
          savers: { rtk: "unsupported", caveman: "unsupported" },
        },
      ],
      raceEntries: [{ id: "race-1", cliId: "codex", worktreePath: "/wt/fix-it-codex" }],
    });
    vi.mocked(ask).mockResolvedValue(true);
    vi.mocked(listWorktrees).mockResolvedValue([{ path: "/wt/a" } as Worktree]);
    renderAgents(<AgentsView />);
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
    renderAgents(<AgentsView />);
    act(() => {
      useSessions.getState().setRaceOpen(true);
    });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() => expect(vi.mocked(ask)).toHaveBeenCalled());
    expect(vi.mocked(removeWorktree)).not.toHaveBeenCalled();
    expect(useSessions.getState().raceEntries).toHaveLength(1);
  });

  it("the page row's ⋯ bundles Race and the layout toggle, for a narrow header where the wide buttons don't fit (C2)", () => {
    renderAgents(<AgentsView />);
    fireEvent.click(screen.getByRole("button", { name: "Agents page actions" }));
    for (const name of ["Race", "Grid layout", "Full width layout"]) {
      expect(screen.getByRole("menuitem", { name })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("menuitem", { name: "Race" }));
    expect(useSessions.getState().raceOpen).toBe(true);
  });
});

describe("solo session pane header (AC2/AC3)", () => {
  function renderSolo() {
    useSessions.setState({
      sessions: [
        { ...useSessions.getState().sessions[0], id: "a1", slot: "auto", savers: { rtk: "active", caveman: "active" } },
      ],
    });
    renderAgents(<AgentsView />);
  }

  it("is the only header row above the terminal, carrying identity, the status chip, New agent, ⋯ and the pane controls", async () => {
    renderSolo();
    expect(document.querySelectorAll(".pane-header")).toHaveLength(1);
    expect(document.querySelector(".agent-phd")).toBeNull();
    const header = document.querySelector(".pane-header") as HTMLElement;
    expect(within(header).getByRole("combobox", { name: "Switch agent" })).toBeInTheDocument();
    expect(within(header).getByText("Running")).toBeInTheDocument();
    const chip = await within(header).findByRole("button", { name: /Usage.*RTK.*Work/ });
    expect(chip).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "New agent" })).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "Session actions" })).toBeInTheDocument();
    expect(within(header).getByTestId("pane-controls")).toBeInTheDocument();
    // The chip's popover carries the RTK and Caveman detail, not the header
    // row. It portals to `document.body` (C4: `position: fixed`, so it is
    // never clipped by `.pane-header`'s `overflow: hidden`), so it is no
    // longer a DOM descendant of `header`.
    fireEvent.click(chip);
    const panel = screen.getByRole("dialog", { name: "Session details" });
    expect(panel).toHaveTextContent("RTK-style compression");
    expect(panel).toHaveTextContent("Caveman-style answers");
  });

  it("⋯ menu bundles the session's and the page's actions with unchanged accessible names and handlers", () => {
    renderSolo();
    fireEvent.click(screen.getByRole("button", { name: "Session actions" }));
    for (const name of [
      "Pin pane left",
      "Pin pane right",
      "Pane full width",
      "Move session to dock",
      "Hand over to another agent",
      "Review beside in Changes",
      "Stop session",
      "Race",
      "Grid layout",
      "Full width layout",
    ]) {
      expect(screen.getByRole("menuitem", { name })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("menuitem", { name: "Pin pane right" }));
    expect(useSessions.getState().sessions.find((s) => s.id === "a1")?.slot).toBe("right");
  });
});

describe("RTK chip states (AC6)", () => {
  it("shows the measured saving when active with runs", async () => {
    useSessions.setState({
      sessions: useSessions.getState().sessions.map((s) =>
        s.id === "a1" ? { ...s, savers: { ...s.savers, rtk: "active" } } : s,
      ),
    });
    renderAgents(<AgentsView />);
    expect(await screen.findByText("RTK −12.3k")).toBeInTheDocument();
  });

  it("shows RTK 0 while active but nothing has been compressed yet, with a data-state distinct from off/n-a (spec G4)", async () => {
    vi.mocked(readSaverStats).mockResolvedValueOnce({ runs: 0, bytesBefore: 0, bytesAfter: 0 });
    useSessions.setState({
      sessions: useSessions.getState().sessions.map((s) =>
        s.id === "a1" ? { ...s, savers: { ...s.savers, rtk: "active" } } : s,
      ),
    });
    renderAgents(<AgentsView />);
    const zero = await screen.findByText("RTK 0");
    // "Armed but 0 runs" must read dashed/muted, not the same as off/n-a
    // (G4: a real number only when there is one, otherwise distinguishable).
    expect(zero).toHaveAttribute("data-state", "zero");
  });

  it("shows RTK off when the saver is off, with a data-state distinct from the zero-runs state", () => {
    useSessions.setState({
      sessions: useSessions.getState().sessions.map((s) =>
        s.id === "a1" ? { ...s, savers: { ...s.savers, rtk: "off" } } : s,
      ),
    });
    renderAgents(<AgentsView />);
    const off = screen.getByText("RTK off");
    expect(off).toHaveAttribute("data-state", "off");
    expect(off.getAttribute("data-state")).not.toBe("zero");
  });

  it("shows RTK n/a for both unavailable and unsupported (the prior wording read as broken)", () => {
    useSessions.setState({
      sessions: useSessions.getState().sessions.map((s) =>
        s.id === "a1" ? { ...s, savers: { ...s.savers, rtk: "unavailable" } } : { ...s, savers: { ...s.savers, rtk: "unsupported" } },
      ),
    });
    renderAgents(<AgentsView />);
    expect(screen.getAllByText("RTK n/a")).toHaveLength(2);
  });

  it("styles the 'active, 0 runs' state as dashed and muted (spec G4), not the default off/n-a look", () => {
    // CSS-level proof that `[data-state="zero"]` actually renders
    // differently (jsdom doesn't apply stylesheets, so this checks the rule
    // exists, same technique PaneHeader.test.tsx uses for its CSS assertion).
    expect(agentsCss).toMatch(/\.status-chip-rtk\[data-state="zero"\]\s*\{[^}]*text-decoration:\s*underline dashed;/);
    expect(agentsCss).toMatch(/\.agent-saver-text\[data-state="zero"\]\s*\{[^}]*text-decoration:\s*underline dashed;/);
  });

  it("Token savers section notes Caveman is a system-prompt instruction with unmeasured savings", () => {
    renderAgents(<AgentsView />);
    openStatusChip(/Work$/);
    const panel = screen.getByRole("dialog", { name: "Session details" });
    expect(panel).toHaveTextContent(/system-prompt instruction; savings aren't measured/);
  });
});

it("ignores a pane pin and shows the global project's sessions", async () => {
  const { PaneProjectProvider } = await import("../../stage/paneProject");
  const projectA = { id: "p1", localPath: "/wt/a" } as Project;
  const projectB = { id: "p2", localPath: "/wt/b" } as Project;
  useRepos.setState({ projects: [projectA, projectB], activeProjectId: "p1" });
  useWorktrees.setState({
    projectId: "p1",
    worktrees: [{ path: "/wt/a" } as Worktree],
    pinnedPaths: [],
    activePath: "/wt/a",
    loading: false,
    error: null,
  });
  vi.mocked(listWorktrees).mockImplementation(async (id: string) =>
    id === "p2" ? [{ path: "/wt/b" } as Worktree] : [],
  );
  const base = useSessions.getState().sessions;
  useSessions.setState({
    sessions: base.map((session, index) => ({
      ...session,
      id: `s${index}`,
      sessionId: `pty-${index}`,
      worktreePath: index === 0 ? "/wt/a" : "/wt/b",
      error: null,
      status: "running" as const,
    })),
  });
  renderAgents(
    <PaneProjectProvider projectId="p2">
      <AgentsView />
    </PaneProjectProvider>,
  );
  // Both terminals stay mounted; only the global project's session is visible
  // (pane pins were removed).
  expect(screen.getByTestId("agent-pty-0")).toBeInTheDocument();
  expect(screen.getByTestId("agent-pty-1")).toBeInTheDocument();
  expect(
    screen.getByTestId("agent-pty-0").closest(".agent-pane"),
  ).not.toHaveClass("agent-off");
  expect(
    screen.getByTestId("agent-pty-1").closest(".agent-pane"),
  ).toHaveClass("agent-off");
});
