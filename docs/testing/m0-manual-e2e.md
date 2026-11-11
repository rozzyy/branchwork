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

### S1-04 · Sidebar navigation (all 14 screens)

Click each item in this order: Launchpad, Graph, Files & editor, Changes, Agents, Terminal, Pull requests, Repository, Inbox, Resolve conflicts, Interactive rebase, Blame & history, Compare worktrees, Settings (footer).

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

---

## Stage 3: Arc-style split view

Run Stages 1–2 again first as a regression check (at least S1-04 and S2-01, S2-04).

### S3-01 · Drag a sidebar item to split

1. Open **Agents**.
2. Drag **Changes** from the sidebar over the content area. Move the pointer slowly toward the left, right, top, and bottom edges.
3. Release near the right edge.
4. Close the second pane (✕). Drag **Graph** and release near the bottom edge.

Expected:
- While dragging, a blurred overlay previews the half nearest the pointer, with a label (Split left / right / top / bottom) and the hint "Drop on the left, right, top, or bottom edge".
- Releasing on the right gives Agents | Changes side by side.
- Releasing at the bottom stacks Agents above Graph.
- Moving the drag out of the window removes the overlay.

### S3-02 · Modifier clicks

1. With a single pane, **⌘-click** Graph.
2. Close the second pane, then **⌥-click** Files & editor.

Expected: ⌘-click opens Graph on the right, and ⌥-click opens Files & editor at the bottom.

### S3-03 · Sidebar context menu

1. Right-click **Inbox** in the sidebar and try each split direction.
2. With a split open, right-click one of the two open screens.

Expected:
- The menu offers Open here, Split right (⌘-click), Split left, Split top, and Split bottom (⌥-click). Each item works.
- For a screen that is in the split, the menu also offers "Remove from split".
- Esc or clicking outside closes the menu.

### S3-04 · ⊞ split menu

1. In single-pane mode, click **⊞** in the pane toolbar.
2. Click a screen row.
3. Open ⊞ again and click one of the ◧ ◨ ⬒ ⬓ icons on a row.

Expected:
- The menu lists every screen except the one already open.
- Clicking a row splits it to the right. Each icon splits it to the matching side.

### S3-05 · Pane controls and focus

1. With two panes open, click inside the left pane, then the right pane.
2. Click a sidebar item while the right pane is focused.
3. Click the sidebar item of the screen that is open in the *other* pane.
4. Use **⇄** (swap), **⬒/◫** (orientation), and **✕** (close).

Expected:
- The focused pane has an accent outline.
- Sidebar clicks replace the screen in the focused pane only.
- Clicking a screen open in the other pane just moves focus there. No duplicate pane appears.
- Both open screens are highlighted in the sidebar, with position glyphs ◧/◨ (or ⬒/⬓ when stacked).
- ⇄ swaps the panes, ⬒ turns side-by-side into stacked (and back), and ✕ returns to a single pane.

### S3-06 · Divider

1. Drag the divider left and right as far as it goes.
2. Switch to stacked and drag the divider up and down.
3. Double-click the divider.

Expected:
- The divider highlights in the accent color while hovered or dragged.
- The first pane stops at about 20% and 80% of the width (or height when stacked).
- Double-click resets it to 50/50.
- Text is not selected while dragging, and resizing is smooth.

### S3-07 · Persistence

1. Make a split (for example Agents ⬒ Changes, stacked, with a 70/30 ratio).
2. Quit (⌘Q) and relaunch.

Expected: the same two screens, orientation, and ratio are restored.

### S3-08 · Narrow panes

1. Make a side-by-side split, then shrink the window to its minimum width (1000 px).

Expected: both pane toolbars stay on one line, and long titles are truncated with "…" rather than wrapping.

### Stage 3 result

| Step | Pass/Fail | Notes |
|---|---|---|
| S3-01 | | |
| S3-02 | | |
| S3-03 | | |
| S3-04 | | |
| S3-05 | | |
| S3-06 | | |
| S3-07 | | |
| S3-08 | | |

---

## Stage 4: Command palette, keyboard map, and collapsible sidebar

Run Stages 1–3 again first as a regression check (at least S1-04, S2-01/S2-04, S3-02/S3-03/S3-05).

### S4-01 · Command palette

1. Press **⌘K**, then close with **Esc**. Click the title-bar search pill to reopen it.
2. Type `spl bot gra`; move with **↑/↓**, run with **Enter**, then close with **Esc** or click outside.
3. Try "Go to Changes", "Split right with Graph", "Split bottom with Graph", "Close split view", "Swap split panes", and "Toggle dark / light".
4. Type `what changed?`; run the single **Ask Claude** result.

