# M10 Manual E2E — Multi-window

Run in the desktop app (`pnpm tauri dev`) on `m10-stage-1`.

- [ ] **M10-01 New window.** ⌘⇧N (or palette "New window") opens a second window with **no project or group selected** ("No project selected"), showing Home; the first window is unchanged.
- [ ] **M10-02 Independent workspace.** In window 2 pick another project/worktree and split panes; window 1 keeps its own selection and layout.
- [ ] **M10-03 Sessions stay per window.** Start an agent and a terminal tab in window 2; they do not appear in window 1.
- [ ] **M10-04 Move pane.** In a split, ⧉ on a pane opens that screen in a new, empty window (pick a project there) and removes it here.
- [ ] **M10-05 Settings sync.** Change theme / text size in one window; every window follows.
- [ ] **M10-06 Quit + relaunch.** With two windows open, quit (⌘Q) and relaunch: both windows reopen with their own project, layout and agent sessions.
- [ ] **M10-07 Close window.** Close window 2 while an agent runs: confirm dialog; on confirm the agent/terminals stop; relaunch does not reopen it.
- [ ] **M10-08 Main window.** Closing the main window quits the app; relaunch reopens the other windows.
- [ ] **M10-09 Limit.** A 9th extra window is refused with a toast.
