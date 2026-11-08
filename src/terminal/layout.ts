// Pure recursive pane layout tree for the Terminal screen (spec §6.5a).
// All operations return new trees and never mutate their input. Pane leaves
// carry only an id; session binding and tab state belong to Task 05.

export type SplitDir = "h" | "v";
export type FocusDir = "left" | "up" | "right" | "down";

export interface PaneNode {
  kind: "pane";
  id: string;
}

export interface SplitNode {
  kind: "split";
  id: string;
  /** 'h' lays children out side by side; 'v' stacks them top to bottom. */
  dir: SplitDir;
  children: LayoutNode[];
  /** Fractional shares of the parent; always the same length as children. */
  sizes: number[];
}

export type LayoutNode = PaneNode | SplitNode;

/** Minimum share of its parent that any pane keeps (spec: 8%). */
export const MIN_PANE_SIZE = 0.08;

let nodeCounter = 0;
function nextPaneId(): string {
  nodeCounter += 1;
  return `layout-pane-${Date.now().toString(36)}-${nodeCounter}`;
}
function nextSplitId(): string {
  nodeCounter += 1;
  return `layout-split-${Date.now().toString(36)}-${nodeCounter}`;
}

function isPane(node: LayoutNode): node is PaneNode {
  return node.kind === "pane";
}

/** Path of child indexes from the root to the pane, or null when absent. */
function findPanePath(node: LayoutNode, paneId: string): number[] | null {
  if (isPane(node)) return node.id === paneId ? [] : null;
  for (let i = 0; i < node.children.length; i += 1) {
    const found = findPanePath(node.children[i], paneId);
    if (found) return [i, ...found];
  }
  return null;
}

/** Path of child indexes from the root to the split, or null when absent. */
function findSplitPath(node: LayoutNode, splitId: string): number[] | null {
  if (isPane(node)) return null;
  if (node.id === splitId) return [];
  for (let i = 0; i < node.children.length; i += 1) {
    const found = findSplitPath(node.children[i], splitId);
    if (found) return [i, ...found];
  }
  return null;
}

function childAt(root: LayoutNode, path: number[]): LayoutNode {
  let node = root;
  for (const index of path) {
    if (isPane(node)) throw new Error(`layout: path descends into pane ${node.id}`);
    node = node.children[index];
  }
  return node;
}

/** Rebuild the tree with `replace` applied to the node at `path`. */
function updateAt(root: LayoutNode, path: number[], replace: (node: LayoutNode) => LayoutNode): LayoutNode {
  if (path.length === 0) return replace(root);
  if (isPane(root)) throw new Error(`layout: path descends into pane ${root.id}`);
  const [head, ...tail] = path;
  return {
    ...root,
    children: root.children.map((child, i) => (i === head ? updateAt(child, tail, replace) : child)),
  };
}

function renormalize(sizes: number[]): number[] {
  const sum = sizes.reduce((a, b) => a + b, 0);
  return sizes.map((s) => s / sum);
}

/**
 * Split `paneId` to the right (`h`) or down (`v`). Splitting in the same
 * direction as the parent adds a sibling after the pane and halves the
 * pane's share; any other case nests a new equal split in the pane's slot.
 */
export function splitPane(root: LayoutNode, paneId: string, dir: SplitDir): LayoutNode {
  const path = findPanePath(root, paneId);
  if (!path) throw new Error(`layout: unknown pane ${paneId}`);
  const newPane: PaneNode = { kind: "pane", id: nextPaneId() };

  if (path.length === 0) {
    // The whole layout is one pane: wrap it in a new split.
    return { kind: "split", id: nextSplitId(), dir, children: [root, newPane], sizes: [0.5, 0.5] };
  }
  const parentPath = path.slice(0, -1);
  const parent = childAt(root, parentPath);
  if (isPane(parent)) throw new Error(`layout: path descends into pane ${parent.id}`);
  const index = path[path.length - 1];

  if (parent.dir === dir) {
    const half = parent.sizes[index] / 2;
    const sizes = [...parent.sizes];
    sizes[index] = half;
    sizes.splice(index + 1, 0, half);
    const children = [...parent.children];
    children.splice(index + 1, 0, newPane);
    return updateAt(root, parentPath, () => ({ ...parent, children, sizes }));
  }
  const nested: SplitNode = { kind: "split", id: nextSplitId(), dir, children: [parent.children[index], newPane], sizes: [0.5, 0.5] };
  return updateAt(root, parentPath, (node) => {
    if (isPane(node)) throw new Error(`layout: path descends into pane ${node.id}`);
    const children = [...node.children];
    children[index] = nested;
    return { ...node, children };
  });
}

/**
 * Close `paneId`. Its share is redistributed proportionally to its siblings
 * and a split left with one child collapses. Returns null when the last pane
 * of the layout was closed so the caller can close the tab.
 */
export function closePane(root: LayoutNode, paneId: string): LayoutNode | null {
  const path = findPanePath(root, paneId);
  if (!path) throw new Error(`layout: unknown pane ${paneId}`);
  if (path.length === 0) return null;

  const parentPath = path.slice(0, -1);
  const parent = childAt(root, parentPath);
  if (isPane(parent)) throw new Error(`layout: path descends into pane ${parent.id}`);
  const index = path[path.length - 1];

  const children = parent.children.filter((_, i) => i !== index);
  if (children.length === 1) {
    // A split with one child collapses into that child.
    return updateAt(root, parentPath, () => children[0]);
  }
  const sizes = renormalize(parent.sizes.filter((_, i) => i !== index));
  return updateAt(root, parentPath, () => ({ ...parent, children, sizes }));
}

