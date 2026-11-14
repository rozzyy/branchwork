# M7 UI/UX Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the approved design system and the 13 → 7 screen flow to Branchwork without losing any feature, with the terminal dock and Ctrl+` untouched.

**Architecture:** Tokens and global rules land first (Stage 1), so every later screen inherits them. The shell (screen registry, sidebar with project picker, breadcrumb, status bar, keyboard) is rebuilt next (Stage 2), with temporary container screens so each feature stays reachable. Stage 3 merges Launchpad + Inbox into Home and finishes History (Graph + Blame + Rewrite). Stage 4 adds the contextual operation banner, per-worktree split layouts and the flush-pane restyle. Existing stores and feature components are reused; only navigation and presentation change.

**Tech Stack:** React 19 + TypeScript, zustand, Vitest + Testing Library, Vite `?raw` CSS imports, Tauri 2 (no Rust changes expected).

**Spec:** `docs/superpowers/specs/2026-11-14-ui-redesign-design-system-design.md` — visual reference `docs/design/redesign-prototype.html` (v3).

## Global Constraints

- The approved design spec is normative. The prototype is a visual aid; when a prototype detail conflicts with `docs/superpowers/specs/2026-11-14-ui-redesign-design-system-design.md`, follow the spec.

- The terminal dock (bottom / right / float / max, tabs, split) and **Ctrl+`** behave exactly as today. No task edits `src/terminal/dock*` behavior or the `Backquote` branch of `src/keys/globalKeys.ts`.
- No feature becomes unreachable at the end of any task; every stage ends with `./init.sh` green.
- All UI strings are English and live in `src/i18n/en.ts`.
- Solid surfaces only; text ≥ 4.5:1 against `--surface` in both themes; no `font-size` below 12px; scrollbars visible; `:focus-visible` ring `0 0 0 2px var(--bg), 0 0 0 4px var(--accent)`.
- Radius: 6px controls, 10px panels/cards/popovers/dialogs, pill only for chips and count badges. Split panes, agent panes and terminals are flush and square (no radius, no gap, 1px `--border` separators, 4–8px header padding); badges inside them stay rounded.
- Targets ≥ 24×24px; buttons 28px, small 24px; rows `--row` 26/30/34.
- Status is icon + text, never color alone.
- Project rules (`CLAUDE.md`): stage branch `m7-stage-<K>` from `main`; no per-task commits; one commit per stage after the user approves its 🛑 checkpoint; manual E2E spec `docs/testing/m7-manual-e2e.md` per stage; version `0.7.0` only after M7 is done (and after M6's `0.6.0`).
- M7 starts only after M6 Stage 4 is approved and merged (user decision).

## Review Focus

- A user updating with a saved layout that uses old screen ids (`graph`, `blame`, `launchpad`, `repo`) lands on the matching new screen, not a reset or blank pane (Task 04 test `migrates saved stage panes`).
- Typing digits in the commit box, palette or a terminal never switches screens unless single-key shortcuts are turned on (Task 07 test `digits do nothing while typing or when disabled`).
- Ctrl+` still toggles the dock from anywhere, including when focus is inside a terminal (Task 07 test `ctrl backquote still toggles the dock`).
- The operation banner appears only for the active worktree's in-progress operation and disappears when the operation ends or the user switches worktrees (Task 10 test `banner follows the active worktree`).
- The project picker closes with Esc, returns focus to its trigger, and still exposes add-project and group management (Task 05 test `project picker keyboard and actions`).

---

## Stage 1 — Design system foundation (🛑 Checkpoint M7.1)

### Task 01: Tokens and global rules

**Files:**
- Modify: `src/theme/tokens.css`
- Create: `src/theme/contrast.ts`, `src/theme/tokens.test.ts`

