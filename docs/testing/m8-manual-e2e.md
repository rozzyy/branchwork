# M8 Manual E2E — Profile switch keeps the conversation

Run in the desktop app (`pnpm tauri dev`) on `m8-stage-1`. Needs two logged-in profiles per CLI (Claude: `personal` + `devhero3`; Codex: e.g. `ulahduri` + one with quota). Mark `[x]` when it behaves as described.

## Stage 1 (Checkpoint M8.1)

- [ ] **M8-01 Claude switch keeps the conversation.** New Claude pane on profile A, tell it a code word, then switch to profile B from the profile chip. The pane restarts on B and answers "what code word did I give you?" correctly. A dim `↻ Account A → B` line appears.
- [ ] **M8-02 Codex switch keeps the conversation.** Same with two Codex profiles.
- [ ] **M8-03 Two panes, one worktree.** Two Claude (or Codex) panes in the same worktree, different code words. Switching each one resumes its own conversation, never the other pane's.
- [ ] **M8-04 After /clear.** In a Claude pane run `/clear`, give a new code word, switch: the *new* conversation continues. Codex: `/new`, same check.
- [ ] **M8-05 Unused pane.** Switch a Claude pane before typing anything: the target starts cleanly, no error toast.
- [ ] **M8-06 Not logged in.** Switch to a logged-out profile: refused with the login toast; the old session keeps running.
- [ ] **M8-07 Usage-limit auto-switch.** When a Claude account hits its limit (or simulate by switching manually from the limit banner), the pane resumes the same conversation on the next profile.
- [ ] **M8-08 Restart.** Quit and reopen the app: each Claude/Codex pane restores its own conversation (not just the latest one in the profile).
- [ ] **M8-09 Close + Undo.** Close a pane and press Undo in the toast: the same conversation resumes.
- [ ] **M8-10 Hook status.** With a Claude pane, the status shows Waiting/Done from hooks after a turn and returns to Running when you type again (regression for the fixed hook event format).
- [ ] **M8-11 Sidebar brand.** The Branchwork logo and name appear above the group/project picker in light and dark; collapsed sidebar shows only the logo.
