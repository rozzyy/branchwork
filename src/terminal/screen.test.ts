import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalScreen } from "./screen";
import { closeTerminal, onTerminalExit, spawnTerminal, writeTerminal } from "../ipc/pty";
import { loadSetting, saveSetting } from "../ipc/settings";
import { ask } from "../ui/dialog";
import { useToasts } from "../ui/toast";
import { useWorktrees } from "../state/worktrees";

vi.mock("../ipc/pty", () => ({
  spawnTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  writeTerminal: vi.fn(),
  onTerminalExit: vi.fn(),
}));

vi.mock("../ipc/settings", () => ({
  loadSetting: vi.fn(),
  saveSetting: vi.fn(),
}));

vi.mock("../ui/dialog", () => ({
  ask: vi.fn(),
}));

const adoptExisting = vi.fn();
const detachTab = vi.fn();
vi.mock("./dock", () => ({
  useDock: {
    getState: () => ({ adoptExisting, detachTab }),
  },
}));

type ExitEvent = { sessionId: string; exitCode: number | null; signal: string | null };

let exitHandler: ((event: ExitEvent) => void) | null = null;
let sessionCounter = 0;

function resetScreen() {
  useTerminalScreen.setState({ tabs: [], selectedTabId: null, loaded: false });
}

async function flushSave() {
  await new Promise((resolve) => setTimeout(resolve, 350));
}

function onlyTab() {
  const tabs = useTerminalScreen.getState().tabs;
  expect(tabs).toHaveLength(1);
  return tabs[0];
}

beforeEach(async () => {
  sessionCounter = 0;
  vi.mocked(spawnTerminal)
    .mockReset()
    .mockImplementation(async () => ({ sessionId: `pty-${(sessionCounter += 1)}` }));
  vi.mocked(closeTerminal).mockReset().mockResolvedValue(undefined);
  vi.mocked(writeTerminal).mockReset().mockResolvedValue(undefined);
  vi.mocked(onTerminalExit).mockReset().mockImplementation((callback: (event: ExitEvent) => void) => {
    exitHandler = callback;
    return Promise.resolve(() => {});
  });
  vi.mocked(loadSetting).mockReset().mockResolvedValue(null);
  vi.mocked(saveSetting).mockReset().mockResolvedValue(undefined);
  vi.mocked(ask).mockReset().mockResolvedValue(true);
  adoptExisting.mockReset();
  detachTab.mockReset().mockReturnValue(null);
  useToasts.setState({ toasts: [] });
  useWorktrees.setState({ activePath: "/wt/a" });
  resetScreen();
  await useTerminalScreen.getState().load();
});

describe("tabs and splits", () => {
  it("opens a new tab with a spawned shell and selects it", async () => {
    const id = await useTerminalScreen.getState().newTab("/wt/a");
    expect(id).toBeTruthy();
    const tab = onlyTab();
    expect(tab.panes[tab.focusedPaneId!]).toMatchObject({ worktreePath: "/wt/a", cwd: "/wt/a" });
    expect(spawnTerminal).toHaveBeenCalledWith("/wt/a", 80, 24, undefined);
    expect(useTerminalScreen.getState().selectedTabId).toBe(id);
  });

  it("starts the shell with the given environment", async () => {
    await useTerminalScreen.getState().newTab("/wt/a", { CLAUDE_CONFIG_DIR: "/p" });
    expect(spawnTerminal).toHaveBeenCalledWith("/wt/a", 80, 24, { CLAUDE_CONFIG_DIR: "/p" });
  });

  it("refuses a new tab without a worktree", async () => {
    useWorktrees.setState({ activePath: null });
    expect(await useTerminalScreen.getState().newTab()).toBeNull();
    expect(spawnTerminal).not.toHaveBeenCalled();
  });

  it("splits the focused pane and spawns in the same worktree", async () => {
    await useTerminalScreen.getState().newTab("/wt/a");
    const tab = onlyTab();
    await useTerminalScreen.getState().splitFocusedPane(tab.id, "h");
    const next = onlyTab();
    expect(Object.keys(next.panes)).toHaveLength(2);
    expect(spawnTerminal).toHaveBeenCalledTimes(2);
    expect(next.focusedPaneId).not.toBe(tab.focusedPaneId);
    await useTerminalScreen.getState().splitFocusedPane(next.id, "v");
    expect(Object.keys(onlyTab().panes)).toHaveLength(3);
  });

  it("moves focus and toggles maximize and broadcast", async () => {
    await useTerminalScreen.getState().newTab("/wt/a");
    const tab = onlyTab();
    await useTerminalScreen.getState().splitFocusedPane(tab.id, "h");
    const two = onlyTab();
    const [first, second] = Object.keys(two.panes);
    useTerminalScreen.getState().moveFocus(two.id, "left");
    expect(onlyTab().focusedPaneId).toBe(first);
    useTerminalScreen.getState().moveFocus(two.id, "right");
    expect(onlyTab().focusedPaneId).toBe(second);
    useTerminalScreen.getState().toggleMaximize(two.id);
    expect(onlyTab().maximizedPaneId).toBe(second);
    useTerminalScreen.getState().toggleMaximize(two.id);
    expect(onlyTab().maximizedPaneId).toBeNull();
    useTerminalScreen.getState().toggleBroadcast(two.id);
    expect(onlyTab().broadcast).toBe(true);
  });
});

