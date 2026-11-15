# M12 — Stage tabs — Design

- **Date:** 2026-11-15
- **Milestone:** M12, Stage 1
- **Status:** Approved by user from the prototype; tab rename added to scope.

## Intent

Allow users to keep several stage contexts in one app window. Each top-level tab owns an independent split-tree layout, so switching tabs does not replace or flatten the current layout. A tab can be named by the user.

## Goals

- Show tabs above the Stage. Switching tabs restores that tab's screen tree, split sizes and focused pane.
- Add a tab from the tab bar (starts at Home) or from a sidebar screen context menu (starts at that screen).
- Rename tabs inline by double-clicking a tab or pressing F2 while it is focused. Enter commits, Escape cancels; trimmed names must be 1–40 characters.
- Put each tab's close control inside its tab card. Closing the active tab selects its previous neighbor. The last tab cannot be closed.
- Maximum 8 tabs per worktree per window. Explain the limit through existing toast UI.
- Persist tabs and active tab using existing window-scoped `stage` setting and per-worktree layout map.
- Migrate existing v2 and legacy stage settings into one tab without changing their layout.
- Preserve current pane limits (4), split behavior, screen singleton behavior within a tab, and current keyboard shortcuts.
- Keep the current screen model and persistence isolated between windows and worktrees.

## Non-goals

- Tabs inside a pane, moving tabs between windows, drag reordering, tab duplication, or a tab-count setting.
- Persisting ephemeral screen-local UI state beyond existing screen stores.
- Changing History's selected mode behavior.

## State and bounds

Saved setting version 3 contains `current: { tabs, activeTabId }` and `layouts: Record<worktreePath, workspace>`. Each tab has an opaque bounded ID, a 1–40 character name, and a validated M9 `StageState`. Keep at most 8 tabs per workspace and 200 worktree layout entries. Corrupt or oversized workspace data falls back safely; old v1/v2 layouts become one tab.

Workspace operations and persistence are O(T) per tab-list update, where T ≤ 8; validated screen-tree work remains O(P), where P ≤ 4. Retained layout memory is bounded by 200 × 8 × 4 panes. No new IPC or filesystem boundary is introduced.

Only the active tab's at most four screens are mounted. Switching tabs unmounts that tab's screen components and mounts the newly active set; durable screen/session state remains in the existing stores and PTYs. This bounds mounted screen work independently of the number of saved tabs.

## UI behavior

- Tab strip sits above the Stage and remains available at narrow widths with horizontal scrolling.
- Tab activation selects its saved layout. The active tab has a visible selected state.
- `+` creates a Home tab. Sidebar context menu adds “Open in new tab”. At 8 tabs, `+` stays actionable and reports the limit without creating a tab.
- Tab buttons use roving focus with Left/Right arrows; Home and End move to the first and last tab.
- Double-click and F2 open an inline text field. Commit on Enter/blur; Escape restores the prior label. Blank or >40 character values are rejected with a clear field state and retain focus.
- Each tab card contains its own close control. It is disabled for the only tab; closing selects the preceding tab when possible, otherwise the new first tab.
- Tab names and controls have translated English strings, labels and keyboard focus styles.

## Acceptance criteria

1. A user can create a tab, switch between tabs, and return to each tab's independent one-to-four-pane arrangement and focus.
2. Sidebar context menu can open a selected screen in a new tab without altering existing tabs.
3. User can rename by double-click or F2; valid names persist, while blank/overlong names are rejected. Escape cancels editing.
4. Closing a tab removes only that tab, selects the documented neighbor, and never closes the final tab.
5. A ninth tab is refused with feedback; each worktree has its own tab collection.
6. Restart restores current tab, names, and layouts. Existing v2 and legacy saved layouts restore as one tab.
7. Secondary windows remain isolated by the existing window-scoped setting boundary.
8. Regression tests cover model bounds/validation, persistence/migration/worktree isolation, and tab UI actions/accessibility.
