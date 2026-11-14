// Stage split model (spec §6.1.4, M9): up to four screens in a nested split
// tree. The tree itself comes from the Terminal screen's tested layout
// module; the stage maps each leaf (pane id) to the screen it shows. All
// operations are pure and return the input unchanged when they do nothing.
import type { ScreenId } from "../screens/registry";
import { SCREEN_IDS } from "../screens/registry";
import {
  closePane as closeLeaf,
  equalizeSplit,
  moveFocus as moveLayoutFocus,
  paneIds,
  splitPane,
  type FocusDir,
  type LayoutNode,
  type SplitNode,
} from "../terminal/layout";

export type Side = "left" | "right" | "top" | "bottom";
export type Dir = "h" | "v";
export type { FocusDir, LayoutNode, SplitNode };

export const MAX_PANES = 4;
/** Smallest share of its parent split a pane keeps. */
export const MIN_SHARE = 0.2;
/** Deepest nesting accepted from saved settings (4 leaves need at most 3). */
const MAX_DEPTH = 3;

export interface StageState {
  tree: LayoutNode;
  /** Pane id → screen shown there; one entry per leaf. */
  screens: Record<string, ScreenId>;
  focusId: string;
}

const ROOT_PANE = "stage-pane-1";
export const initialStage: StageState = {
  tree: { kind: "pane", id: ROOT_PANE },
  screens: { [ROOT_PANE]: "home" },
  focusId: ROOT_PANE,
};

let idCounter = 1;
const nextId = (kind: "pane" | "split") => {
  idCounter += 1;
  return `stage-${kind}-${Date.now().toString(36)}-${idCounter}`;
};

export const leafIds = (s: StageState): string[] => paneIds(s.tree);
export const panesOf = (s: StageState): ScreenId[] => leafIds(s).map((id) => s.screens[id]);
export const focusIndex = (s: StageState): number => Math.max(0, leafIds(s).indexOf(s.focusId));
export const rootDir = (s: StageState): Dir => (s.tree.kind === "split" ? s.tree.dir : "h");
export const canSplit = (s: StageState): boolean => leafIds(s).length < MAX_PANES;
export const paneOf = (s: StageState, screen: ScreenId): string | null =>
  leafIds(s).find((id) => s.screens[id] === screen) ?? null;

/** Rebuild the tree with `f` applied to the split that directly holds `childId`. */
function mapParent(
  node: LayoutNode,
  childId: string,
  f: (split: SplitNode, index: number) => SplitNode,
): LayoutNode {
  if (node.kind === "pane") return node;
  const index = node.children.findIndex((child) => child.id === childId);
  if (index >= 0) return f(node, index);
  return { ...node, children: node.children.map((child) => mapParent(child, childId, f)) };
}

function mapSplit(node: LayoutNode, splitId: string, f: (split: SplitNode) => SplitNode): LayoutNode {
  if (node.kind === "pane") return node;
  if (node.id === splitId) return f(node);
  return { ...node, children: node.children.map((child) => mapSplit(child, splitId, f)) };
}

function findSplit(node: LayoutNode, splitId: string): SplitNode | null {
  if (node.kind === "pane") return null;
  if (node.id === splitId) return node;
  for (const child of node.children) {
    const found = findSplit(child, splitId);
    if (found) return found;
  }
  return null;
}

function moveChild(split: SplitNode, from: number, to: number): SplitNode {
  const children = [...split.children];
  const sizes = [...split.sizes];
  [children[from], children[to]] = [children[to], children[from]];
  [sizes[from], sizes[to]] = [sizes[to], sizes[from]];
  return { ...split, children, sizes };
}

export function navigate(s: StageState, id: ScreenId): StageState {
  const visible = paneOf(s, id);
  if (visible) return visible === s.focusId ? s : { ...s, focusId: visible };
  return { ...s, screens: { ...s.screens, [s.focusId]: id } };
}

export function setFocus(s: StageState, paneId: string): StageState {
  return paneId !== s.focusId && paneId in s.screens ? { ...s, focusId: paneId } : s;
}

/**
 * Split `targetId` (default: focused pane) toward `side` and show `id` in
 * the new pane. A visible screen is focused instead; a full stage is left
 * unchanged (callers check `canSplit` to explain why).
 */
