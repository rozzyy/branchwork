# M2 Manual E2E Test Spec

Manual end-to-end checks for milestone M2 (Changes, files, editor). Each stage adds a section. Run every section of finished stages before signing off a checkpoint. The M1 spec (`docs/testing/m1-manual-e2e.md`) stays a regression check: re-run at least M1-S2-01 and M1-S3-01.

## Setup

| Item | Value |
|---|---|
| OS | macOS 26 (Tahoe) or later |
| Toolchain | Rust ≥ 1.99, Node 22, pnpm 10, `git` on PATH |
| Native app | `pnpm tauri dev` |
| Automated pre-checks | `./init.sh`, `pnpm test:e2e` |
| Test repo | A scratch local repository you can dirty freely (e.g. `git init /tmp/bw-m2 && cd /tmp/bw-m2 && echo hello > a.txt && git add . && git commit -m init`) |

Status and diff only work in the **native app**. Stage 1 is read-only: there is no stage, unstage, discard or commit yet.

Record **Pass / Fail + notes** for every step. On failure, attach a screenshot and the terminal output.

---

## Stage 1: Status read model and shared diff renderer

### M2-S1-01 · No worktree

1. Start the app with no repository open (or close all projects).
2. Open **Changes** (sidebar, key `4`, or `⌃⇧G`).

Expected:
- The Changes pane shows "Open a worktree to see its changes." No error, no spinner stuck.

### M2-S1-02 · Clean worktree

1. Open the scratch repository with a clean working tree and make it the active worktree.
2. Open **Changes**.

Expected:
- Staged and Unstaged sections are visible with "No changes in this worktree."
- The diff area shows "Select a file to see its diff."

### M2-S1-03 · Dirty file list

1. In a terminal in the scratch repo: edit `a.txt`, create `b.txt`, then `git add b.txt`.
2. Look at the Changes screen without clicking anything.

Expected:
- Within about a second (no manual refresh), `b.txt` appears under **Staged** with status `A`, and `a.txt` under **Unstaged** with status `M`.
- A file that is partially staged (edit, `git add`, edit again) appears in **both** sections.

### M2-S1-04 · Read-only diff

1. Click `a.txt` in Unstaged.
2. Scroll the pane until the diff fills it (the stub stacks the file lists above the diff).

Expected:
- The row shows as selected. The diff shows a hunk header `@@ -a,b +c,d @@`, an **Unstaged** chip, and old/new line numbers side by side.
- Changed words inside a modified line are highlighted (intraline marks).
- The right-edge ruler shows one tick per hunk.
- Hunk action buttons are visible but do nothing yet (wired in Stage 2).

### M2-S1-05 · Split / inline toggle and persistence

1. Click the **Split view / Inline view** toggle.
2. Quit and restart the app, reopen Changes, select the file again.

Expected:
- Inline mode shows one column with `−`/`+` prefixes and the same intraline marks.
- The chosen mode survives the restart.

### M2-S1-06 · Binary and large file

1. Add and select a binary file (e.g. a PNG) and a text file larger than 1 MB.

Expected:
- Each shows a summary card (name, size, reason) instead of hunks.

Note: the "⋯ N unchanged lines" collapse (runs > 7 context lines) is covered by unit tests only. With Git's 3-line context and `interhunk_lines = 0`, a real hunk never holds more than 6 consecutive context lines, so it cannot be triggered manually.

### M2-S1-07 · Live refresh and worktree switch

1. With a file selected, edit it again in the terminal.
2. Switch the active worktree in the sidebar to another worktree or repository.

Expected:
- The diff updates on its own after the edit; the selection stays on the same file.
- After switching, the list shows the new worktree's changes; the old selection is cleared.

### M2 Stage 1 results

| Step | Pass/Fail | Notes |
|---|---|---|
| M2-S1-01 | | |
| M2-S1-02 | | |
| M2-S1-03 | | |
| M2-S1-04 | | |
| M2-S1-05 | | |
| M2-S1-06 | | |
| M2-S1-07 | | |

---

## Stage 2: Changes screen — staging, commit, stashes

Stage 2 wires all write operations. You need a scratch repository you can freely commit to.

> **Prerequisites:** Stage 1 manual checks passed. Active worktree set to a dirty repository.

### M2-S2-01 · Stage a file by row action

1. With a modified, unstaged file (`a.txt`) in the scratch repo, open **Changes**.
2. Hover over `a.txt` in the **Changes (Unstaged)** section; click the **＋ Stage** button.

Expected:
- `a.txt` disappears from **Changes** and appears under **Staged Changes** with status `M`.
- A success toast appears briefly.

### M2-S2-02 · Unstage a file by row action

