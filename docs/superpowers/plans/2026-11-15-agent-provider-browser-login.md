# Agent Provider Browser Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start built-in provider authentication from Settings, open the provider's browser flow, and keep the user on Settings until login is verified or fails.

**Architecture:** Add a typed provider login adapter registry and a bounded app-scoped background PTY lifecycle. The Rust command boundary validates profile directory and fixed process inputs; the profile store owns pending/probe state; Settings collects OpenCode choices and reports status without rendering PTY output.

**Tech Stack:** React, TypeScript, Zustand, Tauri 2, Rust, portable-pty, Vitest, cargo tests.

**Spec:** `docs/superpowers/specs/2026-11-15-agent-provider-browser-login-design.md`

## Global Constraints

- Use fixed executable and argv arrays; never interpolate provider names, profile labels, or URLs into a shell command.
- Validate profile slugs and provider/method identifiers at the backend boundary.
- Never expose token or auth-code output in the WebView, logs, errors, or persisted app settings.
- Allow at most one login per profile and a small fixed app-wide concurrency limit; always close processes on success, cancellation, failure, or timeout.
- Account-row rendering is O(profiles); starting a login is O(1) apart from provider process/network work; retained output is capped.
- Provider login capability and tested CLI versions live in the adapter registry; missing or incompatible commands fail visibly in Settings.

## Review Focus

- Malformed profile path or slug must not escape the profile root — Rust auth-spawn validation tests.
- Arbitrary provider/method values must not reach process argv — adapter catalog and Rust boundary tests.
- PTY output containing tokens or URLs must not be surfaced or opened without validation — lifecycle sanitization and HTTPS-host tests.
- Duplicate clicks and many profiles must respect per-profile and global concurrency caps — login manager tests.
- Shared Muse credentials must update every Muse row after verified success while pending stays on the initiating row — profile store tests.

---

## File Map

- `src/agents/login.ts` (create): fixed per-provider argv, environment, Settings choices, completion semantics, and verified CLI version metadata.
- `src/agents/login.test.ts` (create): adapter catalog validation and provider argv tests.
- `src/agents/profiles.ts`: replace terminal-tab navigation with the background login manager; coordinate pending state, probes, cancellation, Muse shared status.
- `src/agents/profiles.test.ts`: store lifecycle, timeout, duplicate prevention, unverified completion, and Muse behavior.
- `src/agents/AgentLoginManager.ts` (create): app-scoped process lifecycle, bounded concurrency/output, browser URL validation, cleanup on exit.
- `src/agents/AgentLoginManager.test.ts` (create): process lifecycle, caps, cleanup and safe URL handling.
- `src/ipc/pty.ts`, `src/ipc/bindings.ts`: typed auth PTY spawn API and generated binding refresh.
- `src-tauri/src/pty.rs`: reusable PTY spawn inputs or an auth-scoped spawn path with output/resource caps.
- `src-tauri/src/lib.rs`: register an auth PTY spawn command that accepts only validated Branchwork profile roots, fixed CLI id, dimensions, and controlled environment.
- `src-tauri/src/cli.rs`: validate provider ids, profile slugs, and profile-root containment for auth process startup.
- `src/screens/settings/SettingsScreen.tsx`: keep authentication interaction on Settings; add OpenCode provider/method choices and pending/error state.
- `src/screens/settings/SettingsScreen.test.tsx`: assert browser-login click does not navigate to Terminal and that Settings choices are passed safely.
- `src/i18n/en.ts`: English labels and bounded, sanitized login status/error messages.
- `feature_list.json`, `progress.md`, `session-handoff.md`: record stage status, evidence, and next action after implementation/checkpoint.

## Tasks

### Task 1: Provider login adapter registry

**Files:** create `src/agents/login.ts`, `src/agents/login.test.ts`; modify `src/agents/registry.ts` only if shared provider version metadata needs a single source.

**Interfaces:** `getLoginAdapter(cliId: CliId): LoginAdapter | null`; `LoginAdapter` contains fixed binary, `buildArgs(options)`, profile env construction, supported Settings choices, credential scope, and bounded `verifiedAgainst` metadata. OpenCode choices must come from the adapter's static catalog.

- [x] Test fixed browser-login argv for Claude, Codex, OpenCode, Gemini, Copilot, and Muse, and no adapter for Custom.
- [x] Test rejection of unknown OpenCode provider/method pairs and methods requiring manual API-key entry.
- [x] Implement the adapter catalog with provider-specific isolated/shared credential scope and CLI version metadata.
- [x] Verify available CLI behavior and status mechanisms; leave unsupported/unverifiable states explicitly unknown. OpenCode current releases store credentials in SQLite; legacy-file existence is not used as a login signal.
- [x] `pnpm exec vitest run src/agents/login.test.ts` passed (4 tests).

