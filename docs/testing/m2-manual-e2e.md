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
- Clicking Undo triggers the `undo_last` IPC (currently shows a deferred toast — full undo wired in Task 14).

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
