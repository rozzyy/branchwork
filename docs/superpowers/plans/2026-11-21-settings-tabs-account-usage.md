# Settings Tabs + Account Usage Meters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split Settings into top tabs and give every connected AI agent account a compact row with usage bars, an expandable detail and a ⋯ action menu, fetched on demand.

**Architecture:** `useAgentMeters` (src/agents/quota.ts) gains `refreshProfile(ref)` so a profile's quota can be read without a live session; Settings and Agents panes share that cache. `SettingsView` renders a tab bar and one tab body at a time; the AI accounts tab is rebuilt around a new `AccountRow` component.

**Tech Stack:** React 19 + TypeScript, zustand, Vitest + Testing Library, Tauri IPC (`agentProfileQuota`, existing).

**Spec:** `docs/superpowers/specs/2026-11-21-settings-tabs-account-usage-design.md`

## Global Constraints

- All UI strings come from `src/i18n/en.ts` (English). Reuse existing `usage.*` / `settings.*` keys where they fit.
- Usage sources: Claude Code + Codex via `readProfileQuota`; Muse via existing `probeOnce` → `useProfiles.usage` (one window). No other provider shows a figure.
- A failed read never shows 0: keep last value with `stale: true` (existing `QuotaView` semantics); show `usage.stale`.
- No background polling in Settings. Reads happen on AI accounts tab mount, on a row's ↻, and on "Check all usage".
- Bar colors via existing `usageTone` (green < 70, yellow 70–89, red ≥ 90); reuse `.ubar`.
- Tab default **General**, component state, not persisted. Rows collapsed by default.
- Narrow panes (`@container (max-width: 560px)`): row stacks who → meters → actions; no horizontal overflow.
- Repo rules: no per-task commits (Commit steps are `_(skipped: no-commit rule)_`); `./init.sh` green after each task (known Rust FSEvent/PTY failures are baseline).

## Review Focus

1. Profile removed while its quota read is in flight → no crash, stale key harmless (the row is gone). Pinned in Task 1 (`refreshProfile` on unknown/removed profile resolves without throwing).
2. Double-click "Check all usage" → one read per profile, not two (in-flight guard shared with `poll`). Pinned in Task 1.
3. Window whose reset time already passed → shows 0% + "reset" label, not the old percent (use `effectivePercent`/`windowExpired`). Pinned in Task 3.
4. Provider with zero accounts (e.g. OpenCode) → no empty group card; listed in one "Not connected" line with its Add button. Pinned in Task 3.
5. Muse account with `api_key` reason (logged in, no allowance) → "No usage data", not "Usage n/a". Pinned in Task 3.

---

### Task 1: `refreshProfile` in the meters store ✅

**Files:**
- Modify: `src/agents/quota.ts` (refactor `refreshQuota` to take a `ProfileRef`; add `refreshProfile`; move `formatAgo` here and export it)
- Modify: `src/screens/agents/AgentsScreen.tsx` (import `formatAgo` from `../../agents/quota` instead of the local copy)
- Test: `src/agents/quota.test.ts`

**Interfaces:**
- Produces:
  - `useAgentMeters.getState().refreshProfile(ref: ProfileRef): Promise<void>` — no-op returning `{kind:"unsupported"}` for CLIs outside `QUOTA_CLIS`; otherwise same in-flight guard (`inFlight` keyed by `usageKey(ref)`), `loading` on first read, `ok`/`none`/`unsupported`/stale-on-error exactly like `poll`, and updates `useProfiles.setProfileUsage`.
  - `export function formatAgo(atMs: number, now: number): string` (moved unchanged).
  - `export const QUOTA_CLIS` (now exported so Settings can tell which rows get meters).
- `poll` keeps its signature and behavior; it calls the shared per-profile path.

- [x] **Step 1: Write failing tests** in `describe("useAgentMeters.refreshProfile")`:
  - `reads one profile without a session`: `await refreshProfile({cliId:"codex", slug:"main"})` → `readProfileQuota` called with `("codex", "/profiles/codex-main")`; `quotas["codex:main"]` is `{kind:"ok", ...}`.
  - `marks non-quota CLIs unsupported without IPC`: `refreshProfile({cliId:"gemini", slug:"x"})` → `{kind:"unsupported"}`, `readProfileQuota` not called.
  - `shares the in-flight guard`: two concurrent `refreshProfile` calls for the same ref (first read held on a deferred promise) → `readProfileQuota` called once.
  - `keeps last value stale on failure`: ok read, then rejected read → `toMatchObject({kind:"ok", stale:true})`.
  - `does not throw when ensureProfileDir rejects` (removed profile): resolves; state `{kind:"unavailable"}`.
