# M2 — Changes, files, and editor

**Status:** Stage 2 in progress
**Depends on:** M1 — Repositories, groups, worktrees, and graph (HEAD `955d888`)
**Source of truth:** `docs/superpowers/specs/2026-11-06-branchwork-design.md`, especially §§3.3, 3.4, 4, 6.3, 6.4, 7, 8, 9.
**Visual reference:** `docs/design/prototype.html` (Changes, Files & editor, and Blame sections).

## Goal

Make local edits first-class: inspect the working-tree status with a shared diff renderer, stage/unstage by file/hunk/line, commit with the spec's variants, manage stashes, browse and edit files in a CodeMirror editor against the active worktree, read blame & file history, and offer oplog-based undo for destructive operations. Preserve every behavior shipped in M0 and M1 (shell, split view, palette, settings, catalog, worktrees, graph).

## Architecture and invariants

- Keep every Git and filesystem operation behind typed Rust commands. The WebView must not gain generic shell access. Expose each new command through `specta`-generated types.
- Use `git2` for all reads (status, diff, blame, file history, log) and `tree_builder` + `index` plumbing only where needed for stage/unstage/discard. Shell out to the user's `git` executable with argument arrays (never a shell string) only for writes that genuinely need the CLI: `commit`, `push`, `pull`, `fetch`, `stash`, and the `git apply --cached` patch application for line-level staging. Reuse the filter-safe pattern from `src-tauri/src/worktree.rs` (isolated config, neutralized checkout filters) for every CLI write.
- Opening a repository, loading a file, or computing a diff must never run repository-defined scripts or hooks. Commits run the user's configured hooks; a hook failure surfaces as an actionable error (spec §7).
- Preserve existing persistence (settings, groups, projects, pins). Add a new `oplog` table that is additive and migration-safe; keep it under the same versioned schema setup used in M1 (`src-tauri/src/store.rs`).
- Discards, deletes, and reverts must be reversible per spec §7: the oplog records a snapshot (file content, index state, or HEAD) before the operation so `undo_last` can restore it. File deletes go through the macOS Trash via `trash` crate (or `NSWorkspace`); they are never `unlink` on disk.
- Resolve and validate every path in Rust. Writes refuse paths outside the active worktree, and refuse the repository's `.git` directory.
- Keep screen components independent. Changes/Files/Blame communicate through stores (`repo`, a new `changes` store, a new `files` store) and IPC events; screens never import each other's internals.
- Reuse the shared `DiffModel` renderer from `src/diff/` across Changes, Files (Diff vs HEAD), and Blame. The Rust side returns the `DiffModel` shape described in spec §6.3; the renderer handles side-by-side, inline, intraline, hunk headers, collapse, and the ruler.
- English-only UI strings land in `src/i18n/en.ts` with new namespaces (`changes.*`, `files.*`, `blame.*`, `undo.*`).
- Carry M1 debt forward as *notes*: deep graph pages re-walking, `bool_assert_comparison` clippy warning in `src/repository.rs` tests, missing sidebar ＋ worktree button, status-refresh perf (<200 ms for 10k files) unmeasured. Schedule only what M2 genuinely depends on — specifically, **measure the 10k-file status budget in Stage 2** because that gate asserts it.

## Deferred to later milestones (stub-only, disabled, or absent)

- `✦` AI generate commit message, `✦` AI commit summary, `✦` AI resolve, `✦` Ask agent about this — deferred to M6 (AI). Render the button, keep it disabled with a tooltip `ui.deferred_m6`.
- `Ask agent` link in the editor header and Files context menu — deferred to M3. Render disabled with a tooltip `ui.deferred_m3`.
- PR link in Blame's commit detail, "Open PR" from file history — deferred to M4. Render disabled.
- Conflict resolver, interactive rebase, Compare worktrees — M5. Not touched by M2 (sidebar entries already exist as placeholders).
- "Open in VS Code / Cursor / Zed" — defer to M4+ (needs an allowlisted editor-discovery flow). Keep the menu entry for **Finder** (safe `reveal_in_finder` via `open -R` with an absolute path) and the top-level **Open in Finder** button only.

