# M8 — Profile switch keeps the conversation: Implementation Plan

> **For agentic workers:** Execute task-by-task (user chose direct/native execution). Steps use checkbox (`- [ ]`) syntax. No per-task commits (CLAUDE.md): one stage commit after the 🛑 checkpoint.

**Goal:** Switching a Claude Code or Codex pane to another profile resumes that pane's exact conversation under the new account.

**Architecture:** Each `AgentSession` carries a `conversationId`. Claude gets it from `--session-id` at launch and from hook reports (`SessionStart`/`Stop`/`Notification`); Codex gets it from a Rust rollout discovery. On switch, a Rust command copies that one transcript into the target profile dir, then the CLI is relaunched with resume-by-ID, inside a settle window with rollback to the source profile.

**Tech Stack:** Tauri 2 (Rust, tauri-specta bindings), React/TypeScript, Zustand, Vitest, cargo test.

**Spec:** `docs/superpowers/specs/2026-11-14-agent-profile-switch-session-design.md`

## Global Constraints

- CLIs in scope: `claude`, `codex`. All others keep today's launch/resume lines.
- Files touched only inside `~/.branchwork/profiles/<cli>-<slug>/`; never the user's own `~/.claude` / `~/.codex`.
- Conversation IDs accepted only as UUID shape `8-4-4-4-12` hex (36 chars); never used as a path segment without that check.
- Transcripts are copied, never moved; copy is temp-file + rename in the destination dir.
- Settle window 5000 ms; Codex discovery mtime slack 5000 ms.
- UI strings only via `src/i18n/en.ts`. Never log transcript contents.
- Regenerate bindings with `cargo test --lib -- --ignored regenerate_bindings_file` (from `src-tauri/`).

## Review Focus

1. A hook payload with a non-UUID or oversized `session_id` → ignored; status event still delivered (Task 2 test `drops_bad_conversation_id_keeps_event`).
2. Two Codex panes in the same worktree + profile with no cached IDs → switch refused, both keep running (Task 4 test "refuses an ambiguous codex switch").
3. Claude pane switched before any message (no transcript) → fresh launch on target with the same `--session-id`, no error (Task 4 test).
4. Target CLI exits non-zero right after resume → pane relaunched on source profile with resume-by-ID, profile unchanged (Task 4 test).
5. Persisted records from before M8 (no `conversationId`) still restore with today's resume line (Task 3 test).

---

### Task 1 (M8-01): Transcript copy + Codex discovery IPC ✅

**Files:**
- Create: `src-tauri/src/conversation.rs`, `src/ipc/conversations.ts`
- Modify: `src-tauri/src/lib.rs` (mod, 2 commands, specta registry), `src-tauri/src/cli.rs` (expose `profile_dir_for(cli_id, slug) -> Result<PathBuf>` without creating), `src/ipc/bindings.ts` (regenerated)

**Interfaces — Produces:**
- Rust: `conversation::copy(cli_id: &str, from_slug: &str, to_slug: &str, conversation_id: &str) -> Result<bool, AppError>` — `true` copied; `false` only for Claude when the source has no transcript yet; Codex missing → `not_found`.
- Rust: `conversation::find_codex(slug: &str, worktree_path: &str, since_ms: u64, exclude: &[String]) -> Result<Option<String>, AppError>` — exactly one candidate after exclusion → `Some(id)`.
- Commands (async): `agent_copy_conversation(cli_id, from_slug, to_slug, conversation_id) -> bool`, `agent_find_codex_conversation(slug, worktree_path, since_ms: u64, exclude: Vec<String>) -> Option<String>`.
- TS: `copyConversation(cliId: "claude" | "codex", fromSlug: string, toSlug: string, conversationId: string): Promise<boolean>`; `findCodexConversation(slug: string, worktreePath: string, sinceMs: number, exclude: string[]): Promise<string | null>` (both reject outside Tauri like `src/ipc/handover.ts`).

