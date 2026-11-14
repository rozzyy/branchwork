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
- [x] **M6-S1-20 At the Stage 1 checkpoint.** Compare with working tree, Rebase from here, and Start agent here were deferred until their implementation stages.

Stage 1 manual flows confirmed OK by the user on 2026-11-13 (Checkpoint M6.1 approved), including the packaged-app retest of the issue #3 fix.

## Stage 2 — Conflict resolver (Checkpoint M6.2)

Restart the app fully first (Rust changed). Use a scratch repository you can merge in.

- [ ] **M6-S2-01 Merge conflict across files.** Create two branches that change the same lines in 2+ text files; merge in the terminal (or pull). The sidebar Conflicts item shows a badge with the file count; the toast offers **Resolve conflicts**, which opens the screen.
- [ ] **M6-S2-02 Columns and choices.** Each file is a tab; Ours | Result | Theirs columns show context lines and highlighted conflict blocks. Resolve one region by clicking the Ours block, one by clicking Theirs, one with **Both**, one with **Edit** (type manual text, Apply). The unresolved count on the tab drops to zero.
- [ ] **M6-S2-03 Undo a resolution.** Change a region's choice twice, press **Undo** → the previous choice returns; Undo again → the region is unresolved.
- [ ] **M6-S2-04 Save resolution.** Save each file → it leaves the tab list; the working file contains exactly the Result (line endings follow `.gitattributes`); `git status` shows it staged.
- [ ] **M6-S2-05 Mark resolved & commit.** With no files left, the button is enabled; it creates the merge commit (two parents in Graph) and opens Graph.
- [ ] **M6-S2-06 Abort.** Start another conflicting merge, click **Abort** → danger confirmation; Cancel does nothing; confirm → branch back at the pre-merge commit, clean tree, badge gone.
- [ ] **M6-S2-07 Cherry-pick conflict from Stage 1.** Cherry-pick a conflicting commit from the Graph menu → toast offers Resolve conflicts → resolve → Mark resolved & commit finishes the cherry-pick with the original message.
- [ ] **M6-S2-08 Whole-file choices.** Make a binary file or a modify/delete conflict → the file shows a summary with Use ours / Use theirs (and **Accept deletion** for the deleted case); each works.
- [ ] **M6-S2-09 Special file names.** A conflict on a file named like `pages/[id].tsx` resolves without touching other files (uncommitted edits elsewhere survive; untracked files stay unstaged).
- [ ] **M6-S2-10 Undo is refused mid-operation.** During an unresolved cherry-pick, ⌘Z / Undo toast → message to finish or abort first; the cherry-pick is still in progress.

## Stage 3 — Local project init & publish, GitHub issue #5 (Checkpoint M6.3)

Restart the app fully first (Rust changed). Use a linked GitHub account; for the multi-account step, link two.

