import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalScreen } from "./screen";
import { TerminalScreen } from "./TerminalScreen";
import { closeTerminal, spawnTerminal, writeTerminal } from "../ipc/pty";
import { loadSetting, saveSetting } from "../ipc/settings";
import { useWorktrees } from "../state/worktrees";
import { useRepos } from "../state/repos";
import { useFiles } from "../state/files";
import { PaneChromeProvider } from "../stage/PaneHeader";

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

// Tracks each sessionId's mount (not re-render) so AC6 can assert the same
// CliPane instance survives a header action instead of being torn down.
let cliPaneMounts: string[] = [];
vi.mock("./CliPane", () => ({
  CliPane: ({ sessionId }: { sessionId: string }) => {
    useEffect(() => {
      cliPaneMounts.push(sessionId);
    }, [sessionId]);
    return <div data-testid={`clipane-${sessionId}`} />;
  },
}));

/** `TerminalScreen` owns its pane header (`ownsHeader`) and reads its split
 * controls from `PaneChromeContext`, which only `Pane` provides outside
 * tests. Every render in this file goes through this helper instead of a
 * bare `render`. */
function renderTerminal(node: ReactNode = <TerminalScreen />) {
  return render(
    <PaneChromeProvider value={{ index: 0, active: true, controls: <div data-testid="pane-controls" /> }}>
      {node}
    </PaneChromeProvider>,
  );
}

let sessionCounter = 0;

