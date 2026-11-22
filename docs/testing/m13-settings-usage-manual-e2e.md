# M13 Stage 2 — Settings tabs + account usage: manual E2E

Run in the desktop app (`pnpm tauri dev`) with at least one Claude Code or Codex account that has been used recently.

## Tabs

- [ ] Open Settings: the **General** tab is selected and shows Appearance + Keyboard.
- [ ] **Agents** shows auto-switch, token saver, and protected commands.
- [ ] **AI accounts** shows the agent accounts list; **GitHub** shows GitHub accounts.
- [ ] No "Component preview" (Demo) section on any tab.
- [ ] Theme/accent/density changes still apply immediately and persist after reload.

## AI accounts — usage

- [ ] Opening the tab reads usage once: Claude/Codex rows show two meters (5h + tightest other window) with green/yellow/red bars.
- [ ] ▾ expands a row: every window with percent, bar, "resets in …", "Updated … ago"; ▴ collapses it.
- [ ] "↻ Check usage" in the detail and "↻ Check all usage" in the toolbar refresh the numbers; the numbers match the Agents pane usage meter for the same account.
- [ ] Gemini/OpenCode/Copilot rows say "<CLI> doesn't report plan usage." — never a number.
- [ ] Muse row shows one "Plan limit" meter with its reset, or "No usage data" when signed in with an API key.
- [ ] Simulate a failed read (e.g. temporarily rename the profile's quota file): the last numbers stay, dimmed, with a ⚠ marker; expanded detail says "refresh failed, showing last known values".

## AI accounts — actions

- [ ] ⋯ menu: Set as default / Clear default, Rename…, Log out (only for a logged-in Codex/Gemini/OpenCode profile), Remove account (red, confirms first).
- [ ] "Sign in again" stays on the row for signed-out accounts and starts the browser login without leaving Settings.
- [ ] "Add account…" opens a provider list; providers with no account appear in the "Not connected" line and can be added from there.

## Narrow panes

- [ ] Split Settings into a ~380px pane: tabs stay on one line (scrolling sideways if needed), rows stack (name → meters → actions), no horizontal overflow, ⋯ menu stays on-screen.
