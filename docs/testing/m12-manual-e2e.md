# M12 Manual E2E — Stage tabs

Run in the desktop app (`pnpm tauri dev`) on `m12-stage-1`.

- [ ] **M12-01 Separate layouts.** Open Agents, split Changes beside it, then create a new tab. Open History in the new tab. Switch between tabs and confirm each shows its own layout and focus.
- [ ] **M12-02 New tab from sidebar.** Right-click Files & editor → Open in new tab. Confirm a Files tab opens and the current tab's panes remain unchanged.
- [ ] **M12-03 Rename.** Double-click a tab name or focus a tab and press F2. Commit a valid name with Enter and blur; confirm it remains after switching away and back. Press Escape while editing another name and confirm it is canceled. Blank and 41-character names should be rejected with an inline message.
- [ ] **M12-04 Close behavior.** Confirm each tab card has its own close control. Close the active tab and confirm the previous tab becomes active. With one tab left, its close control is disabled.
- [ ] **M12-05 Limit.** Add tabs to the eight-tab limit. Click plus once more; confirm the limit message appears and no ninth tab is created. Use Left/Right and Home/End to navigate tabs by keyboard.
- [ ] **M12-06 Worktrees.** Give two worktrees different tab names and layouts. Switch worktrees and confirm each retains its own tab collection.
- [ ] **M12-07 Persistence and windows.** Create visibly different tab collections and layouts in two windows. Restart the app and confirm each window restores its own active tab, names, and splits.
- [ ] **M12-08 Existing settings migration.** Use a disposable profile copy or prepared v2 settings fixture; confirm it opens as one tab with the prior split layout intact without changing live app data.
- [ ] **M12-09 Narrow width.** Narrow the app window until the tab strip overflows; confirm tabs scroll horizontally and the active tab controls remain reachable.
