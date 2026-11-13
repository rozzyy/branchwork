# M6 Plan — Advanced Git

> **Status:** approved plan (decisions below, 2026-11-12). Task files and
> `feature_list.json` entries are written when M6 starts. Starts only after
> M5-01 is approved and committed.

Spec §11 calls this milestone "M5 — Advanced Git". M5 is now the
Launchpad/Inbox UI-parity milestone, so this plan uses **M6**; AI assists
(spec "M6") moves to **M7**. Scope follows spec §6.8 and adds the Git
write actions that the Graph and Changes screens still show as
`disabled · Later` (spec §3.3, §6.2, §6.3), because the conflict resolver and
rebase depend on them.

Existing building blocks to reuse:
- `commit.rs` `run_git` / `require_success` (git CLI writes, hook-aware
  error classification) and `oplog.rs` (`record`, `undo_last`).
- `worktree.rs` `WorktreeState::{Conflict, Rebasing}` detection.
- `diff.rs` `DiffModel`, path validation helpers, and the shared
  `src/diff/DiffRenderer.tsx`.
- `ask()` dialog, toasts with Undo, dock/Terminal-screen `openHere`.

## Stage 1 — Git write actions (sync, branch, commit picks)

| Task | Scope | Depends on |
|---|---|---|
| M6-01 Remote sync IPC + UI ✅ | Typed `fetch`, `pull`, `push` commands over the git CLI. Pull records an oplog entry (undo = `reset --keep` to `before_ref`). Errors map to `GitAuth` / `GitHook` / `Network`; failures show an expandable "Show details" toast with stderr, and auth failures offer "Open terminal to authenticate" (spec §7). Enable Graph toolbar Fetch / Pull (count) / Push (count) and add pull / push / fetch / pop stash to the Changes ⋯ menu. | M5-01 |
| M6-02 Checkout, branch, cherry-pick, revert ✅ | Typed `checkout`, `branch_create`, `cherry_pick`, `revert` commands with validated ref names (`git check-ref-format`) and oplog entries (undo = `reset --keep` for cherry-pick/revert; restore previous HEAD for checkout). A dirty tree that blocks checkout yields a clear `Conflict` error, not a forced checkout. A cherry-pick/revert that conflicts leaves the worktree in `Conflict` state for Stage 2. Enable these items in the Graph context menu and the inspector, plus Checkout in the Changes ⋯ menu. | M6-01 |
| M6-03 Graph cross-screen actions ✅ | Enable the remaining Graph menu items that need no new backend: Blame files (opens Blame for the commit's files), Open pull request (implemented as "Open on GitHub": an allowlisted GitHub commit page that links its PRs, since `gh_open_url` only allows the device-login page — see `.agent/tasks/m6-task-03-graph-cross-screen.md`), Open terminal here. Compare with working tree and Interactive rebase from here stay disabled until Stages 4–5 and are enabled there. | M6-02 |

Manual checkpoint M6.1 ✅ (approved 2026-11-13): fetch/pull/push against a real remote (including an
auth failure and a hook failure), undo pull, checkout with a dirty tree,
create branch, cherry-pick and revert with undo, a cherry-pick that conflicts.

## Stage 2 — Conflict resolver (spec §6.8)

| Task | Scope | Depends on |
|---|---|---|
| M6-04 Conflict read model IPC ✅ | `conflict_list(worktree)` (conflicted paths plus operation kind: merge / cherry-pick / revert / rebase) and `conflict_read(worktree, path)` returning base/ours/theirs from index stages 1/2/3, split into conflict regions and shared context. Binary files and files over 1 MB return a summary (choose ours/theirs only). Path validation reuses `diff.rs`. | M6-02 |
| M6-05 Resolve, abort, continue IPC ✅ | `conflict_resolve(path, choices)` writes the merged result (per region: ours / theirs / both / manual text) and stages the file. `merge_abort` (also `cherry-pick --abort` / `revert --abort`) after confirmation. "Mark resolved & commit" runs the matching `--continue` / merge commit and is rejected while any region is unresolved. | M6-04 |
| M6-06 Conflicts screen ✅ | Replace the placeholder: per-file tabs, Ours / Result / Theirs columns, click a side or use ← Ours / Both / Theirs →, per-resolution undo (a local stack), remaining-conflicts counter, confirmed Abort, Mark resolved & commit. Sidebar Tools badge shows the conflict count. The ✦ explanation button is shown disabled until the AI milestone. | M6-05 |

Manual checkpoint M6.2: resolve a merge conflict across 2+ files using every
choice type, undo a resolution, abort a merge, resolve a cherry-pick conflict
from Stage 1.

## Stage 3 — Local project init & publish (inserted 2026-11-13, GitHub issue #5)

Design: `docs/superpowers/specs/2026-11-13-local-project-init-publish-design.md` (approved).
Detailed plan: `docs/superpowers/plans/2026-11-13-m6-stage3-init-publish.md`.

| Task | Scope | Depends on |
|---|---|---|
| M6-07 Initialize on add ✅ | `repository_classify` + `repository_init`: a non-Git folder offers a confirmed `git init` (honoring `init.defaultBranch`) and becomes a normal project; a folder inside a repo offers that repo; home/root refused. | M6-03 (reordered: Stage 3 runs before Stage 2's checkpoint by user order, 2026-11-13) |
| M6-08 Repositories with no commits ✅ | Worktree list, Graph, file history tolerate an unborn HEAD; Graph empty state; first commit from Changes; worktree creation asks for a first commit. | M6-07 |
| M6-09 Publish to GitHub ✅ | `gh_publish_owners` + `gh_repo_publish`: create the repo (Private default) with the selected account, set `origin`, first push authenticated with that account's token via the git child environment only; Repository screen and Changes ⋯ entry points. | M6-08 |

Manual checkpoint M6.3: init a new folder, refusal of `~`, inside-repo offer, first commit,
Graph empty state, private publish with a second account, name collision, push-failure retry.

## Stage 4 — Interactive rebase (spec §6.8)

| Task | Scope | Depends on |
|---|---|---|
| M6-10 Rebase plan read IPC | `rebase_plan(worktree, base)` lists commits `base..HEAD` (capped, for example 500) with sha, subject, and author, and reports whether the branch is already pushed (upstream contains any of those commits). | M6-02 |
| M6-11 Rebase execution IPC | `rebase_interactive(plan)`: create the backup ref `refs/branchwork/backup/<branch>/<ts>`, write the todo file, and run `git rebase -i` non-interactively with no shell invocation (see Decision 2). Emits per-step progress events. Stops on conflict and hands off to the Conflicts screen; `rebase_continue` and `rebase_abort` (confirmed). Oplog entry: undo restores the backup ref. A subsequent push of a rewritten pushed branch uses `--force-with-lease` after `ask()` confirmation. | M6-10, M6-05 |
| M6-12 Rebase screen | Replace the placeholder: drag to reorder, per-commit action (pick / reword with inline edit / squash / fixup / drop), auto-squash for `fixup!` / `squash!` subjects, result preview with count, pushed-branch warning, per-step progress. Enable "Interactive rebase from here" in the Graph menu and inspector. ✦ heuristic auto-squash (typo/wip) waits for the AI milestone. | M6-11 |

Manual checkpoint M6.4: reorder, reword, squash, fixup, and drop in one run;
undo via the backup ref; a rebase that conflicts and continues; abort; the
force-with-lease confirmation on a pushed branch.

## Stage 5 — Compare worktrees (spec §6.8)

| Task | Scope | Depends on |
|---|---|---|
| M6-13 Compare IPC | `compare_worktrees(a, b, include_uncommitted)` returns a file list with +/− stats (capped); `compare_file_diff(a, b, path, include_uncommitted)` returns a `DiffModel`; `compare_patch` returns patch text for Copy patch (size-capped). Uncommitted state is snapshotted without touching either working tree (see Decision 3). Both worktrees must belong to the same repository. | M6-02 |
| M6-14 Compare screen + entry points | Replace the placeholder: worktree A/B pickers, include-uncommitted toggle, file list, shared diff renderer, Copy patch. Entry points: Graph "Compare with working tree", Race results "Compare" with Keep one / Discard others (removes worktree + branch after confirmation, spec §6.6.6). | M6-13 |

Manual checkpoint M6.5: compare two race worktrees with and without
uncommitted changes, copy the patch and apply it elsewhere, keep one race
result and discard the others. Then the M6 review gate (code + security +
E2E + §9 performance note), and on approval the `v0.6.0` release.

## Cross-stage constraints

- **Writes go through the git CLI** (hooks, signing, credential helpers);
  reads use git2. Arguments are passed as an argv array, never through a
  shell. Ref names, paths, and SHAs coming over IPC are validated in Rust.
- **Safety:** every destructive action uses `ask()` (abort merge/rebase,
  force-with-lease, discard race worktree). Every undoable write records an
  oplog entry before it runs. Nothing auto-resolves or auto-applies.
- **Bounds:** commit lists, file lists, conflict regions, and patch text have
  explicit caps; large/binary files are summarized (spec §9: diff render of a
  5k-line file < 100 ms). Long operations (fetch, pull, push, rebase) run off
  the UI thread and report progress through events.
- **No AI in this milestone.** ✦ buttons stay visible but disabled with the
  existing `ui.deferred_*` tooltip.
- Strings in `src/i18n/en.ts`. Tests only as each task file specifies:
  Rust tests on temporary repositories for each new command (spec §10:
  conflict detection, rebase plan execution, oplog undo).
- Per `CLAUDE.md`: one stage branch `m6-stage-<K>`, one commit per stage after
  user approval, never push.

## Decisions (user, 2026-11-12)

1. **Numbering:** M6 = Advanced Git, M7 = AI assists. Spec §11 carries a
   note.
2. **Non-interactive rebase:** a tiny bundled helper binary (like
   `branchwork-notify`) set by absolute path as `GIT_SEQUENCE_EDITOR`; it
   only copies a prepared todo file over git's. Reword uses
   `exec git commit --amend --only -F <msgfile>` lines, so no `GIT_EDITOR`
   is needed. No in-process git2 rebase.
3. **Compare uncommitted state:** `git stash create` snapshots tracked
   changes without touching the tree; untracked files are excluded
   (shown as a note in the Compare screen).
4. **Stage 1** (Git write actions) stays in this milestone.
