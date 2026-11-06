import { useStage } from "./stage";
import { initialStage } from "../stage/stageModel";
import { useToasts } from "../ui/toast";

beforeEach(() => {
  localStorage.clear();
  useStage.setState({ ...initialStage });
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
  useStage.getState().openSplit("launchpad", "right");
  expect(useStage.getState().panes).toEqual(["launchpad"]);
  expect(useToasts.getState().toasts[0].title).toBe("Launchpad is already open");
});

it("persists and restores the layout", async () => {
  vi.useFakeTimers();
  useStage.getState().openSplit("graph", "bottom");
  vi.advanceTimersByTime(400);
  vi.useRealTimers();
  await new Promise((r) => setTimeout(r, 0));
  useStage.setState({ ...initialStage });
  await useStage.getState().load();
  expect(useStage.getState().panes).toEqual(["launchpad", "graph"]);
  expect(useStage.getState().dir).toBe("v");
});
