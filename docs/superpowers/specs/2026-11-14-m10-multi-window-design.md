# M10 — Multi-window — Design

- **Date:** 2026-11-14
- **Milestone:** M10 (user request; lifts spec §12 deferral "Multi-window")
- **Approach (user):** 2a — every window is an independent workspace.
- **Followed by:** general browser with tabs and free URLs (separate design).

## 1. Intent

Work on several projects/worktrees side by side in separate macOS windows (e.g. one per monitor). Each window has its own active group/project/worktree, its own split layout, its own agent sessions, terminal dock and Terminal screen tabs. Git, PTYs, profiles and settings stay shared in the one backend process.

## 2. Current state

- One window, label `main` (from `tauri.conf.json`); capability `default.json` is bound to `["main"]`.
- All UI state persists through `loadSetting`/`saveSetting` (`src/ipc/settings.ts`) under global keys: `repos` (selection), `activeWorktrees`, `stage`, `agentSessions`, the dock and Terminal screen keys, `sidebar`, plus app-wide keys (`theme`, settings, profiles, inbox, GitHub).
- Backend events (`pty:output`, `pty:exit`, `agent:status`, `git:changed`) go to every webview; each store already filters by the ids it owns. Worktree watchers are per path, so two windows on different worktrees do not conflict.

## 3. Goals, non-goals, anti-goals

**Goals**
- ⌘⇧N / palette "New window" opens an **empty, isolated** window: no group, no project tabs, no worktree (user decision 2026-11-14), showing Home.
- Pane control "Move to new window" (and palette) opens that screen in a new window and removes it from the current split.
- Each window restores its own selection, layout, agent sessions, dock and Terminal tabs.
- All windows that were open at quit reopen at launch (my call — the user did not answer; it is the more useful default).
- App-wide settings (theme, text size, shortcuts…) changed in one window apply to all open windows.

**Non-goals**
- Moving a running agent/terminal session between windows (sessions belong to the window that started them; moving the Agents screen shows that window's own sessions).
- Per-window settings; window tabs; tearing panes out by drag.

**Anti-goals**
- Two windows restoring the same agent sessions (duplicate CLIs on one conversation).
- Closing a window leaving orphaned PTYs running invisibly.
- Weakening IPC/CSP: new windows get the same capability and navigation guard as `main`, nothing more.

## 4. Approaches

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | Namespace window-scoped setting keys by window label in `ipc/settings.ts`; Rust opens/tracks windows. | Stores stay unchanged; one choke point. |
| B | One shared state in Rust, windows as views on it. | Big rewrite of every store; no benefit for independent workspaces. |

## 5. Design

### 5.1 Window identity and scoped settings

- Labels: `main` and `ws-<n>` (`n` = 1–9999, validated in Rust).
- `ipc/settings.ts` gets `WINDOW_SCOPED_KEYS` = `repos`, `activeWorktrees`, `stage`, `agentSessions`, dock key, Terminal screen key, `sidebar`. For `main` the key is unchanged (existing data keeps working); for `ws-<n>` it is `ws-<n>:<key>`. All other keys stay global.
- Outside Tauri (browser e2e) the label is `main`.

### 5.2 Opening, tracking and restoring windows (Rust)

- `window_open(label: Option<String>) -> String`: validates/creates the next free `ws-<n>`, builds a `WebviewWindow` with the same options as `main` (size 1440×900, min 1000×640, overlay title bar, hidden title, transparent, sidebar vibrancy), loads the app.
- Open window list persisted under the global setting `windows` (labels other than `main`): added on open, removed when the **user closes** a window (`CloseRequested`), kept on app quit, so they reopen at launch.
- `window_restore()` is called by `main` once at startup and opens every saved label.
- Closing a secondary window clears its scoped keys (its workspace is gone).
- Capability `default.json`: `windows: ["main", "ws-*"]`.

### 5.3 Frontend

- `src/state/windows.ts`: `openNewWindow(screen?)`. The new window is seeded (in the same Rust command that opens it) with an empty selection (`repos` with no group/project and `openProjectIds: []`) and a single-pane layout showing `screen`. Nothing from the current workspace is copied.
- ⌘⇧N and palette "New window"; pane control "Move to new window" (moves the screen: seed with that screen, then close the pane here when split; a single pane just opens it there).
- Close of a secondary window: if it has running agent sessions or terminals, confirm ("Close window? N sessions will stop"); then stop them and let the window close.
- Settings sync: after saving a global key the window emits `settings:changed { key }`; other windows reload that store (theme, settings, profiles).

## 6. Constraints

- English strings in `src/i18n/en.ts`; no new dependencies.
- Validate the label in Rust; never create a window from a URL/label supplied by web content beyond the `ws-<n>` pattern.
- `./init.sh` and Playwright stay green (browser mode = single `main` window).

## 7. Left to the builder

- Exact dock / Terminal screen setting key names (read from their modules).
- Window cascade offset for new windows.

## 8. Manual checks (checkpoint M10.1)

- ⌘⇧N opens a second window; choose another project/worktree there; the first window is unchanged.
- Agents in window 2 do not appear in window 1; Terminal tabs likewise.
- Move a pane to a new window.
- Change theme in one window → all follow.
- Quit and relaunch → both windows reopen with their own state; closing window 2 (with a running agent) confirms, stops it, and it does not reopen next launch.
