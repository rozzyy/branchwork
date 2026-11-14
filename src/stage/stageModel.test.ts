import {
  MAX_PANES,
  canSplit,
  closePane,
  equalize,
  equalizeAll,
  layoutRects,
  fromLegacy,
  initialStage,
  isValidStage,
  layoutOf,
  leafIds,
  moveFocus,
  navigate,
  nearestSide,
  openSplit,
  panesOf,
  rootDir,
  setFocus,
  setGutter,
  swap,
  toggleDir,
  type StageState,
} from "./stageModel";

const focused = (s: StageState) => s.screens[s.focusId];
const sizesOf = (s: StageState) => (s.tree.kind === "split" ? s.tree.sizes : [1]);

describe("navigate and focus", () => {
  it("replaces the focused pane's screen, or focuses a visible one", () => {
    expect(panesOf(navigate(initialStage, "history"))).toEqual(["history"]);
    const two = openSplit(initialStage, "changes", "right");
    const back = navigate(two, "home");
    expect(panesOf(back)).toEqual(["home", "changes"]);
    expect(focused(back)).toBe("home");
  });
  it("ignores unknown panes", () => {
    expect(setFocus(initialStage, "nope")).toBe(initialStage);
  });
});

describe("openSplit", () => {
  it("adds panes up to four and refuses the fifth", () => {
    let s = openSplit(initialStage, "changes", "right");
    s = openSplit(s, "agents", "bottom");
    s = openSplit(s, "history", "right");
    expect(panesOf(s)).toHaveLength(MAX_PANES);
    expect(canSplit(s)).toBe(false);
    expect(openSplit(s, "files", "right")).toBe(s);
  });

  it("splits the focused pane by default and focuses the new pane", () => {
    const two = openSplit(initialStage, "changes", "right");
    expect(rootDir(two)).toBe("h");
    expect(focused(two)).toBe("changes");
    const three = openSplit(two, "agents", "bottom");
    // `changes` was focused, so it is the one split below.
    expect(panesOf(three)).toEqual(["home", "changes", "agents"]);
    expect(three.tree.kind === "split" && three.tree.children[1].kind).toBe("split");
  });

  it("puts left/top splits first without moving the existing screen's pane", () => {
    const homePane = initialStage.focusId;
    const s = openSplit(initialStage, "changes", "left");
    expect(panesOf(s)).toEqual(["changes", "home"]);
    expect(s.screens[homePane]).toBe("home");
    expect(rootDir(openSplit(initialStage, "changes", "top"))).toBe("v");
  });

  it("focuses an already visible screen instead of duplicating it", () => {
    const two = openSplit(initialStage, "changes", "right");
    const s = openSplit(two, "home", "bottom");
    expect(panesOf(s)).toEqual(["home", "changes"]);
    expect(focused(s)).toBe("home");
  });

  it("splits an explicit target pane", () => {
    const two = openSplit(initialStage, "changes", "right");
    const homePane = leafIds(two)[0];
    expect(panesOf(openSplit(two, "agents", "right", homePane))).toEqual(["home", "agents", "changes"]);
  });
});

describe("closePane", () => {
  it("keeps the last pane and focuses a neighbor when the focused pane closes", () => {
    expect(closePane(initialStage, initialStage.focusId)).toBe(initialStage);
    let s = openSplit(initialStage, "changes", "right");
    s = openSplit(s, "agents", "right");
    const middle = leafIds(s)[1];
    s = setFocus(s, middle);
    const closed = closePane(s, middle);
    expect(panesOf(closed)).toEqual(["home", "agents"]);
    // The pane that grows into the closed slot (its next sibling) takes focus.
    expect(focused(closed)).toBe("agents");
    expect(isValidStage(closed)).toBe(true);
  });
});

