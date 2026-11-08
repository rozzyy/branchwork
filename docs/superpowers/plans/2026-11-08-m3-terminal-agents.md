# M3 Plan — Terminal and agents

M3 adds local PTY-backed terminals and CLI-native agent sessions, following design spec §§6.5–6.6. Work proceeds one task at a time on stage branches, with a manual checkpoint after each stage. M3 depends on the completed M1/M2 repository, worktree, Graph, Changes, and Files foundations.

## Stage 1 — PTY foundation and terminal dock

| Task | Scope | Depends on |
|---|---|---|
| ✅ M3-01 PTY manager and IPC | Spawn the user's login shell in a registered worktree; typed spawn/write/resize/close commands; scoped output/exit events; session cleanup and Rust/IPC tests. | M2 Task 17 |
| ✅ M3-02 Shared terminal pane | Add xterm.js `CliPane`, consume PTY events, send input/resize, and handle mount/unmount and process exit. | M3-01 |
| ✅ M3-03 Terminal dock | Dock modes, tabs, side-by-side sessions, persistence, keyboard access, and entry points from supported screens. | M3-02 |

Manual checkpoint: validate shell I/O, worktree binding, resize, tab close, and dock persistence. Target: 8 concurrent PTYs without dropped frames.

## Stage 2 — Full-screen Terminal workspace

| Task | Scope | Depends on |
|---|---|---|
| M3-04 Pane layout reducer | Pure recursive layout tree with split, close, resize, focus, and maximize actions plus unit tests. | M3-02 |
| M3-05 Terminal screen | Tabs and pane UI, keyboard focus, worktree/cwd selection, pane actions, broadcast input, persistence, and dock moves. | M3-03, M3-04 |

Manual checkpoint: validate nested splits, focus/resize, tab restore, worktree switching, broadcast, and dock moves.

## Stage 3 — Agent registry and session lifecycle

| Task | Scope | Depends on |
|---|---|---|
| M3-06 CLI registry and profile environment | CLI metadata, executable resolution, launch/resume commands, and isolated profile environment construction. | M3-01 |
| M3-07 Profile/account management | Add, login, logout, profile selection, and secret handling without storing credentials in SQLite or logs. | M3-06 |
| M3-08 New Agent and Sessions | Agent creation flow, worktree/profile selection, session grid, and pane layout. | M3-02, M3-07 |
| M3-09 Session status and notification | Hook/notification integration, output heuristics, `branchwork-notify`, and status UI. | M3-08 |
| M3-10 Agent lifecycle and profile switching | Confirmed stop, resume/Undo, profile switch, and usage-limit handoff behavior. | M3-09 |

Manual checkpoint: use mock CLIs to verify launch, status transitions, profile isolation, switch/resume, close, and Undo. Target: 4 agents across 2 repositories within the 400 MB memory budget.

## Stage 4 — Agent workflows

| Task | Scope | Depends on |
|---|---|---|
| M3-11 Handover | Preview and launch a handover to another CLI/profile or a new worktree; keep handover data excluded from Git. | M3-10 |
| M3-12 Race | Launch selected CLIs in separate race worktrees, compare outcomes, and safely keep or remove worktrees. | M3-11 |

Manual checkpoint: exercise handover and race with mock CLIs, verify worktree cleanup, then complete the M3 review gate.

## Cross-stage constraints

- Keep all PTY and agent process control behind typed Tauri commands; do not grant the WebView generic shell access.
- Validate registered worktrees and bound input sizes, terminal dimensions, process/session counts, and event routing.
- Repository content must not execute automatically. Only launch user-selected shell/CLI programs.
- Store credentials only in the system Keychain; isolate profile directories and redact secrets from logs.
- Each stage runs `./init.sh`, targeted and full Playwright tests as applicable, code review, and focused security review for IPC/process/secret surfaces. Record manual checks and stop at the stage checkpoint.
- Do not bump the version until M3 is complete. Do not commit or push until the user approves a checkpoint; create one stage commit and fast-forward into `main` only after explicit commit authorization.