## Open questions

Each has a recommended default so planning can proceed. Confirm these at the first Stage 1 review.

1. **Discard backup mechanism.** Spec §7 says "content is stashed or copied before discard". Options: (a) write a per-file blob into the oplog SQLite row (cheap; no Git state mutation); (b) stash onto a dedicated `refs/branchwork/discard-backup` ref (richer; survives app reinstall). **Default: (a)**, because it keeps undo scoped to one process, matches M1's oplog expectations in §3.4, and avoids surprising the user's stash list. Revisit in Stage 2 if it fails any acceptance case. **✅ Resolved 2026-11-07 (user): (a) oplog blob.**
2. **Trash integration crate.** Options: (a) `trash` crate 3.x (cross-platform, used by many Tauri apps); (b) Objective-C FFI to `NSWorkspace.recycle`. **Default: (a)**, because it keeps the Rust surface small and is already macOS-10.13-safe. Pin the version and add it as an allowed dependency.
3. **External file-system changes while editing.** Spec §6.4 requires a reload banner when the file is dirty and silent reload when clean. Two watch sources: the M1 `git:changed` debounced watcher (already emitted per worktree), and `notify` on each open editor file. **Default:** reuse the M1 `git:changed` payload plus a lightweight mtime check when the editor regains focus; do not spin up a per-file watcher in M2. If users report lag, add a per-file watcher in M3. **✅ Resolved 2026-11-07 (user): reuse `git:changed` + focus mtime check.**
4. **Line-level staging patch synthesis.** `git apply --cached` with a hand-built patch is the spec's chosen path. The alternative is to update the index entry in Rust (`git2::Index::add_frombuffer`). **Default:** `git apply --cached --unidiff-zero --whitespace=nowarn` with argument arrays, in the isolated-config pattern. The Rust-only path is faster but harder to keep correct across renames and permission changes; defer it.
5. **Blame scope for v1.** Spec §6.4 Blame shows age, author, message, heat stripe, consecutive-line collapse, and links to PR. **Default:** ship everything except the PR link (M4). Ship the "View commit" link to the Graph screen using the M1 inspector.
6. **Commit signing (GPG/SSH).** Not in the M2 spec row, and clone/open does not touch it. **Default:** do not wire anything; the user's `git` config takes effect because we call the CLI. If their config requires signing and it fails, surface the stderr as an actionable toast per §7.
7. **`undo_last` scope.** Spec lists it as an IPC command alongside `op:done{undoable}`. **Default** for M2: implement undo for commit (soft reset to `HEAD@{1}`), discard (restore from oplog blob), delete (restore from Trash), stash-drop (reapply). Other operations are additive in later milestones.

## Stage 1: Status read model and shared diff renderer

Everything in this stage is read-only. It establishes the data shapes the write stages rely on.

### Task 00 — AppError and specta-generated IPC types

Added at M2 start by user decision (full spec §3/§8/§10): `AppError { kind, message, detail?, recoverable }`, `tauri-specta` bindings at `src/ipc/bindings.ts`, migration of all M0/M1 commands, and a drift check in `cargo test`. Task file: `.agent/tasks/m2-task-00.md`.

### Task 01 — Status read model (Rust)

Add a typed `status(worktree_path)` IPC that returns an ordered list of file entries: path, old path (for renames), index status letter, worktree status letter, and byte/line counts for size gating. Use `git2::Repository::statuses` with `include_untracked = true`, `recurse_untracked_dirs = true`, `renames_head_to_index`, and `renames_index_to_workdir`. Group entries into `staged` and `unstaged` lists. A partially-staged file appears in **both**. Mark entries whose working-tree or index blob exceeds 1 MB as `large = true` so the diff layer can short-circuit.

**Tests:** temporary repositories cover modified / added / deleted / untracked / renamed, partially-staged files appearing twice, large-file flag, and empty working tree. IPC tests cover the public contract.

