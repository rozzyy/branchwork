# Agent Session Usage and Token Saver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show per-session token usage and quota in each Agent pane, and give Claude Code sessions RTK-style tool-output compression plus Caveman-style concise answers, both on by default.

**Architecture:** Rust reads each provider's local session log (Claude `projects/<cwd>/*.jsonl`, Codex `sessions/**/rollout-*.jsonl`) incrementally and returns numeric aggregates over one IPC command. A new `branchwork-saver` sidecar runs as a Claude `PreToolUse` hook: it rewrites allowlisted simple Bash commands to `branchwork-saver run -- <cmd>`, which filters stdout fail-open and appends measured byte savings to a per-session stats file. The frontend polls usage for live panes, shows a meter and saver badges in the pane header, and adds Caveman through `claude --append-system-prompt`.

**Tech Stack:** Tauri 2 (Rust, serde_json), React + zustand, Vitest, tauri-specta bindings.

**Spec:** `docs/superpowers/specs/2026-11-13-agent-session-usage-token-saver-design.md`

## Global Constraints

- Never fabricate: no percentage without a provider limit, no saving without measured before/after payloads.
- Session usage and account quota stay separate numbers and separate bars.
- Native PTY mode stays the default; no proxy is added in this iteration (spec allows "any proxy path ... opt-in"; none ships).
- Compression is fail-open: non-zero exit, JSON output, oversize output, a filter that does not shrink, or any error → original bytes.
- No transcript content, prompts or credentials leave the reader; only integers cross IPC.
- Bounded I/O: per-file read cap 64 MiB, stats file read cap 1 MiB, saver capture cap 4 MiB, at most one usage probe in flight per session, poll every 5 s.
- All UI strings live in `src/i18n/en.ts`, English.
- The 9Router service is never required or contacted.

## Review Focus

- Two panes on the same CLI + profile + worktree: a log file cannot be attributed → both show "unavailable", never the same numbers twice (Task 4 test `ambiguous panes show unavailable`).
- A Claude log line repeated per content block with the same `message.id` must count once (Task 1 test `claude_dedupes_message_ids`).
- A Bash command with pipes, redirects, `$()`, `;`, `&&`, env-assignment prefix, or a protected tool must never be rewritten (Task 2 test `rewrite_rejects_shell_syntax_and_protected`).
- A failing command (`cargo test` exit 101) must print its full original stdout and keep its exit code (Task 2 test `compress_skips_failures_and_json`).
- Saver off in Settings → the next session gets no `BRANCHWORK_SAVER` env and no `--append-system-prompt`, and badges read "off" (Task 3 test `saver disabled launches plain argv`).

---

### Task 1: Rust session-usage reader ✅

**Files:**
- Create: `src-tauri/src/session_usage.rs`
- Modify: `src-tauri/src/lib.rs` (mod, command, `collect_commands!`), `src/ipc/bindings.ts` (regenerated)

**Interfaces:**
- Produces (Rust → TS via specta):
  ```rust
  #[serde(rename_all = "camelCase")]
  pub struct TokenCounts { pub input: u64, pub output: u64, pub total: u64 }
  pub struct UsageQuota { pub percent: u32, pub window_minutes: Option<u32>, pub resets_at: Option<u64> /* unix s */ }
  #[serde(tag = "state", rename_all = "camelCase")]
  pub enum SessionUsage {
      Unsupported,                       // CLI has no reader
      NoData,                            // reader exists, no matching log yet
      Ok { tokens: TokenCounts, context_used: Option<u64>, context_limit: Option<u64>, quota: Option<UsageQuota> },
  }
  pub struct SaverStats { pub runs: u32, pub bytes_before: u64, pub bytes_after: u64 }
  ```
- Commands: `agent_session_usage(cli_id: String, profile_dir: String, worktree_path: String, since_ms: f64) -> Result<SessionUsage, AppError>` (async) and `agent_saver_stats(agent_id: String) -> Result<SaverStats, AppError>`.
- TS: `commands.agentSessionUsage(...)`, `commands.agentSaverStats(...)`.