- [ ] **M6-S3-01 Initialize a new folder.** Create an empty folder (e.g. `~/Projects/demo app`), then Open (or Add repository into a group) → "Initialize Git in demo app?" → Initialize Git → the project appears in the sidebar on your default branch (`init.defaultBranch`). Cancel instead → nothing is created.
- [ ] **M6-S3-02 Refused folders.** Pick `~` or `/` → error toast, no init dialog. Pick a subfolder of an existing repo → "This folder is inside the repository …" with Open that repository (opens the root; never inits).
- [ ] **M6-S3-03 Empty repository works.** In the new project: Changes lists the files, Files and the terminal work, Graph shows "No commits yet — make your first commit in Changes." with Open in Changes. Push/Pull say to make a first commit. Creating a worktree asks for a first commit.
- [ ] **M6-S3-04 First commit.** Stage and commit from Changes → Graph shows the commit.
- [ ] **M6-S3-05 Publish entry points.** With no `origin`, Repository shows "Publish to GitHub…" and the Changes ⋯ menu has it. A repo whose origin is GitLab/Bitbucket shows neither. Before the first commit, the dialog's Publish button is disabled with "Make a first commit before publishing."
- [ ] **M6-S3-06 Publish private.** Dialog defaults: your default account, owner = that account, name = sanitized folder name (`demo-app`), Private. Publish → toast "Published to …" with Open on GitHub; the repo exists on GitHub as private with your commit; `git status -sb` shows the upstream; `.git/config` contains no token or extraheader.
- [ ] **M6-S3-07 Second account / organization.** Pick the other account (or an organization owner) → publish works as that account (the first push uses that account's token even if your keychain holds the other account).
- [ ] **M6-S3-08 Name collision.** Publish with a name that already exists on that owner → clear GitHub error; no `origin` is added; nothing pushed.
- [ ] **M6-S3-09 Push failure keeps the repo.** Simulate a push failure (e.g. a pre-push hook that exits 1) → toast says the repo was created and to retry with Push; `origin` is set; Push from Graph succeeds after removing the hook.

## Stage 4 — Interactive rebase (Checkpoint M6.4)

> **Checkpoint M6.4 approved by the user on 2026-11-14** and the stage commit ordered. The user did not report results for M6-S4-01..09, so the checks below remain unverified.

Rebuild the app (`pnpm tauri build`) and test the built `.app` at least once: the rebase sequence editor is the app binary itself (`--branchwork-rebase-todo`), so the dev run and the bundle both have to work. Use a throwaway branch with 5–6 local commits, including one `fixup! <subject>` commit; for the pushed steps, a branch that has an upstream on GitHub.

- [ ] **M6-S4-01 Entry.** Graph → right-click a commit → "Rebase from here" opens Rebase with the commits after it, oldest first (author, short SHA). The inspector's Rebase button does the same. Opening Rebase with no base says to pick a commit in Graph. Choosing a base in worktree A and then switching to worktree B doesn't show A's plan.
- [ ] **M6-S4-02 Edit the plan.** Reorder by drag and drop and with ↑/↓ (Tab to the buttons and press Enter). Change actions; reword shows a prefilled input; drop strikes the row through. The side panel count ("N of M commits") and the preview follow; squash/fixup rows show "↳ melded into the commit above". Dragging text from another app onto the list does nothing.
- [ ] **M6-S4-03 Auto-squash.** "Auto-squash fixup!/squash!" moves the `fixup!` commit right after its target with action fixup. A `fixup!` whose target isn't in the range stays in place. ✦ AI auto-squash is disabled.
- [ ] **M6-S4-04 Start guards.** Start is disabled with a reason when the first kept row is squash/fixup, when every row is dropped, when a reword message is empty, and for a range containing a merge commit.
- [ ] **M6-S4-05 Run.** With reorder + reword + fixup + squash + drop, Start → "Rebasing step/total" → toast "Rebase complete" with Undo. Graph and `git log` show the new order, the reworded message, the squash's combined message, and the dropped commit gone. `git for-each-ref refs/branchwork/backup` lists a backup at the old HEAD. No `branchwork-rebase` folder remains under `.git`.
- [ ] **M6-S4-06 Undo.** Click Undo (or ⌘Z undo-last) → HEAD returns to the old commit; the working tree is untouched.
- [ ] **M6-S4-07 Refused when dirty.** Modify a tracked file → Start → clear error, nothing changes. Restore the file.
- [ ] **M6-S4-08 Conflict → Continue.** Reorder two commits that touch the same lines → Start → toast with Resolve conflicts; Rebase shows "Rebase in progress" (Continue disabled while files are conflicted, with a link to Conflicts). Resolve in Conflicts → back in Rebase → Continue → "Rebase complete" (a reword placed after the conflict keeps its new message).
- [ ] **M6-S4-09 Abort.** Start a conflicting rebase again → Abort asks (danger) → Cancel keeps it; Abort → the branch is back at the old HEAD and `git status` is clean.
- [ ] **M6-S4-10 Pushed branch.** On a branch that's already pushed: the side panel warns about `--force-with-lease`. After the rebase (also after a conflict + Continue), the screen offers "Push with --force-with-lease" → a danger confirm → the push succeeds and the screen returns to "Pick a commit…". If someone else pushed to the remote branch first, the push is refused with a clear error and nothing is overwritten.

## Stage 5 — Compare worktrees (Checkpoint M6.5)

Restart the app fully first (Rust changed). Use a repository with at least two
worktrees; Race creates additional unpinned worktrees.

- [ ] **M6-S5-01 Compare committed differences.** In Graph, right-click a commit and choose "Compare with working tree". Select two different worktrees; confirm the file list and +/− stats match `git diff`, then inspect a file in the shared split diff.
- [ ] **M6-S5-02 Include tracked working changes.** Make staged and unstaged edits in both worktrees. Enable "Include tracked uncommitted changes"; confirm the displayed changes include both and neither worktree's HEAD, index, or file contents change during comparison.
- [ ] **M6-S5-03 Untracked files.** Add an untracked file in either worktree; confirm the comparison note says untracked files are excluded and the file is absent from the result.
- [ ] **M6-S5-04 Copy patch.** Copy patch, apply it in a scratch worktree with `git apply --check` then `git apply`; confirm the patch applies cleanly.
- [ ] **M6-S5-05 Race comparison.** Start a race with two CLIs, wait for both worktrees to exist, choose Compare on a result, and compare it against another worktree. Return to Race results; Keep the selected result and confirm it remains; Discard another result and confirm the danger prompt removes its worktree and branch only after confirmation.
