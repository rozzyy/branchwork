import { describe, expect, it } from "vitest";
import {
  closePane,
  equalizeSplit,
  moveFocus,
  paneCount,
  paneIds,
  resizeGutter,
  splitPane,
  toggleMaximized,
  type LayoutNode,
  type PaneNode,
} from "./layout";

function pane(id: string): PaneNode {
  return { kind: "pane", id };
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) freeze((value as Record<string, unknown>)[key]);
    Object.freeze(value);
  }
  return value;
}

function sizesOf(root: LayoutNode): number[] {
  if (root.kind === "pane") return [1];
  return root.sizes;
}

describe("splitPane", () => {
  it("wraps a lone pane in an equal split", () => {
    const root = freeze(pane("a"));
    const next = splitPane(root, "a", "h");
    expect(next.kind).toBe("split");
    if (next.kind !== "split") return;
    expect(next.dir).toBe("h");
    expect(paneIds(next)).toHaveLength(2);
    expect(sizesOf(next)).toEqual([0.5, 0.5]);
  });

  it("adds a sibling and halves the share when splitting in the parent direction", () => {
    const root = freeze<LayoutNode>({
      kind: "split",
      id: "s",
      dir: "h",
      children: [pane("a"), pane("b")],
      sizes: [0.5, 0.5],
    });
    const next = splitPane(root, "a", "h");
    expect(paneIds(next)).toHaveLength(3);
    if (next.kind !== "split") return;
    expect(next.children.map((c) => (c.kind === "pane" ? c.id : "?"))).toEqual([
      "a",
      expect.any(String),
      "b",
    ]);
    expect(next.sizes[0]).toBeCloseTo(0.25);
    expect(next.sizes[1]).toBeCloseTo(0.25);
    expect(next.sizes[2]).toBeCloseTo(0.5);
  });

  it("nests a new split when splitting across the parent direction", () => {
    const root = freeze<LayoutNode>({
      kind: "split",
      id: "s",
      dir: "h",
      children: [pane("a"), pane("b")],
      sizes: [0.5, 0.5],
    });
    const next = splitPane(root, "a", "v");
    if (next.kind !== "split") return;
    expect(next.sizes).toEqual([0.5, 0.5]);
    const nested = next.children[0];
    expect(nested.kind).toBe("split");
    if (nested.kind !== "split") return;
    expect(nested.dir).toBe("v");
    expect(nested.sizes).toEqual([0.5, 0.5]);
    expect(paneIds(nested)).toEqual(["a", expect.any(String)]);
  });

  it("supports repeated splits of any pane", () => {
    let root: LayoutNode = pane("a");
    root = splitPane(root, "a", "h");
    const second = paneIds(root)[1];
    root = splitPane(root, second, "v");
    root = splitPane(root, "a", "h");
    expect(paneCount(root)).toBe(4);
  });

  it("throws for an unknown pane", () => {
    expect(() => splitPane(pane("a"), "zzz", "h")).toThrow();
  });
});

describe("closePane", () => {
  it("redistributes the closed share proportionally to siblings", () => {
    const root = freeze<LayoutNode>({
      kind: "split",
      id: "s",
      dir: "h",
      children: [pane("a"), pane("b"), pane("c")],
      sizes: [0.25, 0.25, 0.5],
    });
    const next = closePane(root, "c");
    expect(next).not.toBeNull();
    if (!next || next.kind !== "split") return;
    expect(paneIds(next)).toEqual(["a", "b"]);
    expect(next.sizes[0]).toBeCloseTo(0.5);
    expect(next.sizes[1]).toBeCloseTo(0.5);
  });

  it("collapses a split left with one child", () => {
    const root = freeze<LayoutNode>({
      kind: "split",
      id: "s",
      dir: "h",
      children: [pane("a"), pane("b")],
      sizes: [0.6, 0.4],
    });
    const next = closePane(root, "b");
    expect(next).toEqual(pane("a"));
  });

  it("returns null when closing the last pane", () => {
    expect(closePane(pane("a"), "a")).toBeNull();
  });

  it("throws for an unknown pane", () => {
    expect(() => closePane(pane("a"), "zzz")).toThrow();
  });
});

