# M9 Manual E2E — More than two split panes

Run in the desktop app (`pnpm tauri dev`) on `m9-stage-1`. Mark `[x]` when it behaves as described.

## Stage 1 (Checkpoint M9.1)

- [ ] **M9-01 Build layouts.** Make 3- and 4-pane layouts using each entry point: pane "Open beside" (◨), sidebar ⌘-click (right) / ⌥-click (below) / right-click menu, dragging a sidebar item onto the edge of a specific pane, palette "Split right/bottom with…", ⌘\ and ⌘⇧\.
- [ ] **M9-02 Fifth pane refused.** With 4 panes, any split shows "Up to 4 panes; close one first" and nothing changes; dragging shows the hint instead of a dropzone.
- [ ] **M9-03 Resize.** Drag every divider (nested ones too); panes stop at ~20% / 200 px; double-click a divider equalizes that split.
- [ ] **M9-04 Close.** Close panes in different positions (✕, ⌘⌥\, palette, sidebar "Remove from split"); focus moves to a remaining pane; the last pane cannot close.
- [ ] **M9-05 Swap / orientation.** ⇄ swaps a pane with its neighbor; ⬒ flips only that pane's split.
- [ ] **M9-06 Focus keys.** ⌘⌥←↑→↓ moves focus between stage panes; inside a focused Terminal screen the chord still moves between terminal panes.
- [ ] **M9-07 Per worktree + restart.** Build a 4-pane layout on worktree A, a 2-pane on B; switching restores each; quit and reopen restores both.
- [ ] **M9-08 Old layout.** A profile saved before M9 with a 2-pane layout opens with the same two panes and ratio.
- [ ] **M9-10 Inbox Review changes.** With 3 panes open, Inbox → Review changes on a finished agent: Agents and Changes appear (Changes focused) and the other panes stay.
- [ ] **M9-09 Screens in narrow panes.** Each screen stays usable at quarter size (known: History mode tabs wrap when very narrow).