Rules:
- Claude dir = `<profile_dir>/projects/<cwd with every non-[A-Za-z0-9] byte replaced by '-'>`; pick newest `*.jsonl` with mtime ≥ `since_ms`. Count only `type == "assistant"` lines with `message.usage`; dedupe by `message.id`. input = `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, output = `output_tokens`. No context limit (none in the log).
- Codex: walk `<profile_dir>/sessions/` (depth ≤ 4), newest `rollout-*.jsonl` with mtime ≥ `since_ms` whose first line is `session_meta` with `payload.cwd == worktree_path`; use the last `event_msg` / `payload.type == "token_count"` with non-null `info`: tokens from `info.total_token_usage` (input = `input_tokens`, output = `output_tokens`, total = `total_tokens`), `context_used = last_token_usage.total_tokens`, `context_limit = model_context_window`; `quota` from `rate_limits.primary` (`used_percent` rounded, clamped 0–100).
- Incremental: a process-wide `Mutex<HashMap<PathBuf, ReaderState>>` (≤ 64 entries, evict oldest) keeps byte offset + running totals + seen ids; reread from 0 when the file shrank. Only whole lines are consumed. Files > 64 MiB → `NoData`.
- Validation: `cli_id` must be a known id; `profile_dir` must be absolute and its file name must start with `"<cli_id>-"`; `worktree_path` absolute.
- Saver stats file = `notify::socket_dir()/saver-<agent_id>.log`, lines `<before> <after>`; agent id validated with the `agent-` rule from `validate_notify_event`; missing file → zeros.

- [x] **Step 1: Write the failing tests** in `session_usage.rs` `mod tests`: `claude_sums_and_dedupes_message_ids` (two lines same id + one other id + a `user` line → input/output sums of the two distinct ids), `claude_dir_encoding` (`/Users/a/my.repo` → `-Users-a-my-repo`), `codex_reads_last_token_count_and_quota` (meta cwd match + two token_count lines → last one; context 99112/258400; quota 4), `codex_skips_other_cwd`, `incremental_read_appends` (write, read, append a line, read → sum grows, no double count), `saver_stats_sums_lines_and_rejects_bad_id`.
- [x] **Step 2:** `cd src-tauri && cargo test session_usage` → FAIL (module missing).
- [x] **Step 3:** Implement the module, register both commands, regenerate bindings (`cargo test --lib -- --ignored regenerate_bindings_file`). Make `notify::socket_dir` `pub(crate)`.
- [x] **Step 4:** `cargo test session_usage` and `cargo clippy -- -D warnings` → PASS.
- [x] **Step 5: Commit** _(skipped: no-commit rule; one commit at the end)_

### Task 2: `branchwork-saver` sidecar (RTK-style compression) ✅

**Files:**
- Create: `src-tauri/src/saver.rs` (pure logic, unit-tested), `src-tauri/src/bin/branchwork-saver.rs`
- Modify: `src-tauri/src/notify.rs` (`ensure_claude_saver_hook`, `saver_binary_path`), `src-tauri/src/lib.rs` (mod + command `cli_ensure_saver_hook`), bindings

**Interfaces:**
- `pub fn rewrite_command(command: &str, protected: &[String], bin: &str) -> Option<String>` → `Some("'<bin>' run -- <command>")` only for allowlisted simple commands.
- `pub fn compress(argv: &[String], stdout: &str) -> Option<String>` → `Some(smaller)` or `None` (pass through).
- `pub fn hook_response(input_json: &str, protected: &[String], bin: &str) -> Option<String>` → Claude `PreToolUse` JSON `{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{...tool_input,"command":<rewritten>}}}`; never sets `permissionDecision`.
- `notify::ensure_claude_saver_hook(profile_dir, saver_bin) -> Result<bool /*installed*/, AppError>` adds `hooks.PreToolUse` entry `{"matcher":"Bash","hooks":[{"type":"command","command":"\"<bin>\" hook"}]}` once.
- Command `cli_ensure_saver_hook(cli_id: String, profile_dir: String) -> Result<bool, AppError>`: true only when the CLI is `claude`, the sidecar exists, and the hook is present after the call.

Rules:
- Allowlist (first tokens): `git status|branch`, `git log` without `-p`/`-u`/`--patch`, `ls`, `cargo test|build|check|clippy`, `pnpm|npm|yarn test|typecheck|lint`, `pnpm|npm run test|typecheck|lint`, `pytest`, `go test`.
- Reject any of `| & ; < > ( ) $ \` \\` newline, a first token containing `=`, a command already containing `branchwork-saver`, and any command whose first one or two tokens equal a protected entry.
- `compress`: strip ANSI CSI sequences; trim trailing spaces; collapse blank-line runs to one; collapse ≥ 3 identical consecutive lines to the line plus `… (repeated N×)`; `git status` drops lines starting with `  (use "git`; `cargo` drops lines starting with `   Compiling `, `    Checking ` and `test … ... ok`; `pnpm|npm|yarn` drops lines whose trimmed text starts with `✓ `. Return `None` when the input parses as JSON or the result is not shorter.
- Sidecar `hook`: no-op unless `BRANCHWORK_SAVER == "rtk"`; stdin cap 1 MiB; protected list from `BRANCHWORK_SAVER_PROTECT` (comma-separated); prints nothing on any error.
- Sidecar `run -- <argv>`: spawn argv with inherited stdin/stderr, capture stdout up to 4 MiB (beyond → flush raw and stream the rest raw); on exit 0 apply `compress`; print result; append `<before> <after>` to `<dir of BRANCHWORK_NOTIFY_SOCKET>/saver-<BRANCHWORK_AGENT_SESSION>.log` only when compressed; exit with the child's code (signal → 128+n). Spawn failure → print the error to stderr, exit 127.