Expected:
- The glass command palette opens, fuzzy-filters commands, and shows group and shortcut hints.
- Arrow keys move the selected row; Enter runs it; Escape and clicking outside close it.
- The listed navigation, split, and theme commands work. Ask Claude shows the later-milestone toast.
- While open, Tab and Shift+Tab keep focus in the palette input.

### S4-02 · Global keyboard shortcuts

1. Press **⌘\\** twice, then **⌘⇧\\**.
2. Press **⌃⇧G**.
3. Press **1–9** in order, then focus a text input and press a number key.

Expected:
- ⌘\\ toggles a right split; ⌘⇧\\ toggles a bottom split; ⌃⇧G navigates to Changes.
- Number keys 1–9 navigate to Launchpad, Graph, Files, Changes, Agents, Terminal, Pull requests, Repository, and Inbox.
- Number keys do nothing while typing or while the palette or a dialog is open.

### S4-03 · Collapse and restore the sidebar

1. Press **⌘B**, then press it again. Repeat using the title-bar **◧** button.
2. Open the palette and run **Toggle sidebar**.
3. Collapse the sidebar, quit, relaunch, and check its state.
4. While collapsed, drag a nav icon to the stage, use ⌘-click and ⌥-click, and open a nav context menu.

Expected:
- The sidebar toggles between its 232 px full width and 52 px icon rail, consistently from all three entry points.
- The collapsed rail shows icons only; section headings, labels, empty-state text, and split glyphs are hidden. Nav buttons remain accessible by name and expose tooltips.
- The collapsed state survives relaunch.
- Drag-to-split, modifier-click, and context-menu actions still work from the icon rail.

### S4-04 · Native cold-start performance

Run the release smoke test in **S1-09** and record the measured cold start to interactive.

Expected: cold start is under the spec §9 budget of 1.5 s.

### Stage 4 result

| Step | Pass/Fail | Notes |
|---|---|---|
| S4-01 | | |
| S4-02 | | |
| S4-03 | | |
| S4-04 | | cold start = ___ s |

---

## M1 Stage 2: Worktrees and sidebar

Run the completed M0 checks first as a regression check. Open a registered Git repository that has its main worktree and at least two linked worktrees. If needed, create linked worktrees with Git before launching Branchwork.

### M1-S2-01 · Active and pinned worktrees

1. Open the repository and inspect **WORKTREES**.
2. Select a different worktree, then pin it from the picker.
3. Pin the active worktree and inspect the sidebar rows and count.

Expected:
- The active worktree is visible even when unpinned; pinned worktrees are also visible.
- The active worktree is not duplicated when it is pinned.
- The count shows visible worktrees / total worktrees, and selecting a row updates the active worktree.

### M1-S2-02 · Search, pinning, and persistence

1. Open the worktree picker and search by branch name and by path.
2. Pin and unpin entries with their checkboxes.
3. Quit and relaunch Branchwork, then reopen the picker.

Expected:
- Search filters the picker by branch and path.
- Pin choices update the sidebar and are restored after relaunch.
- The active worktree remains visible even if it is not pinned.

### M1-S2-03 · Overflow, status, and refresh

1. Pin enough worktrees to exceed the sidebar's visible rows, then open the overflow row.
2. In a linked worktree, edit a tracked file and save it; revert the edit afterward.
3. If available, inspect worktrees with ahead/behind, conflict, or rebase state.
4. For the §9 performance check, time a status refresh in a worktree containing about 10,000 files.

Expected:
- The overflow row reports additional worktrees and opens the picker.
- Branch and status labels are shown; the changed-file count refreshes after the Git change notification.
- Ahead/behind and conflict/rebase state appears where the repository has those conditions.
- Status refresh is under 200 ms; record the measured time and file count.

### M1-S2-04 · Collapsed sidebar and split interactions

1. Collapse the sidebar and inspect the worktree controls.
2. Select a worktree and use a navigation item to open a split; restore the sidebar.

Expected:
- Collapsed controls retain accessible names/tooltips and remain usable.
- Worktree selection and existing split gestures continue to work.

### M1-S2-05 · Terminal affordance placeholder

Superseded by M3 Stage 1 below: the worktree-row terminal button now opens the Terminal dock. Use M3-S1-06 instead.

