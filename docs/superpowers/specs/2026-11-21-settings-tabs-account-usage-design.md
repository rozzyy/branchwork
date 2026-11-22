# Settings tabs + per-account usage meters — design (short)

Date: 2026-11-21 · Size: small change · Mockup: option B in `.superpowers/brainstorm/34094-1795263081/content/settings-usage.html`

## Intent

Tidy the Settings screen and let the user check usage limits for every connected AI agent account from Settings, with bars, without starting an agent session first.

## Goals

- Settings is split into top tabs: **General** (Appearance + Keyboard), **Agents** (agent behavior: auto-switch, token saver, protected commands), **AI accounts**, **GitHub**.
- AI accounts: grouped per provider; each account is one compact row showing name, Default chip, identity (email/plan when known) and the two headline meters (`headlineWindows`: shortest window + tightest other).
- A row expands (▾/▴) to show every window with label, percent, bar and reset countdown.
- Each row's ⋯ menu (`src/ui/Menu.tsx`) holds Set/clear default, Rename, Log out (only where it exists today), Remove. Sign-in again and login status stay visible on the row, since they need attention.
- Header of the tab: "↻ Check all usage", "＋ Add account", and "updated X ago".
- Remove the Demo section.

## Non-goals / anti-goals

- No new usage sources: only Claude Code and Codex (`agentProfileQuota`) and Muse (`muse usage --json`, one window). Other providers show "Usage not reported by <CLI>". Never a fabricated or zero figure for a failed read (keep last value, marked stale — existing `QuotaView` semantics).
- No background polling in Settings.
- No visual restyle beyond the layout; reuse current tokens, `.panel`, `.chip`, `.ubar`, `usageTone` thresholds (green < 70, yellow 70–89, red ≥ 90).

## Approaches considered

1. **Reuse `useAgentMeters` + fetch on demand** — *chosen.* Add `refreshProfile(ref)` to the store that reads one profile's quota without a session (`ensureProfileDir` → `readProfileQuota`), with the same in-flight guard, stale handling and `setProfileUsage` update. Settings calls it for each Claude/Codex profile when the AI accounts tab mounts and on the refresh buttons. Settings and Agents panes show the same numbers. Cost: one local read per profile, only when asked; O(profiles) IPC calls per "Check all", bounded by the existing per-key in-flight set.
2. Settings-local fetch — rejected: duplicates stale/error logic and can disagree with pane bars.
3. Option 1 + 15 s polling while Settings is open — rejected: constant reads for a rarely-watched screen.

## Decided details

- Usage reflects each CLI's local state, i.e. the last time that account ran; rows show "updated X ago" from `fetchedAtMs`.
- Muse uses the existing `probeOnce` result (single meter); "↻" on a Muse row re-runs the probe.
- All strings come from `src/i18n/en.ts` (English UI; the mockup's Indonesian text is illustrative only).
- Narrow panes: the row stacks (who → meters → actions) under the existing `@container (max-width: 560px)` rules; no horizontal overflow.

## Left to the builder (my calls, adjustable)

- Selected tab is component state, default **General**, not persisted.
- Expanded rows are component state; all collapsed by default.
- Tests: store test for `refreshProfile` (ok / unsupported / failure keeps stale value) and updates to `SettingsScreen.test.tsx` for tabs, ⋯ menu actions, expand, and the "not reported" state.
