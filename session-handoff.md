# Session Handoff

- **Last Updated:** 2026-11-08
- **Current Objective:** M2 execution (Changes, files, editor)

- **Milestone / stage:** M1 complete; M2 Stage 1 and Stage 2 committed. **M2 Stage 3 (Tasks 09–11) complete, all reviews passed, uncommitted.**
- **Branch:** `m2-stage-3` (from `main` @ `66454d5`).
- **Active task:** 🛑 **Checkpoint M2.3** — waiting for the user's manual test.

## Recommended Next Step

1. User runs `docs/testing/m2-manual-e2e.md` → Stage 3 (M2-S3-01…M2-S3-11), plus native cold start (<1.5 s) and real-IPC editor paint for a 5 000-line file.
2. On go-ahead and an explicit commit order: one Stage 3 commit on `m2-stage-3` (exclude `.claude/`, `src-tauri/.claude/`, `node-compile-cache/`), then `git switch main && git merge --ff-only m2-stage-3 && git branch -d m2-stage-3`. Never push.
3. Then Stage 4: branch `m2-stage-4` from `main`, start `m2-task-12` (Blame and file history IPC).

## M2 structure

- Stage 1 — Status read model + shared diff renderer (Tasks 01–04) → Checkpoint M2.1 ✅ committed
- Stage 2 — Changes screen: staging, commit variants, stashes (Tasks 05–08) → Checkpoint M2.2 ✅ committed
- Stage 3 — Files & editor: fs IPC, File manager UI, CodeMirror (Tasks 09–11) → Checkpoint M2.3 🛑 (reviews passed)
- Stage 4 — Blame, history, oplog undo, polish (Tasks 12–15) → Checkpoint M2.4 (M2 done)

## Decisions this session (user)

- `trash` crate 5.3.0 accepted (plan Open Question 2 resolved).
- File tree loads lazily now (I7).
- Sidebar grouped Workspace / Code / AI / GitHub; Inbox stays in Workspace (number keys 1–9 keep the spec order).
- Diff long lines scroll horizontally per hunk (no wrap: the virtualizer needs fixed 20px rows).

## Blockers / notes

- Reviews: `.agent/reviews/m2-stage-3-code-review.md` (APPROVE WITH NITS), `m2-stage-3-security-review.md` (PASS), `m2-stage-3-e2e.md` (PASS). Minors deferred there, notably: ⌘P full walk per `git:changed` while a query is active; app edits enter undo history; split-pane sync resets the other pane's cursor; diff width estimate ignores wide (CJK/emoji) chars; `open`/`osascript` via PATH; oplog `previousBytes` uncapped (Task 14); `devCsp: null`.
- `e2e/m2-stage2-changes.spec.ts`: 17 tests pass vacuously (dead `__bwTest` mock). Rewrite pending user OK.
- Playwright once flaked with many failures while another agent shared the :1420 dev server; reruns 74/74.
- `Undo Last Commit` and in-app undo for Delete-to-Trash arrive with the oplog in Task 14.
