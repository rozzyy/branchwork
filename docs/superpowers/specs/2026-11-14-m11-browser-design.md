# M11 — Browser screen (tabs + free address) — Design

- **Date:** 2026-11-14
- **Milestone:** M11 (user request: "UI browser", general browser with tabs and free URLs)
- **Placement (my call, user did not choose):** a stage **screen** ("Browser"), so it splits beside Agents/Changes (M9) and moves to other windows (M10).

## 1. Intent

Look at web pages — a dev server on `localhost`, docs, a PR, a deploy preview — next to the agents and diffs without leaving Branchwork.

## 2. Approach

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | Native child webview per tab (Tauri `unstable` multi-webview: `Window::add_child`), positioned over the Browser pane's content area; React draws the chrome (tabs, address bar, buttons). | Real browser engine, any site works; native view floats above the DOM, so it must hide while app overlays are open. |
| B | `<iframe>` in the pane. | Simple, but most sites forbid framing (X-Frame-Options/CSP) and the app CSP would need loosening. Rejected. |
| C | Separate browser window. | Simpler positioning, but cannot split beside other screens. Rejected for placement. |

## 3. Goals / non-goals / anti-goals

**Goals:** tabs (new, close, switch), address bar (URL or search), back / forward / reload, page title and URL kept in sync, tabs persisted per window, works in splits and secondary windows.

**Non-goals (later):** bookmarks, history list, downloads UI, devtools toggle, zoom, find-in-page, popups (`window.open` / `target=_blank` are not opened).

**Anti-goals:** web pages reaching Branchwork IPC; the browser navigating Branchwork's own webviews; a native view covering menus/dialogs.

## 4. Design

### 4.1 Security
- Capability `default.json` switches from `windows` to `webviews: ["main", "ws-*"]` (per Tauri docs, `windows` grants every webview in the window). Browser webviews are labelled `browser-<window>-<n>` and get **no** capability; remote origins are denied IPC by default too.
- Navigation guard: app webviews keep `is_local_navigation`; browser webviews allow only `http`/`https`.
- Address input is parsed in Rust as well (`http`/`https` only, ≤ 2048 chars); `javascript:`, `file:`, `data:`, `tauri:` rejected.

### 4.2 Rust (`browser.rs`, commands)
- `browser_open(tab_id, url, x, y, w, h)`: create a child webview in the **calling** window (label from tab id, validated `[a-z0-9-]{1,40}`), at the given logical bounds, hidden until shown.
- `browser_set_bounds(tab_id, x, y, w, h)`, `browser_show(tab_id, visible)`, `browser_navigate(tab_id, url)`, `browser_go(tab_id, "back" | "forward" | "reload")`, `browser_close(tab_id)`.
- Page load / title changes emit `browser:state { tabId, url, title, loading }` to the owning window only.
- All commands act only on browser webviews that belong to the calling window.

### 4.3 Frontend
- Screen `browser` (icon 🌐 → "◎", label "Browser") after GitHub in the sidebar; no ⌘ digit.
- Store `src/browser/store.ts`: `tabs: { id, url, title, loading }[]`, `activeId`; window-scoped setting `browserTabs` (URLs + titles + active).
- `BrowserScreen`: tab strip, ← → ↻, address input (Enter = go), content placeholder div measured with ResizeObserver; the active tab's webview is created lazily, shown and kept at that rect; other tabs hidden. Unmount (screen closed) hides all.
- Overlays: while a menu, dialog, palette, shortcut sheet or project picker is open, browser webviews hide; they show again when it closes.
- Address parsing (TS, mirrored in Rust): scheme `http(s)://` → as is; `localhost[:port]` / `127.0.0.1[:port]` → `http://`; looks like a host (has a dot, no spaces) → `https://`; otherwise Google search (user decision 2026-11-14).

## 5. Constraints
- Cargo feature `tauri/unstable` (multi-webview). No new npm/crate dependencies.
- English strings; `./init.sh` + Playwright green (browser mode shows the chrome; the native view is desktop-only).

## 6. Manual checks (checkpoint M11.1)
- Open Browser, type `localhost:1420` and `example.com`, and a search phrase.
- New/close/switch tabs; back/forward/reload; title appears on the tab.
- Split Browser beside Agents; resize dividers — the page follows the pane.
- Open the palette / a menu / a dialog over the page — it is not covered.
- Move Browser to a new window; quit/relaunch restores tabs.
- A page cannot call Branchwork (no IPC); a `javascript:` URL is rejected.
