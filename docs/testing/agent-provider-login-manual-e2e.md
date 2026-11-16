# Agent provider browser login — manual checkpoint

Run this checklist in the native desktop app on the feature branch. Keep Settings visible throughout each flow.

## Shared checks

- [ ] Open more than eight terminal tabs and confirm the ninth and later PTY sessions start normally; close a tab and confirm another session can start.
- [ ] Existing profile: click **Sign in**; confirm the browser opens and Branchwork stays on Settings.
- [ ] New profile: create it from Settings; confirm profile creation does not navigate to Terminal.
- [ ] While login is active, confirm only the initiating profile shows pending state and duplicate clicks are disabled.
- [ ] Complete browser approval; confirm Settings reports signed in only when the provider status probe verifies it.
- [ ] Cancel the browser flow or close its browser tab; confirm pending clears and retry works.
- [ ] Deny/expire authentication; confirm a bounded error or unknown state appears without tokens, codes, or raw PTY output.
- [ ] Start two provider logins; confirm a third is rejected until one slot is free.
- [ ] Navigate away from Settings and return while a flow is active; confirm Settings state remains coherent and no terminal pane is created.

## Provider-specific checks

- [ ] Claude: verify browser approval updates the isolated profile status.
- [ ] Codex: verify browser approval updates the isolated `CODEX_HOME` profile status.
- [ ] Gemini: verify the OAuth mode opens browser authentication and completes without needing a terminal selection.
- [ ] Copilot: verify `--web-flow` opens the browser and that Settings labels its system-keychain credential as device-wide.
- [ ] Muse: verify browser approval updates every Muse row because credentials are device-wide; only the initiating row should be pending.
- [ ] OpenCode: choose each offered provider/method pair; verify the selected provider's browser flow. The current app intentionally shows status as unknown because OpenCode stores credentials in SQLite and no verified auth-list parser is wired yet.
- [ ] Custom CLI: confirm no sign-in action is offered.

## Findings

Record OS, CLI versions, provider, and outcome. Do not paste tokens, authorization codes, or raw credential output.

- OS:
- App build / branch:
- CLI versions:
- Result and issues:
