# Merged pane headers (Agents + Terminal) and honest token-saver badges — design

Date: 2026-11-21 · Size: project
Mockups: `.superpowers/brainstorm/34094-1795263081/content/nested-split-headers.html` (option **B** chosen), `one-header-per-pane.html` (Agents single and grid), `agents-headerless.html` (RTK badge states).
Header layout: `tidy-agent-header-v3.html` option **H** (calm row, cluster on focused pane / hover). Rejected along the way (do not build): right-side icon rail, slim header, floating pills, sidebar actions, options A–G of the tidy-header rounds.

## Intent

Agents and Terminal panes stack several header rows before any content (user screenshot, 2026-11-21):
- **Agents, one session:** the page header (`Agents · Grid/Full · Race · New agent · pane controls`, 44px), then the session header (`Claude Code ⇕ · worktree · Waiting · Personal · ◧◨▭ · ⤴ ↗ ✕`, 34px), then the meter strip (`5h · Weekly · RTK · Caveman · Review beside`, 30px). About 108px in total.
- **Terminal:** the page header (`Terminal ＋`), then the terminal tabs, then one header per split part (`● worktree ⇕ cwd ⫴ ⫴ ⤢ × ⋯`), then a status bar at the bottom. Four rows for a two-part split.

The top row only labels what is under it. The goal is **one header row per stage pane**, without changing how stage split view looks.

Second goal: the RTK badge reads "on" when RTK is merely armed. In a real session about 100 commands ran and none were compressed, because they were `cd … && …` or piped. Another real session showed "RTK unavailable". The badge must show real impact, the common `cd <dir> && <cmd>` shape should be compressed, and the "unavailable" cause must be found.

## Goals

### G1. Shared: a screen can own its pane header (revised 2026-11-21 after the first build was too crowded)
- `ScreenView` gains an optional `ownsHeader?: true`. For such screens `Pane` does not render `header.pane-tool`. The screen renders one `PaneHeader` row itself, and `PaneControls` is passed through context (`PaneChromeContext`). The controls are unchanged: Open beside when unsplit; Open beside / Swap / Orientation / Move to new window / Close pane when split; same handlers, accessible names and shortcuts.
- **`PaneHeader` is one calm row, 34px, that never wraps** (mockup `tidy-agent-header-v3.html`, option **H**):
  - **Left: identity.** It may shrink: text truncates with ellipsis, the least important parts first.
  - **Right: one status element** (G2 status chip, or the Broadcasting chip in G3).
  - **Action cluster:** the screen's actions + ⋯ + `PaneControls`, as one group positioned at the right end of the row, *over* the status element (absolute, no layout shift, solid surface background).
- **When the cluster is visible:**
  - **Always** when the pane is the only stage pane, or when it is the focused stage pane in a split (`useStage` `focusId`, the pane that already shows the accent line).
  - **Otherwise (unfocused pane in a split):** shown on pointer hover over the pane header, and on `:focus-within` (keyboard). It is hidden at rest, but stays in the DOM and in the tab order. Hiding it only changes opacity/visibility, so it never moves anything.
  - **Revision (2026-11-22, coordinator ruling on stage-3 review finding C4):** the line above ("over the status element") conflicts with G2's "clicking the chip opens its popover" — the cluster covered the chip and swallowed the click on the only/focused pane. Resolved as: **active pane** (only pane, or the focused pane in a split) — the cluster sits in **normal flow** after the status element instead of overlapping it: `identity (shrinks) | status chip (shrinks: full → ring+% → ring) | cluster (fixed)`. Nothing overlaps; the chip stays clickable. **Inactive pane** — unchanged: hidden at rest, revealed as an absolute overlay over the status element on hover/`:focus-within`.
- The cluster never clips: it is a fixed-size group anchored right. When the row is narrow, the identity truncates and the status element shrinks (see G2).
- Screens without `ownsHeader` (every other page) keep today's header. Stage split view is unchanged: dividers, focus accent line.