Rules: slugs validated with `cli::validate_profile_ref`; `cli_id` ∈ {claude, codex}; both profile dirs derived from slugs (no raw dirs over IPC — stricter than spec §6.4, my call). Claude source = exactly one `projects/*/<id>.jsonl` (regular file, not symlink); destination same relative path. Codex source = exactly one `sessions/*/*/*/rollout-*-<id>.jsonl`. Codex discovery: files with mtime ≥ `since_ms - 5000`, first line read capped at 1 MiB, JSON `type == "session_meta"`, `payload.cwd` equal to `worktree_path` (exact, or equal after canonicalizing both), `payload.id` valid UUID and not in `exclude`. Pure helpers take a base dir so tests use temp dirs.

- [x] Step 1: Write Rust tests in `conversation.rs`: `copies_claude_transcript_to_same_relative_path`, `claude_without_transcript_returns_false`, `copies_codex_rollout_and_replaces_existing`, `codex_missing_rollout_is_not_found`, `rejects_bad_ids_and_slugs` (`"../x"`, `"abc"`, slug `"A B"`), `rejects_symlinked_transcript`, `finds_single_codex_rollout_for_cwd_since`, `codex_find_excludes_claimed_and_refuses_ambiguity`, `codex_find_ignores_old_and_other_cwd`.
- [x] Step 2: Run `cargo test --lib conversation` → fail (module missing).
- [x] Step 3: Implement module + commands + TS wrapper; regenerate bindings.
- [x] Step 4: `cargo test --lib conversation` and `cargo test --lib export_bindings` → pass.
- [x] Step 5: Commit — _(skipped: no-commit rule)_

### Task 2 (M8-02): Hook status carries the conversation ID ✅

**Files:**
- Modify: `src-tauri/src/notify.rs`, `src-tauri/src/bin/branchwork-notify.rs`, `src-tauri/src/lib.rs` (`notify_status`), `src/ipc/notify.ts`, `src/ipc/bindings.ts`

**Interfaces — Produces:**
- `AgentStatusPayload { session_id, event, conversation_id: Option<String> }` with `#[serde(rename_all = "camelCase")]` — **fixes existing bug**: the event was emitted as `session_id` while the frontend reads `sessionId`, so hook status never matched a pane.
- `validate_notify_event(session, event, conversation: Option<&str>)`; events: `waiting`, `done`, new `start` (`NOTIFY_EVENT_START`). Invalid conversation → dropped to `None`, event kept.
- Socket line: `<session> <event>[ <conversation-id>]`.
- `ensure_claude_hooks` also adds `SessionStart` → `start`.
- `branchwork-notify`: when stdin is not a terminal, read ≤ 64 KiB, parse JSON, take `session_id` if UUID-shaped, append to the line. Any failure → send the line without it.
- TS: `AgentStatusEvent { sessionId: string; event: "waiting" | "done" | "start"; conversationId?: string | null }`.

- [x] Step 1: Rust tests: `payload_serializes_camel_case` (regression for the bug), `accepts_start_event_with_conversation`, `drops_bad_conversation_id_keeps_event`, `claude_hooks_include_session_start` (extend existing hook test), `parses_three_part_line` (pure line parser extracted from `handle_client`).
- [x] Step 2: Run → fail.
- [x] Step 3: Implement; regenerate bindings.
- [x] Step 4: `cargo test --lib notify` + bindings test → pass.
- [x] Step 5: Commit — _(skipped: no-commit rule)_

### Task 3 (M8-03): Conversation ID on sessions — launch, hooks, persistence, restore/undo ✅

**Files:**
- Modify: `src/agents/registry.ts`, `src/agents/sessions.ts`, `src/agents/registry.test.ts`, `src/agents/sessions.test.ts`

