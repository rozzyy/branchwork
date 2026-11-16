import { useStage, stageSnapshot } from "./stage";
import { initialStage, layoutOf } from "../stage/stageModel";
import { useToasts } from "../ui/toast";
import { useHistory, openHistory } from "./history";
import { migrateScreenId } from "../screens/registry";

beforeEach(() => {
  localStorage.clear();
  useStage.setState(stageSnapshot(initialStage));
  useHistory.setState({ mode: "graph", file: null });
  useToasts.setState({ toasts: [] });
});

it("opens splits up to four panes and toasts on the fifth", () => {
  useStage.getState().go("agents");
  useStage.getState().openSplit("changes", "right");
  useStage.getState().openSplit("history", "bottom");
  useStage.getState().openSplit("files", "right", 0);
  expect(useStage.getState().panes).toEqual(["agents", "files", "changes", "history"]);
  useStage.getState().openSplit("terminal", "right");
  expect(useStage.getState().panes).toHaveLength(4);
  expect(useToasts.getState().toasts.slice(-1)[0].title).toBe("Up to 4 panes; close one first");
  useStage.getState().closePane(1);
  expect(useStage.getState().panes).toEqual(["agents", "changes", "history"]);
});

it("persists a nested layout and tab workspace as version 4", async () => {
  vi.useFakeTimers();
  useStage.getState().openSplit("changes", "right");
  useStage.getState().openSplit("history", "bottom");
  const firstTree = useStage.getState().tree;
  const firstFocusId = useStage.getState().focusId;
  const first = useStage.getState().activeTabId;
  const second = useStage.getState().newTab("agents")!;
  useStage.getState().renameTab(second, "Agent review");
  useStage.getState().activateTab(first);
  vi.advanceTimersByTime(400);
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 0));
  expect(JSON.parse(localStorage.getItem("bw:stage")!).version).toBe(4);
  useStage.setState(stageSnapshot(initialStage));
  await useStage.getState().load();
  expect(useStage.getState().tabs).toHaveLength(2);
  expect(useStage.getState().activeTabId).toBe(first);
  expect(useStage.getState().tree).toEqual(firstTree);
  expect(useStage.getState().focusId).toBe(firstFocusId);
  expect(useStage.getState().tabs.find((tab) => tab.id === second)?.name).toBe("Agent review");
  expect(useStage.getState().panes).toEqual(["home", "changes", "history"]);
  useStage.getState().activateTab(second);
  expect(useStage.getState().tabs.find((tab) => tab.id === second)?.name).toBe("Agent review");
  expect(useStage.getState().panes).toEqual(["agents"]);
});

it("keeps split trees separate while switching stage tabs", () => {
  useStage.getState().go("agents");
  useStage.getState().openSplit("changes", "right");
  const first = useStage.getState().activeTabId;
  const focusId = useStage.getState().focusId;
  const second = useStage.getState().newTab("history")!;
  expect(useStage.getState().panes).toEqual(["history"]);
  useStage.getState().activateTab(first);
  expect(useStage.getState().panes).toEqual(["agents", "changes"]);
  expect(useStage.getState().focusId).toBe(focusId);
  useStage.getState().focusPane(0);
  useStage.getState().activateTab(second);
  expect(useStage.getState().panes).toEqual(["history"]);
  useStage.getState().activateTab(first);
  expect(useStage.getState().focus).toBe(0);
});

it("renames tabs with trimmed bounded names and closes to the previous neighbor", () => {
  const first = useStage.getState().activeTabId;
  const second = useStage.getState().newTab("changes")!;
  expect(useStage.getState().renameTab(second, "  Review  ")).toBe(true);
  expect(useStage.getState().tabs.find((tab) => tab.id === second)?.name).toBe("Review");
  expect(useStage.getState().renameTab(second, "   ")).toBe(false);
  expect(useStage.getState().renameTab(second, "x".repeat(41))).toBe(false);
  expect(useStage.getState().closeTab(second)).toBe(true);
  expect(useStage.getState().activeTabId).toBe(first);
  expect(useStage.getState().closeTab(first)).toBe(false);
});

