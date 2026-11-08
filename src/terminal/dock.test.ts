import { useDock } from "./dock";
import { closeTerminal, onTerminalExit, spawnTerminal } from "../ipc/pty";
import { loadSetting, saveSetting } from "../ipc/settings";
import { useToasts } from "../ui/toast";
import { useWorktrees } from "../state/worktrees";

vi.mock("../ipc/pty", () => ({
  spawnTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  onTerminalExit: vi.fn(),
}));

type ExitEvent = { sessionId: string; exitCode: number | null; signal: string | null };

let exitHandler: ((event: ExitEvent) => void) | null = null;

vi.mock("../ipc/settings", () => ({
  loadSetting: vi.fn(),
  saveSetting: vi.fn(),
}));

function resetDock() {
  useDock.setState({
    open: false,
    mode: "bottom",
    bottomHeight: 260,
    rightWidth: 400,
    floating: { x: 80, y: 80, width: 720, height: 420 },
    tabs: [],
    selectedId: null,
    splitIds: null,
    loaded: false,
  });
}

beforeEach(async () => {
  vi.mocked(spawnTerminal).mockReset().mockImplementation(async (worktreePath: string) => ({ sessionId: `pty:${worktreePath}` }));
  vi.mocked(closeTerminal).mockReset().mockResolvedValue(undefined);
  vi.mocked(onTerminalExit).mockReset().mockImplementation((callback: (event: ExitEvent) => void) => {
    exitHandler = callback;
    return Promise.resolve(() => {});
  });
  vi.mocked(loadSetting).mockReset().mockResolvedValue(null);
  vi.mocked(saveSetting).mockReset().mockResolvedValue(undefined);
  useToasts.setState({ toasts: [] });
  useWorktrees.setState({ activePath: null });
  resetDock();
  // Installs the shared exit subscription once (later calls are no-ops);
  // the captured handler looks tabs up live, so it serves every test.
  await useDock.getState().load();
});

async function flushSave() {
  await new Promise((resolve) => setTimeout(resolve, 350));
}

it("persists mode and geometry and restores them on load", async () => {
  useDock.getState().setMode("right");
  useDock.getState().setRightWidth(500);
  useDock.getState().setBottomHeight(300);
  useDock.getState().setFloating({ x: 10, y: 20, width: 800, height: 500 });
  await flushSave();

  expect(saveSetting).toHaveBeenCalled();
  const calls = vi.mocked(saveSetting).mock.calls;
  const saved = calls[calls.length - 1]?.[1] as Record<string, unknown>;
  expect(saved["mode"]).toBe("right");
  expect(saved["rightWidth"]).toBe(500);
  expect(saved["bottomHeight"]).toBe(300);
  expect(saved["floating"]).toEqual({ x: 10, y: 20, width: 800, height: 500 });

  vi.mocked(loadSetting).mockResolvedValue(saved);
  resetDock();
  await useDock.getState().load();
  const state = useDock.getState();
  expect(state.mode).toBe("right");
  expect(state.rightWidth).toBe(500);
  expect(state.bottomHeight).toBe(300);
  expect(state.floating).toEqual({ x: 10, y: 20, width: 800, height: 500 });
  expect(state.loaded).toBe(true);
});

it("creates, switches, and closes tabs with PTY cleanup", async () => {
  const first = await useDock.getState().newTab("/wt/a");
  const second = await useDock.getState().newTab("/wt/b");
  expect(first).toBeTruthy();
  expect(second).toBeTruthy();
  expect(spawnTerminal).toHaveBeenCalledWith("/wt/a", 80, 24);
  expect(useDock.getState().selectedId).toBe(second);

  useDock.getState().select(first!);
  expect(useDock.getState().selectedId).toBe(first);

  // Hiding the dock preserves every session.
  useDock.getState().setOpen(false);
  expect(closeTerminal).not.toHaveBeenCalled();

  await useDock.getState().closeTab(first!);
  expect(closeTerminal).toHaveBeenCalledWith("pty:/wt/a");
  expect(useDock.getState().tabs.map((tab) => tab.id)).toEqual([second]);
  // Saved metadata drops the closed tab.
  await flushSave();
  const calls = vi.mocked(saveSetting).mock.calls;
  const saved = calls[calls.length - 1]?.[1] as { tabs: unknown[] };
  expect(saved.tabs).toHaveLength(1);
});

it("splits two sessions side by side and swaps them", async () => {
  const first = await useDock.getState().newTab("/wt/a");
  const second = await useDock.getState().newTab("/wt/b");
  useDock.getState().select(first!);

  await useDock.getState().toggleSplit();
  expect(useDock.getState().splitIds).toEqual([first, second]);

  useDock.getState().swapSplit();
  expect(useDock.getState().splitIds).toEqual([second, first]);
  expect(useDock.getState().selectedId).toBe(second);

  await useDock.getState().toggleSplit();
  expect(useDock.getState().splitIds).toBeNull();
});

