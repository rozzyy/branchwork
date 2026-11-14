# Profile switch keeps the active agent conversation — Design

- **Date:** 2026-11-14
- **Milestone:** M8 (replaces AI assists §6.9, cancelled; the handover-optimization idea was also dropped by the user)
- **Extends:** spec §6.6.1 (CLI registry), §6.6.4 (Accounts / profiles)
- **CLIs in scope:** Claude Code and Codex. OpenCode, Copilot, Gemini, Muse and Custom keep today's behavior.

## 1. Intent

When the user switches an agent pane to another account/profile (profile chip menu, `/account`, or the usage-limit Switch / auto-switch), the **same conversation continues** under the new account, the way Orca does it. Today it silently starts a new conversation.

Why: users run several accounts per CLI (e.g. `claude-personal`, `codex-masmastobat`, `codex-ulahduri`, …) and switch mostly because one account hit its usage limit. Losing the conversation at that moment defeats the point of switching.

## 2. Current behavior and root cause

- `switchProfile` (`src/agents/sessions.ts:820`) stops the PTY and relaunches in the same worktree with the new profile env and the registry `resumeLine`: `claude --continue || claude`, `codex resume --last || codex` (`src/agents/registry.ts`).
- Each profile is an isolated directory, and each CLI stores conversation history **inside it**:
  - Claude Code: `<CLAUDE_CONFIG_DIR>/projects/<cwd-slug>/<session-uuid>.jsonl`
  - Codex: `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl`; the first line is `session_meta` with `payload.id` and `payload.cwd`.
- The target profile has no copy of the conversation, so `--continue` / `resume --last` finds nothing and the `|| claude` fallback launches a fresh session with no error.
- Second defect: `--continue` / `--last` pick the *latest* conversation in that profile, not this pane's, so two panes in one worktree can cross-resume. Restore-on-app-start (`resume: true`) and close-Undo use the same resume line and share this defect.

## 3. Goals, non-goals, anti-goals

**Goals**
- Switching profile on a Claude Code or Codex pane resumes the pane's *exact* conversation under the target profile.
- The user is told when that is impossible; it never silently becomes a new conversation.

**Non-goals**
- Merging or syncing all history between profiles (rejected option 1: history stays per account).
- Moving transcripts: the source profile keeps its copy.
- OpenCode, Copilot, Gemini, Muse, Custom.
- Handover between different CLIs (§6.6.5 unchanged).