describe("resizeGutter", () => {
  it("moves the gutter by the delta", () => {
    const root = freeze<LayoutNode>({
      kind: "split",
      id: "s",
      dir: "h",
      children: [pane("a"), pane("b")],
      sizes: [0.5, 0.5],
    });
    const next = resizeGutter(root, "s", 0, 0.1);
    expect(sizesOf(next)[0]).toBeCloseTo(0.6);
    expect(sizesOf(next)[1]).toBeCloseTo(0.4);
  });

  it("clamps so every pane keeps at least 8% of its parent", () => {
    const root = freeze<LayoutNode>({
      kind: "split",
      id: "s",
      dir: "h",
      children: [pane("a"), pane("b")],
      sizes: [0.5, 0.5],
    });
    const grown = resizeGutter(root, "s", 0, 10);
    expect(sizesOf(grown)[0]).toBeCloseTo(0.92);
    expect(sizesOf(grown)[1]).toBeCloseTo(0.08);
    const shrunk = resizeGutter(root, "s", 0, -10);
    expect(sizesOf(shrunk)[0]).toBeCloseTo(0.08);
    expect(sizesOf(shrunk)[1]).toBeCloseTo(0.92);
  });

  it("equalizes siblings on double-click", () => {
    const root = freeze<LayoutNode>({
      kind: "split",
      id: "s",
      dir: "v",
      children: [pane("a"), pane("b"), pane("c")],
      sizes: [0.7, 0.2, 0.1],
    });
    const next = equalizeSplit(root, "s");
    for (const size of sizesOf(next)) expect(size).toBeCloseTo(1 / 3);
  });

  it("throws for unknown splits and gutters", () => {
    const root = pane("a");
    expect(() => resizeGutter(root, "zzz", 0, 0.1)).toThrow();
    const split: LayoutNode = freeze<LayoutNode>({
      kind: "split",
      id: "s",
      dir: "h",
      children: [pane("a"), pane("b")],
      sizes: [0.5, 0.5],
    });
    expect(() => resizeGutter(split, "s", 1, 0.1)).toThrow();
    expect(() => equalizeSplit(root, "zzz")).toThrow();
  });
});

describe("moveFocus", () => {
  // A | B
  //   | C
  const root: LayoutNode = freeze<LayoutNode>({
    kind: "split",
    id: "s",
    dir: "h",
    children: [
      pane("a"),
      { kind: "split", id: "t", dir: "v", children: [pane("b"), pane("c")], sizes: [0.5, 0.5] },
    ],
    sizes: [0.5, 0.5],
  });

  it("moves to the nearest pane in each direction", () => {
    expect(moveFocus(root, "a", "right")).toBe("b");
    expect(moveFocus(root, "b", "left")).toBe("a");
    expect(moveFocus(root, "b", "down")).toBe("c");
    expect(moveFocus(root, "c", "up")).toBe("b");
  });

  it("returns null when no pane lies in that direction", () => {
    expect(moveFocus(root, "a", "left")).toBeNull();
    expect(moveFocus(root, "a", "up")).toBeNull();
    expect(moveFocus(root, "c", "right")).toBeNull();
    expect(moveFocus(root, "c", "down")).toBeNull();
  });

  it("throws for an unknown pane", () => {
    expect(() => moveFocus(root, "zzz", "right")).toThrow();
  });
});

describe("toggleMaximized", () => {
  it("shows only the pane, and restores on second press", () => {
    expect(toggleMaximized(null, "a")).toBe("a");
    expect(toggleMaximized("a", "a")).toBeNull();
    expect(toggleMaximized("a", "b")).toBe("b");
  });
});

describe("immutability", () => {
  it("never mutates its input", () => {
    const root = freeze<LayoutNode>({
      kind: "split",
      id: "s",
      dir: "h",
      children: [pane("a"), pane("b")],
      sizes: [0.5, 0.5],
    });
    const snapshot = JSON.parse(JSON.stringify(root));
    splitPane(root, "a", "h");
    closePane(root, "b");
    resizeGutter(root, "s", 0, 0.1);
    equalizeSplit(root, "s");
    moveFocus(root, "a", "right");
    expect(root).toEqual(snapshot);
  });
});