### M1 Stage 2 result

| Step | Pass/Fail | Notes |
|---|---|---|
| M1-S2-01 | | |
| M1-S2-02 | | |
| M1-S2-03 | | |
| M1-S2-04 | | |
| M1-S2-05 | | Superseded by M3-S1-06 |

---

## M3 Stage 1: PTY foundation and terminal dock

Run the completed M0/M1 checks first as a regression check. Open a registered Git repository with at least one worktree, then exercise the dock.

### M3-S1-01 · Toggle, shortcut, and session survival

1. Open the dock from the title-bar ❯_ button, then hide it from its × button.
2. Toggle it with ⌃` (Control + backquote).
3. Start a shell tab, run `sleep 60`, hide the dock, switch screens, and reopen it.

Expected:
- The button, the shortcut, and the palette entries all toggle the dock.
- Hiding the dock or switching screens never closes PTY sessions; the `sleep` output resumes on reopen.

### M3-S1-02 · Modes, resize, and geometry persistence

1. Switch through bottom, right, floating, and maximized modes.
2. Drag-resize the bottom and right docks; drag-move and corner-resize the floating dock.
3. Quit and relaunch Branchwork with the dock open.

Expected:
- Bottom/right docks reserve layout space; floating/maximized overlay the content.
- Mode and size persist across relaunch.

### M3-S1-03 · Tabs, worktree binding, and close

1. Open a new tab with ＋ while a worktree is active.
2. Switch between tabs and confirm each session keeps its own output.
3. Type `exit` in a tab and confirm the tab closes by itself; end another shell abnormally (e.g. `kill -9 $$`) and confirm that tab stays with its output until you close it.

Expected:
- Each tab runs the login shell in its worktree; switching preserves sessions.
- Closing a tab closes its PTY and removes it; a cleanly exited shell closes its own tab.
- Abnormally ended sessions stay visible with their output and error state until explicitly closed.

### M3-S1-04 · Split and swap

1. With one tab open, use the split control; with two tabs, toggle the split.
2. Use the swap control and confirm the panes exchange sides.
3. Confirm no more than two dock panes are ever visible.

### M3-S1-05 · Restore after relaunch

1. Open tabs in two registered worktrees, arrange a split, quit, and relaunch.
2. If a saved worktree is no longer registered, confirm the behavior.

Expected:
- Fresh shells start for still-registered worktrees with the saved selection and split.
- Missing worktrees report a restore error without silently dropping the saved tab.

### M3-S1-06 · Entry points

1. Open the dock from each: sidebar worktree hover button, Files toolbar and file context menu, Graph context menu, Changes toolbar and ⋯ menu, palette commands.

Expected: each entry opens the dock on the active (or row) worktree without launching anything else.

### M3-S1-07 · Concurrent sessions (§9 target)

1. Open 8 terminal tabs and run output in each (e.g. `seq 1 200`).

Expected: all 8 sessions stay responsive with no dropped frames; record any lag.

### M3 Stage 1 result

| Step | Pass/Fail | Notes |
|---|---|---|
| M3-S1-01 | | |
| M3-S1-02 | | |
| M3-S1-03 | | |
| M3-S1-04 | | |
| M3-S1-05 | | |
| M3-S1-06 | | |
| M3-S1-07 | | 8-PTY target: ___ |

### M3-S2-01 · Tabs and keyboard access

1. Open the Terminal screen from the sidebar; confirm the empty state and open a tab with ＋.
2. Open a second tab with ⌘T; confirm each tab shows its worktree name and pane count.
3. Close the focused pane with ⌘W; confirm closing the last pane closes the tab and selects a neighbor.

Expected: tabs open shells in the focused pane's worktree (or the active worktree); ×/⌘W agree.

### M3-S2-02 · Nested splits, resize, and maximize

1. Split right (⌘D), then split one pane down (⇧⌘D) to nest; split again in the parent direction.
2. Drag a gutter and confirm siblings clamp at 8%; double-click a gutter to equalize.
3. Maximize the focused pane (⇧⌘↵); confirm only it shows, then restore.

Expected: splits nest and halve correctly; resize never collapses a pane; maximize restores the exact layout.

### M3-S2-03 · Focus movement

1. Click panes and confirm the accent outline follows.
2. Move with ⌥⌘←↑→↓ across nested splits; confirm diagonal neighbors are never picked for a side they do not border.

Expected: focus always lands on the visually nearest pane in the pressed direction.

### M3-S2-04 · Worktree switching and status bar

1. Change a pane's worktree from its header selector; confirm the shell runs `cd` there.
2. Read the status bar: worktree, cwd, "pane i/n", and live columns × rows after resizing the window.

### M3-S2-05 · Broadcast input

1. Toggle broadcast (⌥⌘I or the status button); confirm orange outlines and the "Broadcasting to N panes" status.
2. Type in one pane and confirm every pane receives it; toggle off and confirm input stays local.

### M3-S2-06 · Moves and running-process confirmation

1. From a pane's ⋯ menu, move it to a new tab and to the dock; from a dock tab's ⤴ button, move it back to the Terminal screen — confirm the same live session continues in each place without respawning.
2. With `sleep 60` running, close the pane (⌘W) and the tab (×); confirm both ask first, Cancel keeps the session, and confirming closes it.

### M3-S2-07 · Restore and entry points

1. Build two tabs with splits, broadcast on, and distinct worktrees/cwds; quit and relaunch.
2. Open the Terminal screen from the palette and from the Files/Graph/Changes "Open in Terminal screen" items.

Expected: fresh shells start for registered worktrees, layouts/sizes/focus/broadcast restore, missing worktrees report errors without dropping tabs, and entries land on the screen without extra sessions.

### M3 Stage 2 result

| Step | Pass/Fail | Notes |
|---|---|---|
| M3-S2-01 | | |
| M3-S2-02 | | |
| M3-S2-03 | | |
| M3-S2-04 | | |
| M3-S2-05 | | |
| M3-S2-06 | | |
| M3-S2-07 | | |

### M3-S3-01 · CLI registry and install guidance

1. Open Agents → ＋ New agent; confirm all 7 CLIs are listed (Claude Code, Codex, OpenCode, Gemini CLI, GitHub Copilot, Muse, Custom).
2. For a CLI whose binary is not installed, confirm the card shows install guidance and Start stays disabled for it.

Expected: `copilot --continue` and `muse resume --last` are the resume argv; verified flags match `copilot --help` 1.0.107 / `muse --help` 1.4.14 on this host.

### M3-S3-02 · Profiles: add, login, logout

1. Add a profile for one CLI; confirm the name slugifies, duplicates are rejected, and a login terminal opens with the profile env (`*_CONFIG_DIR`/`HOME` pointing under `~/.branchwork/profiles`).
2. Log out from the profile; confirm only the declared credential files are deleted, the profile record is kept, and re-login works.

Expected: credentials are only ever typed into the vendor CLI; nothing secret is stored, read, or logged.

### M3-S3-03 · New Agent flow validation

1. Open ＋ New agent with no worktree open; confirm Start is refused with a message.
2. Pick CLI + profile + worktree; confirm the preview command shows the profile env and launch argv, and the session spawns.

Expected: nothing spawns until CLI, worktree, and a valid slug are all chosen.

### M3-S3-04 · Sessions grid layout

1. With one session, confirm it fills the whole view.
2. Start a second session; confirm both panes sit side by side at full height.
3. Pin ◧/◨ and confirm conflicts move to the other side; toggle ▦/▭ and confirm all panes follow.

Expected: single and split panes are always full-height; headers are edge-to-edge on every screen.

### M3-S3-05 · Close, Undo, and dock sharing

1. Close a running session; confirm the confirmation appears, Cancel keeps it, and confirming stops it gracefully (worktree kept). Type `exit` in an agent instead and confirm its pane closes by itself.
2. From the Undo toast, confirm the session relaunches with resume argv and the conversation continues.
3. Move a session to the dock (⤴); confirm it stays visible in both places, closing the grid pane only detaches, and the dock owns cleanup.

### M3-S3-06 · Status detection and hooks

1. Start an agent; confirm the pane shows running (pulsing dot + chip).
2. Trigger a permission prompt (or wait 4 s with no output); confirm the pane gets the yellow outline, the sidebar Agents badge counts it, and a toast appears.
3. With the app unfocused, repeat step 2 and confirm a macOS notification arrives.
4. Hook path with a real CLI: in a Claude session, trigger a permission prompt; confirm the pane flips to waiting promptly (hook beats the 4 s timer) and back to running on new output. (Skipped when the sidecar was missing at session start — heuristics still apply; hook delivery itself was verified with the sidecar directly during implementation.)

Expected: hook events beat the 4 s heuristic; malformed/unknown input never touches a session.

### M3-S3-07 · Profile switching and usage limits

1. Add a second profile for one CLI; open the pane chip menu and confirm both profiles (✓ current), "Add account…", and "Manage accounts" (→ Settings).
2. Switch while running; confirm the dialog appears, Cancel keeps the session, and confirming relaunches with the resume command plus a dimmed `↻ Account A → B` line in the new pane.
3. Type `/account` in the pane and confirm it cycles to the next profile without a dialog; ordinary typing is unaffected.
4. Trigger a usage limit (or wait for the 4 s heuristic text); confirm the inline banner with Switch/Dismiss and the toast action both switch and resume. Flip Settings → Agents → Auto-switch off and confirm the banner/toast path asks first.

Expected: no switch ever kills a dock-shared PTY; usage percentages stay hidden; no fabricated numbers anywhere.

### M3 Stage 3 result

| Step | Pass/Fail | Notes |
|---|---|---|
| M3-S3-01 | | |
| M3-S3-02 | | |
| M3-S3-03 | | |
| M3-S3-04 | | |
| M3-S3-05 | | |
| M3-S3-06 | | |
| M3-S3-07 | | |

## M3 Stage 4: Agent handover

### M3-S4-01 · Handover in the same worktree

1. In an agent pane, press ↗; confirm From shows CLI/profile/worktree/status, the source CLI card is disabled, and the note is prefilled with status, `## Task/Done/Remaining`, changed files, and no AI-regenerate button.
2. Edit the note; tick diff + output tail; confirm the preview shows the launch command plus `# note: .branchwork/handover.md`, and Start stays disabled until target CLI + profile resolve.
3. Start with Same worktree; confirm `.branchwork/handover.md` is written, the target session starts, and a dimmed handover line prints in the new pane.