beforeEach(async () => {
  sessionCounter = 0;
  cliPaneMounts = [];
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
    renderTerminal();
    expect(screen.getByRole("status")).toHaveTextContent("Loading terminal…");
  });

  it("renders exactly one header row with tabs, new tab, broadcast toggle and pane controls (AC1)", async () => {
    renderTerminal();
    await waitFor(() => expect(useTerminalScreen.getState().loaded).toBe(true));
    await act(async () => {
      await useTerminalScreen.getState().newTab("/wt/a");
    });

    expect(document.querySelectorAll(".pane-header")).toHaveLength(1);
    expect(document.querySelector("header.pane-tool")).toBeNull();
    expect(document.querySelector(".term-screen-pane-head")).toBeNull();
    expect(document.querySelector(".term-screen-status")).toBeNull();
    expect(screen.getByRole("tablist", { name: "Terminal tabs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New terminal tab" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Broadcast input" })).toBeInTheDocument();
    expect(screen.getByTestId("pane-controls")).toBeInTheDocument();
    // Broadcast is off: no chip at rest.
    expect(document.querySelector(".term-screen-broadcast-chip")).toBeNull();
  });

  it("renders tabs and panes; the corner label shows position and size when focused (AC4, AC5)", async () => {
    renderTerminal();
    await waitFor(() => expect(useTerminalScreen.getState().loaded).toBe(true));

    await act(async () => {
      await useTerminalScreen.getState().newTab("/wt/a");
    });
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("a");
    expect(screen.getByTestId("clipane-pty-1")).toBeInTheDocument();

    // Unsplit tab: exactly one corner label (AC5).
    const labels = screen.getAllByLabelText("Terminal pane in a", { selector: ".term-screen-corner" });
    expect(labels).toHaveLength(1);

    fireEvent.focus(labels[0]);
    expect(labels[0]).toHaveTextContent("pane 1/1");
    expect(labels[0]).toHaveTextContent("80×24");
  });

  it("creates and closes a tab through the header's tab strip (AC2)", async () => {
    renderTerminal();
    await waitFor(() => expect(useTerminalScreen.getState().loaded).toBe(true));
    fireEvent.click(screen.getByRole("button", { name: "New terminal tab" }));
    await waitFor(() => expect(useTerminalScreen.getState().tabs).toHaveLength(1));
    const tab = useTerminalScreen.getState().tabs[0];
    expect(useTerminalScreen.getState().selectedTabId).toBe(tab.id);

    fireEvent.click(screen.getByRole("button", { name: `Close tab ${tab.name}` }));
    await waitFor(() => expect(useTerminalScreen.getState().tabs).toHaveLength(0));
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

    renderTerminal();
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
    renderTerminal();

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
    renderTerminal();
    await waitFor(() => expect(useTerminalScreen.getState().loaded).toBe(true));
    await act(async () => {
      await useTerminalScreen.getState().newTab("/wt/a");
    });

    const pane = screen.getByTestId("clipane-pty-1");
    act(() => {
      key(pane, { code: "KeyD", key: "d", metaKey: true });
    });
    await waitFor(() =>
      expect(screen.queryAllByLabelText(/Terminal pane in/, { selector: ".term-screen-pane" }).length).toBe(2),
    );

    const panes = screen.getAllByLabelText(/Terminal pane in/, { selector: ".term-screen-pane" });
    expect(panes[1]).toHaveClass("focused");
    act(() => {
      key(panes[1], { code: "ArrowLeft", key: "ArrowLeft", metaKey: true, altKey: true });
    });
    expect(screen.getAllByLabelText(/Terminal pane in/, { selector: ".term-screen-pane" })[0]).toHaveClass("focused");
  });

  it("shows the Broadcasting chip in the header at rest while broadcast is on, through the header toggle (AC1, AC2)", async () => {
    renderTerminal();
    await waitFor(() => expect(useTerminalScreen.getState().loaded).toBe(true));
    await act(async () => {
      await useTerminalScreen.getState().newTab("/wt/a");
    });
    const tab = useTerminalScreen.getState().tabs[0];
    await act(async () => {
      await useTerminalScreen.getState().splitFocusedPane(tab.id, "h");
    });

    const toggle = screen.getByRole("button", { name: "Broadcast input" });
    expect(toggle).toHaveAttribute("title", "Broadcast input · ⌥⌘I");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(toggle);

    expect(useTerminalScreen.getState().tabs[0].broadcast).toBe(true);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Broadcasting to 2 panes")).toBeInTheDocument();
    expect(document.querySelector(".term-screen-status")).toBeNull();
  });

  it("expands a corner label on focus and its buttons call the same store functions after focusing that part (AC3)", async () => {
    renderTerminal();
    await waitFor(() => expect(useTerminalScreen.getState().loaded).toBe(true));
    await act(async () => {
      await useTerminalScreen.getState().newTab("/wt/a");
    });
    const tab = useTerminalScreen.getState().tabs[0];
    await act(async () => {
      await useTerminalScreen.getState().splitFocusedPane(tab.id, "h");
    });

    let labels = screen.getAllByLabelText("Terminal pane in a", { selector: ".term-screen-corner" });
    expect(labels).toHaveLength(2);

    fireEvent.focus(labels[0]);
    const splitRight = within(labels[0]).getByRole("button", { name: "Split right" });
    expect(splitRight).toHaveAttribute("title", "Split right · ⌘D");
    fireEvent.click(splitRight);
    await waitFor(() => expect(Object.keys(useTerminalScreen.getState().tabs[0].panes)).toHaveLength(3));
    expect(useTerminalScreen.getState().tabs[0].focusedPaneId).not.toBeNull();

    // Re-query after every mutation: each one restructures the split tree
    // (new pane, then the maximize swap below), so stale label references
    // from before the mutation are no longer attached to the document.
    labels = screen.getAllByLabelText("Terminal pane in a", { selector: ".term-screen-corner" });
    fireEvent.focus(labels[0]);
    const worktreeSelect = within(labels[0]).getByRole("combobox", { name: "Pane worktree" });
    fireEvent.change(worktreeSelect, { target: { value: "/wt/a" } });

    labels = screen.getAllByLabelText("Terminal pane in a", { selector: ".term-screen-corner" });
    fireEvent.focus(labels[0]);
    const maximize = within(labels[0]).getByRole("button", { name: "Maximize pane" });
    expect(maximize).toHaveAttribute("title", "Maximize pane · ⇧⌘↵");
    fireEvent.click(maximize);
    expect(useTerminalScreen.getState().tabs[0].maximizedPaneId).not.toBeNull();

    // Maximized: only that one pane renders, with its own fresh corner label.
    labels = screen.getAllByLabelText("Terminal pane in a", { selector: ".term-screen-corner" });
    expect(labels).toHaveLength(1);
    fireEvent.focus(labels[0]);
    const close = within(labels[0]).getByRole("button", { name: "Close pane" });
    expect(close).toHaveAttribute("title", "Close pane · ⌘W");
    fireEvent.click(close);
    await waitFor(() => expect(Object.keys(useTerminalScreen.getState().tabs[0].panes)).toHaveLength(2));
  });

  it("keeps the ⋯ menu open across the corner label's own mouseleave so a menu item click lands (I1)", async () => {
    renderTerminal();
    await waitFor(() => expect(useTerminalScreen.getState().loaded).toBe(true));
    await act(async () => {
      await useTerminalScreen.getState().newTab("/wt/a");
    });
    const label = screen.getByLabelText("Terminal pane in a", { selector: ".term-screen-corner" });
    fireEvent.focus(label);
    fireEvent.click(within(label).getByRole("button", { name: "More pane actions" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();

    // The bug: moving the pointer off the corner label toward the portaled
    // menu fired this mouseleave, which used to also reset `menuAt`,
    // unmounting `Menu` before the item's click could land.
    fireEvent.mouseLeave(label);
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Clear pane" }));
    await waitFor(() => expect(vi.mocked(writeTerminal)).toHaveBeenCalledWith("pty-1", new TextEncoder().encode("\x0c")));
    // `Menu` closes itself on select (its own `onClose`), same as before.
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("keeps the same CliPane instance mounted across a broadcast toggle — no remount (AC6)", async () => {
    renderTerminal();
    await waitFor(() => expect(useTerminalScreen.getState().loaded).toBe(true));
    await act(async () => {
      await useTerminalScreen.getState().newTab("/wt/a");
    });
    expect(cliPaneMounts).toEqual(["pty-1"]);

    fireEvent.click(screen.getByRole("button", { name: "Broadcast input" }));
    expect(useTerminalScreen.getState().tabs[0].broadcast).toBe(true);

    // Still mounted exactly once: the broadcast toggle only changed
    // CliPane's `interceptInput` prop, not the `sessionId` it is keyed on.
    expect(cliPaneMounts).toEqual(["pty-1"]);
    expect(screen.getByTestId("clipane-pty-1")).toBeInTheDocument();
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
  renderTerminal(
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