**Interfaces:**
- Produces: CSS custom properties from the spec table (`--bg --surface --raised --overlay --hover --selected --border --border-strong --text --text-2 --text-3 --accent --accent-strong --on-accent --success --warning --danger --info --agent`, the `-bg` tints, `--diff-add --diff-del`, `--fs-meta --fs-body --fs-title --fs-h2 --fs-h1`, `--space-1..--space-6`, `--r-control --r-panel --r-pill`, `--focus`). Old names stay as aliases so un-migrated CSS keeps working: `--surf: var(--surface)`, `--s2: var(--raised)`, `--s3: var(--overlay)`, `--s4: var(--border-strong)`, `--glass/--glass2: var(--surface)/var(--raised)`, `--line: var(--border)`, `--line2: var(--border-strong)`, `--fg: var(--text)`, `--fg2: var(--text-2)`, `--fg3: var(--text-3)`, `--acc: var(--accent)`, `--grn/--red/--yel/--blu/--pur` → success/danger/warning/info/agent.
- Produces: `contrastRatio(a: string, b: string): number` in `src/theme/contrast.ts` for `oklch(L C H)` strings with `var(--ah)`/`var(--bh)` substituted (OKLCH → linear sRGB → WCAG relative luminance).
- Produces: utility classes `.flush` (square, no gap) used by Task 12.

- [ ] **Step 1: Write the failing tests** in `src/theme/tokens.test.ts` (import `tokens.css?raw`):
  - `text roles pass AA in both themes`: for `--text`, `--text-2`, `--text-3`, `--accent`, `--success`, `--warning`, `--danger`, `--info`, `--agent` in the dark block and the `[data-theme="light"]` block, `contrastRatio(value, surface) >= 4.5` (hue 250, tint 265).
  - `no blanket square corners or hidden scrollbars`: the CSS does not contain `border-radius: 0 !important`, `scrollbar-width: none`, or `::-webkit-scrollbar { display: none`.
  - `focus ring is defined`: contains `:focus-visible` and `--focus`.
  - `contrastRatio` unit cases: `contrastRatio("oklch(1 0 0)", "oklch(0 0 0)")` ≈ 21 (±0.1), equal colors → 1.
- [ ] **Step 2:** `pnpm vitest run src/theme/tokens.test.ts` → FAIL.
- [ ] **Step 3:** Rewrite `tokens.css` with the spec's values (dark default, light under `:root[data-theme="light"]`, `[data-text="large"]` scale, densities), the aliases above, visible thin scrollbars, the focus ring, `prefers-reduced-motion`. Remove the glass/`data-solid` blocks and the blanket radius/scrollbar rules; keep pill radius for `.btn`-like pills only where the spec says pill (chips, badges).
- [ ] **Step 4:** `pnpm vitest run src/theme` and `pnpm typecheck` → PASS. Run the app (`pnpm tauri dev`) once and note any screen whose layout broke because of the removed square-corner rule; fix only breakage, not redesign.
- [ ] **Step 5: Commit** _(skipped: no-commit rule)_

### Task 02: Theme settings — Text size replaces contrast and transparency

**Files:**
- Modify: `src/theme/theme.ts`, `src/theme/theme.test.ts`, `src/state/settings.ts`, `src/screens/settings/SettingsScreen.tsx`, `src/i18n/en.ts`

**Interfaces:**
- Produces: `ThemeSettings = { mode; accentHue; baseHue; textSize: "default" | "large"; density }` (removes `contrast`, `reduceTransparency`). `applyTheme` sets `root.dataset.text = "large"` or removes it; no longer sets `--k` or `data-solid`.
- Loading tolerates old saved objects: unknown keys are ignored, missing `textSize` → `"default"`.

- [ ] **Step 1: Failing tests** in `theme.test.ts`: `applies large text size` (`applyTheme({...DEFAULT_THEME, textSize: "large"})` → `document.documentElement.dataset.text === "large"`); `ignores legacy contrast and transparency` (settings load with `{contrast: 1.4, reduceTransparency: true}` → theme has no such keys, `data-solid` absent). In `SettingsScreen.test.tsx`: `appearance offers text size` (a "Text size" segmented control with Default/Large; no "Contrast" or "Reduce transparency" rows).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement; i18n keys `settings.textSize`, `settings.textSize.default`, `settings.textSize.large`; delete `settings.contrast`, `settings.reduceTransparency`.
- [ ] **Step 4:** `pnpm vitest run src/theme src/screens/settings src/state` → PASS.
- [ ] **Step 5: Commit** _(skipped)_

### Task 03: Base components