Expected: `git status` stays clean of `.branchwork/` (excluded via `.git/info/exclude`); the source session keeps running unless Stop is ticked.

### M3-S4-02 · Handover to a new worktree

1. Repeat M3-S4-01 with Where = New worktree; confirm the branch defaults to `handover/<branch>-<cli>` and Start is disabled for an empty branch.
2. Start; confirm the worktree is created, the sidebar and all pages follow it, and the new session is visible there.

Expected: no leftover worktree or branch when creation fails midway (error toast, dialog stays open).

### M3-S4-03 · Agents follow the active project/worktree

1. With agent sessions in two worktrees (or projects), switch worktree/project; confirm only that context's sessions show — the others hide without closing.
2. Switch back and forth; confirm terminals stay clean (no replay garble, no stray characters), and typing still goes to the intended session.

Expected: hidden sessions keep running; switching never respawns or replays a terminal.

### M3-S4-04 · Stop-source and validation

1. Hand over with Stop ticked; confirm the source session closes without a second confirmation and the target starts.
2. Hand over without Stop; confirm the source keeps running.
3. Open ＋ New agent with no worktree open; confirm Start is refused with a message.

### M3 Stage 4 result

| Step | Pass/Fail | Notes |
|---|---|---|
| M3-S4-01 | | |
| M3-S4-02 | | |
| M3-S4-03 | | |
| M3-S4-04 | | |

