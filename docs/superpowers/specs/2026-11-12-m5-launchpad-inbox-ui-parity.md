# M5 Task 01 — Launchpad and Inbox prototype parity

Stage 1 of `docs/superpowers/plans/2026-11-12-m5-ui-parity.md`. Redesign the
existing Launchpad and Inbox screens to match their layout and visual treatment
in `docs/design/prototype.html`, while retaining the real data and actions
already provided by the M4 implementation.

## Goal

Make both screens visually recognizable as the prototype at the same desktop
stage size: Launchpad uses the prototype's three-column dashboard composition,
and Inbox uses its 400px list plus selected-item detail pane. Match spacing,
card treatment, status marks, and row density. Do not replace live data with the
prototype's sample content.

## Acceptance criteria

1. **Launchpad toolbar:** show the Launchpad title and current-scope summary in
   the shared toolbar. Replace the current dropdown with the prototype's
   segmented current-group / all-groups control. Keep New Worktree as the
   primary action and retain manual refresh as a compact secondary action.
   New Worktree prompts for a branch name, derives the sibling destination by
   replacing `/` in the branch with `-`, calls the existing `createWorktree`
   IPC, then reloads/selects the new worktree. Disable it when no active project
   exists; add no backend command or shell invocation.
2. **Launchpad hero and KPIs:** use a full-width hero row with a time-aware
   greeting and one concise, live summary. Place three compact KPI cards on the
   right: open PRs, worktrees, and completed CI runs in the last 24 hours shown
   as passed/total. Draw small inline sparklines from the same bounded 24-hour
   run data. Do not show a percentage without its count or fabricate summary
   events that the loaded data cannot establish.
3. **Launchpad grid:** at the prototype desktop width, use a 20px content
   inset, 14px grid gaps, and columns in a 1.3:1:1 ratio. The left
   “Needs your attention” card spans two rows and contains open PRs followed
   by an “Issues for you” subsection. The center Agents card spans the same
   two rows. The right column contains the CI feed. Preserve natural vertical
   scrolling and use a single-column reading order when the stage is too narrow
   for the three-column layout.
4. **Launchpad visual treatment:** use the prototype's layered surface cards,
   rounded 14px outer cards/KPIs, 12px agent cards, compact rows, status chips,
   colored dots, and subtle hover/selection surfaces. Reuse existing theme
   variables and button primitives; do not add raw palette values. Keep the
   displayed PR, issue, agent, and CI records within the current collection
   limits.
5. **Launchpad actions:** preserve current scope behavior and the existing
   Start-to-worktree, Assign-to-agent, Open CLI, Handover, and safe GitHub
   routes. The CI feed shows Re-run on failed runs and uses the existing
   confirmation and `ghRepoRerun` flow; it adds no backend operation. Keep
   refresh and error/loading/empty/low-quota states available without changing
   their data behavior. Render these states inside their corresponding cards
   so the grid does not jump when data arrives.
6. **Inbox toolbar and filters:** show Inbox with the prototype subtitle
   “GitHub + agents”, the segmented filters All, Review, Mention, CI, Agent,
   and a Read all action. Keep unread status visible with a dot and stronger
   title weight; do not add extra filter chips. Map GitHub reasons
   `review_requested` to Review, `mention` and `team_mention` to Mention,
   `ci_activity` to CI, and agent events to Agent. Other GitHub reasons appear
   only in All.
7. **Inbox split view:** within the screen, use a fixed 400px left list and a
   flexible right detail pane at the prototype desktop width. List rows show a
   30px rounded source icon, title, source/context, relative time, unread dot,
   and selected-row tint. Show compact Done and Snooze controls only on row
   hover/focus. Selecting a row updates the detail pane without automatically
   marking it read.
8. **Inbox detail and actions:** show the selected item’s 44px source icon,
   title, source/context, relative time, and context-specific primary action(s)
   in the right pane, using the prototype’s 24px inset. Keep GitHub navigation
   on the existing validated route API and agent navigation on existing
   session actions. Read all, mark done, and snooze continue to use the existing
   stores and IPC wrappers. Snooze defaults to one day to match the prototype;
   do not show the current per-row duration selector.
9. **Inbox states and responsive behavior:** keep loading, partial-account
   errors, quota retry, and empty states inside the split view. At narrow stage
   widths, show either the list or the selected detail pane with a Back to
   Inbox action; do not compress both panes below readable widths.
10. **Localization and accessibility:** all visible copy stays English per
    repository rules. Controls remain keyboard-operable with visible focus,
    filter state uses `aria-pressed`, list selection and row actions have
    accessible names, and hover-only actions are also available on keyboard
    focus.
11. **Coverage:** update Launchpad and Inbox component tests for the new
    composition, scope/filter selection, selected-detail content, safe action
    routes, read/done/snooze actions, and error/empty states. Add no live GitHub
    dependency. Record desktop and narrow-stage visual checks in the M5 manual
    E2E checklist.

## Performance and security constraints

- Reuse existing fetches, caches, stores, and IPC. Add no endpoint, request,
  polling loop, or per-row network call for this visual redesign.
- Existing bounds remain: at most 8 Launchpad projects, at most 200 worktree
  metadata paths and 30 workflow runs per project, at most 12 displayed PRs and
  issues, at most 8 refreshed GitHub accounts with 50 notifications each, and
  at most 500 retained agent events.
- Filtering and deriving visible rows should remain O(P + R + N), where P is
  selected projects, R is their bounded run/pull/issue data, and N is the
  bounded Inbox item count. Derived arrays should be computed once per data or
  filter change; temporary memory remains O(P + R + N), within the existing
  collection limits.
- Continue constructing GitHub routes through the existing safe route API.
  Never navigate to URLs from notification or API payloads. Do not expose
  account tokens or persist GitHub response bodies.

## Out of scope

- Changes to GitHub polling, cache policy, notification retrieval, or agent
  event persistence.
- New GitHub write operations, new analytics, or new information that is not
  available through the current typed data.
- Changes to the app shell, global navigation, repository screen, or shared
  design tokens.
- Matching the prototype's Indonesian copy; the app remains English.

## Visual reference

- Launchpad CSS and markup: `.lp`, `.hero`, `.kpis`, `.kpi`, `.agc`,
  `.card`, `.ch`, and `.row` near the “launchpad” section in
  `docs/design/prototype.html`.
- Inbox CSS and markup: `.ib`, `.ibl`, `.ibi`, and the `V.inbox` renderer near
  the “inbox” section in `docs/design/prototype.html`.
- The prototype is authoritative for composition and visual hierarchy. Reuse
  live Branchwork data and interactions as specified above.

## Status

Spec reviewed 2026-11-12. Implementation, automated coverage, and desktop/narrow-stage manual checkpoint are complete. The user confirmed the manual flows are OK on 2026-11-12.