- [x] **Step 2: Run** `pnpm exec vitest run src/agents/quota.test.ts` — Expected: new tests FAIL (`refreshProfile is not a function`).
- [x] **Step 3: Implement.** Extract the body of `poll`'s per-profile closure into `refreshOne(ref: ProfileRef)`, with `refreshQuota` reading `ref.cliId` (the profile's CLI equals the session's). `poll` maps sessions → `refreshOne(session.profile)`; `refreshProfile = refreshOne`. Move `formatAgo`.
- [x] **Step 4: Run** `pnpm exec vitest run src/agents/quota.test.ts src/screens/agents` — Expected: all PASS (existing poll tests unchanged).
- [x] **Step 5: Commit** _(skipped: no-commit rule)_

### Task 2: Settings tabs, Demo removed ✅

**Files:**
- Modify: `src/screens/settings/SettingsScreen.tsx` (`SettingsView`)
- Modify: `src/screens/settings/settings.css`
- Modify: `src/i18n/en.ts`
- Test: `src/screens/settings/SettingsScreen.test.tsx`

**Interfaces:**
- Produces: `type SettingsTab = "general" | "agents" | "accounts" | "github"`; tab bar `role="tablist"` with `role="tab"` buttons (`aria-selected`, pattern from `InboxScreen.tsx:309`), body `role="tabpanel"`.
- Tab → content: general = Appearance + Keyboard panels; agents = existing Agents panel (auto-switch, token saver, protected commands); accounts = `<AgentAccounts />` panel; github = `<GithubAccounts />` panel.
- New i18n keys: `"settings.tabs": "Settings sections"`, `"settings.tab.general": "General"`, `"settings.tab.agents": "Agents"`, `"settings.tab.accounts": "AI accounts"`, `"settings.tab.github": "GitHub"`. Delete `settings.demo*` and `demo.*` keys only if no other file uses them (grep first).

- [x] **Step 1: Write failing tests:**
  - `opens on General`: tab "General" has `aria-selected="true"`; heading "Appearance" visible; "Agent accounts" heading absent.
  - `switches tabs`: click tab "AI accounts" → accounts list visible, "Appearance" absent; click "GitHub" → GitHub panel visible.
  - `has no demo section`: `queryByText(t("settings.demo"))` is null.
  - Update existing account tests to click the "AI accounts" tab first (shared helper `openAccounts()`).
- [x] **Step 2: Run** `pnpm exec vitest run src/screens/settings/SettingsScreen.test.tsx` — Expected: new tests FAIL.
- [x] **Step 3: Implement** tabs with `useState<SettingsTab>("general")`; remove the Demo panel and its handlers. CSS: `.settings-tabs` uses existing `.tab` styling, sits at the top of `.settings`, scrolls horizontally inside itself if narrow; `.settings` content max-width 820px centered (mockup B).
- [x] **Step 4: Run** the same file — Expected: PASS. Then `pnpm typecheck`.
- [x] **Step 5: Commit** _(skipped: no-commit rule)_

### Task 3: AI accounts rows — meters, expand, ⋯ menu, refresh ✅

**Files:**
- Create: `src/screens/settings/AccountRow.tsx` (one profile row: who, headline meters, expand detail, status/sign-in, ⋯ menu)
- Modify: `src/screens/settings/SettingsScreen.tsx` (`AgentAccounts` uses `AccountRow`; `AccountActions` logic for status/login/logout/remove/rename moves into `AccountRow`; tab header with "Check all usage" + "Add account" menu; "Not connected" line)
- Modify: `src/screens/settings/settings.css`, `src/i18n/en.ts`
- Test: `src/screens/settings/SettingsScreen.test.tsx`

