# Branchwork UI/UX Redesign: Design System and Flow

- **Date:** 2026-11-14
- **Status:** Approved in conversation; document awaiting user review
- **Visual reference:** `docs/design/redesign-prototype.html` (approved prototype v3; open it in a browser, use the top strip to switch between "App prototype" and "Design system" and between dark and light)
- **Supersedes, for visuals and navigation only:** the look of `docs/design/prototype.html` and the navigation parts of `docs/superpowers/specs/2026-11-06-branchwork-design.md` (§6.1). Feature behavior in that spec stays valid.

## Intent

Make Branchwork comfortable and easy to use, both visually and in how features are reached. Today, context is spread across three places (project in the right rail and title bar, worktree in the middle of the left sidebar, screen at the top of the left sidebar). Several features overlap (commit in Graph and Changes, diffs in four screens, terminals in three places). Tools are buried or dead-end (Rebase only works when started from Graph; Compare is a placeholder). Much of the UI uses 9–11px text, hidden scrollbars, glass backgrounds and few focus styles. The redesign rearranges what exists into a calmer, accessible structure. It does not add new Git features.

## Goals

- One place to read "where am I": group → project → worktree → screen, in the left column, mirrored as a breadcrumb in the title bar.
- Fewer, clearer destinations: 13 menu items become 7 screens plus Settings, with no feature lost.
- Tools appear when they are needed: an in-progress merge, rebase, cherry-pick or revert shows a banner on every screen.
- One canonical place per job: commit only in Changes; blame, file history and rebase inside History.
- Split view is discoverable: a visible "Open beside" control and ready-made layouts.
- Accessible by default: WCAG 2.2 AA contrast in both themes, visible focus on every control, everything reachable by keyboard, status never shown by color alone, no text below 12px, visible scrollbars.
- A written design system (tokens, components, rules) that every screen uses.

## Non-goals

- New Git, GitHub or agent features. The Compare screen is not built here.
- Changing feature logic in stores or the Rust backend, beyond what navigation and state migration need.
- Mobile or web layouts. Branchwork is a macOS desktop app.
- Theming beyond the current options plus "Text size".

## Anti-goals (a failure even if it works)

- Any existing feature becomes unreachable or needs more steps for its common case.
- The terminal dock or its **Ctrl+`** shortcut behaves differently from today.
- Text on translucent or glass backgrounds, or text that fails AA contrast.
- A shortcut that triggers from a single character key while the user expects to type.

## Constraints

- Tauri 2 + React/TypeScript; existing zustand stores (`useStage`, `useWorktrees`, `useRepos`, `useSidebar`, `useDock`, `useSessions`, `useSettings`) remain the sources of truth.
- All UI strings are English and live in `src/i18n/en.ts`.
- Project rules in `CLAUDE.md` apply: stage branches, one commit per stage, `./init.sh` green after every task, manual E2E spec per stage.
- **The terminal dock (bottom / right / float / max, tabs, split) and Ctrl+` stay exactly as they are.**
- Persisted user state must survive the update (stage panes and saved screen ids, sidebar state, settings).

## Approaches considered

All approaches were shown as wireframes in the browser.

1. **A. Task-first:** five big verbs in the sidebar; worktree picked from a dropdown; tools as contextual banners. Simple, but switching worktrees costs an extra click, which works against Branchwork's multi-worktree strength.
2. **B. Worktree-first:** worktree list in the sidebar with status; tasks per worktree. It fits how Branchwork is used (many worktrees and agents in parallel); the sidebar is denser.
3. **C. Keep structure, polish visuals only:** lowest risk, but it leaves the flow problems unsolved.
4. **D. Hub & focus:** a board of worktree cards, then a focus mode. Good overview, but an extra hop to work.
5. **E. Guided steps:** Edit → Review → Commit → Sync → PR stepper. Beginner-friendly, slow for experienced users.
6. **F. Command-first:** palette as the main entry. Fast and keyboard-friendly, but features become hard to discover.
7. **G. Split workspace by default:** two panes always. Good for agent + review work, crowded on laptops.

