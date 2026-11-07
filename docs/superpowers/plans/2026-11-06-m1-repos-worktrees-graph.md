# M1 — Repositories, groups, worktrees, and graph

**Status:** In progress  
**Depends on:** M0 — Shell & design system  
**Source of truth:** `docs/superpowers/specs/2026-11-06-branchwork-design.md`, especially §§3–4, 6.1.1–6.1.3, 6.2, 7–10.

## Goal

Make local repositories first-class: open or clone repositories, organize them into groups, manage worktrees and pins, and browse repository history in the Graph screen. Preserve M0's shell, split view, palette, settings, and accessibility behavior.

## Architecture and invariants

- Keep all Git and filesystem operations behind typed Rust commands. The WebView must not gain generic shell access.
- Use `git2` for repository discovery and reads. Use the user's `git` executable with argument arrays (never a shell string) for clone and worktree writes.
- Opening a repository must not run repository-defined scripts. Clone/setup scripts are out of scope.
- Persist groups, projects, and worktree pins in SQLite; preserve the existing settings table and its data.
- Resolve and validate repository/worktree paths in Rust. Never remove a repository when removing a worktree; refuse unsafe removal of dirty worktrees unless the product flow explicitly preserves their changes.
- Keep screen components independent. Cross-screen state and IPC subscriptions live in stores/hooks.
- Surface recoverable errors through the existing toast/dialog system; do not silently substitute success-shaped results.

## Stage 1: Repository catalog and project groups

### Task 01 — SQLite catalog schema ✅

Add versioned, idempotent schema setup for `groups`, `projects`, and `worktree_pins` to the existing store. Enforce unique project paths, group foreign keys with `ON DELETE SET NULL`, and pin foreign keys with `ON DELETE CASCADE`. Preserve settings behavior and existing databases.

**Tests:** migration is repeatable; settings survive initialization; group deletion ungroups projects; project deletion removes pins; duplicate project paths are rejected.

**Status:** Complete — spec review PASS; `./init.sh` green (typecheck clean, 16 Vitest files/56 tests, Clippy clean, Rust tests 5/5).

### Task 02 — Catalog persistence and IPC ✅

Implement typed Rust models and CRUD for groups, projects, and pins, then expose narrowly scoped Tauri commands and typed frontend wrappers. Validate IDs, paths, required names, and group references. Return explicit errors.

**Tests:** Rust store/command tests cover create, list, update, delete, ungroup, and pin operations; frontend wrappers cover browser fallback and IPC payloads.

**Status:** Complete — spec review and security review PASS; `./init.sh` green (typecheck clean, 17 Vitest files/58 tests, Clippy clean, Rust tests 9/9).

### Task 03 — Open and clone repositories ✅

Implement repository discovery/metadata reads with `git2` and clone via the Git CLI using argument arrays. Reject non-repositories, invalid destinations, and unsafe path cases. Register successfully opened/cloned repositories in the catalog; do not execute hooks or setup scripts automatically.

**Tests:** temporary repositories cover open, invalid paths, clone success/failure, and catalog registration.

**Status:** Complete — spec review PASS; security review APPROVE; `./init.sh` green (typecheck clean, 17 Vitest files/58 tests, Clippy clean, Rust tests 13/13); `cargo fmt --check` clean.

### Task 04 — Repository state and project navigation ✅

Add a repository/group Zustand store, startup restoration, active-project selection, and project tabs. Keep loading and operation errors explicit; switching projects must not corrupt stage or settings state.

**Tests:** store restoration, selection, and failure cases.

**Status:** Complete — spec review PASS; `./init.sh` green (typecheck clean, 19 Vitest files/67 tests, Clippy clean, Rust tests 13/13).

### Task 05 — Group and project switcher ✅

Implement the title-bar switcher/popover with search across groups, projects, and Ungrouped; open/clone entry points; group create/edit (name, color, clone path template), project-to-group movement, and confirmed group deletion that moves projects to Ungrouped with an undo toast. Profile defaults are persisted only if the existing domain contract supports them; profile resolution remains deferred to M3.

**Tests:** focused component tests for search, grouping, open/clone entry points, delete/undo, and keyboard dismissal.