1. With `a.txt` now staged (from M2-S2-01 or `git add a.txt`), hover over its row in **Staged Changes** and click the **− Unstage** button.

Expected:
- `a.txt` moves back to **Changes** (Unstaged). No error toast.

### M2-S2-03 · Discard working-tree changes

1. Edit `a.txt` so it has unstaged changes.
2. Hover over its row in **Changes** and click the **↶ Discard** button.

Expected:
- The file reverts to the last committed content (check in a terminal: `git diff a.txt` shows nothing).
- No file was deleted; untracked files are unaffected.

### M2-S2-04 · Stage All and Discard All section actions

1. Create three modified files. Click the **＋ Stage All** icon (right of **Changes** section header).

Expected:
- All three move to **Staged Changes** instantly.

2. Click the **↶ Discard All** icon (left of **Changes** section header). Confirm in the dialog.

Expected:
- A confirmation dialog lists the files. After OK all unstaged changes are reverted.

### M2-S2-05 · Stage a hunk from the diff pane

1. Edit `a.txt` with two separate blocks of changes (enough apart to produce two hunks in `git diff`).
2. Click `a.txt` in **Changes** to show its diff.
3. Click the **Stage hunk** button in the header of the *first* hunk only.

Expected:
- The first hunk disappears from the unstaged diff. Running `git diff --cached a.txt` shows only the first block staged.

### M2-S2-06 · Stage selected lines

1. With a hunk visible, click two individual `+` or `−` lines (they become highlighted).
2. Click **Stage selected lines**.

Expected:
- Only the clicked lines appear in the staged diff. The rest remain unstaged.

### M2-S2-07 · Commit staged changes

1. Stage at least one file. Type a commit message (e.g. `test: manual commit`) in the commit box.
2. Check that the counter shows `XX/72` with no colour change for a short message.
3. Click **✓ Commit** (or press ⌘↵).

Expected:
- A success toast appears. The staged section empties. Running `git log --oneline -1` shows the new commit.

### M2-S2-08 · Amend the last commit

1. Make a small change and stage it. Open the split-button menu (▾).
2. Choose **Amend**.

Expected:
- `git log --oneline -1` shows the same commit SHA updated with the staged changes (and the new message if you typed one).

### M2-S2-09 · Commit & Push against a local bare remote

> **Setup:** `git init --bare /tmp/bw-bare && git remote add origin /tmp/bw-bare && git push -u origin HEAD` in the scratch repo.

1. Stage a change. Type a message. Open the split-button menu, choose **Commit & Push**.

Expected:
- The commit appears both locally and in the bare remote (`git log --oneline /tmp/bw-bare`). An auth error (wrong remote URL) surfaces as an actionable toast.

### M2-S2-10 · Commit message counter colour changes

1. Type exactly 50 characters in the commit box. The counter should be neutral (grey).
2. Type one more character (51 total): the counter turns **yellow**.
3. Type to 73 total: the counter turns **red**.

Expected: exact threshold matching as described.

### M2-S2-11 · ✦ Generate is disabled

Expected:
- The **✦** button next to the commit textarea is visually disabled. Hovering shows a tooltip mentioning it is coming in a future version (M6).

### M2-S2-12 · Stash Push (Stash All from ⋯ menu)

1. Have both staged and unstaged changes. Click **⋯** (More) in the Changes header.
2. Choose **Stash All**.

Expected:
- Both staged and unstaged changes are cleared from the list.
- The **Stashes** section shows a new entry at index 0 with the commit message prefix.

### M2-S2-13 · Stash Apply

1. With at least one stash, click the **↓ Apply stash** button on `stash@{0}`.

Expected:
- The stash's changes reappear in the working tree. The stash entry *remains* in the list (apply does not remove it).

### M2-S2-14 · Stash Pop

1. Click the **⇪ Pop stash** button on `stash@{0}`.

Expected:
- The stash's changes reappear in the working tree. The stash entry *disappears* from the list.

### M2-S2-15 · Stash Drop + Undo toast

1. Click the **× Drop stash** button on `stash@{0}`.

Expected:
- The stash entry disappears. A toast appears with an **Undo** action.
- Clicking Undo reapplies the dropped stash and restores the stash entry.

### M2-S2-16 · Sync without a new message

1. Click the **⟳ Sync** button in the branch line (no message typed).

Expected:
- A fetch + rebase + push runs. Any current commit message draft is *preserved* in the textarea.

### M2 Stage 2 results

| Step | Pass/Fail | Notes |
|---|---|---|
| M2-S2-01 | | |
| M2-S2-02 | | |
| M2-S2-03 | | |
| M2-S2-04 | | |
| M2-S2-05 | | |
| M2-S2-06 | | |
| M2-S2-07 | | |
| M2-S2-08 | | |
| M2-S2-09 | | |
| M2-S2-10 | | |
| M2-S2-11 | | |
| M2-S2-12 | | |
| M2-S2-13 | | |
| M2-S2-14 | | |
| M2-S2-15 | | |
| M2-S2-16 | | |