- [x] **Step 1: Write the failing tests** in `saver.rs`: `rewrite_accepts_allowlisted_commands` (`git status`, `cargo test -p x` → `Some` with `'/b/branchwork-saver' run -- …`), `rewrite_rejects_shell_syntax_and_protected` (`git status | head`, `ls; rm x`, `FOO=1 cargo test`, `echo $(x)`, `git log && ls`, `rm -rf x`, `git status` with protected `["git status"]` → `None`), `compress_filters_known_noise` (git status hint lines; cargo `Compiling` + passing tests removed, failures kept; repeated lines collapsed), `compress_skips_failures_and_json` (JSON stdout → `None`; output that cannot shrink → `None`), `hook_response_rewrites_bash_only` (Read tool → `None`; Bash → JSON with `updatedInput.command` and no `permissionDecision`). In `notify.rs`: `claude_saver_hook_merges_once`.
- [x] **Step 2:** `cargo test saver` → FAIL.
- [x] **Step 3:** Implement `saver.rs`, the bin, the hook install, and the command; regenerate bindings.
- [x] **Step 4:** `cargo test saver notify` + clippy → PASS; manual: `cargo build --bin branchwork-saver && echo '{"tool_name":"Bash","tool_input":{"command":"git status"}}' | BRANCHWORK_SAVER=rtk target/debug/branchwork-saver hook` prints the rewrite.
- [x] **Step 5: Commit** _(skipped: no-commit rule)_

### Task 3: Saver wiring in sessions and Settings ✅

**Files:**
- Create: `src/agents/savers.ts`, `src/agents/savers.test.ts`
- Modify: `src/agents/sessions.ts`, `src/state/settings.ts`, `src/ipc/notify.ts` (`ensureSaverHook`), `src/screens/settings/SettingsScreen.tsx`, `src/i18n/en.ts`, `src/agents/sessions.test.ts`

