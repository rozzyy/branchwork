import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalScreen } from "./screen";
import { TerminalScreen } from "./TerminalScreen";
import { closeTerminal, spawnTerminal } from "../ipc/pty";
import { loadSetting, saveSetting } from "../ipc/settings";
import { useWorktrees } from "../state/worktrees";
import { useRepos } from "../state/repos";
import { useFiles } from "../state/files";

vi.mock("../ipc/pty", () => ({
  waitTerminalReady: vi.fn(async () => true),
  spawnTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  writeTerminal: vi.fn(),
  onTerminalExit: vi.fn(() => Promise.resolve(() => {})),
}));

vi.mock("../ipc/settings", () => ({
  loadSetting: vi.fn(),
  saveSetting: vi.fn(),
}));

vi.mock("../ui/dialog", () => ({
  ask: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("./dock", () => ({
  useDock: {
    getState: () => ({ adoptExisting: vi.fn(), detachTab: vi.fn(() => null) }),
  },
}));

vi.mock("./CliPane", () => ({
  CliPane: ({ sessionId }: { sessionId: string }) => <div data-testid={`clipane-${sessionId}`} />,
}));

let sessionCounter = 0;

beforeEach(async () => {
  sessionCounter = 0;
  vi.mocked(spawnTerminal)
    .mockReset()
    .mockImplementation(async () => ({ sessionId: `pty-${(sessionCounter += 1)}` }));
  vi.mocked(loadSetting).mockReset().mockResolvedValue(null);
  vi.mocked(saveSetting).mockReset().mockResolvedValue(undefined);
  useRepos.setState({
    projects: [
      { id: "p1", owner: null, name: "Project A", localPath: "/wt/a", groupId: null },
      { id: "p2", owner: null, name: "Project B", localPath: "/wt/b", groupId: null },
    ],
    activeProjectId: "p1",
    status: "ready",
  });
  useFiles.setState({ dirty: {} });
  useWorktrees.setState({
    projectId: "p1",
    worktrees: [{ path: "/wt/a" } as never],
    activePath: "/wt/a",
    loading: false,
  });
  useTerminalScreen.setState({ tabs: [], selectedTabId: null, loaded: false });
});

function key(target: Element, init: KeyboardEventInit & { code: string }): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

describe("TerminalScreen", () => {
  it("shows loading feedback while terminal state is being restored", () => {
    render(<TerminalScreen />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading terminal…");
  });

  it("renders tabs, panes, and the status bar", async () => {
    render(<TerminalScreen />);
    await waitFor(() => expect(useTerminalScreen.getState().loaded).toBe(true));

    await act(async () => {
      await useTerminalScreen.getState().newTab("/wt/a");
    });
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("a");
    expect(screen.getByTestId("clipane-pty-1")).toBeInTheDocument();
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("pane 1/1");
    expect(status).toHaveTextContent("80×24");
  });

  it("shows only the selected project's tabs after a project switch without closing hidden sessions", () => {
    const tabFor = (id: string, worktreePath: string) => {
      const paneId = `${id}-pane`;
      return {
        id,
        name: id,
        layout: { kind: "pane" as const, id: paneId },
        panes: {
          [paneId]: {
            id: paneId,
            sessionId: `${id}-session`,
            worktreePath,
            cwd: worktreePath,
            error: null,
            cols: 80,
            rows: 24,
          },
        },
        focusedPaneId: paneId,
        maximizedPaneId: null,
        broadcast: false,
      };
    };
    useTerminalScreen.setState({
      tabs: [tabFor("Project A", "/wt/a"), tabFor("Project B", "/wt/b")],
      selectedTabId: "Project A",
      loaded: true,
    });

    render(<TerminalScreen />);
    expect(screen.getByRole("tab", { name: "Project A" })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Project B" })).not.toBeInTheDocument();

    act(() => useRepos.getState().selectProject("p2"));

    expect(screen.queryByRole("tab", { name: "Project A" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Project B" })).toBeInTheDocument();
    expect(screen.getByTestId("clipane-Project B-session")).toBeInTheDocument();
    // The off-project tab stays mounted but hidden so its rendered buffer
    // survives the project switch; the PTY session is never closed.
    expect(screen.getByTestId("clipane-Project A-session")).toBeInTheDocument();
    expect(
      screen.getByTestId("clipane-Project A-session").closest(".term-screen-tabpage"),
    ).toHaveAttribute("hidden");
    expect(
      screen.getByTestId("clipane-Project B-session").closest(".term-screen-tabpage"),
    ).not.toHaveAttribute("hidden");
    expect(useTerminalScreen.getState().tabs).toHaveLength(2);
    expect(closeTerminal).not.toHaveBeenCalled();
  });

  it("keeps inactive tabs mounted so switching tabs never blanks the terminal", () => {
    const tabFor = (id: string) => {
      const paneId = `${id}-pane`;
      return {
        id,
        name: id,
        layout: { kind: "pane" as const, id: paneId },
        panes: {
          [paneId]: {
            id: paneId,
            sessionId: `${id}-session`,
            worktreePath: "/wt/a",
            cwd: "/wt/a",
            error: null,
            cols: 80,
            rows: 24,
          },
        },
        focusedPaneId: paneId,
        maximizedPaneId: null,
        broadcast: false,
      };
    };
    useTerminalScreen.setState({
      tabs: [tabFor("t1"), tabFor("t2")],
      selectedTabId: "t1",
      loaded: true,
    });
    render(<TerminalScreen />);

    expect(screen.getByTestId("clipane-t1-session")).toBeInTheDocument();
    expect(screen.getByTestId("clipane-t2-session")).toBeInTheDocument();
    expect(
      screen.getByTestId("clipane-t2-session").closest(".term-screen-tabpage"),
    ).toHaveAttribute("hidden");

    act(() => useTerminalScreen.getState().selectTab("t2"));

    expect(screen.getByTestId("clipane-t1-session")).toBeInTheDocument();
    expect(screen.getByTestId("clipane-t2-session")).toBeInTheDocument();
    expect(
      screen.getByTestId("clipane-t1-session").closest(".term-screen-tabpage"),
    ).toHaveAttribute("hidden");
    expect(
      screen.getByTestId("clipane-t2-session").closest(".term-screen-tabpage"),
    ).not.toHaveAttribute("hidden");
    expect(closeTerminal).not.toHaveBeenCalled();
  });

  it("defaults a new tab to the active project when the selected tab belongs to another project", async () => {
    const paneId = "old-pane";
    useTerminalScreen.setState({
      tabs: [
        {
          id: "old-tab",
          name: "Old project",
          layout: { kind: "pane", id: paneId },
          panes: {
            [paneId]: {
              id: paneId,
              sessionId: "old-session",
              worktreePath: "/wt/a",
              cwd: "/wt/a",
              error: null,
              cols: 80,
              rows: 24,
            },
          },
          focusedPaneId: paneId,
          maximizedPaneId: null,
          broadcast: false,
        },
      ],
      selectedTabId: "old-tab",
      loaded: true,
    });

    act(() => useRepos.getState().selectProject("p2"));
    await act(async () => {
      await useTerminalScreen.getState().newTab();
    });

    expect(spawnTerminal).toHaveBeenCalledWith("/wt/b", 80, 24, undefined);
  });

  it("splits with ⌘D and moves focus with ⌥⌘ arrows", async () => {
    render(<TerminalScreen />);
    await waitFor(() => expect(useTerminalScreen.getState().loaded).toBe(true));
    await act(async () => {
      await useTerminalScreen.getState().newTab("/wt/a");
    });

    const pane = screen.getByTestId("clipane-pty-1");
    act(() => {
      key(pane, { code: "KeyD", key: "d", metaKey: true });
    });
    await waitFor(() => expect(screen.queryAllByLabelText(/Terminal pane in/).length).toBe(2));

    const panes = screen.getAllByLabelText(/Terminal pane in/);
    expect(panes[1]).toHaveClass("focused");
    act(() => {
      key(panes[1], { code: "ArrowLeft", key: "ArrowLeft", metaKey: true, altKey: true });
    });
    expect(screen.getAllByLabelText(/Terminal pane in/)[0]).toHaveClass("focused");
  });

  it("shows the broadcast state in the status bar", async () => {
    render(<TerminalScreen />);
    await waitFor(() => expect(useTerminalScreen.getState().loaded).toBe(true));
    await act(async () => {
      await useTerminalScreen.getState().newTab("/wt/a");
    });
    const tab = useTerminalScreen.getState().tabs[0];
    await act(async () => {
      await useTerminalScreen.getState().splitFocusedPane(tab.id, "h");
    });
    act(() => {
      useTerminalScreen.getState().toggleBroadcast(tab.id);
    });
    expect(screen.getByRole("status")).toHaveTextContent("Broadcasting to 2 panes");
  });
});

it("ignores a pane pin and shows the global project's tabs", async () => {
  const { PaneProjectProvider } = await import("../stage/paneProject");
  const tabFor = (id: string, worktreePath: string, sessionId: string) => {
    const paneId = `${id}-pane`;
    return {
      id,
      name: id,
      layout: { kind: "pane" as const, id: paneId },
      panes: {
        [paneId]: {
          id: paneId,
          sessionId,
          worktreePath,
          cwd: worktreePath,
          error: null,
          cols: 80,
          rows: 24,
        },
      },
      focusedPaneId: paneId,
      maximizedPaneId: null,
      broadcast: false,
    };
  };
  useRepos.setState({
    projects: [
      { id: "p1", owner: null, name: "Project A", localPath: "/wt/a", groupId: null },
      { id: "p2", owner: null, name: "Project B", localPath: "/wt/b", groupId: null },
    ],
    activeProjectId: "p1",
  });
  useWorktrees.setState({
    projectId: "p1",
    worktrees: [{ path: "/wt/a" } as never],
    activePath: "/wt/a",
    loading: false,
  });
  useTerminalScreen.setState({
    tabs: [tabFor("t1", "/wt/a", "pty-a"), tabFor("t2", "/wt/b", "pty-b")],
    selectedTabId: "t1",
    loaded: true,
  });
  render(
    <PaneProjectProvider projectId="p2">
      <TerminalScreen />
    </PaneProjectProvider>,
  );
  // Both terminals stay mounted; only the global project's tab is visible
  // (pane pins were removed), and no PTY session is closed.
  expect(screen.getByTestId("clipane-pty-a")).toBeInTheDocument();
  expect(screen.getByTestId("clipane-pty-b")).toBeInTheDocument();
  expect(screen.getByTestId("clipane-pty-a").closest(".term-screen-tabpage")).not.toHaveAttribute("hidden");
  expect(screen.getByTestId("clipane-pty-b").closest(".term-screen-tabpage")).toHaveAttribute("hidden");
  expect(closeTerminal).not.toHaveBeenCalled();
});