**Files:**
- Modify: `src/ui/ui.css`, `src/ui/Button.tsx`, `src/ui/controls.tsx`, `src/ui/Menu.tsx`, `src/ui/dialog.tsx`, `src/ui/toast.tsx`
- Create: `src/ui/StatusLabel.tsx`, `src/ui/Banner.tsx`, `src/ui/StatusLabel.test.tsx`, `src/ui/Banner.test.tsx`

**Interfaces:**
- Produces: `StatusLabel({ tone, icon, children }: { tone: "ok" | "warn" | "bad" | "agent" | "info"; icon: string; children: ReactNode })` → `<span class="status {tone}"><span aria-hidden>{icon}</span>{children}</span>`.
- Produces: `CountBadge({ count, tone, label }: { count: number | string; tone?: "neutral" | "warn" | "bad" | "agent"; label: string })` (exported from `StatusLabel.tsx`; `aria-label={label}`).
- Produces: `Banner({ tone, icon, title, detail, actions }: { tone: "warn" | "bad" | "info"; icon: string; title: string; detail?: string; actions: ReactNode })` with `role="status"`.

- [ ] **Step 1: Failing tests:** `status label shows icon and text` (renders text "2 conflicts", icon hidden from AT); `count badge has an accessible label`; `banner announces itself` (`role="status"`, title text, actions rendered).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement components and restyle buttons (28/24px, 6px radius, variants primary/secondary/ghost/danger), segmented, switch, menu/popover/dialog (10px radius, `--overlay`, shadow), toast, with the prototype as reference.
- [ ] **Step 4:** `pnpm vitest run src/ui` → PASS; `./init.sh` green.
- [ ] **Step 5:** Stage 1 review gate (code review; security review not needed — no IPC/CSP change), write `docs/testing/m7-manual-e2e.md` Stage 1 (theme switch, Text size Large, focus ring on Tab through title bar + sidebar, visible scrollbars, contrast spot check in light), 🛑 **Checkpoint M7.1**.

---

## Stage 2 — Shell and navigation (🛑 Checkpoint M7.2)

### Task 04: Screen registry, migration and container screens

**Files:**
- Modify: `src/screens/registry.ts`, `src/stage/stageModel.ts`, `src/state/stage.ts`, `src/screens/views.tsx`, `src/palette/commands.ts`, and every `go("graph" | "blame" | "rebase" | "repo" | "launchpad" | "inbox")` call site (`GraphScreen.tsx`, `FilesScreen.tsx`, `CodeMirrorEditor.tsx`, `ConflictsScreen.tsx`, `LaunchpadScreen.tsx`, `InboxScreen.tsx`, `RepoScreen.tsx`)
- Create: `src/state/history.ts`, `src/screens/history/HistoryScreen.tsx`, `src/screens/history/HistoryScreen.test.tsx`, `src/screens/home/HomeScreen.tsx` (temporary), `src/state/stage.test.ts` additions

