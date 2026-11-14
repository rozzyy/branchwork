# M9 — More than two split panes — Design

- **Date:** 2026-11-14
- **Milestone:** M9 (user request; lifts the spec §12 deferral "More than two split panes")
- **Replaces:** spec §6.1.4 two-pane limit (Arc-style split view)
- **Followed by:** M10 multi-window (separate design)

## 1. Intent

The main stage can show up to **four** screens at once, split freely like VS Code / iTerm: any pane can be split again to the right or below. Users run several worktree tools side by side (e.g. Agents + Changes + History + Terminal) and two panes is too few.

## 2. Current state

- `StageState { panes: ScreenId[] (1–2), focus, dir, ratio }` in `src/stage/stageModel.ts`; store `src/state/stage.ts` persists `{ current, layouts }` (per-worktree layouts, LRU 200) with migration from older shapes.
- `Stage.tsx` renders pane 0, one divider, pane 1; drag a sidebar item onto the stage picks a side of the **whole stage**.
- `PaneControls` (swap / orientation / close, "Open beside" menu with presets), sidebar ⌘/⌥-click and right-click split, palette split commands, ⌘\ toggle.
- Consumers read `panes` (sidebar position glyphs, `sessions.ts` attach check, palette close).
- The Terminal screen already has a pure, tested recursive layout tree: `src/terminal/layout.ts` (`splitPane`, `closePane`, `resizeGutter`, `equalizeSplit`, `moveFocus`, `paneIds`, `MIN_PANE_SIZE` 8%).

## 3. Goals, non-goals, anti-goals

**Goals**
- Up to 4 panes in any nested arrangement of horizontal/vertical splits.
- Every split's dividers are draggable; double-click equalizes that split.
- Split from: pane control menu, sidebar ⌘-click (right) / ⌥-click (below) / right-click, drag onto **a pane's** edge, palette, ⌘\.
- Per-worktree layouts, restore on restart, and migration of saved 1–2 pane layouts keep working.

**Non-goals**
- Same screen in two panes (screens stay singletons; opening an already-visible screen focuses it).
- Tabs inside stage panes; floating panes; maximize-one-pane (can come later).
- Multi-window (M10).

**Anti-goals**
- Breaking existing 1–2 pane behavior, shortcuts or saved layouts.
- Panes so small their screens are unusable.

## 4. Approaches

| | Approach | Trade-off |
|---|---|---|
| **A (chosen by user)** | Recursive split tree, max 4 leaves. | Fully flexible; more UI states. |
| B | Preset grids (2 cols, 3 cols, 2×2). | Simpler, but cannot express e.g. one tall pane + two stacked. |

Implementation call (mine): **reuse `src/terminal/layout.ts`** rather than writing a second tree. Leaves need to carry a `ScreenId`; the stage keeps a `paneScreens: Record<paneId, ScreenId>` map next to the tree, so the terminal module stays untouched.

## 5. Design

### 5.1 State

```
StageState {
  tree: LayoutNode            // from terminal/layout.ts
  screens: Record<string, ScreenId>   // paneId → screen, one entry per leaf
  focus: string               // focused paneId
}
```
- Derived (selectors, not stored): `panes: ScreenId[]` = leaves in tree order — keeps today's consumers working.
- Invariants (`isValidStage`): 1–4 leaves, every leaf has a screen, no screen twice, `focus` is a leaf.
- `MAX_PANES = 4`. Size limits: see §5.5 (4).

### 5.2 Operations (pure, in `stageModel.ts`)

- `navigate(id)`: visible → focus it; else replace the focused pane's screen (unchanged behavior).
- `openSplit(id, side, target = focus)`: split `target` toward `side` (right/left → `h`, bottom/top → `v`; left/top put the new pane first). Visible `id` → focus it instead. At 4 panes → refuse with toast "Up to 4 panes; close one first" (new string).
- `closePane(paneId)`: remove leaf; focus its nearest sibling. Last pane cannot close.
- `swapWithSibling(paneId)`: swap the pane with its neighbor in the parent split (replaces 2-pane swap).
- `toggleDir(paneId)`: flip the parent split's orientation (replaces global orientation).
- `resize(splitId, gutterIndex, delta)` / `equalize(splitId)`: via `resizeGutter` / `equalizeSplit`.
- `moveFocus(dir)`: via `layout.moveFocus`.
- `setLayout(screens[])` (presets): builds a row of 1–4 equal panes.