it("caps workspaces at eight tabs", () => {
  for (let i = 1; i < 8; i++) expect(useStage.getState().newTab()).not.toBeNull();
  expect(useStage.getState().tabs).toHaveLength(8);
  expect(useStage.getState().newTab()).toBeNull();
  const toasts = useToasts.getState().toasts;
  expect(toasts[toasts.length - 1]?.title).toBe("Up to 8 tabs; close one first");
});

it("toasts instead of duplicating the only open screen", () => {
  useStage.getState().openSplit("home", "right");
  expect(useStage.getState().panes).toEqual(["home"]);
  expect(useToasts.getState().toasts[0].title).toBe("Home is already open");
});

it("persists and restores the layout", async () => {
  vi.useFakeTimers();
  useStage.getState().openSplit("history", "bottom");
  vi.advanceTimersByTime(400);
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 0));
  useStage.setState(stageSnapshot(initialStage));
  await useStage.getState().load();
  expect(useStage.getState().panes).toEqual(["home", "history"]);
  expect(useStage.getState().dir).toBe("v");
});

it("migrates saved stage panes", async () => {
  localStorage.setItem("bw:stage", JSON.stringify({ panes: ["graph", "blame"], focus: 0, dir: "h", ratio: 0.5 }));
  await useStage.getState().load();
  expect(useStage.getState().panes).toEqual(["history"]);
  expect(useStage.getState().focus).toBe(0);
  expect(useHistory.getState().mode).toBe("graph");

  localStorage.setItem("bw:stage", JSON.stringify({ panes: ["launchpad", "repo"], focus: 0, dir: "h", ratio: 0.5 }));
  await useStage.getState().load();
  expect(useStage.getState().panes).toEqual(["home", "github"]);

  localStorage.setItem("bw:stage", JSON.stringify({ panes: ["bogus"], focus: 0, dir: "h", ratio: 0.5 }));
  await useStage.getState().load();
  expect(useStage.getState().panes).toEqual(["home"]);
});

it("migrates a saved v2 workspace into one stage tab", async () => {
  const stage = layoutOf(["agents", "history"]);
  localStorage.setItem("bw:stage", JSON.stringify({ version: 2, current: stage, layouts: {} }));
  await useStage.getState().load();
  expect(useStage.getState().panes).toEqual(["agents", "history"]);
  expect(useStage.getState().tabs).toHaveLength(1);
});

it("rejects oversized and malformed v3 workspaces safely", async () => {
  const tooMany = Array.from({ length: 9 }, (_, index) => ({ id: `tab-${index}`, name: `Tab ${index}`, stage: initialStage }));
  localStorage.setItem("bw:stage", JSON.stringify({ version: 3, current: { tabs: tooMany, activeTabId: "tab-0" }, layouts: {} }));
  await useStage.getState().load();
  expect(useStage.getState().tabs).toHaveLength(1);
  expect(useStage.getState().panes).toEqual(["home"]);

  localStorage.setItem("bw:stage", JSON.stringify({
    version: 3,
    current: { tabs: [{ id: "../bad", name: "Bad", stage: initialStage }], activeTabId: "../bad" },
    layouts: {},
  }));
  await useStage.getState().load();
  expect(useStage.getState().tabs).toHaveLength(1);
  expect(useStage.getState().panes).toEqual(["home"]);
});

it("maps legacy screen ids and opens History at a file", () => {
  expect(migrateScreenId("inbox")).toEqual({ screen: "home" });
  expect(migrateScreenId("compare")).toEqual({ screen: "home" });
  expect(migrateScreenId("graph")).toEqual({ screen: "history", historyMode: "graph" });
  expect(migrateScreenId("blame")).toEqual({ screen: "history", historyMode: "file" });
  expect(migrateScreenId("rebase")).toEqual({ screen: "history", historyMode: "rewrite" });
  expect(migrateScreenId("repo")).toEqual({ screen: "github" });
  expect(migrateScreenId("conflicts")).toEqual({ screen: "conflicts" });
  expect(migrateScreenId("settings")).toEqual({ screen: "settings" });
  expect(migrateScreenId("unknown")).toEqual({ screen: "home" });

  openHistory("file", { path: "a.ts" });
  expect(useStage.getState().panes).toEqual(["history"]);
  expect(useHistory.getState()).toMatchObject({ mode: "file", file: { path: "a.ts" } });
});