**Status:** Complete — spec review PASS; security review APPROVE; `./init.sh` green (typecheck clean, 20 Vitest files/78 tests, Clippy clean, Rust tests 13/13). Folder input is a text path (no dialog plugin); group profile fields deferred to M3; move via menu (no drag).

### Stage 1 follow-ups ✅

Added after the Stage 1 review and user requests: 05b review fixes (clone off main thread, `~` expansion, popover toggle, undo active group), 05c native folder picker for Open repository (`tauri-plugin-dialog`, `dialog:allow-open`), 05d close/hide project tabs, 05e collapsible group sections, 05g fix for projects invisible in the switcher, 05f remove project from Branchwork with undo, 05h group clone folder via Browse, 05i follow-up review fixes, and 05j per-group Add repository, repository-folder warning, and simpler new-group form. Footer Open repository leaves new projects Ungrouped. Task files: `.agent/tasks/m1-task-05{b..j}.md`.

**Status:** Complete — spec review PASS; code review found no significant issues; security review found no vulnerabilities; `./init.sh` green (117 Vitest, 18 Rust); cargo fmt clean; e2e 48/48.

**Stage 1 gate:** `./init.sh`, targeted browser E2E for repository/group flows, code and security review, then update the manual test spec and stop at Checkpoint M1.1.

## Stage 2: Worktrees and sidebar

### Task 06 — Worktree reads and file watcher ✅

List worktrees and read branch/head/ahead/behind/dirty/conflict/rebase state with `git2`. Add a debounced watcher that coalesces changes per worktree, skips/retries while `.git/index.lock` exists, and emits typed `git:changed` events.

**Tests:** temporary repositories cover main/linked worktree metadata, dirty state, actual filesystem notifications (including newly created top-level directories), independent per-worktree event coalescing, ahead/behind and conflict/rebase state, and index-lock retry behavior.

- [x] Add typed worktree reads and metadata using `git2`.
- [x] Watch worktree files and Git metadata; coalesce and defer on `index.lock`.
- [x] Cover filesystem changes, new directories, per-worktree debounce, and metadata states.
- [x] Commit _(skipped: no-commit rule)_

### Task 07 — Worktree lifecycle and pin persistence ✅

Create worktrees with the Git CLI, list/prune stale registrations, and safely remove only validated worktree paths. Persist pins and automatically pin user-created worktrees; do not pin race/handover worktrees (those arrive in M3).

**Tests:** temporary repositories cover add/list/remove/prune, refusal of unsafe removal, pin persistence, and unchanged repository data.

- [x] Add typed Git-CLI worktree create/remove/prune operations with path validation.
- [x] Automatically pin created worktrees and validate persisted pins against the project.
- [x] Isolate Git configuration and neutralize configured checkout filters during worktree creation; cover with sentinel regression tests.
- [x] Cover lifecycle, unsafe paths/removal, pin persistence, and unchanged repository data.
- [x] Commit _(skipped: no-commit rule)_

### Task 08 — Worktree sidebar and picker ✅

Replace the M0 empty state with pinned worktrees plus the active worktree, the `n/total` count, searchable checkbox picker, overflow row, branch/status display, terminal affordance placeholder, and unpin action. Preserve collapsed-rail behavior and existing split gestures.

**Tests:** focused UI tests for active/pinned visibility, filtering, overflow, unpin, and collapsed mode; E2E for create/pin/select/restore.

- [x] Render the active and pinned worktrees with count, status, overflow, and terminal placeholder.
- [x] Add the searchable pin picker, selection persistence, and collapsed-sidebar behavior.
- [x] Refresh matching worktree metadata on `git:changed` and clean up the listener.
- [x] Cover sidebar interactions and create/pin/select/restore in focused tests and E2E.
- [x] Pass Task 08 spec review and the Stage 2 code, security, and E2E reviews.
- [x] Run `./init.sh`, focused worktree E2E, and full E2E.
- [x] Commit _(skipped: no-commit rule)_