it("restores fresh shells and keeps tabs whose worktree is gone", async () => {
  vi.mocked(loadSetting).mockResolvedValue({
    mode: "bottom",
    tabs: [
      { id: "t1", worktreePath: "/wt/ok" },
      { id: "t2", worktreePath: "/wt/gone" },
    ],
    selectedId: "t2",
    splitIds: ["t2", "t1"],
  });
  vi.mocked(spawnTerminal).mockImplementation(async (worktreePath: string) => {
    if (worktreePath === "/wt/gone") throw new Error("not found");
    return { sessionId: "pty:ok" };
  });

  await useDock.getState().load();

  const state = useDock.getState();
  expect(state.tabs).toHaveLength(2);
  expect(state.tabs.find((tab) => tab.id === "t1")?.sessionId).toBe("pty:ok");
  const failed = state.tabs.find((tab) => tab.id === "t2");
  expect(failed?.sessionId).toBeNull();
  expect(failed?.error).toBeTruthy();
  expect(state.selectedId).toBe("t2");
  expect(state.splitIds).toEqual(["t2", "t1"]);
  expect(useToasts.getState().toasts.length).toBeGreaterThan(0);
});

it("closes the PTY when its tab is closed while the spawn is in flight", async () => {
  let resolveSpawn!: (session: { sessionId: string }) => void;
  vi.mocked(spawnTerminal).mockImplementationOnce(
    () =>
      new Promise<{ sessionId: string }>((resolve) => {
        resolveSpawn = resolve;
      }),
  );
  const pending = useDock.getState().newTab("/wt/a");
  const tabId = useDock.getState().tabs[0]?.id;
  expect(tabId).toBeTruthy();
  await useDock.getState().closeTab(tabId!);
  expect(useDock.getState().tabs).toHaveLength(0);
  resolveSpawn({ sessionId: "pty:orphan" });
  await pending;
  expect(closeTerminal).toHaveBeenCalledWith("pty:orphan");
  expect(useDock.getState().tabs).toHaveLength(0);
});

it("ignores a second retry while a spawn is in flight", async () => {
  useDock.setState({
    tabs: [{ id: "t1", worktreePath: "/wt/a", sessionId: null, error: "boom" }],
    selectedId: "t1",
  });
  const resolvers: Array<(session: { sessionId: string }) => void> = [];
  vi.mocked(spawnTerminal).mockImplementation(
    () =>
      new Promise<{ sessionId: string }>((resolve) => {
        resolvers.push(resolve);
      }),
  );
  const first = useDock.getState().retryTab("t1");
  const second = useDock.getState().retryTab("t1");
  expect(spawnTerminal).toHaveBeenCalledTimes(1);
  expect(resolvers).toHaveLength(1);
  resolvers[0]?.({ sessionId: "pty:retry" });
  await first;
  await second;
  expect(spawnTerminal).toHaveBeenCalledTimes(1);
  const tab = useDock.getState().tabs.find((item) => item.id === "t1");
  expect(tab?.sessionId).toBe("pty:retry");
  expect(tab?.error).toBeNull();
});

it("does not respawn a tab that already has a live session", async () => {
  useDock.setState({
    tabs: [{ id: "t1", worktreePath: "/wt/a", sessionId: "pty:live", error: null }],
    selectedId: "t1",
  });
  await useDock.getState().retryTab("t1");
  expect(spawnTerminal).not.toHaveBeenCalled();
  expect(useDock.getState().tabs.find((item) => item.id === "t1")?.sessionId).toBe("pty:live");
});

it("closes the tab when its session exits cleanly", async () => {
  await useDock.getState().load();
  useDock.setState({
    tabs: [{ id: "t1", worktreePath: "/wt/a", sessionId: "pty:done", error: null }],
    selectedId: "t1",
  });
  expect(exitHandler).not.toBeNull();
  exitHandler!({ sessionId: "pty:done", exitCode: 0, signal: null });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(closeTerminal).toHaveBeenCalledWith("pty:done");
  expect(useDock.getState().tabs).toHaveLength(0);
});

it("keeps the tab when its session dies abnormally", async () => {
  await useDock.getState().load();
  useDock.setState({
    tabs: [{ id: "t1", worktreePath: "/wt/a", sessionId: "pty:dead", error: null }],
    selectedId: "t1",
  });
  expect(exitHandler).not.toBeNull();
  exitHandler!({ sessionId: "pty:dead", exitCode: 1, signal: null });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(closeTerminal).not.toHaveBeenCalled();
  expect(useDock.getState().tabs).toHaveLength(1);
});

it("refuses to open a tab without an active worktree", async () => {
  const id = await useDock.getState().newTab();
  expect(id).toBeNull();
  expect(spawnTerminal).not.toHaveBeenCalled();
  expect(useDock.getState().tabs).toHaveLength(0);
  expect(useToasts.getState().toasts.length).toBeGreaterThan(0);
});

it("starts a new tab in the active worktree by default", async () => {
  useWorktrees.setState({ activePath: "/wt/active" });
  const id = await useDock.getState().newTab();
  expect(id).toBeTruthy();
  expect(spawnTerminal).toHaveBeenCalledWith("/wt/active", 80, 24);
  expect(useDock.getState().open).toBe(true);
});