**Interfaces:**
- Produces: `ScreenId = "home" | "changes" | "history" | "files" | "agents" | "terminal" | "github" | "settings" | "conflicts"`; `NAV_SCREENS: ScreenId[] = ["home","changes","history","files","agents","terminal","github"]` (⌘1–⌘7 order); `conflicts` has no nav section.
- Produces: `migrateScreenId(id: string): { screen: ScreenId; historyMode?: HistoryMode }` — `launchpad|inbox|compare → home`, `graph → history/graph`, `blame → history/file`, `rebase → history/rewrite`, `repo → github`, known new ids unchanged, anything else → `home`.
- Produces: `useHistory` store: `{ mode: HistoryMode; file: { path: string; line?: number } | null; setMode(m): void }` with `HistoryMode = "graph" | "file" | "rewrite"`, and `openHistory(mode: HistoryMode, file?: { path: string; line?: number }): void` (sets store, `useStage.go("history")`).
- Produces: `HistoryToolbar` (mode tabs + the active mode's existing toolbar: `GraphToolbar` / `BlameToolbar` / `RebaseToolbar`) and `HistoryView` (renders `GraphView` / `BlameView` / `RebaseView`).
- Temporary: `HomeView` = Launchpad content with an "Inbox" tab (`LaunchpadView` / `InboxView`) until Task 08.

- [ ] **Step 1: Failing tests:** in `stage.test.ts` — `migrates saved stage panes` (saved `{panes:["graph","blame"], …}` loads as `["history"]` with focus 0 and `useHistory.mode === "graph"`; `{panes:["launchpad","repo"]}` → `["home","github"]`; `{panes:["bogus"]}` → `["home"]`); `migrateScreenId` table test. In `HistoryScreen.test.tsx` — `switches modes` (tabs Graph / File history · blame / Rewrite history render the matching view; `openHistory("file", {path:"a.ts"})` selects File history).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement. `stage.load()` maps panes through `migrateScreenId`, de-duplicates, clamps focus, then validates. Replace old `go(...)` calls: blame entry points → `openHistory("file", {path})`, Graph "Rebase from here" → `openHistory("rewrite")` (after `setBase`), "View commit" → `openHistory("graph")`, repo → `go("github")`. Palette commands follow the new ids. i18n: `nav.home`, `nav.history`, `nav.github`, `history.mode.graph`, `history.mode.file`, `history.mode.rewrite`, `sidebar.sectionScreens`.
- [ ] **Step 4:** `pnpm vitest run src/state src/stage src/screens src/palette` → PASS (update tests that referenced old ids).
- [ ] **Step 5: Commit** _(skipped)_

### Task 05: Sidebar with project picker; right rail removed

**Files:**
- Modify: `src/shell/Sidebar.tsx`, `src/shell/Sidebar.test.tsx`, `src/shell/shell.css`, `src/shell/GroupSwitcher.tsx`, `src/state/sidebar.ts`, `src/App.tsx`
- Create: `src/shell/ProjectPicker.tsx`, `src/shell/ProjectPicker.test.tsx`
- Delete: `src/shell/ProjectSidebar.tsx`, `src/shell/ProjectSidebar.test.tsx`

**Interfaces:**
- Consumes: `buildSections`, `GroupSwitcherPopover` / `useSwitcher` from `GroupSwitcher.tsx` (search, groups, add project, add/manage group), `NAV_SCREENS` (Task 04).
- Produces: `ProjectPicker()` — trigger button (mark, project name, "Group · N projects") opening the group/project popover anchored below it.
- `useSidebar` drops `projectRailOpen` and `toggleProjectRail`; persisted `{collapsed}` only (old key ignored).

- [ ] **Step 1: Failing tests:** `Sidebar.test.tsx` — `lists the seven screens in order with shortcut hints` (labels Home…GitHub, hints ⌘1…⌘7, Settings in the footer); `no conflicts item in the menu`; `worktree rows show a status label` (e.g. "4 changes", "2 conflicts"). `ProjectPicker.test.tsx` — `project picker keyboard and actions` (Enter opens; Esc closes and focus returns to the trigger; "Add project…" and a group's manage action are present; selecting a project calls the repos store switch).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement: sidebar order = ProjectPicker → Worktrees (existing `WorktreeSection`, rows get `StatusLabel`) → "Screens" → footer Settings. Keep ⌘-click/⌥-click/drag/context-menu split behavior on screen rows. Remove the right rail from `App.tsx` and its toggle from the title bar.
- [ ] **Step 4:** `pnpm vitest run src/shell src/state` → PASS.
- [ ] **Step 5: Commit** _(skipped)_

### Task 06: Breadcrumb title bar and status bar

**Files:**
- Modify: `src/shell/TitleBar.tsx`, `src/shell/TitleBar.test.tsx`, `src/shell/shell.css`, `src/App.tsx`
- Create: `src/shell/StatusBar.tsx`, `src/shell/StatusBar.test.tsx`

**Interfaces:**
- Produces: breadcrumb `Group › Project › Worktree ▾`; group and project segments open the ProjectPicker popover; the worktree segment opens a worktree menu (pinned worktrees; selecting sets `useWorktrees.activePath`).
- Produces: `StatusBar()` (26px): active branch, `StatusLabel` for changes, `↑ahead ↓behind`, agents summary ("N agents · M waiting", agent tone), dock toggle button labelled "Terminal Ctrl+`" calling `useDock.getState().toggle()`.

- [ ] **Step 1: Failing tests:** `breadcrumb shows group, project and worktree`; `worktree crumb switches worktree`; `status bar summarizes the worktree and toggles the dock` (click → `useDock.toggle` called once).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement; keep ⌘K search, theme toggle; add the `?` button (opens the sheet from Task 07).
- [ ] **Step 4:** `pnpm vitest run src/shell` → PASS.
- [ ] **Step 5: Commit** _(skipped)_

### Task 07: Keyboard — ⌘1–⌘7, optional single keys, shortcut sheet

**Files:**
- Modify: `src/keys/globalKeys.ts`, its test, `src/state/settings.ts`, `src/screens/settings/SettingsScreen.tsx`, `src/i18n/en.ts`
- Create: `src/shell/ShortcutSheet.tsx`, `src/shell/ShortcutSheet.test.tsx`

**Interfaces:**
- Produces: `useSettings.singleKeyShortcuts: boolean` (default `false`, persisted key `singleKeyShortcuts`) + `setSingleKeyShortcuts(on)`.
- Produces: `useShortcutSheet` (`open`, `show()`, `hide()`); `?` (no modifier, not typing, no dialog/palette open) and the title-bar `?` open it.
- Key map: ⌘/Ctrl+1..7 → `NAV_SCREENS[n-1]`; bare 1..7 only when `singleKeyShortcuts`; ⌘K, ⌘B, ⌘\, Ctrl+⇧G and Ctrl+` unchanged.

- [ ] **Step 1: Failing tests:** `meta digits navigate` (⌘3 → `history`); `digits do nothing while typing or when disabled` (bare `2` with setting off → no navigation; setting on but focus in a textarea → no navigation; setting on, not typing → `changes`); `ctrl backquote still toggles the dock` (also when `document.activeElement` is a `.xterm-helper-textarea`); `question mark opens the shortcut sheet`; sheet lists Ctrl+` and closes with Esc.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement; Settings → Keyboard section with the switch "Single-key screen shortcuts (1–7)" and a read-only row "Terminal dock · Ctrl+`".
- [ ] **Step 4:** `pnpm vitest run src/keys src/shell src/screens/settings` → PASS; `./init.sh` green.
- [ ] **Step 5:** Stage 2 review gate (code review; e2e: update Playwright specs that click old menu items), manual spec Stage 2 (project picker, breadcrumb switching, worktree list, saved-layout migration from a pre-M7 profile, ⌘1–⌘7, digits while typing, Ctrl+` from a terminal), 🛑 **Checkpoint M7.2**.

---

## Stage 3 — Home and History (🛑 Checkpoint M7.3)

### Task 08: Home = Launchpad + Inbox

**Files:**
- Modify: `src/screens/home/HomeScreen.tsx`, `src/screens/launchpad/LaunchpadScreen.tsx`, `src/screens/inbox/InboxScreen.tsx`, `src/screens/views.tsx`, `src/i18n/en.ts`
- Create: `src/screens/home/attention.ts`, `src/screens/home/attention.test.ts`, `src/screens/home/HomeScreen.test.tsx`

**Interfaces:**
- Consumes: the Inbox store items (GitHub notifications + agent waiting/done) and Launchpad's data (KPIs, issues, CI feed, scope).
- Produces: `attentionItems(inbox: InboxItem[], conflicts: { worktree: string; count: number }[]): AttentionItem[]` with `AttentionItem = { id; kind: "review" | "mention" | "ci" | "agent" | "conflict"; title; meta; at: number }`, newest first, conflicts pinned on top.
- Produces: `HomeView` sections: header (greeting, scope selector, ＋ New worktree) → "Needs your attention" with filter tabs All / Review / Mention / CI / Agents (Inbox actions: open, snooze, mark done, reply to agent) → KPIs → Issues for you + CI feed. Launchpad and Inbox stop being screens; their components become sections (`LaunchpadKpis`, `LaunchpadIssues`, `LaunchpadCiFeed`, `InboxList({ filter })`).

- Produces: an agent "finished" item's primary action **Review changes**: sets `useWorktrees.activePath` to the session's worktree and opens the layout `["agents","changes"]` with focus on Changes.

- [ ] **Step 1: Failing tests:** `attention.test.ts` — `orders items and pins conflicts`, `maps inbox kinds to filters`; `HomeScreen.test.tsx` — `filters the attention list` (Agents tab shows only agent items), `snooze and mark done still work` (calls the inbox store), `shows KPIs, issues and CI feed`, `review changes opens agents and changes beside` (activePath set; stage panes `["agents","changes"]`, focus 1).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement; remove the temporary tabbed Home from Task 04.
- [ ] **Step 4:** `pnpm vitest run src/screens/home src/screens/launchpad src/screens/inbox` → PASS.
- [ ] **Step 5: Commit** _(skipped)_

### Task 09: History completion — Rewrite base picker, Commit… beside, blame at a line

**Files:**
- Modify: `src/screens/history/HistoryScreen.tsx`, `src/screens/rebase/RebaseScreen.tsx`, `src/screens/graph/GraphScreen.tsx`, `src/screens/graph/WipInspector.tsx`, `src/screens/blame/BlameScreen.tsx`, `src/screens/files/FilesScreen.tsx`, `src/editor/CodeMirrorEditor.tsx`, `src/i18n/en.ts`
- Create: `src/screens/rebase/BasePicker.tsx`, `src/screens/rebase/BasePicker.test.tsx`

**Interfaces:**
- Consumes: `readGraphPage(projectId, worktreePath, 0)` and `graphAncestry(commits, headSha)`; `useRebaseUi.setBase(worktree, sha)`; `openHistory` (Task 04); `useStage.openSplit("changes", "right")`.
- Produces: `BasePicker({ worktree })` — lists up to 50 HEAD-ancestor commits (subject, short SHA, age) excluding HEAD; choosing one calls `setBase`. Rewrite mode shows it instead of "Pick a commit in Graph".
- WIP inspector: staging buttons removed; one primary "Commit…" opens Changes beside (or focuses it if already open).
- Files/editor: line action "Who changed this?" → `openHistory("file", { path, line })`; `BlameView` selects `useHistory.file.line` on open.

- [ ] **Step 1: Failing tests:** `BasePicker.test.tsx` — `lists ancestors and sets the base` (HEAD excluded, max 50, click → `setBase(worktree, sha)`); `RebaseScreen.test.tsx` — `rewrite mode without a base shows the picker`; `GraphScreen.test.tsx` — `working copy offers Commit beside and no staging` (no Stage buttons; click → `openSplit("changes","right")`); `BlameScreen.test.tsx` — `opens at the requested line`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `pnpm vitest run src/screens` → PASS; `./init.sh` green.
- [ ] **Step 5:** Stage 3 review gate, manual spec Stage 3 (Home filters and actions, KPIs; History modes; base picker; Commit… beside; Files → who changed this line), 🛑 **Checkpoint M7.3**.

---

## Stage 4 — Context, split and flush restyle (🛑 Checkpoint M7.4)

### Task 10: Operation banner replaces the Conflicts menu item

**Files:**
- Create: `src/shell/OperationBanner.tsx`, `src/shell/OperationBanner.test.tsx`
- Modify: `src/stage/Stage.tsx` (banner above panes), `src/shell/Sidebar.tsx` (worktree ⚠ badge opens Conflicts), `src/palette/commands.ts`, `src/i18n/en.ts`

**Interfaces:**
- Consumes: `useConflicts` (`list.operation: "merge" | "cherryPick" | "revert" | "rebase" | "none"`, `list.files`) for the active worktree via `useConflictWatch`; `rebaseContinue`, `rebaseAbort`, `conflictAbort`; `ask()` for danger confirms.
- Produces: `OperationBanner()` — hidden when `operation === "none"` or the list belongs to another worktree. Copy: `"<Operation> in progress · N files in conflict"` (or "· conflicts resolved"). Actions: **Resolve conflicts** (→ `go("conflicts")`, hidden when N = 0), **Continue** (rebase only; disabled while N > 0; calls `rebaseContinue` with the existing done/lease handling from `useRebaseUi.finished`), **Abort** (danger confirm; `rebaseAbort` for rebase, `conflictAbort` otherwise).

- [ ] **Step 1: Failing tests:** `banner follows the active worktree` (list for `/wt/a` with rebase + 2 files shows; activePath `/wt/b` hides; operation `none` hides); `continue is disabled while conflicted` ; `abort asks first` (Cancel → no IPC; confirm → `rebaseAbort`); `resolve opens Conflicts`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement; palette gets "Resolve conflicts" only while an operation is in progress.
- [ ] **Step 4:** `pnpm vitest run src/shell src/stage src/palette` → PASS.
- [ ] **Step 5: Commit** _(skipped)_

### Task 11: Open beside and per-worktree layouts

**Files:**
- Modify: `src/screens/agents/AgentsScreen.tsx`, `src/stage/PaneControls.tsx`, `src/stage/splitMenu.tsx`, `src/stage/stageModel.ts`, `src/state/stage.ts`, `src/stage/Stage.test.tsx`, `src/state/stage.test.ts`, `src/i18n/en.ts`

**Interfaces:**
- Produces: pane header control "◨ Open beside" (single pane) opening a menu of `NAV_SCREENS` minus the current one, then layouts **Agent + Changes** (`["agents","changes"]`) and **History + Files** (`["history","files"]`). Two panes: swap + close (as today).
- Produces: `useStage` persists `layouts: Record<string /*worktree path*/, StageState>` under the existing `stage` key as `{ current, layouts }`; on `useWorktrees.activePath` change the stage switches to that worktree's saved layout (default `{panes:["home"]}`). Loading accepts the old single-state shape (treated as the layout for every worktree until changed).

- Produces: each agent pane header gets **± Review beside** → opens Changes beside the Agents pane (`openSplit("changes","right")`, or focuses it when already open).

- [ ] **Step 1: Failing tests:** `open beside menu offers screens and layouts`; `agent review beside opens changes` (in `AgentsScreen.test.tsx`); `layout preset opens two panes`; `layouts are remembered per worktree` (split on `/wt/a`, switch to `/wt/b` → single Home, back to `/wt/a` → split restored); `loads the pre-M7 stage shape`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement; ⌘\, ⌘-click/⌥-click, drag and right-click keep working.
- [ ] **Step 4:** `pnpm vitest run src/stage src/state` → PASS.
- [ ] **Step 5: Commit** _(skipped)_

### Task 12: Flush panes and screen restyle

**Files:**
- Modify: `src/stage/stage.css`, `src/screens/agents/agents.css`, `src/terminal/*.css` (visual padding/radius only — no dock behavior), all `src/screens/**/*.css`, `src/screens/changes/ChangesScreen.tsx` (clean-tree empty state)
- Create: `src/theme/cssRules.test.ts`

**Interfaces:**
- Consumes: tokens (Task 01), `.flush` rules.
- Produces: split Stage, lone Agents/Terminal pane, agent grid, Terminal screen panes and the dock are flush and square (1px separators, 4–8px headers, focused split pane = 2px accent top line); badges/chips inside keep `--r-pill`.

- [ ] **Step 1: Failing test** `src/theme/cssRules.test.ts` (eager `import.meta.glob("/src/**/*.css", { query: "?raw" })`): `no font size below 12px` (every `font-size: Npx` ≥ 12); `scrollbars are never hidden`; `flush panes are square` (`stage.css` split pane rule and `agents.css` agent pane rule set `border-radius: 0`); `Changes clean tree shows an empty state with a link to History` (component test in `ChangesScreen.test.tsx`).
- [ ] **Step 2:** run → FAIL (today: ~90 sub-12px declarations).
- [ ] **Step 3:** Restyle screens onto tokens; replace sub-12px sizes with `--fs-meta`; flush pane rules; Changes empty state.
- [ ] **Step 4:** `./init.sh` green; Playwright suite has no new failures versus the 11 pre-existing ones.
- [ ] **Step 5:** Stage 4 review gate (code + e2e; security only if IPC changed), manual spec Stage 4 (banner flow during a real rebase conflict, Open beside + presets, per-worktree layouts, flush panes, Ctrl+` dock unchanged, light/dark + Large text pass on every screen), 🛑 **Checkpoint M7.4**. After approval: stage commit, then `chore(release): v0.7.0` per the versioning rule (after M6's `0.6.0`).