**Security-relevant surfaces:** read-only metadata IPC over a validated worktree path.

### Task 02 — Diff computation and `DiffModel` IPC (Rust)

Add `diff_file(worktree_path, path, area)` where `area ∈ { "staged", "unstaged" }`. Return `DiffModel { hunks: [{ oldStart, newStart, lines: [{ kind: context|add|del, old?, new?, text, intra? }] }], binary, truncated, bytes }`. Use `git2`'s patience diff (`DiffOptions::patience(true)`), with `interhunk_lines = 0` and `context_lines = 3`. Compute intraline word-level highlights in Rust for each paired del/add line (reuse a simple LCS over Unicode scalar values; no external crate). Short-circuit to `binary = true` for detected binary blobs and `truncated = true` when `bytes > 1_048_576`.

**Tests:** diff of M/A/D/U cases, binary detection, 1 MB truncation, intraline on a modified line, unicode safety on a non-ASCII line.

**Security-relevant surfaces:** read-only diff IPC; no CLI invocation.

### Task 03 — Shared diff renderer (React) ✅

Add `src/diff/DiffRenderer.tsx` that accepts a `DiffModel` plus a `mode: "split" | "inline"`, `area: "staged" | "unstaged" | "all"`, and optional callbacks `onToggleLine(hunk, line)` and `onRequestHunkAction(hunk, action)`. Render hunk headers with the chip (`Staged` / `Unstaged`), side-by-side or inline rows, intraline mark spans, a right-edge overview ruler, collapsed-unchanged markers that expand on click, and dimming for off-area hunks. Render a summary card for `binary` or `truncated`. The renderer owns no network/IPC calls; it is pure presentation plus the two callbacks.

**Tests:** Vitest + Testing Library against hand-built `DiffModel` fixtures: side-by-side vs inline layout, off-area dimming, intraline marks, ruler marker counts, truncated/binary summaries, collapse/expand.

**Security-relevant surfaces:** none (pure UI).

### Task 04 — Changes store scaffolding ✅

