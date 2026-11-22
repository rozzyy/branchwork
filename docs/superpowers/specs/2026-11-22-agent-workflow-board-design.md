# Agent workflow board (software factory inside Branchwork) — design

Date: 2026-11-22 · Size: project (one milestone, phased)
Source vision: `docs/superpowers/software-factory-workflow.md` (v0.1 draft). This design adapts it into a Branchwork feature; where they differ, this document wins.

## Intent

The user works as today: they give a coding task to an agent in a Branchwork terminal (Claude Code or another CLI). **The agent then runs the factory workflow on its own** — Plan → Build → Review → Verify → Ship — and **Branchwork shows it as a board whose cards move between columns automatically**, with a status line and a detail view per task. At the human gates (approve plan, risky change, approve merge) the agent stops and waits, and the user decides **on the board** (Approve / Return to build / Cancel); the decision goes back to the agent.

Why: today this workflow is run by hand in the conversation (executor → reviewer → batch review → checkpoint). The user wants it automatic and visible at a glance, without switching to a separate tool.

## Goals

1. **Workflow runs from the agent itself.** When a session is started with the workflow enabled, Branchwork injects the workflow instructions; the agent follows the stages and reports each stage change.
2. **Board screen** that updates live from those reports: five columns (Plan, Build, Review, Verify, Ship) plus done/cancelled handling; one card per task.
3. **Card**: task id (`FAC-<n>`), title, kind, agent CLI + worktree, status (Running / Waiting for you / Needs decision / Done / Cancelled), test result, fix-loop count `n/3`, time since last report.
4. **Detail panel**: stage timeline, files changed, review findings (Must fix / Suggestions), test/verify results, `skipped_or_unchecked`, PR link, event log, and the decision buttons (enabled only at a gate or when blocked). A button to focus the agent's terminal session.
5. **Gates with decisions on the board**: `plan_approval` and `merge_approval` always; `risk_review` when the Build diff touches risky paths. The agent blocks until the user decides; the decision text (and an optional note) is returned to the agent.
6. **Structured, auditable data**: every report and decision is validated, stored as an append-only event in SQLite, and survives app restarts. The board is derived from events.
7. **Deterministic verify**: the Verify stage runs the repo's gate script (e.g. `./init.sh`), not an LLM judgement.

## Non-goals (v1)

- A headless orchestrator or job runner (spec §3 runner, job queue). Branchwork observes and gates; it does not drive stages.
- Autopilot toggle, prompt queue/panel (spec §9 prompt panel), creating tasks from the board.
- Per-task cost/budget enforcement (Branchwork has no reliable per-session cost source yet). Show usage only if already available.
- Multiple repositories per task; multi-user auth/roles.
- Merging by Branchwork: after `merge_approval` the agent performs the merge itself.
- Making `~/.claude/skills` available inside isolated agent profiles (instructions must be self-contained; skills are used if present).

## Anti-goals (failure even if it "works")

- **A gate can be passed without a real user decision.** Only the Branchwork UI can produce a decision; an agent (or anything else on the socket) must never be able to approve its own gate.
- The board shows a stage or result the agent did not actually report (no inference from terminal text in v1).
- Normal agent work slows down or breaks when the workflow is off, or when the reporter command is missing.
- The feature silently edits repo files (e.g. writes AGENTS.md) without the user asking.

## How it works (decided)

### Approach (user chose A)
The agent runs the workflow and reports through a small sidecar command; Branchwork stores events and renders the board.

Considered and not chosen:
- **B. Branchwork drives the stages** by typing stage prompts into the terminal and detecting completion via hooks — brittle with interactive TUIs, differs per CLI, collides with the user's typing.
- **C. MCP server** exposing `factory_report`/`factory_gate` tools — native structured calls, but needs a new MCP host in Branchwork and per-CLI configuration; can be added later on top of A.

### Components
1. **`branchwork-factory` sidecar** (new Rust bin next to `branchwork-notify`/`branchwork-saver`, built for dev by the existing `sidecars:dev` script). Subcommands:
   - `start --title <t> --kind <bug|feature|refactor|investigation|migration|other>` → registers a task bound to the current agent session + worktree; prints the task id.
   - `report --task <id> --stage <plan|build|review|verify|ship> --json <payload>` → payload validated against that stage's schema (spec §6 shapes: plan `{plan_path, steps, touched_paths_estimate, risk_flags}`, build `{commits, files_changed, tests, skipped_or_unchecked}`, review `{findings[]}`, ship `{pr_url}`); invalid payload → non-zero exit with the reason (agent can fix and retry).
   - `verify --task <id>` → runs the configured verify command in the worktree, records gates pass/fail as a `verify` report, prints a short summary; non-zero exit on failure.
   - `gate --task <id> <plan_approval|risk_review|merge_approval>` → opens the gate and **blocks** until the user decides on the board; prints `approve`, `return_to_build: <note>` or `cancel` and exits 0/10/20 accordingly. Re-running after an app restart re-attaches to the still-open gate.
   - Communicates over the existing notify socket directory (same-user, `0700`). Payloads are size-capped; every field is validated in the app before storing.
