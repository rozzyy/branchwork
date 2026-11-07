# Branchwork: Agent Harness

Branchwork is a macOS Git client built with Tauri 2 (Rust) and React/TypeScript. It covers multi-worktree work, CLI agents, GitHub, and split view.

## Startup Workflow (every session, before writing code)

1. Read `session-handoff.md`. It holds the current stage, the active task, and the next action.
2. Read `feature_list.json`. One feature at a time: work on **exactly one** task: the first one whose status is not `done` and whose dependencies are all `done`.
3. Run `./init.sh` to establish the baseline. If it fails, fix the baseline before starting new work.

## Sources of truth

- Spec: `docs/superpowers/specs/2026-11-06-branchwork-design.md`
- Active plan: `docs/superpowers/plans/2026-11-07-m2-changes-files-editor.md`
- Task files: `.agent/tasks/m2-task-NN.md` (acceptance criteria, scope, task text)
- Visual reference: `docs/design/prototype.html`

## Workflow (per stage)

```
for each task in the stage:
  task-executor (implements .agent/tasks/<task>.md)
  → spec-reviewer (PASS required; on FAIL the same executor fixes, then re-review)
after the last task of the stage:
  code-reviewer + security-reviewer (if security surfaces were touched) + e2e-testing  → reports in .agent/reviews/
  write/extend the manual E2E test spec: docs/testing/m0-manual-e2e.md
  🛑 STOP at the stage's MANUAL TEST CHECKPOINT and wait for the user
  on go-ahead: commit the stage (one commit), then start the next stage
```

## Hard rules

- **No per-task commits, never `git push`.** Skip the plan's per-task "Commit" steps. After the user approves a stage checkpoint, make **one commit per stage** (the coordinator does this, not executors).
- No over-engineering: build only what the task text specifies.
- No over-testing: write only the tests in the task text. Add a regression test only for a bug that was actually found.
- All UI strings are English and come from `src/i18n/en.ts`.
- Stop at every 🛑 checkpoint. Never start the next stage without the user's go-ahead.

## Testing levels (keep each one proportional)

| Level | Where |
|---|---|
| Unit | Vitest tests next to the code; `cargo test` for Rust |
| Integration | Store ↔ IPC ↔ SQLite (Stage 2), stage store ↔ components |
| Regression | `./init.sh` must stay green after every task |
| Performance | Checked once per stage against spec §9 budgets (e.g. cold start < 1.5 s) and noted in the stage review |
| Security | `security-reviewer` for tasks that touch CSP, capabilities, IPC, or secrets |
| Manual E2E | `docs/testing/m0-manual-e2e.md`, written at the end of each stage |

## Definition of Done (per task)

- The task's acceptance criteria are met and spec-reviewer reports PASS.
- `./init.sh` is green, and the exact output is quoted as evidence.
- `feature_list.json` (status + evidence) and `progress.md` are updated.
- In the plan file, the task's steps are checked (`- [x]`), its heading gets ✅, and the Commit step is marked `_(skipped: no-commit rule)_`.

## End of Session

Update `progress.md`, `feature_list.json`, and `session-handoff.md` (stage, active task, blockers, next action).