Add `src/state/changes.ts` Zustand store: `{ entries, loading, error, selection: { path, area }, dmode: "split" | "inline" }`. Expose `refresh(worktreePath)` that calls `status` and `diff_file`, re-subscribes on `git:changed{worktree}` with 250 ms debounce (reuse M1's event), and clears on worktree change. No writes yet; the store exposes a `dispatch` surface that Stage 2 fills in.

**Tests:** store refresh on event, selection persistence across refresh, worktree-switch clearing.

**Security-relevant surfaces:** none (consumes existing M1 IPC + events).

**Stage 1 gate.** `./init.sh`; focused browser E2E for Changes stub (renders a diff fixture through the shared renderer); `code-reviewer`; `security-reviewer` (new read IPC, path validation); §9 perf check for diff render: a 5 000-line patched file under 100 ms wall-clock from `DiffModel` to first paint on the Intel i5-1038NG7 baseline; new `docs/testing/m2-manual-e2e.md` Stage 1 section (open a dirty repo, see the file list and a read-only diff). 🛑 **Manual Checkpoint M2.1.** _(Gate complete 2026-11-07; awaiting user approval.)_

## Stage 2: Changes screen — staging, commit, stashes

### Task 05 — Changes screen scaffold ✅

Replace the Changes placeholder with a two-pane layout: left source-control panel (header with list/tree toggle, refresh button, ⋯ menu placeholder; commit message box with 50/72 counter; commit split-button placeholder; Staged Changes / Changes / Stashes sections; file rows with status letter, strike-through for `D`, hover actions open/discard/stage/unstage; double-click opens Files), right diff pane wired to the shared renderer, with side-by-side/inline toggle in the toolbar. No commit, no stage operations yet; the hover actions dispatch into the Stage 2 Tasks 06–08 reducers.

**Tests:** Vitest for the list/tree toggle, the 50/72 counter transitions (grey → yellow → red), status-letter and strike-through rendering, double-click → Files navigation.

**Security-relevant surfaces:** none (UI only; wiring arrives in later tasks).

- [x] Implement the Changes toolbar, source-control panel, tree/list toggle, stub actions, and Files open intent.
- [x] Add focused Vitest coverage for the Task 05 acceptance cases.
- [x] `./init.sh` — Test Files 28 passed (28), Tests 172 passed (172), Rust 60 passed/0 failed/2 ignored.
- Commit step _(skipped: no-commit rule)_.

### Task 06 — Stage / unstage / discard IPC and reducers ✅

Add Rust IPC: `stage_paths(worktree, paths)`, `unstage_paths(worktree, paths)`, `discard_paths(worktree, paths)`, `stage_hunks(worktree, path, hunk_indices, area)`, `unstage_hunks(worktree, path, hunk_indices)`, `stage_lines(worktree, path, line_ids, area)`, `revert_hunk(worktree, path, hunk_index)`. Implementation: build the index via `git2` where possible (`stage_paths`/`unstage_paths`/whole-file hunk-mode); for partial hunks and line-level staging, synthesize a unified patch from the cached `DiffModel`, write it to a temp file, and invoke `git apply --cached --unidiff-zero --whitespace=nowarn -- <patch>` using argument arrays, inside the M1 filter-isolation pattern (local checkout filters neutralized; `GIT_CONFIG_GLOBAL=/dev/null`). Record every destructive change into the new `oplog` table before applying (file blob snapshot for discard; previous index blob for unstage/stage). Discard refuses untracked files unless an explicit "discard untracked" flag is set (that flag deletes to Trash, not `unlink`). Wire the new IPC into the `changes` store.

**Tests:** temporary-repository Rust tests cover stage_paths (M/A/D), stage_hunks (first hunk only, last hunk only), stage_lines (3 lines across 2 hunks), discard_paths restoring working-tree blob, discard of untracked moving to Trash, and the oplog row shape for each operation. Vitest covers the store reducer plus the file-row hover actions.

**Security-relevant surfaces:** index writes and `git apply --cached` CLI path with argument arrays and isolated config. Path validation refuses paths outside the active worktree and anything under `.git/`.

- [x] Rust stage/unstage/discard/hunk/line IPC + in-process oplog bridge + filter isolation.
- [x] Diff row-level windowing for a single very large hunk (user-approved N-4).
- [x] Changes store dispatch + file-row/section/diff actions + toast/i18n.
- [x] Rust + Vitest coverage for the Task 06 acceptance cases.
- [x] `./init.sh` — Test Files 28 passed (28), Tests 177 passed (177), Rust 71 passed/0 failed/2 ignored; `cargo fmt --check` clean.
- Commit step _(skipped: no-commit rule)_.

### Task 07 — Commit variants and message validator ✅

Add Rust IPC: `commit({ worktree, message, amend, stage_all })`, `commit_and_push({ … })`, `commit_and_sync({ … })`. Writes go through the `git` CLI with argument arrays; stderr is forwarded verbatim into `AppError::GitHook` (hook failures) or `AppError::GitAuth` (push/sync auth). Soft-reset undo path: `commit` records the previous `HEAD` SHA into the `oplog` so `undo_last` can `git reset --soft HEAD@{1}`. Add the UI: commit message box with a split button (Commit ⌘↵, Amend, Commit & Push, Commit & Sync, Commit All, Undo Last Commit — the last entry is wired to the oplog undo path), the branch line (ahead/behind from M1 worktree metadata), a disabled `✦ Generate` with a `deferred_m6` tooltip.

**Tests:** Rust tests for commit, amend (reuses previous message when message is empty), stage-all, commit-and-push error path (mock remote), `undo_last` restoring working-tree + index state after a plain commit. Vitest for the split-button menu, 50/72 counter integration, disabled-state wiring.

**Security-relevant surfaces:** Git CLI writes (commit, push), hook execution via the user's `git` (hooks are the user's own configuration, not repo-injected), argument arrays only.

