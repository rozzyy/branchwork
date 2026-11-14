import { useStage } from "./stage";
import { initialStage } from "../stage/stageModel";
import { useToasts } from "../ui/toast";
import { useHistory, openHistory } from "./history";
import { migrateScreenId } from "../screens/registry";

beforeEach(() => {
  localStorage.clear();
  useStage.setState({ ...initialStage });
  useHistory.setState({ mode: "graph", file: null });
  useToasts.setState({ toasts: [] });
});

it("opens and toggles a split", () => {
  useStage.getState().go("agents");
  useStage.getState().openSplit("changes", "right");
  expect(useStage.getState().panes).toEqual(["agents", "changes"]);
  useStage.getState().toggleSplit("right");
  expect(useStage.getState().panes).toEqual(["agents"]);
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
  useStage.setState({ ...initialStage });
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
