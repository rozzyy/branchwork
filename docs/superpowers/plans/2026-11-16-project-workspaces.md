# Project workspaces implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-project work without friction: one-hotkey toggle between recent projects and per-pane project pins for side-by-side work.

**Architecture:** Recency lives in the repos store; the toggle reuses the existing `selectProject` path (dirty guard included). Pins live on the stage pane model as an additive `paneProjects` map, exposed to screens through a `PaneProjectContext` + `usePaneProjectId()` hook with global-active-project fallback, so unpinned panes behave byte-for-byte as today.

**Tech Stack:** React + TypeScript, zustand stores, Tauri 2 desktop, Vitest + `pnpm exec vitest run`, existing oklch CSS token system.

**Spec:** `docs/superpowers/specs/2026-11-16-project-workspaces-design.md`

## Global Constraints

- All UI strings are English and come from `src/i18n/en.ts` (typed `MsgKey`).
- No per-task commits and never `git push`; every task's Commit step is skipped per the repo no-commit rule — leave the work uncommitted for review.
- `pnpm exec tsc --noEmit` (via `npm run typecheck`) is clean after every task.
- Every interactive element keeps an accessible name and the visible focus ring.
- Persisted-state changes are additive only; old saved state must load with new fields defaulted.

## Review Focus

- A pinned pane points at a project that was just removed → the pane must fall back to the global project, never crash or show another project's data. Pinned to the task owning the hook (Task 5).
- A git action dispatched from a pinned pane must target the pinned project's worktree, never the global active one. Pinned to the worktree-cache task (Task 7).
- Toggling projects with unsaved editor changes stays blocked with the files toast. Pinned to the recency/toggle task (Task 1).
- The toggle hotkey must not fire on key repeat, while the palette/dialog is open, or from a non-modifier keypress. Pinned to the hotkey task (Task 2).
- Saved stage v3 (no pins) loads with pins empty, and pins round-trip through save/load. Pinned to the pin-model task (Task 4).

---

## File structure

- `src/state/repos.ts` (+ `repos.test.ts`): `recentProjectIds`, `togglePreviousProject()`.
- `src/keys/globalKeys.ts` (+ `globalKeys.test.ts`): toggle hotkey.
- `src/palette/commands.ts` (+ `Palette.test.tsx`): "toggle previous project" command.
- `src/shell/GroupSwitcher.tsx` (+ test): Recents section; `ShortcutSheet.tsx` + `en.ts`: labels.
- `src/stage/stageModel.ts` (+ test): `paneProjects` on `StageState`, picked per stage tab.
- `src/state/stage.ts` (+ test): persist v4 (accept v3), pin set/clear actions.
- `src/stage/paneProject.tsx` (new) + `Pane.tsx`, `PaneControls.tsx`: context, hook, pin chip.
- `src/terminal/TerminalScreen.tsx`, `src/screens/agents/AgentsScreen.tsx` (+ tests): pin-aware filtering.
- `src/state/worktrees.ts` (+ test): per-project cache.
- `src/screens/files/FilesScreen.tsx`, `src/screens/changes/ChangesScreen.tsx`, `src/screens/history/*` (+ tests): pane-project migration.
- `src/theme/tokens.css`, `src/theme/theme.ts`, `src/shell/GroupSwitcher.tsx` (swatches), `en.ts`: palette values.

### Task 1: Recency tracking + toggle action in the repos store

**Files:**
- Modify: `src/state/repos.ts`
- Test: `src/state/repos.test.ts`

**Interfaces:**
- Consumes: existing `selectProject(id)`, `selectGroup(id)`, `persistRepos()`.
- Produces: `recentProjectIds: string[]` (most-recent-first, cap 5, persisted), `togglePreviousProject(): void` for Tasks 2–3.

- [ ] **Step 1: Write the failing tests**

```ts
it("tracks recently used projects, most-recent-first, capped at five", () => {
  // select 6 projects in order, expect recentProjectIds to hold the last 5
  // with the latest first; re-selecting moves it to the front without dupes
});
it("togglePreviousProject switches to the last project and back", () => {
  // with A active and B previous: toggle → B active; toggle → A active
});
it("toggle with unsaved editor changes stays blocked", () => {
  // seed useFiles dirty map, toggle, expect activeProjectId unchanged
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run src/state/repos.test.ts`
Expected: FAIL (3 tests, `recentProjectIds`/`togglePreviousProject` undefined).

- [ ] **Step 3: Implement in `src/state/repos.ts`**