- [x] Rust `commit` / `commit_and_push` / `commit_and_sync` IPC with pre-write HEAD oplog rows.
- [x] Git CLI argument arrays: `-m`, `--amend --no-edit`, `add -A`, `push`, `fetch --prune`, `rebase` (+ `--abort` on conflict).
- [x] `AppError` classification: `GitHook` (installed-hook fallback when git hides the hook name), `GitAuth`, `GitConflict`; validation for empty messages.
- [x] Changes UI: commit box, split-button and six-item menu, ⌘↵, branch line, Sync without a new message, disabled `✦` with `ui.deferred_m6`.
- [x] Temporary-repository Rust tests for plain commit, amend reuse, stage-all, hook failure, bare-remote push, auth failure, and the `beforeHead` oplog shape.
- [x] Vitest for commit dispatch, menu actions, Sync draft preservation, counter boundaries, and the disabled Generate tooltip.
- [x] `./init.sh` — Test Files 28 passed (28), Tests 186 passed (186), Rust 78 passed/0 failed/2 ignored; Clippy and `cargo fmt --check` clean.
- Commit step _(skipped: no-commit rule)_.

### Task 08 — Stashes

Add Rust IPC: `stash_list(worktree)`, `stash_push(worktree, { message?, include_untracked })`, `stash_apply(worktree, index)`, `stash_pop(worktree, index)`, `stash_drop(worktree, index)`. `stash_push` uses `git stash push` with argument arrays; the others use `git stash` subcommands similarly. `stash_drop` records the dropped stash's ref SHA in the oplog so `undo_last` can `git stash apply <sha>` to recover. Add the Stashes section to the Changes screen with apply/pop/drop and a stash-all entry in the ⋯ menu.

**Tests:** temporary-repository Rust tests for push/list/apply/pop/drop and the drop/undo round-trip. Vitest for the stashes section rendering, the ⋯ menu wiring, and drop → undo toast flow.

**Security-relevant surfaces:** Git CLI writes via argument arrays.

**Stage 2 gate.** `./init.sh`; full Playwright E2E including a new `changes.spec.ts` (stage-file → commit → undo); `code-reviewer`; `security-reviewer` (several write IPC, patch synthesis, undo reversibility); §9 perf check for **status refresh: 10k files < 200 ms** on the baseline machine (this discharges the M1 debt); updated `docs/testing/m2-manual-e2e.md` Stage 2 section (stage hunk, stage line, commit, amend, commit & push against a local bare remote, stash push/pop/drop, undo). 🛑 **Manual Checkpoint M2.2.**

## Stage 3: Files & editor

### Task 09 — Filesystem IPC

Add Rust IPC: `fs_tree(worktree, { show_ignored })` returning a lazy tree (direct children per expanded node; the frontend expands on click) with Git status letters joined in from the `status` read model; `fs_read(worktree, path)` returning bytes + detected encoding + EOL; `fs_write(worktree, path, bytes, expected_mtime)` with optimistic-concurrency rejection on mtime mismatch; `fs_create(worktree, path, kind)` (file or folder); `fs_rename(worktree, from, to)`; `fs_delete(worktree, path)` sending to the macOS Trash via the `trash` crate; `reveal_in_finder(absolute_path)` invoking `open -R` with the absolute path (argument array). Gitignore matching uses `git2::Repository::is_path_ignored`. Every path is resolved and refused if it escapes the active worktree or points under `.git/`.

**Tests:** temporary-repository Rust tests for tree listing (including the ignored-toggle), read/write round-trip with mtime guard, create, rename, delete to Trash (asserts the file is gone and the Trash contains the inode on macOS CI — fall back to asserting the `trash` call shape if macOS CI is unavailable), path-escape refusal.

**Security-relevant surfaces:** filesystem writes, delete-to-Trash, `open -R` with a validated absolute path. New Tauri capabilities: none beyond what M1 exposes; the frontend still goes through typed IPC.

### Task 10 — File manager UI

