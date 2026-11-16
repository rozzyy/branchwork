# Agent provider browser sign-in from Settings

## Intent

Signing in to a built-in agent provider should start from Settings, open the provider's browser authentication flow directly, and leave the user on Settings. Settings remains the place where login progress and verified completion are shown. The provider CLI remains the authority for OAuth, callback handling, and credential storage.

## Current behavior

Settings profile rows call `useProfiles.loginProfile`. `profiles.ts` creates a Terminal screen tab with a provider-scoped environment, switches the Stage to Terminal, and writes the provider login command into that PTY. Settings polls `checkProfileLogin` and shows `loginPending` while the flow runs. Adding a new profile follows the same route through `loginProfile`.

Provider login behavior differs. Claude Code, Codex, Copilot, Gemini CLI, and Muse can use browser authentication. OpenCode's `auth login` asks the user to choose an underlying model provider and authentication method. Muse credentials are shared device-wide. Some providers may store credentials in an OS credential store rather than in the isolated profile directory. Custom CLI has no configured login flow.

## Goals

- A Sign in action in Settings starts the built-in provider's official browser login without changing the selected app page.
- Keep login progress, retry, cancellation, and verified completion visible in Settings.
- Keep provider-specific choices, such as OpenCode provider and OAuth method, in Settings.
- Reuse provider CLI login behavior and credential storage; Branchwork must not collect, serialize, or log vendor tokens.
- Continue to use each profile's configured environment where the provider supports profile isolation.
- Report unknown login state honestly; do not show success unless a provider probe or successful login completion verifies it.
- Bound login process count, duration, and output handling; prevent duplicate flows for the same profile.

## Non-goals

- Implement vendor OAuth clients or token exchange inside Branchwork.
- Embed provider websites in Branchwork or move authentication into the Agent screen.
- Change agent session startup, profile switching, usage meters, or logout policy except where a login probe must be added to confirm this flow.
- Change custom CLI login; Custom remains unavailable until it has an explicit trusted login configuration.

## Approaches considered

### A. Launch the provider's official browser flow from Settings — selected

Settings starts the provider's fixed login command in a background PTY session, without creating a Terminal screen tab. The provider CLI opens its browser and owns the callback and credential write. Settings keeps its existing pending state and updates the row after a provider-specific probe confirms login. Any required provider or auth-method choices are gathered in a Settings dialog before the process starts.

This matches the requested interaction while preserving vendor-owned credential handling. It needs a small login adapter per built-in CLI because commands, prompts, and status probes differ.

### B. Implement OAuth directly in Branchwork

Branchwork would manage provider client IDs, browser callbacks, token exchange, refresh, and credential writing for each provider. This creates duplicated auth code, expands the secret boundary, and does not fit providers whose CLI owns the auth store or whose login is not a standard OAuth flow. Rejected.

### C. Keep opening a visible terminal

The current implementation already does this and changes the app page. It does not meet the requested interaction. Rejected.

## Design

### Settings interaction

- Existing account rows keep their Sign in action. New account creation still creates the profile and begins sign-in without navigating away.
- Clicking Sign in marks that profile as pending synchronously, then starts the matching provider login adapter.
- For OpenCode, Settings asks for the model provider and authentication method before launch. The UI must not request or display a provider secret; API-key-only methods are outside this browser-sign-in change unless the provider's official flow can open a browser without collecting a key.
- Browser completion returns to Settings. The row shows a verified signed-in state when the existing or new provider probe succeeds. If status cannot be verified, Settings shows an explicit unknown/checking result and offers retry; it never infers success from a browser tab merely opening.
- Failure, cancellation, timeout, and retry remain on Settings. Error text is bounded and scrubbed of auth codes, tokens, and credential-like values.

### Login process lifecycle

- Add a provider login adapter keyed by built-in `CliId`. Each adapter owns fixed argv, profile environment, any required Settings choices, the expected browser behavior, the completion probe, and bounded cleanup.
- Spawn the official CLI through the existing PTY process path without attaching it to the Terminal screen. Do not construct shell text from user input. Any OpenCode provider and method identifiers are validated against the provider catalog before becoming argv elements.
- A profile can have at most one active login session. Bound simultaneous login sessions across the app and impose a timeout. On verified success, cancel, timeout, or terminal exit, close the background PTY and clear pending state.
- The login manager is app-scoped, not tied to a Settings component or window. If the app exits, its PTY manager terminates the process group; pending state is in-memory and clears on restart. No login process or pending flag is restored on the next launch.
- The PTY is used only to support CLIs that require a TTY and to let their own browser callback finish. Its output is not rendered as a terminal view. If a CLI emits a browser URL rather than opening it itself, only a provider-validated HTTPS URL may be handed to the system browser; never open arbitrary PTY output as a URL.
- Login must not require an open repository. If the current PTY spawn command remains restricted to registered worktrees, add a narrow auth-spawn command that accepts only a validated Branchwork profile directory as its working directory. It must use fixed executable/argv from the adapter and preserve the existing PTY session, input, output, and cleanup limits.