describe("review fixes", () => {
  it("starts panes of one split equal", () => {
    let s = openSplit(initialStage, "changes", "right");
    s = openSplit(s, "agents", "right");
    s = openSplit(s, "history", "right");
    expect(sizesOf(s)).toEqual([0.25, 0.25, 0.25, 0.25]);
  });

  it("focuses the nearest sibling when the focused pane closes", () => {
    // h[home, v[changes, agents]]: closing changes focuses agents, not home.
    let s = openSplit(initialStage, "changes", "right");
    s = openSplit(s, "agents", "bottom");
    s = setFocus(s, leafIds(s)[1]);
    expect(focused(closePane(s, leafIds(s)[1]))).toBe("agents");
  });

  it("equalizes every split", () => {
    let s = openSplit(initialStage, "changes", "right");
    s = setGutter(s, s.tree.id, 0, 0.7);
    expect(sizesOf(equalizeAll(s))).toEqual([0.5, 0.5]);
  });

  it("returns pane boxes and gutters as stage fractions", () => {
    let s = openSplit(initialStage, "changes", "right");
    s = openSplit(s, "agents", "bottom");
    const { panes, gutters } = layoutRects(s.tree);
    expect(panes.get(leafIds(s)[2])).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    expect(gutters.map((g) => g.at)).toEqual([0.5, 0.5]);
  });
});

describe("swap and toggleDir", () => {
  it("act on the split that holds the pane", () => {
    const two = openSplit(initialStage, "changes", "right");
    expect(panesOf(swap(two))).toEqual(["changes", "home"]);
    expect(rootDir(toggleDir(two))).toBe("v");
    expect(swap(initialStage)).toBe(initialStage);
  });
});

describe("gutters", () => {
  it("clamps each side to the minimum share and equalizes", () => {
    const two = openSplit(initialStage, "changes", "right");
    const id = two.tree.id;
    expect(sizesOf(setGutter(two, id, 0, 0.05))).toEqual([0.2, 0.8]);
    const pixelMin = setGutter(two, id, 0, 0.25, 0.3);
    expect(sizesOf(pixelMin)[0]).toBeCloseTo(0.3);
    expect(sizesOf(equalize(setGutter(two, id, 0, 0.7), id))).toEqual([0.5, 0.5]);
    expect(setGutter(two, "nope", 0, 0.5)).toBe(two);
  });
});

describe("moveFocus", () => {
  it("follows the visual layout", () => {
    const two = openSplit(initialStage, "changes", "right");
    expect(focused(moveFocus(two, "left"))).toBe("home");
    expect(moveFocus(two, "right")).toBe(two);
  });
});

describe("layouts and migration", () => {
  it("builds rows and migrates a saved two-pane layout", () => {
    expect(panesOf(layoutOf(["agents", "changes", "history"]))).toEqual(["agents", "changes", "history"]);
    const legacy = fromLegacy({ panes: ["agents", "changes"], focus: 0, dir: "v", ratio: 0.7 });
    expect(panesOf(legacy)).toEqual(["agents", "changes"]);
    expect(rootDir(legacy)).toBe("v");
    expect(sizesOf(legacy)[0]).toBeCloseTo(0.7);
    expect(focused(legacy)).toBe("agents");
    expect(panesOf(fromLegacy({ panes: ["files"], focus: 0, dir: "h", ratio: 0.5 }))).toEqual(["files"]);
  });

  it("rejects oversized and malformed trees", () => {
    expect(isValidStage(initialStage)).toBe(true);
    const five = layoutOf(["home", "changes", "agents", "history"]);
    const tree = five.tree as { children: unknown[]; sizes: number[] };
    expect(isValidStage({ ...five, tree: { ...tree, children: [...tree.children, { kind: "pane", id: "x" }], sizes: [0.2, 0.2, 0.2, 0.2, 0.2] } })).toBe(false);
    expect(isValidStage({ ...initialStage, screens: { [initialStage.focusId]: "nope" } })).toBe(false);
    expect(isValidStage({ ...initialStage, focusId: "missing" })).toBe(false);
    expect(isValidStage({ tree: { kind: "split", id: "s", dir: "h", children: [], sizes: [] }, screens: {}, focusId: "a" })).toBe(false);
    expect(isValidStage(null)).toBe(false);
  });
});

describe("nearestSide", () => {
  it("picks the closest edge", () => {
    expect(nearestSide(0.1, 0.5)).toBe("left");
    expect(nearestSide(0.5, 0.95)).toBe("bottom");
  });
});
