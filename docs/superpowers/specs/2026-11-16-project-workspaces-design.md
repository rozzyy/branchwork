# Project workspaces: quick toggle + per-pane project pins

## Intent and the why

The user works multi-project tasks daily. Switching projects today means
opening the sidebar picker, searching, and clicking — after which the whole
app re-scopes to the new project (agents filter, terminal tabs, files,
changes, history). There is no fast A↔B toggle and no way to see two
projects side by side. The requested feel is "as simple as Orca AI", with
zero features removed.

## Goals

- G1: One hotkey toggles between the two most recently used projects.
- G2: The project popover lists recently used projects on top.
- G3: Any split pane can pin its own project; unpinned panes keep following
  the global active project.
- G4: No feature is removed; all 10 screens keep working as today.
- G5: Pinned panes keep their sessions alive across global project switches
  (no detach/replay churn; builds on the keep-mounted CliPane fix).

## Non-goals

- Per-pane *worktree* selection. Pins are project-level; the worktree follows
  that project's own worktree state.
- Stage-tab workspaces (dropped approach, see below).
- Any change to the persisted-settings format beyond additive fields.

## Anti-goals

- A second global mode where it is unclear which project a pane shows. The
  pinned project must always be visible in the pane header.
- Weakening the dirty-edit guard (`files.switchDirtyBlocked`): switching
  projects with unsaved editor changes stays blocked with the same toast.

## Constraints

- Architecture: a single global `activeProjectId` in `src/state/repos.ts`
  plus a single global worktree selection in `src/state/worktrees.ts`.
  Roughly 25 files read one of them; all scope changes flow through zustand.
- All UI strings are English and come from `src/i18n/en.ts`.
- Repo policy: one feature at a time (M13 is in review, so this is queued
  next), no commit/push without an explicit order.
- Accessibility: pin control and toggle are keyboard reachable, labeled, and
  keep the visible focus ring.

## Approaches considered

- **A. Quick toggle only** (hotkey + recents). Cheap, no architecture change.
  Rejected as insufficient on its own: still one project at a time.
- **B. Per-pane project pin** (this design, with A). Real side-by-side;
  medium-large change because every screen reads the global project.
- **C. Stage tab = workspace per project** (each tab remembers its project).
  Medium change. Rejected: it only switches faster sequentially, never
  simultaneous in one screen — it does not deliver what was asked.

Picked: **A + B**, chosen by the user.

## The design

### Part 1 — Quick toggle and recents (build first, independent)

- `src/state/repos.ts` tracks `recentProjectIds` (cap ~5, most-recent-first,
  persisted alongside the existing repo settings). Every `selectProject` /
  `selectGroup` that changes the project unshifts the id and trims.
  (`openProjectIds` already exists but is unordered history; recents is the
  ordered view over the same events.)
- One hotkey toggles between the two most recent projects. Exact binding is
  the builder's call: it must be free in `src/keys/globalKeys.ts` and be
  added to `ShortcutSheet` plus `en.ts`. Suggested candidates are noted in
  the plan, not fixed here.
- `GroupSwitcherPopover` gains a "Recent" section above the grouped list.
  The grouped list below stays complete and unchanged (no deduplication
  games: recents are shortcuts, the list is the source of truth).
- The toggle goes through the same `selectProject` path, so the dirty-edit
  guard behavior is unchanged (blocked switch toasts as today).

### Part 2 — Per-pane project pins (build second)

- Data: the stage pane model gains an additive `projectId?: string | null`
  per pane (`null`/missing = follow the global active project). Old saved
  state without the field behaves exactly as today.
- Plumbing: a `PaneProjectContext` provided by `Pane`, set to
  `pin ?? global activeProjectId`. A new `usePaneProjectId()` hook returns
  the effective id and `usePaneProject()` the record. Screens migrate off
  direct `useRepos(s => s.activeProjectId)` reads onto the hook, starting
  with the daily-driver batch: files, changes, history, agents, terminal.
  Remaining screens (github, browser, conflicts, settings, home) migrate
  after; unmigrated screens simply keep following the global project, which
  is always a correct fallback.
- Worktree scoping (biggest risk, explicitly called out): `useWorktrees` is
  global-single (`projectId` + `activePath`). Pinned panes need that
  project's worktree set. The design calls for a lazily loaded per-project
  cache in the worktrees store (`byProject: projectId → { worktrees,
  activePath }`) with the existing global selectors preserved for unpinned
  panes. If the cache proves too invasive in planning, the fallback is to
  scope phase one to project-level screens whose worktree resolves via the
  project's own `activePath`, and note terminal/agents pinning as phase two.
- Pane header UI: the pin control lives in `PaneControls` (always present in
  every pane header): a small chip with the project's group color dot +
  name (reuses `projectLabel` and group colors), opening the existing
  `GroupSwitcherPopover` anchored to the chip. The popover's first item is
  "Follow global project" (unpin). A pinned pane always shows the chip, so
  there is never ambiguity about which project a pane shows.
- Sessions: agent/terminal sessions bind `worktreePath` at spawn, so a
  pinned pane spawns into its own project's worktrees. The keep-mounted
  views (`TerminalScreen` hidden tabs, `CliPane` view cache keyed by
  session id) apply unchanged — a global project switch no longer unmounts
  anything in a pinned pane.
- Dirty guard on pin changes: changing a pane's pin discards no state
  (other panes and the editor store are untouched), so pins are not guarded
  by default. The builder must verify the editor dirty lifecycle per pane
  during planning; if any dirty content can be stranded, the same block
  toast applies to pin changes.

### Rollout order

1. Part 1 (toggle + recents): small, ships independently.
2. Part 2 data model + context + header chip (behind no flag; unpinned
   panes behave exactly as today).
3. Screen migration, files/changes first; worktree cache alongside.
4. Remaining screens, shortcut sheet, i18n polish, manual multi-project
   walkthrough.

## Parts the user decided

- Combination A + B (quick toggle plus per-pane pins); approach C dropped.
- Simplicity like Orca AI, with no features removed (G4).
- Eye-comfort palette (approved 2026-11-16): `--bg` → `oklch(.18 .006
  260)`; primary `--text` → `oklch(.92 …)` instead of `.96`; default accent
  hue 250 → ~215 with chroma ~`.14` (the user hue setting is untouched,
  only the default changes); group swatch chroma `.19` → `~.13`;
  semantic washes stay at alpha `.14`; the focus ring stays as-is.
  Rationale: slightly lifted neutral background, no full-white text on
  dark, calm blue over vivid purple for large areas, never color-alone
  (always paired with label/icon). Contrast stays AA. No light mode.

## Left to the builder

- Exact toggle hotkey (must be free; update `ShortcutSheet` + `en.ts`).
- Shape of the per-project worktree cache and its loading/eviction rules.
- Whether pin changes need the dirty guard (verify editor dirty lifecycle).
- Visual details of the pin chip and the recents section (mockups with the
  user after this doc is approved).
- Which screens beyond the first batch migrate, and in what order.
