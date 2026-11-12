# M6 Manual E2E — Advanced Git

Run in the desktop app (`pnpm tauri dev`) against a repository with a real GitHub remote you can
push to, plus a scratch branch you can rewrite. Restart the app fully first (Rust changed).

## Stage 1 — Git write actions (Checkpoint M6.1)

### Remote sync (M6-01)

- [x] **M6-S1-01 Fetch.** Push a commit to the remote from elsewhere. In Graph, click Fetch; the button shows `Fetch…` while running, a "Fetch complete" toast appears, and Pull shows the behind count.
- [x] **M6-S1-02 Pull + undo.** Click Pull (count); the new commit appears and the toast offers Undo. Click Undo; HEAD returns to the previous commit and the behind count comes back. Pull again when up to date → "Already up to date", no Undo.
- [x] **M6-S1-03 Push.** Commit locally; Push shows the ahead count. Click Push; the remote receives the commit and the count clears.
- [x] **M6-S1-04 Push a new branch.** On a new local branch with no upstream, Push → branch appears on GitHub with upstream set.
- [x] **M6-S1-05 Rejected push.** Make the remote diverge, then Push → failure toast with a short title and "Show details" containing git's `rejected` output.
- [x] **M6-S1-06 Auth failure.** Point `origin` at an HTTPS URL without stored credentials (or revoke them) and Pull/Push → failure toast with "Show details" and "Open terminal to authenticate", which opens the dock terminal in the worktree.
- [x] **M6-S1-07 Hook failure.** Add an executable `.git/hooks/pre-push` that prints a message and exits 1; Push → "pre-push hook failed" with the hook output in details.
- [x] **M6-S1-08 Changes ⋯ menu.** Pull / Push / Fetch work from the Changes ⋯ menu; "Pop latest stash" pops `stash@{0}` and is disabled with no stashes.
- [x] **M6-S1-09 Credential helper / identity.** Commit & push from Changes uses your global identity and the macOS keychain credential helper (no "Please tell me who you are", no auth prompt failure).

### Checkout, branch, cherry-pick, revert (M6-02)

- [x] **M6-S1-10 Checkout branch + undo.** Right-click a commit with a local branch → Checkout; the worktree switches branch (sidebar/title update), toast offers Undo; Undo returns to the previous branch.
- [x] **M6-S1-11 Detached checkout.** Right-click a commit without a branch → Checkout → confirmation about detached HEAD; confirm → detached. Cancel does nothing.
- [x] **M6-S1-12 Dirty-tree checkout.** Edit a file that differs on the target branch, then Checkout → clear "commit, stash, or discard" error; the edit is untouched.
- [x] **M6-S1-13 Create branch here.** Right-click → Create branch, enter a name → branch is created at that commit and checked out. Invalid names (`bad..name`, `-x`) are rejected.
- [x] **M6-S1-14 Cherry-pick + undo.** Cherry-pick a commit from another branch (menu and inspector) → new commit; Undo removes it.
- [x] **M6-S1-15 Revert + undo.** Revert a commit (menu and inspector) → revert commit; Undo removes it.
- [x] **M6-S1-16 Conflicting cherry-pick.** Cherry-pick a commit that conflicts → `GitConflict` toast with `CONFLICT` lines in details; the worktree shows the conflict state (resolution arrives in Stage 2; abort with `git cherry-pick --abort` in the terminal for now).
- [x] **M6-S1-17 Changes ⋯ Checkout….** Enter a branch name → switches; a remote-only branch name creates a tracking branch.

### Graph cross-screen actions (M6-03)

- [x] **M6-S1-18 Open on GitHub.** Right-click a commit → Open on GitHub opens `github.com/<owner>/<repo>/commit/<sha>` (PR links visible there). A repo without a GitHub `origin` shows an error toast.
- [x] **M6-S1-19 Blame files.** Right-click a commit → Blame files opens its first changed file in Blame. A commit with no file changes shows an info toast.
- [x] **M6-S1-20 Still deferred.** Compare with working tree, Rebase from here, Start agent here show "· Later" and are disabled.

Stage 1 manual flows confirmed OK by the user on 2026-11-13 (Checkpoint M6.1 approved), including the packaged-app retest of the issue #3 fix.