## M3 Stage 5: Switcher, accounts, provider icons

### M3-S5-01 · Pane-header CLI switcher

1. In an agent pane header, open the agent dropdown; confirm it lists all agent CLIs with the session's CLI selected.
2. Pick another CLI; confirm the Handover dialog opens with that CLI preset as target, Same worktree selected, and the Start preview correct.
3. Cancel; confirm no session started or stopped, and the preset is cleared (reopening via ↗ defaults to first non-source again).
4. With the handover dialog open for a pane, confirm that pane's dropdown is disabled while other panes' dropdowns still work.

### M3-S5-02 · Settings agent accounts

1. Open Settings → Agent accounts; confirm every CLI lists its profiles with paths, and Add account buttons are present.
2. Set one profile as default (badge appears); start a New Agent / Race with that CLI and confirm the default profile is used.
3. Clear the default; confirm resolution falls back to the first profile.
4. Log out of a profile; confirm the confirmation appears, only the declared credential files are removed, and the profile record stays for re-login.

### M3-S5-03 · Provider icons in both themes

1. In light and dark mode, confirm agent panes, CLI cards (New/Handover/Race), the contestants list, Settings rows, and toasts show the real provider marks (Claude, Codex, OpenCode, Gemini, Copilot, Meta, terminal for Custom) — monochrome, legible, no missing/tofu glyphs.

### M3 Stage 5 result