Replace the Files placeholder with the two-column layout: left side worktree selector, fuzzy file search (`⌘P`, reuse the M0 fuzzy ranker), Open Editors list, project tree with Git status letters + dirty dots, show-ignored toggle, context menu limited to M2 actions (New file, New folder, Rename F2, Duplicate, Delete-to-Trash confirmed, Reveal in Finder, Copy path, Blame, File history, Discard changes). Disabled-with-tooltip for "Open terminal here" (`deferred_m3`), "Ask agent about this" (`deferred_m3`). Right side is the editor host (Task 11). Double-click on a Changes file row (from Stage 2) opens here. The ⌘P search uses the same `fuzzyRank` as the palette and walks the current fs-tree worktree.

**Tests:** Vitest for tree rendering, status-letter + dirty-dot display, show-ignored toggle, context-menu items (visible vs disabled), ⌘P fuzzy-rank integration, discard-changes confirmation dialog.

**Security-relevant surfaces:** none beyond consuming the new IPC.

### Task 11 — CodeMirror editor

Add `src/editor/` with a CodeMirror 6 editor host: tabs (bound to `src/state/files.ts` open-editors list), dirty indicator, breadcrumbs, Git gutter (added / modified / deleted markers computed from the `DiffModel` for that file against HEAD), bracket matching + auto-close, status bar (Ln/Col, selection, Spaces/Tabs, UTF-8, LF/CRLF, language, branch from M1 worktree store). Language modes: TS/JS/JSX/TSX, JSON, Markdown, CSS, HTML, Rust, Go, Python, YAML, TOML — using `@codemirror/lang-*` packages. ⌘S saves via `fs_write` with the editor's remembered mtime (optimistic concurrency; on mismatch surface the external-change banner). **Diff vs HEAD** toggles the editor out for the shared diff renderer. External-change banner (silent reload on clean; "Reload / Keep mine / Compare" on dirty) triggered by `git:changed` events plus an mtime check on focus. **Open in Finder** button wires to `reveal_in_finder`. The `Open in VS Code / Cursor / Zed` menu is omitted; a tooltipped `Open in` button renders only `Finder` and a `deferred_m4` entry.

**Tests:** Vitest for save-flow (mtime guard round-trip), dirty-indicator lifecycle, language-mode mapping, external-change banner (clean-reload vs dirty-prompt), status-bar updates on cursor move, Diff-vs-HEAD toggle calling into the shared renderer. One E2E that opens a file, edits, saves, and sees the Changes count increase.

**Security-relevant surfaces:** CodeMirror is a known dependency; new npm packages (`codemirror`, `@codemirror/lang-*`) land in a single pin set. No remote fetches at runtime. Keep `vite-plugin-pwa` and dynamic-import semantics as M1 left them.

**Stage 3 gate.** `./init.sh`; full Playwright E2E including a `files.spec.ts`; `code-reviewer`; `security-reviewer` (fs writes, `open -R`, Trash, mtime guard); §9 perf check for cold start (<1.5 s) and editor load for a 5 000-line TS file (first paint target: under 150 ms after `fs_read` resolve, documented as a non-§9 note); updated `docs/testing/m2-manual-e2e.md` Stage 3 section. 🛑 **Manual Checkpoint M2.3.**

## Stage 4: Blame, history, and oplog undo

### Task 12 — Blame and file history IPC

Add Rust IPC: `blame(worktree, path)` returning per-line commit SHA, author, timestamp, and first-line-of-message, collapsing consecutive identical SHAs into a `groupId`; `file_history(worktree, path, { limit })` returning `[{ sha, author, message, time }]` using `git2::Revwalk` scoped to the path. `blame` uses `git2::Blame` with default follow options. Bundle an "age heat" field (`hours|days|weeks|months`) so the UI can map it to the stripe color without recomputing dates.

**Tests:** temporary-repository Rust tests for blame of a multi-commit file (correct SHA per line, group collapse), file_history ordering and limit, renamed-file follow behavior (default off; document the choice).

