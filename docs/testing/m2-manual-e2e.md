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