export function openSplit(s: StageState, id: ScreenId, side: Side, targetId = s.focusId): StageState {
  const visible = paneOf(s, id);
  if (visible) return setFocus(s, visible);
  if (!canSplit(s) || !(targetId in s.screens)) return s;
  const dir: Dir = side === "top" || side === "bottom" ? "v" : "h";
  const before = new Set(leafIds(s));
  let tree = splitPane(s.tree, targetId, dir);
  const newId = paneIds(tree).find((paneId) => !before.has(paneId))!;
  // splitPane halves the target's share; panes in one split start equal.
  tree = mapParent(tree, newId, (split) => ({ ...split, sizes: split.children.map(() => 1 / split.children.length) }));
  if (side === "left" || side === "top") {
    // splitPane always appends after the target; move the new pane first
    // so the existing screen keeps its pane (and its mounted view).
    tree = mapParent(tree, newId, (split, index) => moveChild(split, index, index - 1));
  }
  return { tree, screens: { ...s.screens, [newId]: id }, focusId: newId };
}

/** The leaf next to `paneId` in its own split (the pane that grows on close). */
function siblingLeaf(node: LayoutNode, paneId: string): string | null {
  if (node.kind === "pane") return null;
  const index = node.children.findIndex((child) => child.id === paneId);
  if (index >= 0) {
    const next = node.children[index + 1];
    if (next) return paneIds(next)[0];
    const previous = paneIds(node.children[index - 1]);
    return previous[previous.length - 1];
  }
  for (const child of node.children) {
    const found = siblingLeaf(child, paneId);
    if (found) return found;
  }
  return null;
}

export function closePane(s: StageState, paneId: string): StageState {
  const ids = leafIds(s);
  if (ids.length < 2 || !ids.includes(paneId)) return s;
  const tree = closeLeaf(s.tree, paneId)!;
  const screens = { ...s.screens };
  delete screens[paneId];
  return { tree, screens, focusId: s.focusId !== paneId ? s.focusId : siblingLeaf(s.tree, paneId) ?? paneIds(tree)[0] };
}

/** Swap the pane (or its subtree) with its neighbor in the parent split. */
export function swap(s: StageState, paneId = s.focusId): StageState {
  if (s.tree.kind === "pane") return s;
  const tree = mapParent(s.tree, paneId, (split, index) =>
    moveChild(split, index, index + 1 < split.children.length ? index + 1 : index - 1),
  );
  return { ...s, tree };
}

/** Flip the orientation of the split that holds `paneId`. */
export function toggleDir(s: StageState, paneId = s.focusId): StageState {
  if (s.tree.kind === "pane") return s;
  const tree = mapParent(s.tree, paneId, (split) => ({ ...split, dir: split.dir === "h" ? "v" : "h" }));
  return { ...s, tree };
}

/**
 * Put the gutter between children `index` and `index + 1` of `splitId` so
 * child `index` takes `leftShare` of the parent, keeping both at least
 * `minShare` (≥ MIN_SHARE).
 */
export function setGutter(s: StageState, splitId: string, index: number, leftShare: number, minShare = MIN_SHARE): StageState {
  const split = findSplit(s.tree, splitId);
  if (!split || index < 0 || index + 1 >= split.children.length || !Number.isFinite(leftShare)) return s;
  const total = split.sizes[index] + split.sizes[index + 1];
  const min = Math.min(Math.max(minShare, MIN_SHARE), total / 2);
  const left = Math.min(Math.max(leftShare, min), total - min);
  const tree = mapSplit(s.tree, splitId, (node) => {
    const sizes = [...node.sizes];
    sizes[index] = left;
    sizes[index + 1] = total - left;
    return { ...node, sizes };
  });
  return { ...s, tree };
}

export function equalize(s: StageState, splitId: string): StageState {
  return findSplit(s.tree, splitId) ? { ...s, tree: equalizeSplit(s.tree, splitId) } : s;
}

