# M1 Manual E2E Test Spec

Manual end-to-end checks for milestone M1 (Repositories, worktrees, graph). Each stage adds a section. Run every section of finished stages before signing off a checkpoint. The M0 spec (`docs/testing/m0-manual-e2e.md`) stays a regression check: re-run at least S1-01, S2-01 and S4-01.

## Setup

| Item | Value |
|---|---|
| OS | macOS 26 (Tahoe) or later, Apple Silicon |
| Toolchain | Rust ≥ 1.99, Node 22, pnpm 10, `git` on PATH |
| Native app | `pnpm tauri dev` |
| Automated pre-checks | `./init.sh`, `pnpm test:e2e` |
| Test repos | Any existing local Git repository (e.g. this project), a public HTTPS repo URL (e.g. `https://github.com/octocat/Hello-World.git`) |

Open, clone and groups only work in the **native app**. The browser build shows an explicit error toast for Open/Clone.

Record **Pass / Fail + notes** for every step. On failure, attach a screenshot and the terminal output.

---

## Stage 1: Repository catalog and project groups

### M1-S1-01 · Empty state

1. Quit the app. Start `pnpm tauri dev` on a fresh catalog (or note existing data).

Expected:
- Title bar shows the group chip ("Ungrouped" when no group is active) and the ＋ button; no project tabs when there are no projects.
- No error toast at launch.

### M1-S1-02 · Open a local repository

