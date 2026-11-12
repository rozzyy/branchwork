# M5 Manual E2E — Launchpad and Inbox

Run at the prototype desktop stage size and at a narrow stage width.

## Launchpad

- [x] Compare hero, KPI cards, 1.3:1:1 columns, card spacing, and row density with `docs/design/prototype.html`.
- [x] Switch between This group and All groups; confirm project counts and records follow scope.
- [x] Refresh; confirm loading, empty, error, low-quota, project-limit, and worktree-limit states stay inside the dashboard cards.
- [x] Create a worktree from a branch name containing `/`; confirm its destination uses the hyphenated sibling path and the new worktree is selected.
- [x] Start an issue, assign it to an agent, open an agent CLI, and hand over an agent; confirm existing flows still work.
- [x] Open a PR and workflow page; confirm navigation uses the existing safe GitHub route.
- [x] Re-run a failed workflow; confirm the existing confirmation appears and the run refreshes afterward.

## Inbox

- [x] Compare the 400px list/detail split, row density, icon sizes, spacing, and surfaces with the prototype.
- [x] Verify All, Review, Mention, CI, and Agent filters, including unknown GitHub reasons appearing only in All.
- [x] Select rows with keyboard and pointer; confirm selection updates details without marking an item read.
- [x] Use Done, Snooze, and Read all; confirm snooze hides an item for one day and agent events are dismissed.
- [x] Open a PR, workflow, thread, and agent from their context actions.
- [x] Check loading, empty, partial account failure, and quota retry messages.
- [x] At narrow width, confirm the UI shows the list or detail pane and Back to Inbox returns to the list.

Manual desktop and narrow-stage flows confirmed OK by the user on 2026-11-12.
