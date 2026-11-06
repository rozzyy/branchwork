# M0 Manual E2E Test Spec

Manual end-to-end checks for milestone M0 (Shell & design system). Each stage adds a section. Run every section of finished stages before signing off a checkpoint, so earlier stages act as regression checks.

## Setup

| Item | Value |
|---|---|
| OS | macOS 26 (Tahoe) or later, Apple Silicon |
| Toolchain | Rust ≥ 1.99, Node 22, pnpm 10 |
| Install | `pnpm install` (first time only) |
| Native app | `pnpm tauri dev` (first build: several minutes) |
| Browser build | `pnpm dev` → http://localhost:1420 |
| Automated pre-checks | `./init.sh` (unit + Rust gate), `pnpm test:e2e` (Playwright, browser build) |

Record **Pass / Fail + notes** for every step. On failure, attach a screenshot and the terminal output.

---

## Stage 1: Native window, theme tokens, shell, placeholder screens

### S1-01 · App launches as a native window

1. Run `pnpm tauri dev`.
2. Wait for the window to open.

Expected:
- One window titled "Branchwork" opens at about 1440×900. The process and Dock name are "branchwork" once the Task 4b rename is applied.
- No grey macOS title bar. The traffic lights (red/yellow/green) float at the top-left over the app's own title bar.
- The terminal shows no Rust panic or JS error.

### S1-02 · Liquid Glass vibrancy

1. Put a colorful window or wallpaper behind the app.
2. Look at the sidebar and the title-bar search pill.
3. Click another app (window inactive), then click back.

Expected:
- The sidebar and search pill are translucent and the background blurs through them.
- The main content panel (right) is near-opaque and readable.
- Vibrancy follows the window active state: it dims while inactive and returns when active.

### S1-03 · Window chrome behaviour

1. Drag the empty area of the title bar, between the "Branchwork" label and the search pill.
2. Resize the window down to its minimum.
3. Double-click the title bar.

Expected:
- Dragging moves the window.
- The window cannot shrink below 1000×640, and the layout doesn't break at that size (no horizontal scroll, the sidebar stays visible).
- Double-click follows the macOS setting (zoom or minimize).

### S1-04 · Sidebar navigation (all 13 screens)

Click each item in this order: Launchpad, Graph, Files & editor, Changes, Agents, Pull requests, Repository, Inbox, Resolve conflicts, Interactive rebase, Blame & history, Compare worktrees, Settings (footer).

Expected for each item:
- The pane toolbar title equals the item name.
- The center shows the item's icon, an h2 with the item name, and the line "This screen arrives in a later milestone."
- The clicked item is highlighted with the accent background and accent icon. The previous item is no longer highlighted.
- The content fades/slides in, with no flicker or layout jump.

### S1-05 · Sidebar sections

Expected:
- Sections, in order: navigation items, then **WORKTREES** with the text "Open a repository to see its worktrees", then **TOOLS** with 4 items, then Settings pinned in the footer.
- Long labels never wrap onto 2 lines.

### S1-06 · Language and copy

Expected: every visible string is English, and there are no leftover scaffold strings ("Welcome to Tauri", "greet", and so on).

### S1-07 · Theme tokens (dark default)

Expected:
- Dark theme by default.
- Secondary text (sidebar section headers, placeholder body, search label) is readable. Task 4b raised `--fg3` to meet WCAG AA (≥ 4.5:1). If you have a contrast checker, spot-check it.

### S1-08 · Browser build parity (optional)

1. Run `pnpm dev` and open http://localhost:1420 in Chrome or Safari.

Expected: the same UI appears over a purple/teal gradient backdrop, and S1-04 through S1-06 behave the same.

### S1-09 · Release build smoke (security regression)

1. Run `pnpm tauri build`, then open `src-tauri/target/release/bundle/macos/Branchwork.app`.
2. Measure the time from double-click to the UI being visible.