### Provider-specific behavior

- **Claude Code:** use the profile-scoped `claude auth login` flow. Do not append `&& claude`; authentication must not start the agent TUI. Use `CLAUDE_CONFIG_DIR` and verify through the existing profile probe.
- **Codex:** use the official browser login in the isolated `CODEX_HOME`; verify the declared `auth.json` presence and, where supported by the installed CLI, its login status command.
- **OpenCode:** collect provider and OAuth method in Settings, then use the fixed `opencode auth login <provider> --method <method>` form. Keep `HOME` scoped to the profile. Current releases store credentials in SQLite, so do not use legacy `auth.json` existence as a probe; until a verified auth-list parser is added, keep login state unknown. Do not offer key-entry methods in this browser-only flow.
- **Gemini CLI:** explicitly select its browser OAuth mode before launch; use `GEMINI_CLI_HOME` for profile-scoped credential storage. Verify only through the declared credential path or a provider-supported status probe. Do not claim success when the CLI or probe cannot verify it.
- **GitHub Copilot CLI:** force its local browser flow and keep its documented browser callback. Verify login with a supported status probe. Its credential store may be device-wide; surface that fact in Settings and do not claim the account is isolated when the OS credential store is shared.
- **Muse:** use its browser sign-in path. Preserve the existing warning that the credential is device-wide and signing in changes the credential used by all Muse profiles. Confirm using the existing Muse login probe.
- **Custom:** no sign-in action until a safe, explicit login configuration exists.

Because Muse login is device-wide, a verified login updates the shared `muse` probe state for every Muse profile row. Pending state remains attached only to the profile whose Sign in action started the flow.

The provider adapter registry is the source of truth for login commands, browser mode, Settings choices, credential scope, and status verification. It should record the CLI versions each adapter was verified against, following `CLI_REGISTRY.verifiedAgainst`; do not introduce a global minimum version unless a provider requires a specific option. At runtime, missing or incompatible commands fail visibly in Settings and never fall back to navigating to Terminal. Authentication URL hosts, callback handling, credential paths, and environment isolation are provider-specific security boundaries.

## Constraints and safety

- All IPC arguments and process output are untrusted. Use fixed executable and argv arrays; never interpolate provider names, profile labels, or URLs into a shell command.
- Validate profile slugs and provider/method identifiers at the backend boundary. Keep credential files under their documented provider profile roots where isolation is supported.
- Never expose token or auth-code output in the WebView, logs, errors, or persisted app settings. Keep only bounded, sanitized status text.
- At most one login per profile and a small fixed app-wide concurrency limit. Login processes have a fixed timeout and are always closed on success, cancellation, failure, or component/store teardown.
- Complexity: account-row rendering is O(profiles); starting one login is O(1) aside from provider process/network work; status probing is bounded to one active probe per pending profile at a fixed interval, with bounded concurrent probes and a fixed timeout. Retained login output is capped and not accumulated indefinitely.
- No benchmark is expected; verify process count/output limits and the Settings flow with the existing type, test, and native app checks.

## Open implementation choices

- Confirm each provider's browser-only invocation and status verification against its supported CLI version; use official behavior and structured status/file probes rather than scraping terminal screen text. Native browser walkthrough remains pending.
- If a provider cannot complete browser sign-in without a terminal choice, show that choice in Settings. If there is no supported way to do so, leave the row in an explicit unsupported/unknown state rather than silently navigating to Terminal or fabricating success.
- Keep profile creation after a canceled browser attempt, matching the existing Settings model where profiles are reusable, unless the current tests establish a different required behavior.

## References

- [Claude Code authentication](https://code.claude.com/docs/en/iam)
- [Codex CLI authentication](https://learn.chatgpt.com/docs/auth?surface=cli)
- [OpenCode CLI providers](https://opencode.ai/docs/cli/providers/)
- [Gemini CLI authentication](https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx)
- [GitHub Copilot CLI authentication](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli)
- [Muse Code authentication](https://dev.meta.ai/docs/muse-code/auth)
