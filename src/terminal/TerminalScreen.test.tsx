import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalScreen } from "./screen";
import { TerminalScreen } from "./TerminalScreen";
import { spawnTerminal } from "../ipc/pty";
import { loadSetting, saveSetting } from "../ipc/settings";
import { useWorktrees } from "../state/worktrees";

vi.mock("../ipc/pty", () => ({
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
  useWorktrees.setState({ activePath: "/wt/a" });
  useTerminalScreen.setState({ tabs: [], selectedTabId: null, loaded: false });
});

function key(target: Element, init: KeyboardEventInit & { code: string }): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
}

describe("TerminalScreen", () => {
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