describe("closing", () => {
  it("asks for confirmation while the process is still running", async () => {
    await useTerminalScreen.getState().newTab("/wt/a");
    const tab = onlyTab();
    vi.mocked(ask).mockResolvedValueOnce(null);
    await useTerminalScreen.getState().closeFocusedPane(tab.id);
    expect(ask).toHaveBeenCalled();
    expect(Object.keys(onlyTab().panes)).toHaveLength(1);
    expect(closeTerminal).not.toHaveBeenCalled();

    await useTerminalScreen.getState().closeFocusedPane(tab.id);
    expect(closeTerminal).toHaveBeenCalledTimes(1);
    expect(useTerminalScreen.getState().tabs).toHaveLength(0);
  });

  it("closes an exited pane without asking", async () => {
    await useTerminalScreen.getState().newTab("/wt/a");
    const tab = onlyTab();
    const pane = tab.panes[tab.focusedPaneId!];
    exitHandler?.({ sessionId: pane.sessionId!, exitCode: 0, signal: null });
    await useTerminalScreen.getState().closeFocusedPane(tab.id);
    expect(ask).not.toHaveBeenCalled();
    expect(closeTerminal).toHaveBeenCalledWith(pane.sessionId);
  });

  it("confirms closing a tab with running panes", async () => {
    await useTerminalScreen.getState().newTab("/wt/a");
    const tab = onlyTab();
    await useTerminalScreen.getState().closeTab(tab.id);
    expect(ask).toHaveBeenCalled();
    expect(closeTerminal).toHaveBeenCalledTimes(1);
    expect(useTerminalScreen.getState().tabs).toHaveLength(0);
  });
});

describe("pane actions", () => {
  it("broadcasts input to every live pane and skips exited ones", async () => {
    await useTerminalScreen.getState().newTab("/wt/a");
    const tab = onlyTab();
    await useTerminalScreen.getState().splitFocusedPane(tab.id, "h");
    const two = onlyTab();
    const ids = Object.keys(two.panes);
    useTerminalScreen.getState().toggleBroadcast(two.id);
    exitHandler?.({ sessionId: two.panes[ids[0]].sessionId!, exitCode: 0, signal: null });
    const consumed = useTerminalScreen.getState().broadcastInput(two.id, "ls\n");
    expect(consumed).toBe(true);
    expect(writeTerminal).toHaveBeenCalledTimes(1);
    const [target, data] = vi.mocked(writeTerminal).mock.calls[0];
    expect(target).toBe(two.panes[ids[1]].sessionId);
    expect(new TextDecoder().decode(data)).toBe("ls\n");
  });

  it("switches a pane's worktree by running cd", async () => {
    await useTerminalScreen.getState().newTab("/wt/a");
    const tab = onlyTab();
    const paneId = tab.focusedPaneId!;
    await useTerminalScreen.getState().setPaneWorktree(tab.id, paneId, "/wt/b");
    const pane = onlyTab().panes[paneId];
    expect(pane.worktreePath).toBe("/wt/b");
    expect(pane.cwd).toBe("/wt/b");
    const data = vi.mocked(writeTerminal).mock.calls[0][1];
    expect(new TextDecoder().decode(data)).toBe("cd '/wt/b'\n");
  });

  it("quotes single quotes when switching worktrees", async () => {
    await useTerminalScreen.getState().newTab("/wt/a");
    const tab = onlyTab();
    await useTerminalScreen.getState().setPaneWorktree(tab.id, tab.focusedPaneId!, "/wt/o'brien");
    const data = vi.mocked(writeTerminal).mock.calls[0][1];
    expect(new TextDecoder().decode(data)).toBe("cd '/wt/o'\\''brien'\n");
  });

  it("clears a live pane with a form feed", async () => {
    await useTerminalScreen.getState().newTab("/wt/a");
    const tab = onlyTab();
    await useTerminalScreen.getState().clearPane(tab.id, tab.focusedPaneId!);
    const data = vi.mocked(writeTerminal).mock.calls[0][1];
    expect(Array.from(data)).toEqual([0x0c]);
  });
});