| Step | Pass/Fail | Notes |
|---|---|---|
| M3-S5-01 | | |
| M3-S5-02 | | |
| M3-S5-03 | | |

## M3 Stage 6: Right-side project navigation

### M3-S6-01 · Project and group rail

1. Launch the desktop app at a wide window size. Confirm application navigation and worktrees remain in the left sidebar, while all groups and projects appear in the right rail.
2. Select a project from another group. Confirm the active group/project context updates in the title bar and the main workspace follows that project.
3. Search by group name, project name, owner, or path. Clear the query and confirm the full catalog returns.
4. Collapse and expand a group, including Ungrouped. Reload the app and confirm collapse state and project selection persist. Search for a project inside a collapsed group, then clear the query and confirm the group remains collapsed.
5. Add a group, edit it, and delete it. Confirm projects move to Ungrouped on deletion and Undo restores the group. Use Project to open or clone a repository, and confirm group add/move/remove actions remain available.
6. Toggle the project rail from the title bar, reload, and confirm its visibility persists. Resize the window below 1120px and confirm the rail overlays the workspace below the title bar without obscuring it; confirm the left sidebar and worktrees remain usable.
7. Repeat the rail, title-bar context, selection, and search checks in light and dark themes.

### M3 Stage 6 result

| Step | Pass/Fail | Notes |
|---|---|---|
| M3-S6-01 | | |

## M4 Stage 1: GitHub auth

### M4-S1-01 · Device flow sign-in

1. Open Settings → GitHub accounts. Confirm the section is empty on first run (no accounts, no tokens).
2. Click "Sign in with GitHub". Confirm a user code and the `github.com/login/device` verification URI appear, and the app polls without freezing the UI.
3. In a browser, open the URI, enter the code, and authorize. Confirm the account appears in the list with a "Logged in" chip and a toast names the account (username only, never a token).
4. Reload the app. Confirm the account is still listed as logged in (Keychain persistence, no re-login).
5. Press Cancel on a fresh sign-in before authorizing. Confirm polling stops and no account is added.
6. Let a code expire (or deny it). Confirm the inline expired/denied message appears and no account is added.

### M4-S1-02 · PAT sign-in and sign-out

1. In GitHub accounts, enter a wrong token in the PAT field. Confirm an inline error appears and nothing is stored (status stays unlinked).
2. Enter a valid PAT. Confirm the account joins the list with "Logged in" and a toast names the username.
3. Add a second account (device flow or PAT). Confirm both list, set one as default, and clear the default.
4. Sign out of an account with confirmation. Confirm the token is gone (status check no longer linked) and the row is pruned; default falls back to the remaining account.
5. Decline the sign-out confirmation. Confirm nothing changes.

### M4 Stage 1 result

| Step | Pass/Fail | Notes |
|---|---|---|
| M4-S1-01 | | |
| M4-S1-02 | | |

## M4 Stage 3: Repository navigation

### M4-S3-01 · Repository header and account switching

1. Open a GitHub repository with at least two linked accounts. Confirm the repository owner/name, group chip, account control, Star, Watch, Fork, and Refresh fit without overlapping.
2. Confirm Star and Watch counts are visible, their active states are clear, and each action is disabled while its request is in flight.
3. Open the account control and choose another account. Confirm the selected account is shown and repository data refreshes for that account.
4. Switch to another repository owned by an organization. Confirm its remembered account is selected after leaving and returning to the repository.
5. Open a private organization repository accessible to the selected account and configured in GitHub CLI. Confirm its metadata and API-backed tabs load without exposing or copying any token.

### M4-S3-02 · Pull request list and routes

1. Open Pull requests. Confirm the tab count matches the open plus closed totals and both filters show their counts.
2. Select Open and Closed. Confirm each list shows the request number, title, status (including Merged), author, source/target branches, comment count, and update age when available.
3. Open a request from its title and its external-link button. Confirm both open the matching GitHub `/pull/<number>` page in the system browser.
4. Confirm empty and loading states render without affecting the other repository sections.

### M4-S3-03 · Issues and Actions regression

1. On Issues, switch between Open and Closed and filter by a label. Start an issue worktree and confirm its terminal opens.
2. On Actions, inspect run status and rerun a failed workflow after confirmation. Decline a second rerun and confirm no request is sent.

### M4 Stage 3 result

| Step | Pass/Fail | Notes |
|---|---|---|
| M4-S3-01 | | |
| M4-S3-02 | | |
| M4-S3-03 | | |
