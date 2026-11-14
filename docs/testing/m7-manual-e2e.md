# M7 Manual E2E — UI/UX redesign

Run in the desktop app (`pnpm tauri dev`) on the stage branch. Mark each item `[x]` when it behaves as described; note anything else under the item.

## Stage 1 — Design system foundation (Checkpoint M7.1)

- [ ] **M7-S1-01 Theme switch.** Settings → Appearance → Theme Light, then Dark, then System. Every screen keeps readable text; no screen shows a translucent or "glass" background behind text; switching is immediate. Partial 2026-11-14: switching was immediate in Settings; Light, Dark and System each rendered with solid surfaces and readable labels. System followed the Mac's current light appearance. Other screens were not checked.
- [ ] **M7-S1-02 Text size.** Settings → Appearance → Text size **Large**: text across the sidebar, pane headers, Changes and Settings becomes larger; **Default** returns it. Restart the app: the choice is kept. The old "Contrast" slider and "Reduce transparency" switch are gone. Partial 2026-11-14: Large visibly enlarged Settings and sidebar text; Default restored it. Contrast and Reduce transparency controls were absent. Restart persistence and Changes/pane-header sizing were not checked.
- [ ] **M7-S1-03 Upgrade keeps settings.** On a profile saved before M7 (with a custom contrast or reduce transparency), the app opens normally, theme/accent/density are kept, Text size is Default.
- [ ] **M7-S1-04 Keyboard focus.** Press Tab repeatedly from the title bar through the sidebar into a screen: every focused control shows a clear blue ring; pill-shaped chips and badges keep their pill shape while focused; nothing is focusable without a visible ring. Partial 2026-11-14: Tab focus showed a clear blue ring around the Large text-size control. The full title-bar-to-sidebar traversal and pill focus shapes remain unchecked.
- [ ] **M7-S1-05 Scrollbars.** Long lists (worktrees, Changes file list, Graph, Files tree) show a thin visible scrollbar when they overflow. Partial 2026-11-14: Settings' overflowing content showed a thin scrollbar; the listed long views were not checked.
- [ ] **M7-S1-06 Shapes.** Buttons, inputs, menus, dialogs and toasts have rounded corners (6px controls, 10px menus/dialogs); chips and count badges are pills. No layout broke after the old "everything square" rule was removed. Partial 2026-11-14: Settings controls and panels had the expected rounded shapes; a toast appeared, but its corner radius and menu/dialog shapes were not verified.
- [ ] **M7-S1-07 Danger buttons.** Discard / Remove / Sign out buttons now show a red label on a normal button background (not a solid red fill). Confirm dialogs still mark the destructive action clearly. Partial 2026-11-14: Settings showed red Log out labels on normal button backgrounds. Confirm-dialog danger emphasis was not verified.
- [x] **M7-S1-08 Light contrast spot check.** In Light theme, secondary and tertiary text (timestamps, counts, hints) is comfortably readable. Verified 2026-11-14 on Settings: secondary labels, descriptions, and counts remained readable.
- [ ] **M7-S1-09 Terminal dock unchanged.** Ctrl+` opens and closes the dock exactly as before (bottom / right / float / maximize, tabs, split). Partial 2026-11-14: Ctrl+` opened and closed the bottom dock with an empty terminal state. Other dock modes, tabs, and splits were not tested. During one toggle the main view changed from Settings to Agents, so screen preservation needs a repeat check.

## Stage 2 — Shell and navigation (Checkpoint M7.2)