### G2. Agents
- **One visible session** (today's "solo"): the session header *becomes* the pane header row.
  - Identity: status dot, CLI switch select, `· <worktree>`, status text (`Waiting for you` → `Waiting` when narrow).
  - Status element: the **session status chip**.
  - Cluster: `＋` New agent (primary, icon), ⋯, `PaneControls`.
  - ⋯ menu, in two sections. **Session:** Left / Right / Full slot, Move to dock, Hand over, Review beside, Close session. **Agents page:** Race, Grid layout, Full width.
- **Session status chip** (replaces today's separate usage meter, RTK badge, Caveman badge and profile chip):
  - Content: a usage ring (tightest effective headline window, `usageTone` color) + `26%` + RTK state (`RTK −18.4k` / `RTK 0`, see G4) + account name.
  - It shrinks by container width: full → ring + percent → ring only.
  - Clicking opens one popover with three sections. **Usage:** today's quota popover content (all windows, resets, updated, stale). **Token savers:** RTK runs/saved/state and why; Caveman state and note. **Account:** today's profile switch list.
  - Loading/none/unsupported/unavailable usage show the ring empty, with today's texts in the tooltip and the popover.
- **Several sessions (grid or full mode)** or **no sessions:** the pane header row has identity `✦ Agents · <n sessions · m waiting>`. Its cluster holds Grid/Full (`aria-pressed`), `⚑ Race`, `＋ New agent`, and `PaneControls`, with the same visibility rule.
  - Each session tile has **one** row: the same identity + session status chip, plus the tile's own ⋯ (slots, dock, hand over, review beside) and ✕ Close session. Both are always visible: they are only two small buttons and belong to the tile, not the stage.
- The separate meter strip (`.agent-phm`) is removed everywhere.

### G3. Terminal (option B for split parts)
- **Pane header row:**
  - Identity: the terminal tab strip (`.term-screen-tabs`: tabs, rename, close) followed by `＋` New tab. These are always visible because they are content. ⌘T is unchanged.
  - Status element: a `Broadcasting to N` chip, only while broadcast is on.
  - Cluster: Broadcast toggle (`◉`, `aria-pressed`, ⌥⌘I), ⋯ (future-proof; may hold nothing yet: omit it if empty), `PaneControls`, with the G1 visibility rule.
  - The old page title + ＋ row is removed.
- **Split parts have no header row.** Each part (leaf) shows a **corner label** at its top right, over the terminal content:
  - Idle: worktree color dot + current folder name (`tail(cwd)`), max 45% of the part's width with ellipsis, semi-opaque surface, and `title` = full cwd and worktree path.
  - On hover (150ms) or focus-within (immediate), it expands in place to show: worktree select (today's `term-screen-worktree`), Split right ⫴, Split down ⫴, Maximize ⤢, Close ×, More ⋯ (today's menu), plus `pane i/n` and `cols×rows`. Same handlers, labels and shortcuts as the current `term-screen-pane-head`.
  - The label is in the tab order. The rest of the part passes clicks through to xterm.
- The focused part is marked by its outline, as today's `.focused` does. Unsplit tabs show the same single corner label.
- **Bottom status bar removed** (`.term-screen-status`); its content moved as described above.

### G4. Token saver honesty
- **RTK state** (shown as text inside the G2 session status chip, details in its popover) reads `useAgentMeters.savings[session.id]`, already polled every 15s for RTK-active sessions:

  | State | Text in status chip | Style |
  |---|---|---|
  | active, runs > 0 | `RTK −<saved>` (e.g. `RTK −18.4k`) | success |
  | active, 0 runs | `RTK 0` | dashed, muted |
  | off | `RTK off` | unchanged style |
  | unavailable | `RTK n/a` | unchanged style |
  | unsupported | `RTK n/a` | unchanged style |

  Tooltip / click text: what RTK does, runs and characters saved, which commands qualify (including after `cd dir &&`), and, for unavailable, why.
- **Caveman** (popover "Token savers" section only, no separate chip): on/off. The text says it is a system-prompt instruction whose savings aren't measured.
- **`cd` prefix in `src-tauri/src/saver.rs::rewrite_command`:** accept exactly `cd <dir> && <allowlisted simple command>`.
  - `<dir>` is a single token with no shell syntax (the existing `SHELL_SYNTAX` set) and no quotes, `~`, or `=`.
  - The rewrite is `cd <dir> && '<bin>' run -- <cmd>`.
  - The protected list applies to `<cmd>`.
  - Anything else stays as today: a second `&&`, `;`, `|`, redirects, `$`, backticks, quotes, env assignments, or `cd` without `&&` → no rewrite.
- **Find why RTK is "unavailable":** reproduce in `pnpm tauri dev` and in the release bundle. `cli_ensure_saver_hook` returns false when `notify::saver_binary_path()` can't find `branchwork-saver` next to the app binary. Fix the root cause, for example a dev build that doesn't place the sidecar there, and add a regression test where testable. If the cause is outside the app, the `unavailable` tooltip names it.

### G5. Every other screen adopts the same header (added 2026-11-21: user approved the Agents result and asked for all pages)
- Every screen renders its header through `PaneHeader` with the G1 rules: calm row, identity left, at most one status element, and the action cluster (screen actions + `PaneControls`) always visible on the only/focused stage pane and revealed on hover/focus-within otherwise. Once every screen has migrated, `Pane` no longer renders `header.pane-tool`, and the old `*Toolbar` components and their `.pane-tool` CSS are removed.
- The table maps today's header controls to the new slots. Nothing is added or dropped, and accessible names, handlers and shortcuts are unchanged. Inline popovers and inputs that open from a header control (e.g. Home's New worktree input, Graph filters) open anchored to the same control inside the cluster.

| Screen | Identity (always visible) | Status element | Cluster actions (before `PaneControls`) |
|---|---|---|---|
| Home (Launchpad) | `⌂ Home` | — | This group / All groups toggle, Refresh, New worktree (primary) |
| Changes | `± Changes` | — | Side by side / Inline toggle, Terminal |
| Files | `▤ Files` | — | view-mode toggle, Reveal in Finder, External editors (stays disabled) |
| History | mode tabs Graph / Blame / Rebase (content navigation, like Terminal tabs) + the active mode's context text (e.g. Graph's branch/"Detached", Blame's file) | Graph: ahead/behind sync chip; Rebase: in-progress chip | Graph: sync (fetch/pull/push as today), Filters, Create worktree at commit · Blame: Blame/Diff/History mode, Open in editor · Rebase: Continue (primary), Abort (danger, confirms), Resolve |
| Conflicts | `⚠ Conflicts` (+ file count if shown today) | — | Abort (danger, confirms), Terminal |
| Settings | `⚙ Settings` | — | — (in-content tabs stay in content) |
| GitHub, Browser, placeholders | screen icon + name | — | — |

- If a screen's header today shows status text (e.g. sync running, rebase in progress), that text becomes its status element, so it stays visible at rest.

## Non-goals
- The bottom Terminal dock (`TerminalDock`), the stage tab bar, the app sidebar, and stage split behavior are not changed.
- No new actions and no behavior changes to existing actions. Only their placement changes.
- No allowlist widening beyond the `cd` prefix.

## Anti-goals
- Any existing control becomes unreachable, loses its accessible name or shortcut, or can't be used with a keyboard.
- The corner label steals keystrokes or clicks from xterm outside its own box, or makes it unclear which split part is focused.
- In stage split view it becomes unclear which pane a control belongs to.
- The RTK chip implies savings that didn't happen.
- A rewritten command does anything the original command would not.

## Constraints
- All strings come from `src/i18n/en.ts`. Reuse today's labels so accessible names, and with them the unit and e2e selectors, stay the same.
- CSS rules tests stay green: no text under 12px (use `var(--fs-meta)`), no hidden scrollbars.
- Narrowest supported pane (~280px): the header row stays one line, collapsing as described in G1.
- The terminal content area grows by the removed rows. xterm refits through the existing resize path, and the `viewCache` re-adoption still works.
- The saver rewrite is security-sensitive: it needs a `security-reviewer` pass, and it must fail open.

## Approaches considered
0. **Header layout (revised):** after the first build put ~12 items in one row and clipped the pane controls in split view, the user chose a *calm row* (mockup H). It shows identity + one status chip, and an action cluster that is always shown on the focused/only pane and revealed on hover/focus elsewhere. The alternatives shown were: everything in ⋯ (A); one status chip with always-visible ＋ ⋯ ✕ (B); info in a bottom strip (C); status as icons (D); controlled two rows (E); controls on the split divider (F); tab-style title with ✕ (G).
1. **Merge page header into the content's first row; split parts get corner labels (B, chosen).** One header row per stage pane, whatever the nesting depth. Cost: the corner label overlaps the right end of each part's first terminal line, and split buttons are visible only on hover or focus (shortcuts remain).
2. **Merge page header into the content's first row; split parts get a 26px row (A).** Clearer, but adds a row per split part. Not chosen.
3. **Right icon rail, slim header, floating pills, sidebar actions.** Rejected by the user because they disturb today's split view or hide controls.

**Implementation shape (my call):** `ownsHeader` plus a `PaneChromeContext` providing `{ index, controls: ReactNode }` from `Pane`. A shared `PaneHeader` component handles layout and overflow. Agents and Terminal render it. Reasons: the change stays local to the two screens; other screens and `Pane` keep their current path; and stage split logic is untouched.

## Left to the builder (my calls, adjustable)
- Glyphs reuse today's (`✦`, `❯_`, `⫴`, `⤢`, `◉`).
- Corner-label expand delay 0ms on focus and 150ms on hover. It collapses on mouse leave or Escape.
- Overflow: measure the row with a `ResizeObserver`, then hide secondary actions into ⋯ in a fixed priority order. O(items) per resize.
- **Tests:**
  - `PaneHeader` (layout order, overflow order, controls present in single and split stage).
  - Agents: solo row contains the session controls, the ⋯ menu holds the session and page actions, grid shows the page row plus one row per tile, and no `.agent-phm`.
  - Terminal: tabs are in the header, no `.term-screen-pane-head` or `.term-screen-status`, the corner label expands on focus and its buttons split/maximize/close with the same store calls, and broadcast toggles from the header.
  - RTK chip states.
  - Rust `rewrite_command` cases: accepts a plain `cd` prefix; rejects quoted, `~`, a second `&&`, `;`, `|`, `$`, protected commands.
  - A regression test for the unavailable cause if one is found.
  - Update e2e only where selectors depended on the removed DOM.
