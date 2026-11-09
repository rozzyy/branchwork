import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsToolbar, AgentsView } from "./AgentsScreen";
import { useSessions } from "../../agents/sessions";
import { useProfiles } from "../../agents/profiles";

export const cliPaneProps: Array<{ sessionId: string; interceptInput?: (data: string) => boolean }> = [];
vi.mock("../../terminal/CliPane", () => ({
  CliPane: (props: { sessionId: string; interceptInput?: (data: string) => boolean }) => {
    cliPaneProps.push(props);
    return <div data-testid={`agent-${props.sessionId}`} />;
  },
}));

vi.mock("../../ipc/cli", () => ({
  ensureProfileDir: vi.fn(),
  resolveCliBinary: vi.fn(() => Promise.reject(new Error("missing"))),
}));

vi.mock("../../ipc/pty", () => ({
  spawnTerminal: vi.fn(),
  writeTerminal: vi.fn(),
  stopTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  onTerminalExit: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../../ipc/settings", () => ({
  loadSetting: vi.fn(),
  saveSetting: vi.fn(),
}));

vi.mock("../../ui/dialog", () => ({
  ask: vi.fn(),
}));

function seed() {
  useProfiles.setState({
    profiles: [{ cliId: "codex", slug: "work", name: "Work", createdAt: 1 }],
    globalDefault: null,
    cliDefaults: {},
    loaded: true,
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
    loaded: true,
  });
}

beforeEach(() => {
  seed();
});

describe("AgentsView", () => {
  it("renders the session grid with headers and panes", () => {
    render(<AgentsView />);
    expect(screen.getByLabelText("Codex session in a")).toBeInTheDocument();
    expect(screen.getByTitle("Codex")).toBeInTheDocument();
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

  it("shows the usage-limit banner with Switch and Dismiss", () => {
    useSessions.setState({
      sessions: [{ ...useSessions.getState().sessions[0], limitHit: true }],
    });
    render(<AgentsView />);
    expect(screen.getByText("Usage limit reached")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
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

  it("shows the empty state and opens the New Agent dialog", async () => {
    useSessions.setState({ sessions: [] });
    render(<AgentsView />);
    fireEvent.click(screen.getByRole("button", { name: "＋ New agent" }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(7);
    expect(screen.getByRole("radio", { name: /codex/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Profile")).toBeInTheDocument();
    expect(screen.getByLabelText("Worktree")).toBeInTheDocument();
    expect(screen.getByText("Run a CLI agent in an isolated worktree. The agent stays its original CLI.")).toBeInTheDocument();
    // No worktrees and no binary: Start stays disabled.
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  });
});