**Interfaces — Consumes:** Task 1 `findCodexConversation`; Task 2 `AgentStatusEvent`.
**Produces:**
- `CliDef.launchWithId: ((id: string) => string[]) | null`, `CliDef.resumeById: ((id: string) => string[]) | null`; same on `ResolvedCli` (null when launch/resume is overridden). Claude: `["claude","--session-id",id]` / `["claude","--resume",id]`. Codex: `null` / `["codex","resume",id]`. Others: `null`/`null`.
- `AgentSession.conversationId: string | null`; persisted (optional on load; non-UUID values dropped).
- `notifySessionEvent(sessionId, event, conversationId?)`: a valid `conversationId` updates the session (and saves) for every event; `start` changes nothing else.
- Module-level `launchedAt: Map<recordId, number>` set whenever a PTY is spawned for a record (start, switch, undo, rollback).
- Restore/undo line when `conversationId` is known: Claude `claude --resume <id> || claude --session-id <id>`; Codex `codex resume <id> || codex`. Unknown → today's `resumeLine`. Undo for Codex refreshes the ID via `findCodexConversation(slug, worktree, launchedAt, otherIds)` first, falling back to the cached one.
- New Claude launch (not resume) uses `launchWithId(crypto.randomUUID())` and stores the ID before spawn.

- [x] Step 1: Tests: registry `exposes id-aware launch/resume for claude and codex only`; sessions `launches new claude sessions with a pinned --session-id`, `hook start event updates conversationId`, `persists conversationId and restores claude by id with fresh fallback`, `restores pre-M8 records with the legacy resume line`, `restores codex by id when known`.
- [x] Step 2: Run `pnpm vitest run src/agents` → fail.
- [x] Step 3: Implement.
- [x] Step 4: `pnpm vitest run src/agents` → pass.
- [x] Step 5: Commit — _(skipped: no-commit rule)_

### Task 4 (M8-04): Switch flow — copy, resume by ID, settle window, rollback ✅

**Files:**
- Modify: `src/agents/sessions.ts` (`switchProfile`, exit handler), `src/agents/sessions.test.ts`, `src/i18n/en.ts`

**Interfaces — Consumes:** Task 1 `copyConversation`, `findCodexConversation`; Task 3 `conversationId`, `launchedAt`, registry fields.
**Produces:** `export const switchTiming = { settleMs: 5000 }` (tests set `0`). New strings `agents.switchNoConversation` ("Couldn't find this pane's {name} conversation, so the account was not switched."), `agents.switchRolledBack` ("Switching to {to} failed, so the pane went back to {from}: {message}").

Flow for claude/codex (others keep today's flow verbatim):
1. Existing checks + `prepareAgentShell(target)` unchanged.
2. ID: Claude → `session.conversationId`; Codex → `findCodexConversation(source.slug, worktree, launchedAt ?? 0, otherCodexIds)` falling back to the cached ID only when discovery returns null and the cached ID exists. None → toast `switchNoConversation`, return null, nothing stopped.
3. Stop/close the old PTY (as today).
4. `copied = await copyConversation(...)`. Command: copied → `resumeById(id)` joined (no fallback); Claude not copied → `launchWithId(id)`. Wrapped with `withSaverLine`.
5. Spawn; then wait `settleMs` while watching that PTY: an exit with non-zero code or a signal inside the window = failure. Keep `profile` = source until settled.
6. Success → update `profile`, `conversationId`, status, save (as today).
7. Failure at 4/5 → `prepareAgentShell(source)` + spawn with source resume-by-ID line (Claude with `|| claude --session-id <id>` fallback), toast `switchRolledBack`, return null.

- [x] Step 1: Tests (update existing codex switch tests to the by-ID command): `copies the codex rollout and resumes it by id`, `copies the claude transcript and resumes it by id`, `launches claude fresh with the same id when no transcript exists`, `refuses an ambiguous codex switch without stopping`, `rolls back to the source profile when the target exits during the settle window`, `rolls back when the copy fails`, `limit auto-switch uses the same by-id flow`.
- [x] Step 2: Run → fail.
- [x] Step 3: Implement.
- [x] Step 4: `pnpm vitest run src/agents` → pass; `./init.sh` green.
- [x] Step 5: Commit — _(skipped: no-commit rule)_

## Stage end

- code-reviewer + security-reviewer (IPC + filesystem touched) → `.agent/reviews/`.
- Manual E2E: `docs/testing/m8-manual-e2e.md` from spec §10.
- 🛑 Checkpoint M8.1.