Exact additions: `recentProjectIds: string[]` on the store + persisted pick; a `touchRecent(id)` helper called from `selectProject`/`selectGroup` only when the active project actually changes; `togglePreviousProject()` calling `selectProject(recentProjectIds[1] ?? recentProjectIds[0])`, which reuses the dirty guard. Cap 5, dedupe on unshift. Extend `persistRepos` and the load-restore path (unknown ids filtered at load).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/state/repos.test.ts` then `npm run typecheck`.
Expected: PASS, typecheck clean.

### Task 2: Toggle hotkey + palette command + shortcut docs

**Files:**
- Modify: `src/keys/globalKeys.ts`, `src/palette/commands.ts`, `src/shell/ShortcutSheet.tsx`, `src/i18n/en.ts`
- Test: `src/keys/globalKeys.test.ts`, `src/palette/Palette.test.tsx`

**Interfaces:**
- Consumes: `togglePreviousProject()` from Task 1.
- Produces: nothing downstream (leaf UI wiring).

- [ ] **Step 1: Write the failing tests**

```ts
it("⌘⇧P toggles to the previous project, ignoring repeats", () => {
  // handleGlobalKey(mod+shift+KeyP, repeat: true) → false, no project change
  // handleGlobalKey(mod+shift+KeyP) → true, active project toggled
});
it("toggle hotkey is inert while the palette or a dialog is open", () => {
  // open palette (or set a dialog current), hotkey → false, no change
});
it("palette lists a Toggle previous project command that toggles", async () => {
  // open palette, filter "previous project", Enter → active project toggled
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run src/keys/globalKeys.test.ts src/palette/Palette.test.tsx`
Expected: FAIL (hotkey unhandled, command missing).

- [ ] **Step 3: Implement**

In `handleGlobalKey`, next to the `KeyN` branch: `if (mod && e.shiftKey && !e.altKey && e.code === "KeyP") { if (!e.repeat) useRepos.getState().togglePreviousProject(); return true; }`. Guard order note: this branch sits above the `isTyping` early-return like the other mod combos, so it works from the terminal too (same as ⌘K). Palette: append `{ id: "project.togglePrevious", group: <existing nav group key>, icon: "⇄", title: <new en key>, kbd: "⌘⇧P", run: () => useRepos.getState().togglePreviousProject() }` to the command list. Add `shortcuts.toggleProject` + command title keys to `en.ts` and a row to `ShortcutSheet`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/keys/globalKeys.test.ts src/palette/Palette.test.tsx` then `npm run typecheck`.
Expected: PASS, typecheck clean.

### Task 3: Recents section in the project popover

**Files:**
- Modify: `src/shell/GroupSwitcher.tsx`, `src/i18n/en.ts`
- Test: `src/shell/GroupSwitcher.test.tsx`

**Interfaces:**
- Consumes: `recentProjectIds` from Task 1, existing `buildSections()` + `selectProject` row behavior.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

```tsx
it("lists recently used projects above the grouped list", () => {
  // seed projects + recentProjectIds [b, a]; open popover;
  // expect a "Recent" heading whose rows selectProject on click, followed by the grouped list
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm exec vitest run src/shell/GroupSwitcher.test.tsx`
Expected: FAIL (no Recents heading).

- [ ] **Step 3: Implement in `src/shell/GroupSwitcher.tsx`**

Render a `group-pop-recent` section above the grouped list mapping `recentProjectIds` (filtered to known projects) to the same row UI + `selectProject` handler; add one `groups.recent` key to `en.ts`. No dedup against the grouped list below (recents are shortcuts, the list is the source of truth).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/shell/GroupSwitcher.test.tsx` then `npm run typecheck`.
Expected: PASS, typecheck clean.

### Task 4: Pane pin data model + persistence

**Files:**
- Modify: `src/stage/stageModel.ts`, `src/state/stage.ts`
- Test: `src/stage/stageModel.test.ts`, `src/state/stage.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `paneProjects: Record<string, string>` on `StageState` (paneId → projectId), `setPaneProject(paneId, projectId | null)` / `clearPaneProject(paneId)` actions for Task 5. Missing entry = follow global.

- [ ] **Step 1: Write the failing tests**

```ts
it("carries paneProjects through split/navigate/close without touching pins of other panes", () => {
  // pin pane A, split/navigate/close pane B, expect A's pin intact
});
it("loads v3 saved state with pins empty and round-trips v4 pins", () => {
  // feed a v3 fixture (no paneProjects) → pins {}; save+load with pins → equal
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run src/stage/stageModel.test.ts src/state/stage.test.ts`
Expected: FAIL (`paneProjects` unknown).

- [ ] **Step 3: Implement**

`StageState` gains `paneProjects: Record<string, string>`; `pick()` includes it; every transform that drops panes also drops their pins (close/split/navigate). Persist version 3 → 4; readers accept 3 by defaulting pins to `{}`. `setPaneProject` writes, `clearPaneProject` deletes the key.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/stage/stageModel.test.ts src/state/stage.test.ts` then `npm run typecheck`.
Expected: PASS, typecheck clean.

### Task 5: Pane project context, hook, and pin chip

**Files:**
- Create: `src/stage/paneProject.tsx`
- Modify: `src/stage/Pane.tsx`, `src/stage/PaneControls.tsx`, `src/i18n/en.ts`
- Test: new `src/stage/paneProject.test.tsx`

**Interfaces:**
- Consumes: `paneProjects` + pin actions from Task 4, `useRepos` projects, existing `GroupSwitcherPopover`.
- Produces: `usePaneProjectId(): string | null`, `usePaneProject()` for Tasks 6 and 8.

- [ ] **Step 1: Write the failing tests**

```tsx
it("returns the pinned project inside its pane and the global one elsewhere", () => {
  // render hook under provider with pin → pinned id; without pin → activeProjectId
});
it("an unknown pinned project id falls back to the global project", () => {
  // pin references a removed project → hook returns activeProjectId
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run src/stage/paneProject.test.tsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`paneProject.tsx` exports `PaneProjectContext` (value: projectId or null), `PaneProjectProvider`, `usePaneProjectId()` (context ?? global `activeProjectId`, with unknown-id fallback to global), `usePaneProject()`. `Pane` wraps its `View` in the provider with the pane's pin. `PaneControls` gains a pin chip (group color dot + `projectLabel`, or "Follow global"): clicking opens `GroupSwitcherPopover` anchored to the chip; first item unpins, project rows call `setPaneProject`. Add `pane.pin/unpin/followGlobal` keys to `en.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/stage/paneProject.test.tsx` then `npm run typecheck`.
Expected: PASS, typecheck clean.

### Task 6: Terminal + Agents follow the pane pin

**Files:**
- Modify: `src/terminal/TerminalScreen.tsx`, `src/screens/agents/AgentsScreen.tsx`
- Test: `src/terminal/TerminalScreen.test.tsx`, `src/screens/agents/AgentsScreen.test.tsx`

**Interfaces:**
- Consumes: `usePaneProjectId()` from Task 5.
- Produces: nothing downstream (both already scope sessions by stored `worktreePath`; the pin only overrides the visibility filter).

- [ ] **Step 1: Write the failing tests**

```tsx
it("a pinned pane shows its project's tabs while the global project differs", () => {
  // two projects; pane pinned to B while global is A → B's tabs visible, no PTY closed
});
```

(one per screen; Agents mirrors with sessions filtered by the pinned project's worktrees.)

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run src/terminal/TerminalScreen.test.tsx src/screens/agents/AgentsScreen.test.tsx`
Expected: FAIL (global filter wins).

- [ ] **Step 3: Implement**

Replace the `useRepos(s => s.activeProjectId)` / `useWorktrees(s => s.activePath)` filter inputs with the pane's effective project (its worktree set). Unpinned panes keep the exact current expressions. Session spawn paths are untouched (worktreePath is already stored per session/tab).

- [ ] **Step 4: Run tests to verify they pass**

Run the same two files, then `npm run typecheck`.
Expected: PASS, typecheck clean.

### Task 7: Per-project worktree cache

**Files:**
- Modify: `src/state/worktrees.ts`
- Test: `src/state/worktrees.test.ts`

**Interfaces:**
- Consumes: project records from `useRepos`.
- Produces: `ensureProjectWorktrees(projectId): Promise<{ worktrees, activePath }>` for Task 8; existing global selectors keep working for unpinned panes.

- [ ] **Step 1: Write the failing tests**

```ts
it("loads and caches a second project's worktrees without disturbing the active one", async () => {
  // active project A loaded; ensureProjectWorktrees(B) → B's set cached, A's selectors unchanged
});
it("a git action from a pinned pane resolves the pinned project's worktree", async () => {
  // helper under test takes an explicit projectId; assert it never reads global activePath
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run src/state/worktrees.test.ts`
Expected: FAIL (no per-project cache).

- [ ] **Step 3: Implement in `src/state/worktrees.ts`**

Add `byProject: Record<string, { worktrees: Worktree[]; activePath: string | null }>` plus `ensureProjectWorktrees(projectId)` that reuses the existing `load()` internals against the target project and caches the result (bounded: evict least-recently-used beyond a small cap, e.g. 5). Global `worktrees`/`activePath` selectors are untouched. Fallback if this proves too invasive in review: keep phase one to terminal/agents (done in Task 6, no cache needed) and defer Task 8 until the cache lands.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/state/worktrees.test.ts` then `npm run typecheck`.
Expected: PASS, typecheck clean.

### Task 8: Files / Changes / History follow the pane pin

**Files:**
- Modify: `src/screens/files/FilesScreen.tsx`, `src/screens/changes/ChangesScreen.tsx`, `src/screens/history/*` (graph, file, rewrite mode consumers)
- Test: their existing test files

**Interfaces:**
- Consumes: `usePaneProjectId()` (Task 5) + `ensureProjectWorktrees()` (Task 7).
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing tests**

```tsx
it("files/changes/history render the pinned project's data under a different global project", () => {
  // pane pinned to B, global A → lists B's worktree content; refresh targets B's path
});
```

(one case per screen; history covers its active mode only.)

- [ ] **Step 2: Run to verify they fail**

Run the three screen test files.
Expected: FAIL (global project shown).

- [ ] **Step 3: Implement**

Swap each screen's global project/worktree reads for the pane-effective project + cached worktree set. Refresh/dispatch paths take the resolved worktree path explicitly (the same pattern `discardAllChanges` already uses with a local `worktree` variable). Unpinned panes keep the exact current expressions.

- [ ] **Step 4: Run tests to verify they pass**

Run the three screen test files, then `npm run typecheck`.
Expected: PASS, typecheck clean.

### Task 9: Eye-comfort palette values

**Files:**
- Modify: `src/theme/tokens.css`, `src/theme/theme.ts`, `src/shell/GroupSwitcher.tsx` (swatch chroma), `src/i18n/en.ts` (only if a label is needed — expected: none)
- Test: `src/theme/tokens.test.ts`, `src/theme/theme.test.ts`, `src/theme/cssRules.test.ts`

**Interfaces:**
- Consumes: approved values in the spec ("Parts the user decided").
- Produces: nothing downstream. Includes the approved dark-only scope (no light mode).

- [ ] **Step 1: Write the failing tests**

```ts
it("keeps body text contrast at AA against the surface", () => {
  // compute contrast of --text on --bg via the existing contrast helper → ≥ 4.5
});
it("ships the approved defaults (bg .18/.006/260, text .92, hue 215, swatch chroma .13)", () => {
  // assert DEFAULT_THEME.accentHue === 215 and the token/swatch literals
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm exec vitest run src/theme/tokens.test.ts src/theme/theme.test.ts src/theme/cssRules.test.ts`
Expected: FAIL (old values).

- [ ] **Step 3: Implement**

`tokens.css`: `--bg: oklch(.18 .006 260)`, `--text: oklch(.92 .004 var(--bh))`; `theme.ts`: `accentHue: 215` default (user-saved hues untouched) — confirm the accent chroma reads `~.14` for large fills vs `.16`; `GroupSwitcher.tsx` `swatchColor`: chroma `.19` → `.13`. Semantic washes and focus ring unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run the three theme test files, then `npm run typecheck`.
Expected: PASS, typecheck clean.

### Execution notes (filled during native implementation)

- Order swap: Task 7 (worktree cache) was implemented before Task 6, because Task 6's visibility filter and new-tab/new-agent targeting need per-project worktree sets to be correct — otherwise a throwaway prefix-match heuristic would have been needed and deleted. No task content changed.
- `usePanePin()` (raw pin, Task 5 file) was added so screens can distinguish "explicitly pinned" from "following global" and keep the exact unpinned behavior; this preserved two existing Agent filter tests that caught an over-broad first version.
- `selectCachedWorktree()` lives in the worktrees store (needed by the Task 8 dropdowns); the Task 7 fallback ("defer Task 8") was not used.
- Task 9 additionally darkened the *light*-theme accent (`.53→.50`, chroma `.19→.17`): the shared hue default 215 dropped light-mode accent contrast to 4.39, and the existing AA gate caught it.
- `swatchColor` is now exported for its unit test (precedent: `projectLabel`, `repoNameFromUrl` are already exported for tests).
- New files: `src/stage/paneProject.tsx`, `src/stage/paneProject.test.tsx`, `src/terminal/viewCache.ts` (prior terminal-blank fix, reused here).

### Task 10: Integration gate + manual multi-project walkthrough

**Files:** none (verification only).

- [ ] **Step 1: Full suite green**

Run: `./init.sh`
Expected: exit 0 (Vitest + Rust + typecheck + Clippy per the script). Pre-existing environment failures (e.g. macOS FSEvent streams in sandbox) are reported as-is, not fixed here.

- [ ] **Step 2: Manual walkthrough in the desktop app**

Toggle hotkey flips A↔B from the terminal, palette, and a dialog-open state (no-op in the last); Recents list orders correctly after several switches; pin Files-A beside Files-B and confirm both live-update; remove a pinned project and confirm fallback; dirty file blocks the toggle with the toast. Record the pass/fail matrix in the task's evidence note for the user checkpoint.

