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

it("persists a nested layout as version 2", async () => {
  vi.useFakeTimers();
  useStage.getState().openSplit("changes", "right");
  useStage.getState().openSplit("history", "bottom");
  vi.advanceTimersByTime(400);
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 0));
  useStage.setState(stageSnapshot(initialStage));
  await useStage.getState().load();
  expect(useStage.getState().panes).toEqual(["home", "changes", "history"]);
  expect(JSON.parse(localStorage.getItem("bw:stage")!).version).toBe(2);
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