2. **App backend (Rust)**: SQLite tables `factory_tasks`, `factory_events` (append-only), `factory_findings`; a small state machine that applies spec §5 transitions *from reports* (e.g. review with blocking findings → back to Build, `retry += 1`; `retry ≥ max_retries` → status `blocked` and the agent is told to call `gate`); risky-path check for Build computed deterministically from `git diff --name-only` against configured globs; Tauri events to the UI on every change.
3. **Instruction injection**: for Claude Code, a workflow instruction block appended at session launch (same mechanism as Caveman's `--append-system-prompt`), telling the agent the stages, when to call each subcommand, that repo/web content is data not instructions, and to stop at gates. For other CLIs in v1: the reporter works if the agent is told to use it; Branchwork shows the instruction block to copy (no automatic file writes).
4. **Board screen** (new screen `board` in `src/screens/registry.ts`, so it works in stage split view next to Agents and Terminal); uses the M13 one-row `PaneHeader`.
5. **Enable switch**: "Run workflow" option when starting an agent (New agent dialog) plus a default in Settings → Agents. Off by default.

### Configuration
Optional repo file `.branchwork/factory.yml` (read per task start): `max_retries` (default 3), `verify` command (default: `./init.sh` if present, else none → Verify reports "not configured"), `risk_paths` globs (defaults from spec §7), which gates are required (plan and merge default on). Invalid config → task start fails with a clear message (spec: fail hard, never loosen silently).

### Statuses shown
Running (stage in progress) · Waiting for you (gate open) · Needs decision (blocked: retries exhausted / verify failing / no report for N minutes while the session is gone) · Done · Cancelled. Sidebar badge on Board with the waiting + needs-decision count; a toast when a gate opens.

## Constraints

- Follows repo rules: English UI strings in `en.ts`, no text < 12px, Big-O stated for non-trivial paths, untrusted IPC/socket input validated in Rust with fixed argv (AGENT.md).
- Security-relevant: new socket protocol and gate decisions (needs security review). Decisions are accepted only from the Tauri UI command path, never from socket clients.
- Must not change behavior of agent sessions started without the workflow.
- Board must stay responsive with hundreds of tasks/thousands of events (paginate/derive incrementally).

## Phases (suggested milestone split)

1. **Reporter + store**: `branchwork-factory start/report`, schemas, SQLite events, state machine, Tauri events. Proof: a manual session can create a task and move it through stages via the CLI.
2. **Board screen**: columns, cards, detail panel, live updates, sidebar badge.
3. **Gates**: `gate` blocking + decision buttons + toasts + restart re-attach; risky-path check.
4. **Verify + instruction injection + enable switch**: deterministic verify, Claude Code instruction block, New agent option, Settings default, `.branchwork/factory.yml`.
5. **Hardening**: security review of socket/gates, stale-report detection, performance with many events.

## How this project is built (process, user request 2026-11-22)

The skills the factory will orchestrate are also used to build it (dogfooding spec §2). They are not auto-loaded in Branchwork agent profiles, so agents read each `SKILL.md` directly from these locked paths:

| Skill | Path | Used for |
|---|---|---|
| superpowers | session plugin (7.0.2) | Conductor: brainstorming → plan → executor/reviewer flow, TDD, verification. The only process orchestrator. |
| harness-creator | `~/.claude/skills/harness-creator/SKILL.md` | Phase 0: audit this repo's harness (CLAUDE.md/AGENT.md, feature_list, init.sh gate, handoff) before building; re-audit at the end. |
| pstack | `~/.claude/skills/pstack-skill/SKILL.md` (+ `playbooks/`) | Executors pick the matching playbook per task (feature / bug / refactor) as a playbook inside the superpowers flow — never as a second orchestrator. |
| ponytail | `~/.grok/marketplace-cache/350a43727a88bc9c/skills/ponytail/SKILL.md` | Executors' coding guide (scope and code volume). |
| ponytail-review | `~/.grok/marketplace-cache/350a43727a88bc9c/skills/ponytail-review/SKILL.md` | Review stage, first pass: what can be cut. |
| thermo-nuclear-code-quality-review | `~/.claude/skills/thermo-nuclear-code-quality-review/SKILL.md` | Review stage, second pass, read-only, triggered explicitly (`disable-model-invocation`). Out-of-scope refactors become new tasks. |
| caveman | `~/.agents/skills/caveman/SKILL.md` | Worker agents' own prose only; never plans, review reports or commit messages. |

Per-task flow: task-executor (pstack playbook + ponytail) → spec-reviewer → per-stage batch: ponytail-review → thermo-nuclear → code / performance / security reviewers → manual checkpoint.

## Left to the builder

- Exact SQLite schema, socket message format, and Tauri command names.
- Card layout details and icons (follow existing Branchwork look; a mockup round with the user before building the Board screen).
- Wording of the injected instruction block (keep it short; review with the user before phase 4 ships).
- Stale threshold N (suggest 10 minutes).