1. Click the group chip → **Open repository…**. A native macOS folder picker opens (titled "Open repository").
2. Browse to and choose a local Git repo folder (e.g. this project's root).
3. Repeat, choosing the same repo folder again.
4. Repeat step 1, but choose a folder that is not a Git repository.
5. Repeat step 1, but press Cancel in the picker.

Expected:
- Steps 2–3: the project appears as an Ungrouped tab and is selected, regardless of which group was active before opening. Opening the same repo twice does not create a duplicate.
- Step 4: a ⚠ error toast with a clear message; no project is added.
- Step 5: the picker closes, no toast appears, no project is added, and the group popover/chip stay in a consistent state.
- No repository hook or script runs (nothing new in the terminal beyond normal logs).

### M1-S1-03 · Clone a repository (UI stays responsive)

1. Create a group first (M1-S1-04) and keep it active.
2. Chip → **Clone repository…** → enter `https://github.com/octocat/Hello-World.git`.
3. Check the destination prefill, then OK.
4. While cloning, move the window and hover the sidebar.
5. Clone again into the same destination.
6. Clone a URL that does not exist (e.g. `https://github.com/octocat/does-not-exist-xyz.git`).

Expected:
- Step 3: destination prefilled as `~/clients/Hello-World` (from the group's chosen clone folder). `~/clients` does not need to exist.
- Step 4: the window stays responsive (no beachball) during the clone.
- After success: folder exists on disk, project tab appears in the active group and is selected.
- Step 5: ⚠ error toast (destination occupied); existing folder untouched.
- Step 6: ⚠ error toast with git's message; the app does not hang waiting for a password.

### M1-S1-04 · Create and edit a group

1. Chip → **New group** → name "Clients", pick a color → Save.
2. Edit the group: rename to "Client work", change color, **Browse…** to a different folder → Save.
3. Try to save with an empty name.

Expected:
- The group appears in the popover with its color square; the chip shows it when active.
- The new-group form has no clone-folder input or **Browse…** button; new groups use the default clone folder `~/clients`.
- The edit form has a **Folder for new clones** read-only display (no typing) plus a **Browse…** button and shows its current folder without the `/{repo}` suffix. Its hint explains that clones use `<folder>/<repo name>` and existing repositories are added from the group list.
- Browsing to a folder that is itself a Git repository shows an inline warning to save the group and use **Add repository**; the folder value is still retained. An ordinary folder shows no warning.
- Edits persist after quitting and relaunching the app.
- Empty name cannot be saved.

### M1-S1-05 · Search and select

1. With ≥2 groups and some Ungrouped projects, open the popover.
2. Type part of a project name, then part of a local path, then a group name.
3. Click a project row.

Expected:
- Search field is focused on open; filtering is case-insensitive; groups without matches are hidden; Ungrouped is listed last.
- Clicking a project selects it, closes the popover, and the chip/tabs switch to that project's group.

### M1-S1-06 · Move a project between groups

1. On a project row, open **Move to…** → pick another group.
2. Move the currently active project to another group.
3. Move a project to Ungrouped.

Expected:
- The project appears under the target group.
- Step 2: the chip and tabs follow the active project to its new group.
- Repositories on disk are untouched.

### M1-S1-07 · Delete a group and undo

1. Delete a group that contains the active project → confirm in the danger dialog.
2. Click **Undo** in the toast (within ~4 s).
3. Delete again, and let the toast expire.

Expected:
- Step 1: projects move to Ungrouped; nothing on disk is removed.
- Step 2: group and its projects are restored; chip shows the restored group with its tabs.
- Step 3: the group stays deleted after relaunch; its projects remain under Ungrouped.

### M1-S1-08 · Popover keyboard and dismissal

1. Open the popover with the chip; click the chip again.
2. Open with ＋; click ＋ again.
3. Open; press Escape.
4. Open; click outside.
5. Open; start Delete group so the confirm dialog shows; press Escape.

Expected:
- Steps 1–2: second click closes the popover.
- Step 3: popover closes and focus returns to the chip.
- Step 4: popover closes.
- Step 5: only the dialog closes; the popover stays open.

### M1-S1-09 · Persistence and isolation

1. Select a project in a non-default group; open a split view (⌘\) and change the theme in Settings.
2. Switch to another project tab.
3. Quit and relaunch.

Expected:
- Step 2: split panes, focus and theme are unchanged by the project switch.
- Step 3: the same group and project are active; split and theme are restored.

### M1-S1-10 · Close tabs

1. With ≥2 open project tabs, hover a non-active tab and click its × (or Tab/focus to it and press it).
2. Close the active tab while another tab is open to its right, then to its left only.
3. Close the only remaining tab.
4. Open the group switcher and select a project whose tab was just closed.
5. Quit and relaunch the app.

Expected:
- Step 1: the tab disappears; the project stays listed in the group switcher; the previously-active tab stays active.
- Step 2: the neighboring tab (right first, else left) becomes active.
- Step 3: no tab is selected; the group chip is unchanged.
- Step 4: the tab reopens and becomes active.
- Step 5: tabs closed before quitting are still closed after relaunch.

### M1-S1-11 · Collapse and expand groups

1. Open the popover. Click the disclosure chevron on a group's header (not Edit/Delete). Repeat for Ungrouped.
2. With a group collapsed, type a search term that matches a project inside it.
3. Clear the search term.
4. Select a project inside a collapsed group via search, then reopen the popover.
5. Quit and relaunch the app, then reopen the popover.

Expected:
- Step 1: the chevron flips (▸ collapsed / ▾ expanded), the group's project rows hide, and the name shows the project count (e.g. "Clients · 3"); Ungrouped behaves the same way.
- Step 2: the collapsed group's matching project is shown despite being collapsed.
- Step 3: the group goes back to showing as collapsed (count, hidden rows).
- Step 4: the project is selected and the popover closes; reopening shows the group still collapsed.
- Step 5: collapsed/expanded state is restored exactly as left.

### M1-S1-12 · Remove a project from Branchwork

1. Open the popover. On a non-active project's row, open **Move to…** and choose **Remove from Branchwork…**; confirm.
2. Note the folder's path from the dialog body, then check it on disk (Finder/Terminal) — still there.
3. Repeat on the active project's tab.
4. Click **Undo** on the toast.
5. Remove a project, let the toast expire without clicking Undo, then quit and relaunch.

Expected:
- Step 1: confirm dialog names the project and states the folder on disk isn't deleted; on confirm the row disappears from the popover and its tab (if any) closes; a "Removed …" toast with Undo appears.
- Step 2: the folder and its contents are untouched on disk.
- Step 3: the active tab closes and the neighboring tab (same rule as closing a tab) becomes active.
- Step 4: the project reappears in the popover, its tab reopens, and (if it was active) it's reselected.
- Step 5: the project stays removed after relaunch.

### M1-S1-13 · Add an existing repository to a group

1. In the popover, collapse a group that has projects.
2. Click **Add repository to {group}** in that group's header, choose an existing repository, and confirm.
3. Repeat and cancel the folder picker.

Expected:
- The chosen repository is registered in the selected group, its section expands, and the project becomes selected.
- Cancel makes no changes.

### Stage 1 results

| Step | Pass/Fail | Notes |
|---|---|---|
| M1-S1-01 | | |
| M1-S1-02 | | |
| M1-S1-03 | | |
| M1-S1-04 | | |
| M1-S1-05 | | |
| M1-S1-06 | | |
| M1-S1-07 | | |
| M1-S1-08 | | |
| M1-S1-09 | | |
| M1-S1-10 | | |
| M1-S1-11 | | |
| M1-S1-12 | | |
| M1-S1-13 | | |