/** Every split back to equal shares (palette "Equalize split sizes"). */
export function equalizeAll(s: StageState): StageState {
  const walk = (node: LayoutNode): LayoutNode =>
    node.kind === "pane" ? node : { ...node, children: node.children.map(walk), sizes: node.children.map(() => 1 / node.children.length) };
  return s.tree.kind === "pane" ? s : { ...s, tree: walk(s.tree) };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Gutter {
  split: SplitNode;
  index: number;
  /** The whole split's box, as fractions of the stage. */
  box: Rect;
  /** Position of the gutter along the split's axis, as a fraction of the stage. */
  at: number;
}

/** Pane boxes and gutters as fractions of the stage (flat rendering, no remounts). */
export function layoutRects(tree: LayoutNode): { panes: Map<string, Rect>; gutters: Gutter[] } {
  const panes = new Map<string, Rect>();
  const gutters: Gutter[] = [];
  const walk = (node: LayoutNode, box: Rect) => {
    if (node.kind === "pane") {
      panes.set(node.id, box);
      return;
    }
    let offset = 0;
    node.children.forEach((child, i) => {
      const share = node.sizes[i];
      const childBox = node.dir === "h"
        ? { x: box.x + box.w * offset, y: box.y, w: box.w * share, h: box.h }
        : { x: box.x, y: box.y + box.h * offset, w: box.w, h: box.h * share };
      walk(child, childBox);
      offset += share;
      if (i < node.children.length - 1) {
        gutters.push({ split: node, index: i, box, at: node.dir === "h" ? box.x + box.w * offset : box.y + box.h * offset });
      }
    });
  };
  walk(tree, { x: 0, y: 0, w: 1, h: 1 });
  return { panes, gutters };
}

export function moveFocus(s: StageState, dir: FocusDir): StageState {
  if (s.tree.kind === "pane") return s;
  const next = moveLayoutFocus(s.tree, s.focusId, dir);
  return next ? { ...s, focusId: next } : s;
}

/** A row of 1–4 equal panes (presets and legacy layouts). */
export function layoutOf(screens: ScreenId[], dir: Dir = "h", sizes?: number[], focus = screens.length - 1): StageState {
  const ids = screens.map(() => nextId("pane"));
  const tree: LayoutNode =
    ids.length === 1
      ? { kind: "pane", id: ids[0] }
      : {
          kind: "split",
          id: nextId("split"),
          dir,
          children: ids.map((id) => ({ kind: "pane", id })),
          sizes: sizes ?? ids.map(() => 1 / ids.length),
        };
  return {
    tree,
    screens: Object.fromEntries(ids.map((id, i) => [id, screens[i]])),
    focusId: ids[Math.min(Math.max(0, focus), ids.length - 1)],
  };
}

/** Saved M0–M8 shape `{ panes: [a] | [a, b], focus, dir, ratio }`. */
export function fromLegacy(raw: { panes: ScreenId[]; focus: number; dir: Dir; ratio: number }): StageState {
  const ratio = Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, raw.ratio));
  return raw.panes.length > 1
    ? layoutOf(raw.panes.slice(0, 2), raw.dir, [ratio, 1 - ratio], raw.focus)
    : layoutOf(raw.panes.slice(0, 1));
}

/** x, y are pointer coordinates normalized to 0..1 within the target. */
export function nearestSide(x: number, y: number): Side {
  const d: Record<Side, number> = { left: x, right: 1 - x, top: y, bottom: 1 - y };
  return (Object.keys(d) as Side[]).reduce((a, b) => (d[a] <= d[b] ? a : b));
}

function validNode(node: unknown, depth: number, seen: Set<string>, leaves: string[]): boolean {
  if (!node || typeof node !== "object" || depth > MAX_DEPTH) return false;
  const n = node as Record<string, unknown>;
  if (typeof n.id !== "string" || !n.id || n.id.length > 64 || seen.has(n.id)) return false;
  seen.add(n.id);
  if (n.kind === "pane") {
    leaves.push(n.id);
    return leaves.length <= MAX_PANES;
  }
  if (n.kind !== "split" || (n.dir !== "h" && n.dir !== "v")) return false;
  const { children, sizes } = n;
  if (!Array.isArray(children) || !Array.isArray(sizes) || children.length < 2 || children.length > MAX_PANES) return false;
  if (sizes.length !== children.length || !sizes.every((size) => typeof size === "number" && Number.isFinite(size) && size >= 0.05)) return false;
  const sum = (sizes as number[]).reduce((a, b) => a + b, 0);
  if (Math.abs(sum - 1) > 0.01) return false;
  return children.every((child) => validNode(child, depth + 1, seen, leaves));
}

/** Untrusted (saved) input check: shape, ≤ 4 leaves, depth ≤ 3, unique screens. */
export function isValidStage(v: unknown): v is StageState {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  const leaves: string[] = [];
  if (!validNode(s.tree, 0, new Set(), leaves) || !s.screens || typeof s.screens !== "object") return false;
  const screens = s.screens as Record<string, unknown>;
  if (Object.keys(screens).length !== leaves.length) return false;
  const shown = leaves.map((id) => screens[id]);
  return (
    shown.every((screen) => typeof screen === "string" && SCREEN_IDS.includes(screen as ScreenId)) &&
    new Set(shown).size === shown.length &&
    typeof s.focusId === "string" &&
    leaves.includes(s.focusId)
  );
}