**Security-relevant surfaces:** read-only; path validation.

### Task 13 — Blame screen

Replace the Blame placeholder with the three-column layout from the prototype: file tree (reuse the fs-tree component from Task 10 in a compact mode), blame gutter column with author avatar initials, age heat stripe, and the collapsed group header, and the right-side detail panel showing the selected line's commit (SHA, author, time, full message) and the file-history timeline. "View commit" navigates to the Graph screen at that SHA (reuse the M1 inspector). The PR link is rendered disabled with `deferred_m4`. Reachable from the Files context menu (`Blame`, `File history`) and from the sidebar Tools entry.

**Tests:** Vitest for group collapse rendering, heat-stripe color mapping, selection → detail-panel update, Graph deep-link, disabled PR link.

**Security-relevant surfaces:** none beyond consuming the new IPC.

### Task 14 — Oplog persistence and `undo_last`

Add the `oplog` table to the SQLite schema (migration-safe, idempotent setup in `src-tauri/src/store.rs`): `id INTEGER PRIMARY KEY, worktree_path TEXT, kind TEXT, payload BLOB, created_at INTEGER`. Wire every Stage 2/3 destructive operation (commit, discard, delete-to-Trash, stash-drop) to append a row *before* the operation runs. Add `undo_last(worktree)` IPC that pops the most recent row for that worktree and applies the reverse: commit → `git reset --soft <prev_head>`; discard → restore blob to disk via `fs_write`; delete-to-Trash → `trash::os_limited::restore` or re-`fs_write` from an inline copy; stash-drop → `git stash apply <sha>`. Emit `op:done{undoable}` after every forward op and after undo. Expose `undo_last` through a "Undo last action" command in the palette (reuse the M0 command-list registration) and the existing toast "Undo" action slot used in M0/M1 toasts.

**Tests:** Rust unit tests for each undo kind (commit, discard, delete, stash-drop) round-tripping state; a schema-migration test that an older SQLite without `oplog` gains it idempotently; Vitest for the palette command + toast-action wiring.

**Security-relevant surfaces:** SQLite schema migration (additive), CLI reset/stash-apply (argument arrays), Trash restore.

### Task 15 — M2 wrap-up polish

Narrow surface task: add any missing i18n strings (`changes.*`, `files.*`, `blame.*`, `undo.*`, `ui.deferred_m3`, `ui.deferred_m4`, `ui.deferred_m6`), update the palette's command list to include "Toggle staged view", "Open Changes", "Open Files", "Open Blame", "Discard all changes" (confirmed), "Undo last action". Update `docs/testing/m2-manual-e2e.md` Stage 4. **No** functional additions outside this list.

**Tests:** Vitest for the new palette entries and i18n presence.

**Security-relevant surfaces:** none.

**Stage 4 gate.** `./init.sh`; full Playwright E2E; `code-reviewer`; `security-reviewer` (oplog SQLite, undo paths, cross-stage regression sweep); §9 perf check for memory (<400 MB open with 2 repos and the editor loaded — approximate measurement documented); final `docs/testing/m2-manual-e2e.md` update. 🛑 **Manual Checkpoint M2.4** (M2 done).

## Harness check