## Stage 3: Files & editor

Stage 3 adds the Files screen, filesystem writes, and the CodeMirror editor. Use the same scratch repository as Stage 2.

> **Prerequisites:** Stage 2 manual checks passed. Active worktree set to the scratch repository with at least one tracked `.ts` file and one `README.md`.

### M2-S3-01 · Open a file

1. Open **Files** in the sidebar. Click a tracked `.ts` file in the project tree.

Expected:
- A tab opens with the file icon and name; breadcrumbs show the path segments.
- Syntax highlighting is TypeScript. Status bar shows `Ln 1, Col 1`, indentation (`Spaces: N` or `Tabs`), `UTF-8`, `LF`/`CRLF`, `TypeScript`, and the branch name.
- The editor loads in under ~150 ms for a normal file; a 5 000-line file still opens without a visible freeze.

### M2-S3-02 · Edit and save

1. Type a change in the editor.
2. Press **⌘S**.

Expected:
- While unsaved, the tab shows the dirty dot instead of `×`, and the tree row shows a dirty dot.
- After save, the dirty dot clears. The Git gutter shows an added/modified marker on the changed line.
- The **Changes** count in the sidebar goes up by one; the file appears in Changes as modified.

### M2-S3-03 · External change

1. With the file open and clean, change it in another editor and save.
2. Make an unsaved edit in Branchwork, then change the file externally again.
3. Open two files, make an unsaved edit in file A, switch to file B, change A externally, then switch back to A.

Expected:
- Step 1: the buffer silently reloads with the external content, no banner.
- Step 2: the banner shows **Reload / Keep mine / Compare**. Reload takes the disk version; Keep mine keeps your edit and the next ⌘S saves it.
- Step 3: the banner appears when you return to A.

### M2-S3-04 · Diff vs HEAD

1. With a modified file open, click **Diff vs HEAD** in the toolbar.
2. Click **Editor**.

Expected:
- The editor is replaced by the shared diff renderer showing all changes against HEAD (staged and unstaged together).
- **Editor** restores the CodeMirror view with the cursor and edits intact.

### M2-S3-05 · Markdown preview

1. Open `README.md`. Click **Source**, then **Preview**.
2. Switch to another file and back to `README.md`.
3. Click a link inside the preview.

Expected:
- Opens in Preview (full width) with a short loader; headings, lists, code blocks, and tables render.
- Switching back shows the preview again, not a stuck loader.
- Clicking a link does not navigate the app window away.

### M2-S3-06 · Create, rename, duplicate

1. Right-click a folder → **New file**, enter a name. Then **New folder**.
2. Right-click the new file → **Rename** (or **F2**), then **Duplicate**.

Expected:
- Each item appears in the tree immediately and as untracked in Changes.
- Names containing `..` or `/` that leave the worktree are refused with an error toast.

### M2-S3-07 · Delete to Trash

1. Right-click the duplicated file → **Delete**. Confirm.
2. In Finder, open the Trash and use **Put Back** on that file.

Expected:
- A confirmation dialog appears first; Cancel leaves the file untouched.
- After confirm, the file disappears from the tree and a "Deleted" toast shows. The file is in the macOS Trash (not permanently deleted).
- After **Put Back**, the file reappears in the tree. In-app Undo is covered by M2-S4-03.

### M2-S3-08 · Reveal in Finder and deferred items

1. Right-click a file → **Reveal in Finder**. Also try the toolbar **Open in** → **Finder**.
2. Inspect the context menu and toolbar for **Open terminal here**, **Ask agent**, and editor-app entries.

Expected:
- Finder opens with the file selected.
- Deferred items are visible but disabled, with a tooltip naming the milestone (M3/M4).

### M2-S3-09 · Unsaved edits are protected

1. Edit a file without saving. Switch to **Changes**, then back to **Files**.
2. With the edit still unsaved, pick another worktree, then another project tab.
3. Click the dirty dot on the tab (or focus it and press Enter).

Expected:
- Step 1: the unsaved text is still there and the tab still shows the dirty dot.
- Step 2: both switches are refused with a "Save or discard unsaved changes…" toast; title bar and sidebar stay on the same project.
- Step 3: a "Discard unsaved changes in …?" dialog appears; Discard closes the tab, Cancel keeps it.
- A clean open file changed by another editor reloads silently and does **not** get a dirty dot.

### M2-S3-10 · Lazy file tree and ⌘P

1. Open Files in a large repo. Expand a few folders. Turn **Show ignored files** on.
2. Focus **Find file**, type part of a file name, then save a file in another editor.