it("remembers layouts independently for each worktree", () => {
  const a = `/wt/a-${Date.now()}`;
  const b = `/wt/b-${Date.now()}`;
  const store = useStage.getState();
  store.switchWorktree(a);
  useStage.getState().setLayout(["agents", "changes"]);
  useStage.getState().switchWorktree(b);
  expect(useStage.getState().panes).toEqual(["home"]);
  useStage.getState().switchWorktree(a);
  expect(useStage.getState().panes).toEqual(["agents", "changes"]);
  useStage.getState().switchWorktree(null);
});

it("remembers each worktree's complete tab workspace", () => {
  const a = `/wt/tabs-a-${Date.now()}`;
  const b = `/wt/tabs-b-${Date.now()}`;
  useStage.getState().switchWorktree(a);
  useStage.getState().renameTab(useStage.getState().activeTabId, "A home");
  useStage.getState().newTab("agents");
  useStage.getState().switchWorktree(b);
  expect(useStage.getState().tabs).toHaveLength(1);
  useStage.getState().newTab("changes");
  useStage.getState().switchWorktree(a);
  expect(useStage.getState().tabs).toHaveLength(2);
  expect(useStage.getState().tabs[0].name).toBe("A home");
  expect(useStage.getState().panes).toEqual(["agents"]);
  useStage.getState().switchWorktree(null);
});

it("serializes and restores the tab collection for the active worktree", async () => {
  vi.useFakeTimers();
  useStage.getState().switchWorktree(null);
  const path = `/wt/tabs-restore-${Date.now()}`;
  useStage.getState().switchWorktree(path);
  const expectedTabs = useStage.getState().tabs.length + 1;
  useStage.getState().newTab("history");
  useStage.getState().renameTab(useStage.getState().activeTabId, "History work");
  vi.advanceTimersByTime(400);
  vi.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const saved = JSON.parse(localStorage.getItem("bw:stage")!);
  expect(saved.layouts[path].tabs).toHaveLength(expectedTabs);
  useStage.setState(stageSnapshot(initialStage));
  await useStage.getState().load();
  expect(useStage.getState().tabs).toHaveLength(expectedTabs);
  const restoredTabs = useStage.getState().tabs;
  expect(restoredTabs[restoredTabs.length - 1]?.name).toBe("History work");
  expect(useStage.getState().panes).toEqual(["history"]);
  useStage.getState().switchWorktree(null);
});

it("opens Agents + Changes without discarding a split layout", () => {
  useStage.getState().openPair("agents", "changes");
  expect(useStage.getState().panes).toEqual(["agents", "changes"]);

  useStage.setState(stageSnapshot(layoutOf(["home", "history", "files"])));
  useStage.getState().openPair("agents", "changes");
  // Agents fits as a fourth pane; the stage is then full, so Changes takes a
  // pane that shows neither of the pair. The other panes stay.
  expect(useStage.getState().panes).toEqual(["changes", "history", "files", "agents"]);
  expect(useStage.getState().panes[useStage.getState().focus]).toBe("changes");

  useStage.setState(stageSnapshot(layoutOf(["agents", "history"])));
  useStage.getState().openPair("agents", "changes");
  expect(useStage.getState().panes).toEqual(["agents", "history", "changes"]);
});

it("loads saved state and ignores legacy pane project pins", async () => {
  const { layoutOf } = await import("../stage/stageModel");
  const stage = layoutOf(["agents", "history"]);
  const paneId = Object.keys(stage.screens)[0];
  localStorage.setItem("bw:stage", JSON.stringify({ version: 3, current: { ...stage, paneProjects: { [paneId]: "p1" } }, layouts: {} }));
  await useStage.getState().load();
  expect("paneProjects" in useStage.getState()).toBe(false);
  expect(useStage.getState().panes).toEqual(["agents", "history"]);
});