**Interfaces:**
- Consumes: `useAgentMeters` (`quotas`, `refreshProfile`), `QUOTA_CLIS`, `headlineWindows`, `windowLabel`, `formatReset`, `formatAgo`, `effectivePercent`, `windowExpired` from `src/agents/quota.ts`; `usageTone`/`UsageBar` from `src/agents/usage.tsx`; `Menu`/`MenuItem` from `src/ui/Menu.tsx`; existing `probeOnce` for Muse.
- `AccountRow` props: `{ cliId: CliId; profile: AgentProfile; isDefault: boolean; onCheckingChange(key: string, checking: boolean): void }`.
- Meter source per row: Claude/Codex → `quotas[usageKey(ref)]`; Muse → `useProfiles.usage[key]` rendered as one window; others → `t("usage.unsupportedHelp", {name})`.
- New i18n keys: `"settings.checkAllUsage": "Check all usage"`, `"settings.checkUsage": "Check usage"`, `"settings.accountMenu": "Actions for {name}"`, `"settings.showUsage": "Show all usage windows"`, `"settings.hideUsage": "Hide usage windows"`, `"settings.notConnected": "Not connected"`. Remove `settings.editProfile` button usage (menu item reuses the label "Edit"→ rename to `"settings.renameAccount": "Rename…"`) and drop now-unused `settings.usageLimit` if nothing else uses it.

Row layout (mockup B): who (name, Default chip, identity or profile path) · up to two headline meters (label, %, bar) · status chip / Sign in again · ▾ toggle · ⋯. Expanded: every window sorted like `headlineWindows` ordering, each with label, %, bar, `usage.resetsIn` (or `usage.resetShort` when expired), plus `usage.updated`/`usage.updatedUnknown`, `usage.stale` when stale, and a ↻ "Check usage" button. ⋯ menu items: Set as default / Clear default · Rename… · Log out (only when `credentialPaths.length > 0` and linked) · separator · Remove account (danger). The ▾ toggle is shown only when the row has quota windows.

- [x] **Step 1: Write failing tests** (mock `readProfileQuota` via `vi.mock("../../ipc/quota")`):
  - `reads usage for claude and codex rows on open`: after `openAccounts()`, `readProfileQuota` called once per Claude/Codex profile; not for gemini.
  - `shows two headline meters and expands to all windows`: quota `[5h 42%, weekly 76%, weekly opus 93%]` → collapsed row shows "5h 42%" and "Weekly · Opus 93%"; click "Show all usage windows" → three rows incl. "resets in".
  - `shows an expired window as 0% reset`: window with `resetsAtMs < now`, percent 80 → shows "0%" and "reset".
  - `check all usage re-reads every quota profile`: click "Check all usage" → `readProfileQuota` call count increases by the number of Claude/Codex profiles.
  - `keeps last values when a refresh fails`: ok then rejected on ↻ → percent still shown + `usage.stale` text.
  - `gemini row says usage not reported`: text `t("usage.unsupportedHelp", {name:"Gemini CLI"})`.
  - `muse api_key account shows no usage data`: probe `{allowance:null, reason:"api_key"}` → `t("usage.none")`, not `usage.na`.
  - `actions live in the ⋯ menu`: click "Actions for Work" → menu items "Set as default", "Rename…", "Remove account"; selecting "Remove account" still calls `ask` with the existing danger dialog (port the existing remove/rename/logout/default tests to go through the menu).
  - `providers without accounts collapse into one line`: no OpenCode profile → no OpenCode group heading; "Not connected" line contains "OpenCode".
- [x] **Step 2: Run** `pnpm exec vitest run src/screens/settings/SettingsScreen.test.tsx` — Expected: new tests FAIL.
- [x] **Step 3: Implement `AccountRow`** and rewire `AgentAccounts`. On mount of `AgentAccounts`: `refreshProfile` for each profile whose `cliId` is in `QUOTA_CLIS`, plus existing Muse probe. "Check all usage" = same calls (Muse re-probed). Bound fan-out: one call per profile, guarded by the store's in-flight set (O(profiles) IPC, no polling). Menu opens at the ⋯ button's `getBoundingClientRect()` bottom-left.
- [x] **Step 4: CSS** in `settings.css`: `.acct-row` grid `who 210px | meters 1fr | actions auto`; `.acct-meters` 2-column grid; `.acct-detail` 3-column grid indented under meters; container query ≤560px stacks to one column. Reuse `.ubar` with `usageTone` color; height 6px.
- [x] **Step 5: Run** the settings test file — Expected: PASS. Then `pnpm typecheck` and `./init.sh`; quote output.
- [x] **Step 6: Manual check** in the running app: AI accounts tab at full width and a 384px pane — no horizontal overflow; ⋯ menu stays on-screen.
- [x] **Step 7: Commit** _(skipped: no-commit rule)_