Expected:
- The tree appears quickly; a folder shows a brief loading row only on first expand.
- ⌘P results stay listed after the external save (no "No matching files" flash).

### M2-S3-11 · Long diff lines and grouped sidebar

1. Change a file so one line is longer than the diff pane. Open it in **Changes** (split and inline) and in Files → **Diff vs HEAD**.
2. Look at the sidebar.

Expected:
- Each hunk scrolls sideways to show the whole line; the hunk header stays in place.
- Sidebar sections read **Workspace** (Launchpad, Inbox), **Code** (Graph, Files & editor, Changes), **AI** (Agents, Terminal), **GitHub** (Pull requests, Repository), then Worktrees and Tools. Number keys 1–9 still open the same screens as before.

### M2 Stage 3 results

| Step | Pass/Fail | Notes |
|---|---|---|
| M2-S3-01 | | |
| M2-S3-02 | | |
| M2-S3-03 | | |
| M2-S3-04 | | |
| M2-S3-05 | | |
| M2-S3-06 | | |
| M2-S3-07 | | |
| M2-S3-08 | | |
| M2-S3-09 | | |
| M2-S3-10 | | |
| M2-S3-11 | | |

## Stage 4: Blame, history, oplog undo, and palette polish

> **Prerequisites:** Stage 3 checks passed. Use a scratch repository with one partially staged file, at least one tracked unstaged change, and a disposable tracked file to delete.

### M2-S4-01 · Palette navigation and diff selection

1. Press **⌘K**, search **Open Changes**, and run it. Repeat with **Open Files**.
2. With no file selected, run **Open Blame**.
3. Return to Changes, select a partially staged file, then run **Toggle staged view** from the palette twice.

Expected:
- Each Open command navigates to its screen. Blame shows its empty state when no file is selected.
- Toggle staged view keeps the selected path and alternates the right-pane diff between its staged and unstaged areas.
- Deferred tooltips name the correct milestone: M3 for Terminal/agents, M4 for GitHub, and M6 for AI assists.

### M2-S4-02 · Confirmed discard-all and Undo

1. Create two tracked unstaged changes. Run **Discard all changes** from the palette and cancel.
2. Run it again, inspect the confirmation's file list, and confirm.
3. Click **Undo** on the resulting toast.

Expected:
- Cancel leaves both changes untouched. Confirm reverts both files, and Undo restores both pre-discard contents.
- Undo is disabled when the recorded payload exceeds the 16 MiB limit.

### M2-S4-03 · Blame, history, and destructive-operation Undo

1. Open a tracked file's context menu in Files and choose **Blame**. Select a line and a file-history entry; use **View commit**.
2. Make and commit a change, then run **Undo last action** from the palette. Drop a stash and use its **Undo** toast.
3. Delete a disposable file to Trash, then use its **Undo** toast.

Expected:
- Blame shows line authorship and commit details; file history selects the matching commit group; View commit opens Graph at that SHA.
- Undo Last Commit soft-resets the commit, preserving its changes staged. Undoing stash-drop reapplies the stash, and Undoing Delete restores the file.
- A failed reverse reports an error and does not silently remove its recovery record.

### M2-S4-04 · Graph working-copy diff tabs

1. Select the **Working copy** row at the top of Graph.
2. Click a file in **Staged**, then click the same partially staged file in **Unstaged**. Each opens a tab in Graph's main editor area, not in the WIP inspector.
3. Switch between the **Graph** tab and both diff tabs, close one, then use a row action to stage or unstage a file from the Graph tab.

Expected:
- Graph remains available as a tab with the commit history, and the WIP inspector stays visible beside the editor. Each diff tab shows the right comparison (HEAD ↔ Index for staged, Index ↔ Working Tree for unstaged); switching tabs preserves its path and area.
- Closing the active diff tab returns to the remaining tab or Graph. Row/hunk actions refresh the worktree.
- **Open in Changes** still exposes commit, stash, and discard operations; opening a file from the diff still routes to Files.

### M2-S4-05 · Native memory budget

1. Launch the native app and open two repositories.
2. Open a 5 000-line file in the editor and wait for loading to settle.
3. Measure the Branchwork app's resident memory, including any associated WebKit content process. Record the process names, RSS values, repository/editor state, and measurement tool.

Expected:
- Total measured RSS for the app and associated WebKit content stays below 400 MB.
- Do not substitute browser E2E measurements or an app sample whose repository/editor state is unknown.

### M2 Stage 4 results

| Step | Pass/Fail | Notes |
|---|---|---|
| M2-S4-01 | | |
| M2-S4-02 | | |
| M2-S4-03 | | |
| M2-S4-04 | | |
| M2-S4-05 | | |