### 5.3 UI

- `Stage.tsx` renders the tree recursively: a split node is a flex row/column with children sized by `sizes` and a `divider` between each pair (existing `.divider` styles, hit area already widened). Mouse drag on a divider calls `resize` for that split; double-click equalizes.
- Drag-and-drop: the drop target is the **pane under the cursor**; `nearestSide` within that pane picks the side; the dropzone highlight covers that pane's half. At 4 panes the drop shows the refusal hint instead.
- `PaneControls` (per pane, in each pane header): "Open beside" menu (now also available when already split, until 4), ⇄ swap with sibling, orientation toggle of the parent split, ✕ close. Single pane keeps today's look.
- Focused pane keeps the 2px accent top edge (M7); other panes stay flush with 1px separators.
- Sidebar position glyphs: generalize from left/right/top/bottom to the pane's order number (1–4) when more than two panes are open (my call; keeps the glyph tiny and unambiguous).
- Keyboard: see §5.5 (2, 3).
- Palette: "Split right/below with X" act on the focused pane; "Close pane", "Swap with neighbor", "Equalize splits".

### 5.4 Persistence and migration

- Saved shape gains `version: 2` with `{ tree, screens, focus }`; per-worktree `layouts` keep the same LRU rules.
- Old shape `{ panes: [a] | [a, b], dir, ratio }` → one leaf, or one split of `dir` with sizes `[ratio, 1 - ratio]`. Invalid saved trees fall back to `initialStage`. Legacy screen ids keep going through `migrateScreenId`.
- Bounds: at most 4 leaves and depth ≤ 3 accepted when loading; anything larger is rejected (untrusted settings input).

## 5.5 Decisions after builder check (my calls)

1. **Split always adds a pane** (until 4), on the *focused* pane, from every entry point (sidebar ⌘/⌥-click and right-click, palette, Open beside, drag onto a pane edge). The old 2-pane "replace the pane on that side / swap if visible" rule is dropped — it contradicts the feature. A screen that is already visible is **focused**, not moved. The split e2e specs are rewritten accordingly.
2. **Keys:** ⌘\ = split focused pane right, ⌘⇧\ = split below (both kept, no longer toggle-close). Close focused pane = **⌘⌥\** (new) and the pane ✕. At 4 panes the split keys show the limit toast. Palette kbd hints and the shortcut sheet follow.
3. **⌘⌥ arrows:** the Terminal screen handles the chord only while **its stage pane is focused** (small guard in `TerminalScreen.tsx`); no fall-through at its edges. Otherwise the stage moves focus between panes.
4. **Sizes:** each split child keeps 20–80% of its parent (today's clamp, not the terminal's 8%), and a divider drag also stops at **200 px** per child (computed from the split element's size in the drag handler). New splits start equal.
5. **Presets** stay in the single-pane "Open beside" menu only (as today), so they never discard a multi-pane layout. With 2–3 panes the menu lists screens to split in.

## 6. Constraints

- English UI strings in `src/i18n/en.ts`.
- No new dependencies.
- Rendering cost: O(leaves) ≤ 4; resize updates only the affected split.
- `./init.sh` and Playwright e2e stay green (update the split e2e specs for the new controls).

## 7. Left to the builder

- Exact default screen chosen by ⌘\ when splitting (follow today's `changes`/`agents` rule, skipping visible ones).
- Dropzone visuals within a pane.
- Whether presets in "Open beside" add 3-pane presets (optional).

## 8. Manual checks (checkpoint M9.1)

- Build 3 and 4 pane layouts with each entry point; 5th split refused with the toast.
- Resize each divider; double-click equalizes; tiny panes stop at the minimum.
- Close panes in different positions; focus lands on the neighbor.
- Per-worktree layouts and restart restore a 4-pane layout; an old 2-pane saved layout opens unchanged.
- ⌘\, ⌘⇧\, ⌘⌥ arrows; Terminal screen splits still work inside its own pane.