- [ ] **M7-S2-01 Project picker.** Picker opens from the sidebar; search filters groups/projects; switch project, add/open/clone/init, and group management still work. Escape closes and returns focus to the trigger. Partial 2026-11-14: picker opened with project/group controls; searching `git-version-control` filtered to that project; Escape closed the picker. Add/open/clone/init, group actions, and focus restoration were not tested.
- [ ] **M7-S2-02 Worktrees.** Active and pinned worktrees appear under the project picker with text status; conflict status opens Conflicts. Selecting another worktree updates the breadcrumb. Partial 2026-11-14: picker showed `main` as Active and the feature/Race worktrees as Clean. Switched from main to the feature worktree and back; the breadcrumb updated both times. Conflict routing was not tested.
- [x] **M7-S2-03 Breadcrumb.** Group/project opens the project picker; worktree opens the pinned-worktree menu and switches worktrees. Verified 2026-11-14: project breadcrumb opened the picker; worktree breadcrumb opened a menu with main and the feature worktree; switching to feature and back updated the breadcrumb.
- [ ] **M7-S2-04 Status bar.** Branch, changes, ahead/behind, agent/waiting count and Terminal toggle match current state. Partial 2026-11-14: status showed `main`, 5 changes, 1 agent / 0 waiting, and Terminal toggle. Ahead/behind indicators were not visible in this state.
- [x] **M7-S2-05 Navigation.** Sidebar shows Home, Changes, History, Files, Agents, Terminal, GitHub, then Settings; Conflicts is contextual only. Verified 2026-11-14 from the native sidebar/accessibility order; Conflicts was absent.
- [ ] **M7-S2-06 Saved layout migration.** Open a profile with legacy `graph` + `blame` panes: it opens one History pane in the previously focused mode. Legacy launchpad/repo panes open as Home/GitHub.
- [ ] **M7-S2-07 Shortcuts.** ⌘1–⌘7 opens the matching screens. Bare digits do nothing by default and while typing; enabling the Settings switch enables bare 1–7 outside text inputs. `?` opens the shortcut sheet; Escape closes it and restores focus.
- [ ] **M7-S2-08 Terminal shortcut.** Ctrl+` toggles the dock from a terminal input; bottom/right/float/maximize, tabs and splits remain unchanged.

## Stage 3 — Home and History (Checkpoint M7.3)

- [ ] **M7-S3-01 Home attention.** Inbox filters All/Review/Mention/CI/Agents work; review/mention/CI and waiting/done agents are ordered by recency, conflicts appear first.
- [ ] **M7-S3-02 Inbox actions.** Open/reply, snooze and mark done still work. Review changes on a completed agent switches to its worktree and opens Agents + Changes with Changes focused.
- [ ] **M7-S3-03 Home summary.** Scope selector, New worktree, KPIs, Issues for you and CI feed remain available below attention.
- [ ] **M7-S3-04 History modes.** Graph, File history · blame, and Rewrite history tabs show the existing feature views.
- [ ] **M7-S3-05 Rewrite base.** Base picker lists at most 50 ancestors excluding HEAD; choosing a commit loads the rebase plan.
- [ ] **M7-S3-06 Commit flow.** Graph working-copy inspector has no Stage/Unstage actions. Commit… opens Changes beside (or focuses Changes if already open).
- [ ] **M7-S3-07 File blame.** “Who changed this?” from Files and the editor opens File history · blame at the requested file and line.

## Stage 4 — Context, split and flush restyle (Checkpoint M7.4)

- [ ] **M7-S4-01 Operation banner.** During a real merge/rebase/cherry-pick/revert, banner appears across screens with the correct conflict count. Resolve conflicts opens Conflicts; rebase Continue disables while conflicts remain; Abort asks for confirmation.
- [ ] **M7-S4-02 Conflict route.** Conflicts is absent from the screen menu; the worktree warning opens its resolver; the command palette offers Resolve conflicts only during an operation.
- [ ] **M7-S4-03 Open beside.** Control offers the other primary screens and Agent + Changes / History + Files presets. Swap, close, sidebar click modifiers, drag and right-click splits still work.
- [ ] **M7-S4-04 Per-worktree layout.** Split `/wt/a`, switch to `/wt/b`, then back: each worktree restores its own layout. Legacy single-layout state migrates.
- [ ] **M7-S4-05 Flush surfaces.** Split panes, lone Agents/Terminal, agent grid, Terminal screen panes and dock are square and touch at 1px separators; focused split pane has the 2px accent top edge.
- [ ] **M7-S4-06 Clean Changes.** A clean working tree shows its empty state and Open History action.
- [ ] **M7-S4-07 Every screen.** Check Home, Changes, History (all modes), Files, Agents, Terminal, GitHub, Conflicts and Settings in dark/light and Large text. Text stays ≥12px, focus is visible, scrollbars show when needed, and no glass surface sits behind text.
- [ ] **M7-S4-08 Terminal regression.** Ctrl+` and all dock modes, tabs and split panes behave exactly as before.