describe("moves", () => {
  it("moves a pane to a new tab without killing its session", async () => {
    await useTerminalScreen.getState().newTab("/wt/a");
    const tab = onlyTab();
    await useTerminalScreen.getState().splitFocusedPane(tab.id, "h");
    const two = onlyTab();
    const moving = two.focusedPaneId!;
    const sessionId = two.panes[moving].sessionId;
    const created = await useTerminalScreen.getState().movePaneToNewTab(two.id, moving);
    expect(created).toBeTruthy();
    expect(closeTerminal).not.toHaveBeenCalled();
    expect(useTerminalScreen.getState().tabs).toHaveLength(2);
    const adopted = useTerminalScreen.getState().tabs.find((t) => t.id === created)!;
    expect(Object.values(adopted.panes)[0].sessionId).toBe(sessionId);
  });

  it("moves a live pane to the dock through adoption", async () => {
    await useTerminalScreen.getState().newTab("/wt/a");
    const tab = onlyTab();
    const paneId = tab.focusedPaneId!;
    const sessionId = tab.panes[paneId].sessionId;
    expect(await useTerminalScreen.getState().movePaneToDock(tab.id, paneId)).toBe(true);
    expect(closeTerminal).not.toHaveBeenCalled();
    expect(adoptExisting).toHaveBeenCalledWith("/wt/a", sessionId);
    expect(useTerminalScreen.getState().tabs).toHaveLength(0);
  });

  it("refuses to move an exited pane to the dock", async () => {
    await useTerminalScreen.getState().newTab("/wt/a");
    const tab = onlyTab();
    const pane = tab.panes[tab.focusedPaneId!];
    exitHandler?.({ sessionId: pane.sessionId!, exitCode: 0, signal: null });
    expect(await useTerminalScreen.getState().movePaneToDock(tab.id, pane.id)).toBe(false);
    expect(adoptExisting).not.toHaveBeenCalled();
  });

  it("adopts a detached dock tab as a new screen tab", () => {
    detachTab.mockReturnValue({ id: "dock-1", worktreePath: "/wt/b", sessionId: "pty-dock" });
    useTerminalScreen.getState().adoptDockTab("dock-1");
    const tabs = useTerminalScreen.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(Object.values(tabs[0].panes)[0]).toMatchObject({
      worktreePath: "/wt/b",
      sessionId: "pty-dock",
    });
    expect(spawnTerminal).not.toHaveBeenCalled();
  });
});

describe("persistence", () => {
  it("saves tabs with layout trees and pane worktrees", async () => {
    await useTerminalScreen.getState().newTab("/wt/a");
    const tab = onlyTab();
    await useTerminalScreen.getState().splitFocusedPane(tab.id, "v");
    await flushSave();
    const calls = vi.mocked(saveSetting).mock.calls;
    const saved = calls[calls.length - 1]?.[1] as {
      tabs: Array<{ layout: unknown; panes: unknown[] }>;
    };
    expect(saved.tabs).toHaveLength(1);
    expect(saved.tabs[0].layout).toMatchObject({ kind: "split", dir: "v" });
    expect(saved.tabs[0].panes).toHaveLength(2);
  });

  it("restores fresh shells and returns to the saved cwd", async () => {
    vi.mocked(loadSetting).mockResolvedValue({
      tabs: [
        {
          id: "tab-1",
          name: "a",
          layout: {
            kind: "split",
            id: "s",
            dir: "h",
            children: [
              { kind: "pane", id: "p1" },
              { kind: "pane", id: "p2" },
            ],
            sizes: [0.4, 0.6],
          },
          focusedPaneId: "p2",
          maximizedPaneId: null,
          broadcast: true,
          panes: [
            { id: "p1", worktreePath: "/wt/a", cwd: "/wt/a/sub" },
            { id: "p2", worktreePath: "/wt/a", cwd: "/wt/a" },
          ],
        },
      ],
      selectedTabId: "tab-1",
    });
    resetScreen();
    await useTerminalScreen.getState().load();
    const tab = onlyTab();
    expect(tab.focusedPaneId).toBe("p2");
    expect(tab.broadcast).toBe(true);
    expect(tab.layout).toMatchObject({ kind: "split", sizes: [0.4, 0.6] });
    expect(spawnTerminal).toHaveBeenCalledTimes(2);
    const cdWrites = vi
      .mocked(writeTerminal)
      .mock.calls.map((call) => new TextDecoder().decode(call[1]));
    expect(cdWrites).toEqual(["cd '/wt/a/sub'\n"]);
  });

  it("retries a failed pane without closing it", async () => {
    vi.mocked(spawnTerminal).mockRejectedValueOnce(new Error("boom"));
    await useTerminalScreen.getState().newTab("/wt/a");
    const tab = onlyTab();
    const paneId = tab.focusedPaneId!;
    expect(onlyTab().panes[paneId].error).toBe("boom");
    await useTerminalScreen.getState().retryPane(tab.id, paneId);
    const pane = onlyTab().panes[paneId];
    expect(pane.error).toBeNull();
    expect(pane.sessionId).toBeTruthy();
  });

  it("keeps tabs whose worktree is gone with an error", async () => {
    vi.mocked(loadSetting).mockResolvedValue({
      tabs: [
        {
          id: "tab-1",
          name: "gone",
          layout: { kind: "pane", id: "p1" },
          focusedPaneId: "p1",
          panes: [{ id: "p1", worktreePath: "/wt/gone", cwd: "/wt/gone" }],
        },
      ],
      selectedTabId: "tab-1",
    });
    vi.mocked(spawnTerminal).mockRejectedValue(new Error("unknown worktree"));
    resetScreen();
    await useTerminalScreen.getState().load();
    const tab = onlyTab();
    expect(tab.panes.p1.error).toBe("unknown worktree");
    expect(tab.panes.p1.sessionId).toBeNull();
  });
});