**Interfaces:**
- `savers.ts`:
  ```ts
  export type SaverId = "rtk" | "caveman";
  export type SaverState = "active" | "off" | "unavailable" | "unsupported";
  export type SessionSavers = Record<SaverId, SaverState>;
  export const CAVEMAN_PROMPT: string;
  export function saverSupport(cliId: CliId): Record<SaverId, boolean>; // claude: both; others: none
  export function withCaveman(cliId: CliId, argv: string[]): string[];   // appends ["--append-system-prompt", CAVEMAN_PROMPT] for claude
  export function cavemanResumeLine(cliId: CliId, line: string): string; // "claude --continue X || claude X" with X quoted
  ```
- `AgentSession` gains `savers: SessionSavers` (not persisted; restored sessions recompute).
- `useSettings` gains `agentTokenSaver: boolean` (default true), `agentSaverProtected: string[]` (default `[]`), setters `setAgentTokenSaver`, `setAgentSaverProtected`; persisted keys `agentTokenSaver`, `agentSaverProtected`.
- `ensureSaverHook(cliId, profileDir): Promise<boolean>` wraps `commands.cliEnsureSaverHook`.

Rules:
- `prepareAgentShell` computes savers: disabled → supported ones `off`, others `unsupported`. Enabled → `caveman` `active` when supported; `rtk` `active` only when `ensureSaverHook` resolves true, else `unavailable`. RTK active adds env `BRANCHWORK_SAVER=rtk` and `BRANCHWORK_SAVER_PROTECT=<comma list>`.
- Launch argv and resume command go through `withCaveman` / `cavemanResumeLine` when caveman is active (all three launch paths: start, switch, undo-relaunch).
- CAVEMAN_PROMPT text: "Answer tersely: drop filler, pleasantries and hedging; fragments are fine. Keep code, commands, paths, identifiers and error text exact. Brevity never overrides correctness, security, validation, or explicit user instructions."
- Settings card "Agents": a "Token saver" switch and a "Protected commands" text input (comma-separated, trimmed, empties dropped).

- [x] **Step 1: Write failing tests**: `savers.test.ts` — `withCaveman adds the flag only for claude`, `cavemanResumeLine quotes the prompt on both sides`; `sessions.test.ts` — `saver enabled launches claude with caveman and rtk env` (mock `cliEnsureSaverHook` → true; assert written command contains `--append-system-prompt` and spawn env has `BRANCHWORK_SAVER: "rtk"`, session `savers` all `active`), `saver disabled launches plain argv` (badges `off`, no flag, no env), `rtk unavailable when the hook cannot install`.
- [x] **Step 2:** `pnpm vitest run src/agents` → FAIL.
- [x] **Step 3:** Implement.
- [x] **Step 4:** `pnpm vitest run src/agents src/screens/settings` + `pnpm typecheck` → PASS.
- [x] **Step 5: Commit** _(skipped: no-commit rule)_

### Task 4: Usage polling and pane UI ✅

**Files:**
- Create: `src/agents/sessionUsage.ts`, `src/agents/sessionUsage.test.ts`, `src/ipc/sessionUsage.ts`
- Modify: `src/screens/agents/AgentsScreen.tsx`, `src/screens/agents/agents.css`, `src/i18n/en.ts`, `src/screens/agents/AgentsScreen.test.tsx`

**Interfaces:**
- `src/ipc/sessionUsage.ts`: `readSessionUsage(cliId, profileDir, worktreePath, sinceMs): Promise<SessionUsage>`, `readSaverStats(agentId): Promise<SaverStats>` (reject outside Tauri like `ipc/notify.ts`).
- `sessionUsage.ts`:
  ```ts
  export type UsageView =
    | { kind: "loading" } | { kind: "unsupported" } | { kind: "unavailable" } | { kind: "none" }
    | { kind: "ok"; tokens: TokenCounts; percent: number | null; stale: boolean };
  export function formatTokens(n: number): string; // 950 → "950", 12_345 → "12.3k", 3_699_548 → "3.7M"
  export const useSessionUsage: zustand store {
    views: Record<string /*session id*/, UsageView>;
    savings: Record<string, SaverStats>;
    poll(sessions: AgentSession[]): Promise<void>; // one tick
  };
  export function useUsagePolling(): void; // 5 s interval while Agents is mounted
  ```