**Chosen:** a proposal grounded in the current features. It combines B (worktree list in the sidebar), A (contextual banners instead of tool menu items), D (a merged Home that answers "what needs me"), F (⌘K stays a full access layer) and G (split made visible, with presets, but not forced). The user approved every part, including merging Launchpad + Inbox into Home, merging Graph + Blame + Rebase into History, and moving the Projects rail from the right into the top of the left sidebar.

## Design system

The prototype's "Design system" view is the reference. The values below are normative.

### Color tokens

Solid surfaces only (no glass, no `backdrop-filter` behind text). The accent hue stays 250 and the neutral tint 265, so the user settings "accent hue" and "base tint" keep working.

| Role | Dark | Light |
|---|---|---|
| `--bg` | `oklch(.17 .010 tint)` | `oklch(.975 .004 tint)` |
| `--surface` | `oklch(.205 .011 tint)` | `oklch(1 0 0)` |
| `--raised` | `oklch(.245 .012 tint)` | `oklch(.965 .005 tint)` |
| `--overlay` | `oklch(.27 .013 tint)` | `oklch(1 0 0)` |
| `--hover` | `oklch(1 0 0 / .06)` | `oklch(0 0 0 / .045)` |
| `--selected` | `oklch(.68 .17 hue / .18)` | `oklch(.55 .18 hue / .12)` |
| `--border` / `--border-strong` | white at .11 / .2 | black at .11 / .2 |
| `--text` / `--text-2` / `--text-3` | L .96 / .80 / .70 | L .22 / .40 / .49 |
| `--accent` / `--accent-strong` | `oklch(.70 .16 hue)` / `.62 .18` | `oklch(.53 .19 hue)` / `.47 .19` |
| `--success` | `oklch(.76 .15 155)` | `oklch(.50 .14 155)` |
| `--warning` | `oklch(.82 .14 80)` | `oklch(.55 .13 70)` |
| `--danger` | `oklch(.72 .17 25)` | `oklch(.53 .19 25)` |
| `--info` | `oklch(.76 .12 230)` | `oklch(.50 .13 240)` |
| `--agent` (AI only) | `oklch(.76 .14 300)` | `oklch(.50 .17 300)` |

Each semantic color also has a 14% tint background (`--success-bg`, `--warning-bg`, `--danger-bg`, `--agent-bg`) and diff add/delete tints. Measured contrast against `--surface`: every text role passes AA. The lowest values are 6.7:1 in dark and 5.0:1 in light.

### Typography

System font (`-apple-system`, SF Pro); mono SF Mono.

| Role | Size / weight |
|---|---|
| H1 | 24 / 700 |
| H2 | 18 / 650 |
| Title (pane headers) | 15 / 650 |
| Body | 13 / 400, line-height 1.45 |
| Meta | 12 / 400 (minimum anywhere) |
| Mono | 12.5 |

Settings gains **Text size: Default / Large**. Large raises the scale (meta 13, body 14.5, title 16.5, H2 20, H1 26).

### Space, shape and size

- 4px grid: 4, 8, 12, 16, 24, 32.
- Radius: 6px controls; 10px panels, cards, popovers and dialogs; pill only for chips and count badges. The current blanket `border-radius: 0 !important` is removed.
- **Exception: split panes, agent panes and terminals are flush and square.** No radius, no gap and no outer padding; neighbors are separated by a 1px `--border` line; headers are thin (4–8px vertical padding). The focused pane in a split gets a 2px accent line on its top edge. This applies to the Stage when split, a lone Agents or Terminal pane, the agent grid, Terminal screen panes and the dock. Badges, chips and status labels inside those panes keep their normal rounded shape.
- Targets at least 24×24px (WCAG 2.5.8). Buttons are 28px, small buttons 24px, list rows `--row` (26 / 30 / 34 for compact / default / comfy).

### Interaction and motion

- Focus ring on every interactive element: `0 0 0 2px var(--bg), 0 0 0 4px var(--accent)` via `:focus-visible`. Never remove an outline without a replacement.
- Scrollbars are visible and thin (`scrollbar-width: thin`); the global hidden-scrollbar rules are removed.
- Motion is 150ms and disabled under `prefers-reduced-motion`.

### Components

The prototype defines the reference look and states (default, hover, selected, focus, disabled). This list is the inventory to implement or restyle in `src/ui` and `src/theme`:

