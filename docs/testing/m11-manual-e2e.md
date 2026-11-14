# M11 Manual E2E — Browser screen

Run in the desktop app (`pnpm tauri dev`) on `m11-stage-1`.

- [ ] **M11-01 Open pages.** Browser in the sidebar → type `example.com`, a local dev server such as `localhost:3000`, and a phrase (Google search). Pages render inside the pane.
- [ ] **M11-02 Tabs.** New tab (＋), switch, close; the tab shows the page title and a spinner while loading.
- [ ] **M11-03 Navigation.** Back / forward / reload work; following a link updates the address bar.
- [ ] **M11-04 Follows the pane.** Split Browser beside Agents; drag dividers, collapse the sidebar, resize the window — the page stays exactly inside its box.
- [ ] **M11-05 Overlays.** Open the palette (⌘K), a context menu, a confirm dialog and the project picker over the page — each is visible (the page hides meanwhile).
- [ ] **M11-06 Leaving the screen.** Switch the pane to another screen: the page disappears; come back: it is still there.
- [ ] **M11-07 Windows.** Move Browser to a new window (⧉): it opens with its own empty tab set (windows are isolated); quit/relaunch restores each window's tabs.
- [ ] **M11-08 Isolation.** In a page's devtools console (if enabled) `window.__TAURI_INTERNALS__?.invoke?.("settings_get", { key: "theme" })` fails; typing `javascript:alert(1)` searches instead of running; `localhost:1420` (Branchwork's own dev server) is refused with a toast.
- [ ] **M11-09 Permissions.** A site asking for camera/microphone is denied without a prompt.