**Anti-goals (a failure even if it "works")**
- Resuming the wrong conversation (another pane's, or an older one).
- Leaving the user with a stopped pane and no conversation after a failed switch.
- Touching anything outside `~/.branchwork/profiles/` or the user's own `~/.claude` / `~/.codex`.

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | Branchwork knows each pane's conversation ID; on switch it copies that one transcript file into the target profile and resumes by ID. | Exact and deterministic; needs an ID per pane and a small copy IPC. |
| B | Find the ID only at switch time: newest transcript whose cwd matches. | Less code, but keeps the "two panes in one worktree" cross-resume bug. |
| C | Learn the ID from CLI hooks. | Only Claude has hooks in Branchwork; Codex still needs A, so two mechanisms for no gain. |

User picked A, Claude Code + Codex first. Hooks from C are still used for one narrow job — keeping a Claude pane's ID current after `/clear` or `/resume` (§6.1) — not as the primary ID source.

## 5. Spike results (2026-11-14)

- **Codex — passed.** Copied one rollout from `codex-masmastobat` to the same relative path under a scratch `CODEX_HOME` holding another account's `auth.json` (`codex-ulahduri`), then ran `codex exec resume <id> "<question>"`. Codex found the session by ID (no `session_index.jsonl` or sqlite changes needed) and answered from the conversation's content. Codex did not object to `creator_account_id` belonging to a different account.
- **Claude Code — passed.** In a scratch cwd, `claude -p --session-id <uuid>` on `claude-personal` stored a code word. The transcript `projects/<cwd-slug>/<uuid>.jsonl` was copied to the same relative path under `claude-devhero3` (a different logged-in account), and `claude -p --resume <uuid>` there answered with the code word. Resume kept the same ID and appended to the copied file. Spike files were removed afterwards.

## 6. Design

### 6.1 Conversation ID per pane

Add `conversationId: string | null` to `AgentSession` and to the persisted session record, so restore keeps it.

- **Claude Code:** Branchwork generates a UUID v4 when it launches a *new* conversation and launches `claude --session-id <uuid>`. The ID is known immediately. Resuming with `claude --resume <uuid>` keeps the same ID (no `--fork-session`).
- **Codex:** no flag sets the ID, so Branchwork discovers it. A Rust command lists rollouts in the pane's profile whose `session_meta.payload.cwd` equals the pane's worktree path and whose **file modification time** is not earlier than the pane's (in-memory) launch/relaunch time, minus a few seconds of slack, excluding IDs claimed by other open panes. *(My call: modification time, not the meta timestamp, so a pane restored with `codex resume --last` — which appends to an older rollout — is still found.)* Exactly one candidate → use it; zero or several → "unknown" (§6.3).
- **Keeping the ID current (user decision: handle it now).** The conversation can change inside a running pane (Claude `/clear`, `/resume`; Codex `/new`, resume picker).
  - Claude: the profile hook config gains a `SessionStart` hook (fires on startup, resume and `/clear`) and the existing `Stop`/`Notification` hooks keep firing. `branchwork-notify` reads the hook JSON on stdin (bounded, e.g. 64 KB), extracts `session_id`, and appends it to the socket line when it is a valid UUID. The backend validates it and the frontend stores it as the pane's `conversationId`. `--session-id` at launch still gives the ID before the first hook.
  - Codex: discovery runs **every time** the ID is needed (switch, restore, undo); a cached ID is only a tie-breaker, never trusted blindly.

### 6.2 Switch flow (Claude Code, Codex)

1. Existing checks (same CLI, target exists, not dock-shared, confirm if running) and `prepareAgentShell` for the target, unchanged — a not-logged-in target still refuses before anything stops.
2. Resolve the conversation ID (Codex: discovery). If unknown → refuse the switch with a toast; the old session keeps running.
3. Stop the old PTY (as today), so the transcript is complete on disk.
4. Copy the transcript (§6.4) from source profile to target profile.
   - **No transcript yet** (Claude pane launched with `--session-id` but no message sent, so `<id>.jsonl` does not exist): nothing to lose. Skip the copy and launch fresh on the target with the same `--session-id`. *(My call.)*
5. Spawn with the target env and the **resume-by-ID** line: `claude --resume <id>` / `codex resume <id>`. No `|| fresh-launch` fallback for this path.
6. **Settle window** *(my call)*: the switch is not committed until the new CLI has stayed alive ~5 s. Until then `profile` keeps the source value. A non-zero exit inside the window counts as failure (step 8). A spawn error also counts.
7. On success: update `profile`, keep `conversationId`, print the existing dim system line (`↻ Account <from> → <to>`), save.
8. On failure (copy error, spawn error, or early exit): relaunch the pane on the **source** profile with resume-by-ID and toast the error. The user ends up where they started, conversation intact.

Usage-limit Switch and auto-switch use this same flow.

### 6.3 Restore and close-Undo

When `conversationId` is known, restore-on-start and close-Undo also resume by ID instead of `--continue` / `--last`. When it is unknown (old persisted records, Codex discovery failed), they keep today's resume line.

### 6.4 Transcript copy IPC (Rust)

`agent_copy_conversation(cli_id, from_profile_dir, to_profile_dir, conversation_id) -> ()`

- Validate: `cli_id` ∈ {claude, codex}; both profile dirs canonicalize to paths inside the Branchwork profiles root for that CLI (the same rule the existing profile/hook commands use); `conversation_id` is a UUID (hex + hyphens, fixed length) — no path segments.
- Claude: find exactly one `projects/*/<id>.jsonl` under the source; copy to the same relative path under the target.
- Codex: find exactly one `sessions/**/rollout-*-<id>.jsonl` under the source; copy to the same relative path under the target.
- Copy to a temp file in the destination directory, then rename (atomic replace). Overwriting is allowed: the source is the newest copy when switching back and forth.
- Not found or more than one match → error. No symlinks followed out of the profile dir.
- Runs off the UI thread. Cost: O(transcript size) I/O, typically 0.3–5 MB; the directory scan is O(number of transcripts in one profile).

### 6.5 Registry

Per CLI add how to launch with an ID and resume by ID, alongside the existing `launch` / `resume` / `resumeLine`:

- Claude Code: launch-with-id `claude --session-id {id}`, resume-by-id `claude --resume {id}`.
- Codex: resume-by-id `codex resume {id}` (no launch-with-id).

Settings overrides of launch/resume (spec §6.6.1) keep working; when the user has overridden the launch command, Branchwork does not inject `--session-id` (ID then comes from nowhere for Claude → treated as unknown).

## 7. Constraints

- UI strings in `src/i18n/en.ts` (English).
- Validate all IPC input; never log transcript contents.
- No change to the user's own `~/.claude` / `~/.codex`.
- Follow CLAUDE.md workflow: stage branch `m8-stage-1`, tests only as the task text specifies, `./init.sh` green.

## 8. Delivery order

Split so Codex and Claude are separable tasks (both cross-account spikes passed, but keep them independent): shared pieces (conversation ID field + persistence, copy IPC, registry fields, switch flow with settle window and rollback) → Codex discovery → Claude `--session-id` + hook `session_id` plumbing → restore/undo by ID.

## 9. Left to the builder

- Exact Rust module placement (likely next to `handover.rs` / `cli.rs`) and the TS wrapper in `src/ipc/`.
- Clock-slack value for Codex discovery; exact settle-window length.
- Which Claude hook events carry `session_id` beyond `SessionStart` (Stop/Notification are fine to include).
- Wording of the new toasts.

## 10. Manual checks (for the stage checkpoint)

- Claude: log in a second Claude profile, have a short conversation on profile A, switch to B, ask "what did I just ask you?" — it answers from A's conversation.
- Codex: same with two logged-in Codex profiles.
- Two panes of the same CLI in one worktree: each switch resumes its own conversation.
- `/clear` (Claude) or `/new` (Codex), chat, then switch: the *new* conversation continues, not the old one.
- Switch a Claude pane before typing anything: target launches cleanly.
- Target not logged in → refused, old session still running.
- Usage-limit auto-switch resumes the conversation.
- Restart the app → each pane restores its own conversation.
