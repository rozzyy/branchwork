import { initialStage, navigate, setFocus, type StageState } from "./stageModel";

const two: StageState = { panes: ["agents", "changes"], focus: 0, dir: "h", ratio: 0.5 };

describe("navigate", () => {
  it("replaces the focused pane's screen", () => {
    expect(navigate(initialStage, "graph").panes).toEqual(["graph"]);
  });
  it("focuses the other pane if it already shows that screen", () => {
    const s = navigate(two, "changes");
    expect(s.panes).toEqual(["agents", "changes"]);
    expect(s.focus).toBe(1);
  });
});

describe("setFocus", () => {
  it("ignores out-of-range panes", () => {
    expect(setFocus(initialStage, 1)).toBe(initialStage);
    expect(setFocus(two, 1).focus).toBe(1);
  });
});