### Task 2: Narrow Rust auth process boundary

**Files:** modify `src-tauri/src/cli.rs`, `src-tauri/src/pty.rs`, `src-tauri/src/lib.rs`; refresh `src/ipc/bindings.ts`; add Rust tests in the owning modules.

**Interfaces:** `pty_auth_spawn(cli_id, profile_slug, columns, rows, options)` resolves the executable from the fixed CLI registry and profile directory internally; it does not accept a worktree path, arbitrary binary, or shell command. The response is the existing `PtySession` shape.

- [x] Test invalid CLI ids/slugs, path traversal, symlink rejection, and valid profile containment.
- [x] Test login session cap, process cleanup, and rejection of unsupported provider options; inherited PTY output replay remains capped by the shared PTY buffer.
- [x] Implement the narrow command using existing PTY session/event machinery and fixed argv/environment from trusted backend data.
- [x] Register the IPC command and regenerate typed frontend bindings.
- [x] Targeted auth boundary/cap Rust tests and `cargo check --manifest-path src-tauri/Cargo.toml` passed.

### Task 3: App-scoped login manager

**Files:** create `src/agents/AgentLoginManager.ts`, `src/agents/AgentLoginManager.test.ts`; modify `src/ipc/pty.ts`.

**Interfaces:** `startLogin(ref, options): Promise<LoginHandle>`; `cancelLogin(ref): Promise<void>`; a handle exposes only lifecycle status and a completion promise, never raw PTY output. Limit one process per profile and a fixed app-wide maximum of two concurrent logins.

- [x] Test duplicate-profile rejection, global cap, timeout, cancellation, child exit, and cleanup on terminal paths.
- [x] Test bounded output and strict provider-validated HTTPS host handling; raw PTY output is never surfaced in Settings.
- [x] Implement login process event handling and lifecycle cleanup; retain only bounded in-memory text for URL detection and clear it on cleanup.
- [x] `pnpm exec vitest run src/agents/AgentLoginManager.test.ts` passed (6 tests).

### Task 4: Settings and profile-store integration

**Files:** modify `src/agents/profiles.ts`, `src/agents/profiles.test.ts`, `src/screens/settings/SettingsScreen.tsx`, `src/screens/settings/SettingsScreen.test.tsx`, `src/i18n/en.ts`.

**Interfaces:** `loginProfile(ref, options?)` marks pending synchronously, starts the app-scoped manager, and reports completion only after provider verification. The Settings OpenCode dialog returns a typed `{ providerId, methodId }` pair.

- [x] Test sign-in never navigates to Terminal or creates a terminal tab.
- [x] Test Settings login launch, OpenCode choice, login verification, and unverified outcomes; native cancellation/timeout presentation remains in manual validation.
- [x] Test Muse shared probe state while pending is scoped to the initiating profile.
- [x] Test OpenCode provider/method selection and invalid options rejection.
- [x] Integrate the manager with profile-specific probes, remove old login-tab behavior, and add Settings choices/status strings.
- [x] Focused profiles, Settings, and manager suites passed; a broader set of 6 impacted suites passed (137 tests).

### Task 5: Stage integration review and manual checkpoint

**Files:** update `feature_list.json`, `progress.md`, `session-handoff.md`; add `docs/testing/agent-provider-login-manual-e2e.md`.

- [x] Run `./init.sh`; TypeScript passed; Vitest passed (88 files / 753 tests); Clippy passed; Rust tests had 332 passed / 11 failed / 3 ignored. The 10 FSEvent startup failures and the buffered PTY replay failure match the recorded baseline.
- [x] `git diff --check` passed; final review confirmed fixed argv, backend path containment, process cleanup, a two-login cap, bounded output, and no PTY output surfaced in Settings.
- [x] Document the manual provider login matrix, including browser callback, cancellation, failure, retry, OpenCode selection, and Muse shared credential scope.
- [x] Feature status/evidence and handoff updated to the manual checkpoint. Stop and wait for the user's manual verification before stage integration or release actions.

## Execution Notes

- Project workflow requires work on a stage branch, no per-task commits, and no push. Skip any generic per-task commit guidance. One stage commit is allowed only after the user approves the manual checkpoint and orders the commit.
- The existing `./init.sh` baseline has known macOS FSEvent startup failures and a PTY replay regression; report the observed baseline instead of attributing those failures to this work.
- The separate blank Agent terminal issue remains a diagnosed follow-up and is outside this login feature's scope.
