import { initialStage, navigate, setFocus, type StageState } from "./stageModel";
import { closePane, isValidStage, nearestSide, openSplit, setRatio, swap, toggleDir } from "./stageModel";

const two: StageState = { panes: ["agents", "changes"], focus: 0, dir: "h", ratio: 0.5 };
const one: StageState = { panes: ["agents"], focus: 0, dir: "h", ratio: 0.5 };

describe("navigate", () => {
  it("replaces the focused pane's screen", () => {
    expect(navigate(initialStage, "history").panes).toEqual(["history"]);
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

describe("openSplit", () => {
  it("opens a right split and focuses it", () => {
    expect(openSplit(one, "changes", "right")).toEqual({ panes: ["agents", "changes"], focus: 1, dir: "h", ratio: 0.5 });
  });
  it("opens a left split", () => {
    expect(openSplit(one, "changes", "left").panes).toEqual(["changes", "agents"]);
  });
  it("uses vertical orientation for top/bottom", () => {
    const s = openSplit(one, "files", "bottom");
    expect(s.dir).toBe("v");
    expect(s.panes).toEqual(["agents", "files"]);
    expect(openSplit(one, "files", "top").panes).toEqual(["files", "agents"]);
  });
  it("does nothing when the only pane already shows the screen", () => {
    expect(openSplit(one, "agents", "right")).toBe(one);
  });
  it("replaces the target side when already split", () => {
    expect(openSplit(two, "history", "right").panes).toEqual(["agents", "history"]);
  });
  it("swaps instead of duplicating when the screen is on the other side", () => {
    expect(openSplit(two, "agents", "right").panes).toEqual(["changes", "agents"]);
  });
});

describe("closePane / swap / toggleDir / setRatio", () => {
  it("closes a pane and keeps the other", () => {
    expect(closePane(two, 0)).toEqual({ ...two, panes: ["changes"], focus: 0 });
    expect(closePane(one, 0)).toBe(one);
  });
  it("swaps panes and keeps focus on the same screen", () => {
    const s = swap({ ...two, focus: 0 });
    expect(s.panes).toEqual(["changes", "agents"]);
    expect(s.focus).toBe(1);
  });
  it("toggles orientation", () => {
    expect(toggleDir(two).dir).toBe("v");
  });
  it("clamps the ratio to 0.2–0.8", () => {
    expect(setRatio(two, 0.05).ratio).toBe(0.2);
    expect(setRatio(two, 0.95).ratio).toBe(0.8);
  });
});

describe("nearestSide", () => {
  it("picks the closest edge", () => {
    expect(nearestSide(0.1, 0.5)).toBe("left");
    expect(nearestSide(0.9, 0.5)).toBe("right");
    expect(nearestSide(0.5, 0.05)).toBe("top");
    expect(nearestSide(0.5, 0.97)).toBe("bottom");
  });
});

describe("isValidStage", () => {
  it("accepts well-formed state", () => {
    expect(isValidStage(two)).toBe(true);
  });
  it("rejects unknown screens, duplicates, and bad focus", () => {
    expect(isValidStage({ ...two, panes: ["nope"] })).toBe(false);
    expect(isValidStage({ ...two, panes: ["agents", "agents"] })).toBe(false);
    expect(isValidStage({ ...two, focus: 3 })).toBe(false);
    expect(isValidStage(null)).toBe(false);
  });
});