**Stage 2 gate:** Complete — `./init.sh` green (21 Vitest files/129 tests; Clippy clean; Rust 35/35), focused worktree E2E 1/1, full E2E 49/49, code review no significant issues, security re-review no remaining vulnerabilities. Manual test spec updated. User authorized the Stage 2 commit and continuation; status-refresh performance (<200 ms for 10k files) remains unmeasured. Stage commit: `415ce65`.

## Stage 3: Commit graph

### Task 09 — Paged graph read model ✅

Implement a Rust graph query that returns 500 commits per page with stable lane layout, refs, author, message, relative-time source fields, short SHA, and worktree-head markers. Include an active-worktree WIP summary. Avoid loading the full history into the UI.

**Tests:** generated temporary repositories cover branches, merges, tags, worktree heads, pagination, and stable lane assignments.

- [x] Add the typed, read-only Rust graph query and active-worktree WIP summary.
- [x] Return deterministic 500-commit pages with refs, metadata, worktree heads, and stable lane edges.
- [x] Cover branches, merges, tags, linked-worktree heads, WIP, pagination, and lane stability with temporary repositories.
- [x] Add the typed frontend IPC wrapper and contract tests.
- [x] Pass Task 09 spec review and security review.
- [x] Run focused graph tests and `./init.sh`; formatting and diff checks pass.
- [x] Commit _(skipped: stage commit only)_

### Task 10 — Graph screen and inspector ✅

Replace the Graph placeholder with a virtualized commit list, All branches/Worktrees/Mine filters, WIP row, commit/WIP inspector, and a context menu. Implement actions supported by M1; expose later-milestone GitHub, diff, and agent actions only as disabled or clearly deferred entries. Preserve keyboard, split, and palette navigation.

**Tests:** frontend tests cover paging, filters, selection, WIP/commit inspector, and action availability; E2E covers graph browsing and inspector interactions.

- [x] Replace the Graph placeholder with a dedicated toolbar and a 500-row paged, fixed-height virtual list.
- [x] Add All branches, Worktrees, and configured-email Mine filters; report missing Git email and unavailable Agent metadata.
- [x] Add WIP and commit inspectors, including changed paths from typed graph IPC.
- [x] Add the row context menu, typed copy-SHA and create-worktree-at-commit actions; retain existing Git filter protections and disable deferred actions.
- [x] Cover paging, virtualization, filters, inspector, retry, and action availability with focused frontend tests; cover graph browsing and inspection with E2E.
- [x] Run `./init.sh`, focused graph tests, focused graph E2E, Rust formatting check, and `git diff --check`.
- [x] Commit _(skipped: stage commit only)_

**Status:** Task implementation complete. `./init.sh` green (23 Vitest files/140 tests, Clippy clean, Rust 40/40); focused Graph frontend/IPC tests 15/15; focused Graph E2E 1/1; Rust formatting and diff checks clean. Stage 3 review, performance measurement, full E2E, manual spec update, and checkpoint remain outside this task.

### Stage 3 follow-ups ✅

Added after the Stage 3 review and user requests:
- Graph read performance fix: a newest-first heap walk that stops at the page, a per-page topological order, and a fixed short SHA. First page at 100k commits went from 11.19 s to 38.3 ms.
- Code-review fixes I1–I4: consistent page boundaries, `log_graph` off the main thread, Retry at the list end, and `git:changed` reload.
- 10b: Graph and Worktrees sidebar prototype parity.
- 10c: GitKraken-style highlight of the active worktree's branch.

Task files: `.agent/tasks/m1-task-10b.md`, `.agent/tasks/m1-task-10c.md`.

**Stage 3 gate:** `./init.sh`, full E2E, code and security review, performance check against the graph budget, final manual spec update, and stop at Checkpoint M1.3.

**Status:** Complete — user approved Checkpoint M1.3. Code review findings fixed (I2 partially: deep pages still re-walk); security review found no vulnerabilities; spec reviews PASS; `./init.sh` green (145 Vitest, Rust 42 passed/1 ignored); E2E 50/50.

## Scope deferred beyond M1

Changes/editor and diff operations (M2), PTYs and agent sessions (M3), GitHub data and PR/CI decorations (M4), advanced Git actions not required for initial graph browsing (M5), and AI summaries (M6). Do not implement these as part of M1.
