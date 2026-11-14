# Session Handoff

- **Last updated:** 2026-11-14
- **Current objective:** Merge all current work on `m7-stage-1` to `main`, commit, push, and create the M6 release tag as explicitly ordered by the user. Included work: M6 Compare, M7 prototype-parity follow-up, and stale linked-worktree recovery.
- **Branch:** `m7-stage-1` (tracks `origin/m7-stage-1`); `main` is two commits behind before the stage commit.
- **Completed:** M6-13 Compare IPC and M6-14 Compare UI/entry points are implemented. Rust validates same-repository worktrees and bounds output; tracked dirty snapshots exclude untracked files and preserve each worktree/index. The Compare dialog has A/B selectors, tracked-uncommitted option, file stats, shared diff renderer and Copy patch. Graph context menu opens Compare; Race results have Compare plus existing Keep and confirmed Discard actions.
- **Existing M7 UI work:** The prototype-parity diff (including Home and Settings full-width adjustment) was present before this task and remains on the same branch; it was preserved.
- **Separate worktree diff:** `src-tauri/src/repository.rs` and `src-tauri/src/worktree.rs` gained stale-worktree-pruning changes during final verification; they are outside M6-13/14 and were preserved for follow-up.
- **Stale worktree recovery:** `git worktree prune --expire=now` runs on repository registration and before worktree list/summary reads. It removes only stale registrations confirmed by Git. Regression tests cover adding a repository and refreshing worktrees.
- **Verification:** `./init.sh` passed after stale-worktree changes: 82 Vitest files / 692 tests; Rust 316 passed / 3 ignored; TypeScript and Clippy clean. Focused stale-worktree tests passed 2/2. Scoped Rust formatting check, `git diff --check`, and feature JSON validation passed. Native app verification remains pending.
- **Manual checkpoint:** M6-S5 desktop E2E cases are documented in `docs/testing/m6-manual-e2e.md` but remain unverified in the native app: compare committed and tracked dirty changes, confirm no mutation/untracked exclusion, copy/apply patch, and compare/keep/discard Race results.
- **Next action:** Follow the user's merge/release order. M6-S5 and stale-worktree native confirmation remain manual follow-ups; do not claim those checks passed.