- `percent = round(contextUsed / contextLimit * 100)` clamped 0–100, only when both exist.
- Session start time: `startedAt: number` (ms) added to `AgentSession`, set when the PTY spawns (start/switch).

Rules:
- Poll only sessions with a live PTY; skip one whose previous probe is in flight. Profile dir via `ensureProfileDir`. Unsupported CLI → `unsupported` without IPC. Error → keep last `ok` with `stale: true`, else `unavailable`. Another live session with the same cli + profile slug + worktree → `unavailable` (ambiguous).
- `quota` from a Codex reply → `useProfiles.setProfileUsage(profile, { percent, window: "resets in …" })` (reuse the Muse label format) — the chip stays the only quota bar.
- `SessionMeter` in the pane header after the status chip: `ok` with percent → `UsageBar` + `NN%` + `12.3k tok`; `ok` without percent → `12.3k tok`; title/aria text gives `In 10.1k · Out 2.2k · Total 12.3k` (+ "context" note when percent). Other kinds → muted short label ("usage n/a", "usage —").
- `SaverBadges`: one `button.agent-saver` per supported saver (`RTK`, `Caveman`) with `data-state`; title + aria-label = method explanation + state + measured saving (`Saved 12.3k chars in 4 runs`) when `savings.bytesBefore > bytesAfter`. Unsupported CLIs render one muted `Saver n/a` chip.

- [x] **Step 1: Write failing tests**: `sessionUsage.test.ts` — `formatTokens`, `ok usage maps percent only with a limit`, `ambiguous panes show unavailable`, `error keeps last value as stale`, `codex quota feeds the profile chip`; `AgentsScreen.test.tsx` — `pane shows session meter and saver badges` (badge `RTK` has `data-state="active"`, aria-label contains the explanation).
- [x] **Step 2:** `pnpm vitest run src/agents/sessionUsage.test.ts src/screens/agents` → FAIL.
- [x] **Step 3:** Implement; styles reuse `.chip` / `.ubar` tokens.
- [x] **Step 4:** `./init.sh` → green.
- [x] **Step 5: Commit** _(skipped: one commit at the end, then merge into `m6-stage-4` after user confirmation)_

### Task 5: Orca-style quota meter and labelled saver badges ✅ (revision 2026-11-14, user request)

The user asked for Orca-style usage (plan quota windows) instead of token counts, and for visible on/off text on the RTK/Caveman badges.

- Rust `src-tauri/src/quota.rs` replaces `session_usage.rs`: `agent_profile_quota(cli_id, profile_dir) -> ProfileQuota` (`unsupported` | `noData` | `ok { windows: QuotaWindow[], fetchedAtMs }`). Claude: `<profile>/.claude.json` → `cachedUsageUtilization` (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`). Codex: newest rollout `rate_limits.primary/secondary`. No credentials, no network. The session token reader and `agent_session_usage` are removed.
- Frontend `src/agents/quota.ts`: one read per distinct live profile every 15 s; the tightest current window feeds the profile chip; failed reads keep the last value marked stale.
- Pane header: `QuotaMeter` shows the tightest current window (`5h 42% ▮ · 2h 5m`, warning tone at ≥ 80 %); clicking opens every window with bar, percent, reset countdown, and "Updated … ago". Windows past their reset time show "Reset — no new report yet".
- `SaverBadges` always render both methods with visible state text: `RTK on|off|unavailable|n/a`, `Caveman …`.
- [x] Tests: `quota.rs` (8), `src/agents/quota.test.ts` (7), AgentsScreen `pane shows the tightest quota window and labelled saver badges`.
