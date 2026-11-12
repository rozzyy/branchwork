# Repository agent instructions

Read `CLAUDE.md` for the project workflow and `AGENT.md` for mandatory performance, Big O complexity, security, and scalability rules before generating or changing code.

## Startup Workflow — Before writing code

1. Read `session-handoff.md` and `feature_list.json` for current state and scope.
2. Follow the active task and dependency order documented in `CLAUDE.md`.
3. Run `./init.sh` when the task workflow requires a baseline; report failures rather than claiming a clean baseline.

## One feature at a time

Work on one active feature and its required fixes. Keep changes inside the task's scope; record unrelated findings for follow-up instead of expanding the task.

## Stay in scope

Preserve the project's Git workflow, review checkpoints, security boundaries, and user authorization rules in `CLAUDE.md`. Do not commit or push unless the user explicitly asks.

## Verification Commands

- `./init.sh` — project verification entrypoint.
- `npm run typecheck` — TypeScript static check.
- `npm test` — Vitest suite, when the task calls for tests.
- `cargo check --manifest-path src-tauri/Cargo.toml` — Rust compile check.
- `cargo test --manifest-path src-tauri/Cargo.toml` — Rust tests, when the task calls for tests.

Run checks that fit the change and the user's instructions. State exactly which commands ran and their results; never imply an unrun test passed.

## Definition of Done

Code is done only when it meets the task's acceptance criteria, relevant verification has passed or remaining gaps are stated, security and performance implications are reviewed, and required project state files are updated.

## End of Session

Update `progress.md`, `feature_list.json`, and `session-handoff.md` with completed work, evidence, blockers, and the next action so another session can restart cleanly.