/**
 * Move the gutter between siblings `index` and `index + 1` of `splitId` by
 * `delta` (positive grows the left/top sibling). The delta is clamped so
 * every sibling keeps at least MIN_PANE_SIZE of the parent.
 */
export function resizeGutter(root: LayoutNode, splitId: string, index: number, delta: number): LayoutNode {
  const path = findSplitPath(root, splitId);
  if (!path) throw new Error(`layout: unknown split ${splitId}`);
  const split = childAt(root, path);
  if (isPane(split)) throw new Error(`layout: ${splitId} is a pane`);
  if (index < 0 || index + 1 >= split.children.length) {
    throw new Error(`layout: gutter ${index} out of range in split ${splitId}`);
  }
  const clamped = Math.min(
    Math.max(delta, MIN_PANE_SIZE - split.sizes[index]),
    split.sizes[index + 1] - MIN_PANE_SIZE,
  );
  const sizes = [...split.sizes];
  sizes[index] += clamped;
  sizes[index + 1] -= clamped;
  return updateAt(root, path, (node) => {
    if (isPane(node)) throw new Error(`layout: path descends into pane ${node.id}`);
    return { ...node, sizes };
  });
}

/** Reset every sibling of `splitId` to an identical share. */
export function equalizeSplit(root: LayoutNode, splitId: string): LayoutNode {
  const path = findSplitPath(root, splitId);
  if (!path) throw new Error(`layout: unknown split ${splitId}`);
  const split = childAt(root, path);
  if (isPane(split)) throw new Error(`layout: ${splitId} is a pane`);
  const share = 1 / split.children.length;
  return updateAt(root, path, (node) => {
    if (isPane(node)) throw new Error(`layout: path descends into pane ${node.id}`);
    return { ...node, sizes: node.children.map(() => share) };
  });
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function paneRects(node: LayoutNode, rect: Rect, out: Map<string, Rect>): void {
  if (isPane(node)) {
    out.set(node.id, rect);
    return;
  }
  let offset = 0;
  for (let i = 0; i < node.children.length; i += 1) {
    const share = node.sizes[i];
    paneRects(
      node.children[i],
      node.dir === "h"
        ? { x: rect.x + rect.w * offset, y: rect.y, w: rect.w * share, h: rect.h }
        : { x: rect.x, y: rect.y + rect.h * offset, w: rect.w, h: rect.h * share },
      out,
    );
    offset += share;
  }
}

/**
 * Return the id of the pane nearest to `fromPaneId` in `dir`, or null when
 * no pane lies in that direction. Distance is measured center to center with
 * the off-axis offset penalized, so the pick follows the visual layout.
 */
export function moveFocus(root: LayoutNode, fromPaneId: string, dir: FocusDir): string | null {
  const rects = new Map<string, Rect>();
  paneRects(root, { x: 0, y: 0, w: 1, h: 1 }, rects);
  const from = rects.get(fromPaneId);
  if (!from) throw new Error(`layout: unknown pane ${fromPaneId}`);
  const fromCx = from.x + from.w / 2;
  const fromCy = from.y + from.h / 2;

  // A pane qualifies only when it sits beyond the source's edge in `dir`
  // with overlapping span on the other axis, so diagonal neighbors are not
  // picked for a direction they do not border.
  const EPS = 1e-9;
  const overlaps = (a0: number, a1: number, b0: number, b1: number) =>
    Math.min(a1, b1) - Math.max(a0, b0) > EPS;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const id of paneIds(root)) {
    if (id === fromPaneId) continue;
    const rect = rects.get(id);
    if (!rect) continue;
    const borders =
      dir === "left"
        ? rect.x + rect.w <= from.x + EPS && overlaps(rect.y, rect.y + rect.h, from.y, from.y + from.h)
        : dir === "right"
          ? rect.x >= from.x + from.w - EPS &&
            overlaps(rect.y, rect.y + rect.h, from.y, from.y + from.h)
          : dir === "up"
            ? rect.y + rect.h <= from.y + EPS && overlaps(rect.x, rect.x + rect.w, from.x, from.x + from.w)
            : rect.y >= from.y + from.h - EPS &&
              overlaps(rect.x, rect.x + rect.w, from.x, from.x + from.w);
    if (!borders) continue;
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2;
    const ahead =
      dir === "left" || dir === "right" ? Math.abs(cx - fromCx) : Math.abs(cy - fromCy);
    const offAxis = dir === "left" || dir === "right" ? Math.abs(cy - fromCy) : Math.abs(cx - fromCx);
    const score = ahead + 2 * offAxis;
    if (score < bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

/**
 * Maximize toggle for tab state: focusing the already-maximized pane
 * restores the layout, otherwise only that pane is shown.
 */
export function toggleMaximized(current: string | null, paneId: string): string | null {
  return current === paneId ? null : paneId;
}

/** Pane ids in tree order (left-to-right, top-to-bottom). */
export function paneIds(root: LayoutNode): string[] {
  if (isPane(root)) return [root.id];
  return root.children.flatMap((child) => paneIds(child));
}

export function paneCount(root: LayoutNode): number {
  return paneIds(root).length;
}