| Task | Instructions | Scope | Verification | Lifecycle | State |
|------|-----|-------|--------------|-----------|-------|
| 01 Status | spec §6.3 + §3.3 | `src-tauri/src/status.rs`, `src/ipc/status.ts` | Rust temp-repo tests; IPC contract | pure read | consumes M1 worktree state |
| 02 Diff | spec §6.3 + §9 diff budget | `src-tauri/src/diff.rs`, `src/ipc/diff.ts` | Rust tests; 1MB cap; intraline | pure read | — |
| 03 Renderer | spec §6.3 | `src/diff/` | Vitest fixtures | pure UI | stateless |
| 04 Changes store | spec §6.3 + M1 `git:changed` | `src/state/changes.ts` | Vitest; event subscribe | start/stop on worktree | persists only selection |
| 05 Changes UI | spec §6.3 prototype | `src/screens/changes/` | Vitest; counter transitions | mounts/unmounts with router | — |
| 06 Stage/unstage | spec §6.3 + §8 | `src-tauri/src/staging.rs`, `src/ipc/staging.ts`, `src/state/changes.ts` | Rust temp-repo tests; oplog rows | all writes record oplog first | oplog |
| 07 Commit | spec §6.3 + §7 | `src-tauri/src/commit.rs`, `src/ipc/commit.ts`, UI | Rust tests + mock remote | commit writes oplog pre-op | oplog |
| 08 Stash | spec §6.3 | `src-tauri/src/stash.rs`, `src/ipc/stash.ts`, UI | Rust tests + drop/undo | drop writes oplog | oplog |
| 09 fs IPC | spec §6.4 + §8 | `src-tauri/src/fs.rs`, `src/ipc/fs.ts` | Rust tests; path escape refused | delete → Trash | optimistic mtime |
| 10 Files UI | spec §6.4 prototype | `src/screens/files/`, `src/state/files.ts` | Vitest; ⌘P; context menu | mounts with router | open-editors |
| 11 Editor | spec §6.4 | `src/editor/`, `src/screens/files/EditorHost.tsx` | Vitest + 1 E2E | tabs/dirty/save | open-editors + dirty set |
| 12 Blame IPC | spec §6.4 | `src-tauri/src/blame.rs`, `src/ipc/blame.ts` | Rust tests | pure read | — |
| 13 Blame UI | spec §6.4 | `src/screens/blame/` | Vitest | mounts with router | — |
| 14 Oplog + undo | spec §3.4 + §7 | `src-tauri/src/oplog.rs`, store schema, palette | Rust round-trip tests | migration idempotent | SQLite `oplog` |
| 15 Polish | spec §6.1.5 | i18n + palette registry | Vitest | — | — |

Every task has: a clear scope boundary (file lists above), a verification path (Rust temp-repo tests and/or Vitest/Playwright), and resumable state (the oplog is the central undo store; selection/state stores rehydrate from SQLite or memory). No task is flagged.

## Risks

- **Patch synthesis for line-level staging.** Edge cases: CRLF files, trailing newline differences, zero-context hunks across binary boundaries. Mitigation: `--unidiff-zero --whitespace=nowarn`, round-trip tests across both EOL modes, and refuse line-staging on files flagged `binary` or `large`.
- **`git apply --cached` interacting with user filters.** Mitigation: reuse the M1 filter-isolation pattern verbatim. Add a sentinel smudge filter in a Rust test and assert it is not invoked (same test shape as `m1-task-07`).
- **Discard reversibility bytes budget.** A user discarding 500 MB of generated files would bloat `oplog`. Mitigation: cap oplog payload size at 16 MB per row; above that, the toast's Undo action is disabled and the operation is still allowed. Document this in Stage 2.
- **CodeMirror bundle size regression.** Spec §9 doesn't name a bundle budget, but M0 tracked gzip size trend (~77 KB at Stage 3). Adding CodeMirror + language modes may add 100+ KB gzipped. Mitigation: code-split the editor behind a dynamic import so the Changes/Graph bundles stay unaffected. Record the measured delta in the Stage 3 review.
- **Trash restore semantics.** The `trash` crate's `os_limited::restore` requires the original path being available. Mitigation: store the pre-trash absolute path in the oplog row so undo can restore even if the user has navigated elsewhere.
- **M1 deep-graph re-walk** and status-refresh perf are explicitly noted but **not** scheduled unless M2 needs them. The Stage 2 gate measures status refresh (needed), so that debt is discharged there. Deep-graph re-walk stays on the M1 note list.

## Scope deferred beyond M2

Advanced Git actions (conflict resolver, interactive rebase, Compare worktrees) — M5. PTYs, Terminal screen, CLI panes — M3. GitHub data, PRs, Actions, Inbox — M4. AI assists (every ✦ action) — M6. Do not implement these as part of M2.