- Button (primary, secondary, ghost, danger, small, icon)
- Chip and count badge (neutral, warning, danger, agent)
- Status label (icon + text: ✓ Clean, ● N changes, ⚠ N conflicts, ✦ Agent running, ↑N ahead)
- Text input and textarea
- Segmented control, switch, tabs
- Panel / card, section header, list row (with `aria-current`)
- Contextual banner
- Menu / popover, command palette, dialog, keyboard-shortcut sheet, toast
- Empty state
- Quota meter and saver badges (from the agent-session feature, restyled)

### Accessibility rules

- Body text ≥ 4.5:1; meaningful icons and borders ≥ 3:1.
- Status is always icon + text (a colored dot alone is never the only signal).
- Every icon-only button has an `aria-label` and a tooltip.
- Banners and live statuses use `role="status"`.
- Esc closes any overlay and returns focus to its trigger.
- Logical tab order: sidebar → banner → pane 1 → pane 2 → dock.
- No single-character shortcuts without a modifier unless the user turns them on (WCAG 2.1.4).

## Information architecture and flow

### Layout

```
┌ Title bar: ◧ | Group › Project › Worktree ▾ | ⌘K Search or ask… | ☾ | ? ┐
├ Sidebar ─────────────┬ Banner (only while an operation is in progress) ─┤
│ [Project ▾ picker]   │ Stage: 1 pane, or 2 flush panes (split)           │
│ WORKTREES        ＋  │                                                   │
│  main      ● 4       │                                                   │
│  feat/…    ✦         │                                                   │
│  m6-…      ⚠ 2       ├───────────────────────────────────────────────────┤
│ SCREENS              │ Terminal dock (unchanged, Ctrl+`)                 │
│  Home ⌘1 … GitHub ⌘7 │                                                   │
│ ⚙ Settings           │                                                   │
└ Status bar: worktree · changes · ahead/behind · agents · dock toggle ────┘
```

- **Project picker** (top of the sidebar) replaces the right-hand Projects rail and holds its features: search, groups with counts, switch project, add project (open / clone / init), new group, manage group. The right rail and its toggle are removed. Group management keeps its current behavior.
- **Breadcrumb** in the title bar: each segment opens the matching picker (group/project, worktree).
- **Worktree list** shows each pinned worktree with its branch and a status label. The picker for showing more worktrees and the "＋ New worktree" action stay.
- **Status bar** (new, 26px) shows the active worktree, changes, ahead/behind, the agent summary and a dock toggle button. It duplicates information for glanceability; it does not replace the sidebar.

### Screens: old → new

| New screen | Absorbs | Behavior |
|---|---|---|
| **Home** (⌘1) | Launchpad, Inbox | "Needs your attention" list at the top: reviews, mentions, CI failures, agents waiting or done, conflicts. Inbox filters become tabs (All, Review, Mention, CI, Agents); snooze and mark done stay. Below the list: KPIs (open PRs, worktrees, CI pass rate), Issues for you (with "Start → worktree"), CI feed, and the scope selector (this group / all groups). |
| **Changes** (⌘2, Ctrl+⇧G) | Changes, Graph's working-copy staging | **The only place to stage and commit.** Content as today (staged/unstaged, tree/list, inline/split diff, commit with amend/push/sync, ✦ generate message). Clean tree shows an empty state with a link to History. |
| **History** (⌘3) | Graph, Blame & history, Interactive rebase | Modes as tabs: **Graph** (commit graph, filters All/Worktrees/Mine/Agent, fetch/pull/push, inspector with checkout, cherry-pick, "＋ Worktree here", "Rewrite from here…"), **File history · blame** (per-line blame, file history, view commit/PR), **Rewrite history** (the interactive rebase UI with a base-commit picker inside it, so it never dead-ends). The working-copy row stays in Graph; its action "Commit…" opens Changes beside. Staging actions are removed from Graph. |
| **Files** (⌘4) | Files & editor | As today. "Blame" and "File history" open History in File-history mode for that file; a line action "Who changed this?" does the same at that line. |
| **Agents** (⌘5) | Agents | As today (grid, race, handover, profiles, quota meter, RTK/Caveman badges), restyled flush and square. Each agent header gets "Review beside", which opens Changes beside. |
| **Terminal** (⌘6) | Terminal screen | As today (tabs, split, broadcast), panes flush and square. |
| **GitHub** (⌘7) | Repository | As today (Code, Issues with "Start → worktree", Pull requests, Actions, star/watch/fork, publish). |
| **Settings** | Settings | As today, plus Text size and a Keyboard section. |
| *(contextual)* | Resolve conflicts | Removed from the menu. While a merge, rebase, cherry-pick or revert is in progress in the active worktree, a banner shows on every screen: operation, progress (e.g. "Rebase paused at 3/7"), conflict count, and actions Resolve conflicts / Continue / Abort. Continue is disabled until conflicts are resolved. The resolver screen itself keeps its behavior and is reachable from the banner, the worktree's ⚠ badge and ⌘K. |
| *(hidden)* | Compare | Hidden until it is built; later it becomes the worktree action "Compare with…". |

### Split view

- Every pane header has **"◨ Open beside"**, a menu of screens plus layouts: *Agent + Changes* and *History + Files*.
- With two panes, each header shows swap and close.
- ⌘\ (⇧ for bottom), ⌘-click / ⌥-click on a menu item, drag-and-drop onto the Stage and right-click all keep working.
- The chosen layout is saved per worktree.

### Keyboard

| Action | Key |
|---|---|
| Command palette / ask Claude (end with `?`) | ⌘K (unchanged) |
| Toggle sidebar | ⌘B (unchanged) |
| Split / unsplit | ⌘\ (unchanged) |
| Changes | Ctrl+⇧G (unchanged) |
| **Terminal dock** | **Ctrl+` (unchanged, must not change)** |
| Screens Home…GitHub | ⌘1–⌘7 (new; replaces bare 1–9) |
| Shortcut sheet | `?` when not typing, or the title-bar `?` button |
| Commit | ⌘↵ in the message box |

