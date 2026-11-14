# M9 — More than two split panes: Implementation Plan

> Native execution (user: "mulai m9 sekarang"). No per-task commits; one stage commit after the 🛑 checkpoint.

**Goal:** Up to 4 stage panes in a nested split tree.
**Architecture:** `StageState = { tree: LayoutNode, screens: Record<paneId, ScreenId>, focusId }` built on `src/terminal/layout.ts`; the store keeps today's derived fields (`panes`, `focus` index, `dir` = root dir) so the ~24 consumers keep working.
**Spec:** `docs/superpowers/specs/2026-11-14-m9-split-panes-design.md` (§5.5 decisions are binding).

## Global Constraints
- `MAX_PANES = 4`, `MIN_SHARE = 0.2`, divider drag min 200 px per child, load accepts ≤ 4 leaves and depth ≤ 3.
- Screens never appear twice; opening a visible screen focuses it.
- Keys: ⌘\ split right, ⌘⇧\ split below, ⌘⌥\ close focused pane, ⌘⌥←↑→↓ move focus (Terminal keeps the chord while its stage pane is focused).
- Strings in `src/i18n/en.ts`; no new dependencies.

## Review Focus
1. Saved v1 layouts (`{panes, dir, ratio}`) and legacy screen ids open unchanged (Task 1 test `migrates a saved two-pane layout`).
2. Corrupt or oversized saved trees fall back to the initial stage (Task 1 test `rejects oversized and malformed trees`).
3. Fifth split from any entry point → toast, layout unchanged (Task 1/2 tests).
4. Closing the focused pane in the middle of 3–4 panes focuses a remaining pane (Task 1 test).
5. ⌘⌥ arrows inside a focused Terminal screen still move terminal panes (Task 3 test).

---

### Task 1 (M9-01): Tree stage model + store + persistence ✅
**Files:** `src/stage/stageModel.ts`, `src/stage/stageModel.test.ts`, `src/state/stage.ts`
**Produces:** model `initialStage`, `leafIds`, `panesOf`, `focusIndex`, `rootDir`, `navigate`, `setFocus(s, paneId)`, `openSplit(s, id, side, targetId?)`, `closePane(s, paneId)`, `swap(s, paneId)`, `toggleDir(s, paneId)`, `setGutter(s, splitId, index, leftShare, minShare?)`, `equalize(s, splitId)`, `moveFocus(s, dir)`, `layoutOf(screens)`, `fromLegacy(raw)`, `isValidStage(v)`, `canSplit(s)`, `nearestSide`. Store: `tree`, `screens`, `focusId`, derived `panes`, `focus`, `dir`; actions `go`, `focusPane(index)`, `openSplit(id, side, targetIndex?)`, `closePane(index)`, `splitFocused(side)`, `closeFocused()`, `swap(index?)`, `toggleDir(index?)`, `setGutter`, `equalize`, `moveFocus`, `setLayout`, `switchWorktree`, `load`. Persist `{ version: 2, current, layouts }`.
- [x] Tests: split adds panes up to 4 and refuses the 5th; left/top put the new pane first without remounting the old one; visible screen focuses; close focuses a neighbor; swap/toggleDir act on the parent split; setGutter clamps; migration of v1; validation bounds.
- [x] Implement; `pnpm vitest run src/stage src/state` passes.

### Task 2 (M9-02): Recursive Stage UI, pane controls, drag-and-drop, sidebar/palette ✅
**Files:** `src/stage/Stage.tsx`, `Pane.tsx`, `PaneControls.tsx`, `splitMenu.tsx`, `stage.css`, `Stage.test.tsx`, `src/shell/Sidebar.tsx`, `src/palette/commands.ts`, `src/i18n/en.ts`
- [x] Render tree with one divider per adjacent pair (drag → `setGutter` with px min, double-click → `equalize`); drop target = pane under cursor; per-pane controls (Open beside until 4, swap, orientation, close); sidebar glyph numbers for > 2 panes; palette close kbd `⌘⌥\`.
- [x] Tests: open 3 panes via Open beside; close the middle pane.

### Task 3 (M9-03): Keyboard map ✅
**Files:** `src/keys/globalKeys.ts`, `src/terminal/TerminalScreen.tsx`, `src/shell/ShortcutSheet.tsx`, related tests
- [x] ⌘\ / ⌘⇧\ split focused, ⌘⌥\ close, ⌘⌥ arrows move focus; Terminal chord: TerminalScreen already scopes its handler to events inside `.term-screen`; globalKeys skips the chord while Terminal is the focused stage pane (no TerminalScreen edit needed).
- [x] Update e2e `e2e/stage3-split.spec.ts`; `./init.sh` + `pnpm test:e2e` green.

## Stage end
- code-reviewer → `.agent/reviews/`; manual checks `docs/testing/m9-manual-e2e.md`; 🛑 checkpoint M9.1.
