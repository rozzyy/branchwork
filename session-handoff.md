# Session Handoff

- **Last Updated:** 2026-11-09
- **Current Objective:** M3 complete — all 87 features done (Stages 1–5 merged); release 0.3.0 + tag await user order

- **Milestone / stage:** M1 and M2 released through M2.5. M3 Stages 1–5 committed and fast-forwarded into `main`. No push.
- **Branch:** `main` (Stage 5 merged; `m3-stage-5` deleted). No push.
- **Active task:** none — M3 complete.

## Recommended Next Step

On user order: `chore(release): v0.3.0` bump (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`) + `git tag -a v0.3.0`. Push (+ tags) only if the user says so.

## M2 structure

- Stage 1 — Status read model + shared diff renderer (Tasks 01–04) → Checkpoint M2.1 ✅ committed
- Stage 2 — Changes screen: staging, commit variants, stashes (Tasks 05–08) → Checkpoint M2.2 ✅ committed
- Stage 3 — Files & editor: fs IPC, File manager UI, CodeMirror (Tasks 09–11) → Checkpoint M2.3 ✅ committed `ad0ff87`
- Stage 4 — Blame, history, oplog undo, polish, Graph WIP inspector (Tasks 12–16) → Checkpoint M2.4 ✅ committed `300a23a`; M2 release `v0.2.0`
- Stage 5 follow-up — Graph commit history diff inspector (Task 17) → committed as `1336afb` and fast-forwarded into `main`, no push
- M3 Stage 1 — PTY foundation and terminal dock (Tasks 01–03) → ✅ committed `a95e38f`, merged into `main`
- M3 Stage 2 — Full-screen Terminal workspace (Tasks 04–05) → ✅ manual OK, committed, merged into `main`
- M3 Stage 3 — Agent registry and session lifecycle (Tasks 06–10) → all done and reviewed ✅; manual M3-S3-01..07 pending
- M3 Stage 4 — Agent workflows (Tasks 11–12) → not started

## Decisions this session (user)

- `trash` crate 5.3.0 accepted (plan Open Question 2 resolved).
- File tree loads lazily now (I7).
- Sidebar grouped Workspace / Code / AI / GitHub; Inbox stays in Workspace (number keys 1–9 keep the spec order).
- Diff long lines scroll horizontally per hunk (no wrap: the virtualizer needs fixed 20px rows).
- Open Question 5: defer PR links to M4; keep Blame/History/Diff tabs; View commit opens Graph.
- Open Question 7: Undo Last Action covers commit, discard, delete-to-Trash, and stash-drop.

## Blockers / notes

- Stage 4 review reports: `.agent/reviews/m2-stage-4-code-review.md` (follow-up PASS), `.agent/reviews/m2-stage-4-security-review.md` (PASS, no findings), and `.agent/reviews/m2-stage-4-e2e.md` (76/76 automated E2E, memory condition unverified).
- The final `./init.sh` is green: typecheck and Clippy clean; 37 Vitest files / 294 tests passed; Rust 126 passed / 3 ignored. `cargo fmt --check` and `git diff --check` clean.
- The user approved Checkpoint M2.4 while accepting that manual M2-S4-01..05 and the native memory budget remain unverified. `.agent/reviews/m2-stage-4-e2e.md` records this explicitly; the unknown-state process sample is not valid evidence.
- `e2e/m2-stage2-changes.spec.ts`: rewritten (real `__TAURI_INTERNALS__` mock, invoke-call assertions) — 16/16 pass, debt closed in Stage 4.
- Prior Stage 3 deferred nits remain recorded in `.agent/reviews/m2-stage-3-code-review.md`; no new Stage 3 scope was changed.
- M2 Stage 4's manual E2E and native memory checks remain unverified by user approval. Do not alter the v0.2.0 release; this follow-up is tracked separately. Do not push.
- Stage 5 validation: `./init.sh` passed (37 Vitest files / 297 tests; Rust 128 passed / 3 ignored; Clippy/typecheck clean); `pnpm test:e2e` passed 76/76; `cargo fmt --check` and `git diff --check` clean. See `.agent/reviews/m2-stage-5-code-review.md`, `.agent/reviews/m2-stage-5-security-review.md`, and `.agent/reviews/m2-stage-5-e2e.md`.
- Manual M2-S5-01 and Checkpoint M2.5 were approved by the user; Stage 5 commit and fast-forward are authorized. Do not push.
- M3 plan: `docs/superpowers/plans/2026-11-08-m3-terminal-agents.md`; Stage 1 Task 03 is active. `./init.sh` passed before implementation (37 Vitest files / 297 tests; Rust 128 passed / 3 ignored; typecheck and Clippy clean).
- Task 03 implementation is complete and verified: dock store + UI, 4 modes, tabs, split/swap, persistence/restore, all Stage 1 entry points. `./init.sh` green (41 Vitest files / 316 tests; Rust 138 passed / 3 ignored); `pnpm test:e2e` 76/76. Formal Task 03 spec review still pending; no commit or push.
- Task 01 is complete: PTY manager/IPC, generated bindings, and tests are implemented. The focused security review found that killing only the shell could leave descendants alive; cleanup now kills the Unix process group or Windows Job Object. Regression tests verify descendant cleanup and reader termination.
- `./init.sh` after Task 01: `=== Verification Complete ===`; typecheck clean; Test Files 38 passed (38), Tests 299 passed (299); Rust 135 passed, 0 failed, 3 ignored; Clippy clean. `cargo fmt --check` and `git diff --check` clean.
- Task 02 is complete and spec-reviewed PASS. `./init.sh`: `=== Verification Complete ===`; 39 Vitest files / 305 tests; Rust 138 passed / 3 ignored; TypeScript and Clippy clean. See `.agent/reviews/m3-task-02-cli-pane-spec.md`.
- Task 02 PTY replay retains bounded output for reattachment. Abnormally ended sessions remain until the dock owner closes them; cleanly exited shells now auto-close their tab. Task 03 must close sessions when tabs are explicitly closed and preserve sessions when the dock is merely hidden.
- Windows cross-build remains unverified on this macOS host: `libz-sys` requires a Windows C toolchain. The Windows Job Object path is present and must receive platform CI coverage.