Bare number keys 1–9 are off by default. Settings → Keyboard has "Single-key screen shortcuts (1–7)" to turn them back on (they then follow the new order). The palette lists every screen, worktree and the main Git, agent and layout actions.

### Main flows (target step counts)

- **Agent finishes → review → commit → PR:** Home item "Review changes" opens Agents + Changes beside (1 click) → commit & push → GitHub, open PR.
- **Conflict during a rebase:** the banner appears on any screen → Resolve → Continue in the banner → the banner disappears.
- **Start from an issue:** Home or GitHub issue → "Start → worktree" (+ agent) → the new worktree is selected in the sidebar → Agents.
- **Trace a line:** Files → "Who changed this?" → History in blame mode at that line → view commit or PR.

## State migration

- Saved stage panes using old screen ids map to new ones: `launchpad`, `inbox` → `home`; `graph`, `blame`, `rebase` → `history` (with the matching mode); `repo` → `github`; `conflicts` stays as a reachable screen id; `compare` → `home`. Unknown ids fall back to `home`.
- Deep links and internal `go("…")` calls to old ids map the same way.
- The theme setting `contrast` (the `--k` slider) is replaced by Text size; the stored value is ignored. `reduceTransparency` becomes moot because surfaces are solid; the setting is removed.
- The right Projects rail open/closed preference is dropped.

## Decisions made by the assistant (please check)

- Text size (Default/Large) replaces the contrast slider, since AA contrast is now guaranteed by the tokens.
- The "reduce transparency" setting is removed because glass is gone.
- A new 26px status bar is added for glanceability.
- Split layouts are saved per worktree (today the split is global).
- `conflicts` stays a screen id (reachable from the banner, the badge and ⌘K) rather than becoming a modal.
- The sidebar heading above the seven screens reads "Screens" (the prototype's "For this worktree" is wrong for Home, which is scoped to the group or all groups).
- The redesign is its own milestone (M7), started after M6 is approved and merged; it does not mix into an M6 stage.

## Left to the builder

- Exact component file structure in `src/ui` and how tokens map onto the existing `tokens.css` variable names (renaming vs aliasing).
- The order of stages for the rollout, as long as each stage leaves every feature reachable and `./init.sh` green.
- Icons: keep the current glyph set or swap to an icon set, provided icon-only controls keep labels.
- Prototype-only content (mock data, the prototype strip) is not part of the product.