Expected:
- The app renders fully. Styles load, so the production CSP doesn't block them.
- **Cold start is under 1.5 s** (spec §9). Write down the measured time.

### Stage 1 result

| Step | Pass/Fail | Notes |
|---|---|---|
| S1-01 | | |
| S1-02 | | |
| S1-03 | | |
| S1-04 | | |
| S1-05 | | |
| S1-06 | | |
| S1-07 | | |
| S1-08 | | |
| S1-09 | | cold start = ___ s |

---

## Stage 2: Persisted settings, UI kit, toasts, dialogs, Settings screen

Run Stage 1 (S1-01…S1-08) again first as a regression check.

### S2-01 · Theme mode

1. Open **Settings** → Appearance → Theme.
2. Click **Light**, then **Dark**, then **System**.
3. With **System** selected, switch macOS (System Settings → Appearance) between Light and Dark.

Expected:
- Light and Dark switch instantly. The sidebar glass (native vibrancy) changes together with the content, and text stays readable in both.
- With System, the app follows the macOS change live.

### S2-02 · Accent, base tint, contrast

1. Click each accent swatch, then drag the Accent slider.
2. Drag the Base tint slider.
3. Drag the Contrast slider to both ends.

Expected:
- The accent recolors the active sidebar item, the primary button, and the focus ring.
- Base tint shifts the surface hue.
- Contrast makes secondary text and lines weaker or stronger. At the lowest contrast, secondary text is still readable.

### S2-03 · Reduce transparency and density

1. Toggle **Reduce transparency** on and off, in both Dark and Light.
2. Pick Compact, then Default, then Comfy density.

Expected:
- With Reduce transparency on, the sidebar is solid (no blur) in both themes.
- Density changes the sidebar row height.

### S2-04 · Persistence across relaunch

1. Set: Light, accent hue 25 (orange), contrast high, Reduce transparency on, Compact.
2. Quit the app (⌘Q) and run `pnpm tauri dev` again.
3. Set Theme = **System**, put macOS in **Light**, then quit and relaunch.

Expected:
- Every choice from step 1 is restored after relaunch. A dark frame or two at launch before the saved theme applies is acceptable.
- After step 3, the app starts in Light, with no lingering dark sidebar.
- The settings file exists at `~/Library/Application Support/dev.branchwork.app/app.db`.

### S2-05 · Toast

1. Click **Show toast**.
2. Click its **Undo** button.
3. Show another toast and leave it alone.

Expected:
- The toast slides in at the bottom-right.
- Undo shows an "Undone" toast.
- An untouched toast disappears after about 4 s.

### S2-06 · Dialogs (`ask()`)

1. **Confirm dialog** → click **Push**. Open it again → **Cancel**. Open it again → press **Esc**. Open it again → click the backdrop.
2. **Danger dialog**: check the button and the file list.
3. **Input dialog**: edit the name and press **Enter**. Open it again and click Cancel.

Expected:
- **Confirm dialog:** a glass dialog with an icon. Push gives the toast "Confirmed". Cancel, Esc, and clicking the backdrop each give "Cancelled".
- **Danger dialog:** the button is red, the dialog shows a monospace list of 3 files, and the danger icon is red.
- **Input dialog:** the field is prefilled and selected. Enter gives "Created <your name>". Cancel gives "Cancelled".
- **Everywhere:** no native macOS or browser alert/confirm/prompt box ever appears.

### S2-07 · Keyboard and accessibility

1. Use **Tab** to move through the Settings controls, then press Space or Enter on them.

Expected: every control is reachable, a focus ring is visible, and the segmented and switch controls toggle.

### Stage 2 result

| Step | Pass/Fail | Notes |
|---|---|---|
| S2-01 | | |
| S2-02 | | |
| S2-03 | | |
| S2-04 | | |
| S2-05 | | |
| S2-06 | | |
| S2-07 | | |
