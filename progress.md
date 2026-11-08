# Progress Log

Append newest entries at the top. Each entry: date, task, what changed, verification evidence, next step.

## 2026-11-08: Light-mode report — code verified, awaiting clean retest (branch `m3-stage-1`, uncommitted)

- **Report:** screenshot 17:13 shows Settings with Light selected but the stage rendered black. Pixel inspection confirms store=light (checked pill) but dark CSS tokens (gray pill, black pane).
- **Ruled out:** store logic (settings tests green), rendering pipeline (Playwright probe: clicking Light sets `data-theme=light` and a light pane background), theme writers (all apply store+DOM atomically). Chromium WebKit canvas-`var()` check earlier also green.
- **Likely cause:** transient state in the live `tauri dev` session (running since 16:50) — the screenshot was taken at 17:13, exactly while files were being hot-edited under it (titlebar/settings/shell edits 17:08–17:13). No code path produces store=light/DOM=dark in one tick.
- **Next:** user reloads (Cmd+R) or restarts dev and retests Light. If it persists on a clean boot, treat as a real bug and instrument further. Probe spec removed; nothing shipped.

## 2026-11-08: Theme toggle in navbar + full-width title bar (branch `m3-stage-1`, uncommitted)

- **Changed (user requests):** added the prototype's `◐` theme toggle next to the terminal button (shared `toggleTheme()` store action, also now used by the palette command); regrouped the right-side icons into a flush-right group so the title bar uses the full width instead of ending in a dead 78px spacer.
- **Verification:** `pnpm typecheck` clean; TitleBar/App suites 7/7 (incl. new toggle test + store flip test).
- **Next:** still 🛑 Checkpoint M3.1 — manual M3-S1-01..07 + commit only on go-ahead and order. No push.

## 2026-11-08: Navbar terminal button matches prototype (branch `m3-stage-1`, uncommitted)

- **Changed (user request):** the title-bar terminal toggle now mirrors the prototype's round glass header button (30×30 circle, `var(--glass)` + shadow, accent-tinted when the dock is open) instead of the flat 26×24 `.icon-btn`. CSS-only; no string, behavior, or test changes.
- **Verification:** `pnpm typecheck` clean; shell/App/terminal suites 62/62.
- **Next:** still 🛑 Checkpoint M3.1 — manual M3-S1-01..07 + commit only on go-ahead and order. No push.

## 2026-11-08: Terminal dock header matches prototype (branch `m3-stage-1`, uncommitted)

- **Changed (user request):** dock header now follows `docs/design/prototype.html`: worktree color dot on each tab (reuses sidebar `worktreeColor`), `＋` beside the tabs, flat control row with prototype glyphs (split `⫴`, swap `⇄`, bottom `▁`, right `▕`, float `❐`, max `⤢`, close `✕`), 26×24 buttons, 12px tabs. Removed the app-specific leading `❯_` title and the bordered mode subgroup. No string or behavior changes; dark `--term` surface deliberately not adopted (app themes via surface tokens).
- **Verification:** `pnpm typecheck` clean; affected suites 41/41; `./init.sh` green (41 files / 324 tests; Rust 139/3); `pnpm test:e2e` 76/76.
- **Next:** still 🛑 Checkpoint M3.1 — manual M3-S1-01..07 + commit only on go-ahead and order. No push.

## 2026-11-08: Terminal invisible text fixed — oklch→sRGB conversion (branch `m3-stage-1`, uncommitted)

- **Cause:** xterm.js v6 cannot parse `oklch()` theme colors. In light mode the background rendered black and text invisible; dark mode only worked by accident. Proven with side-by-side raw-xterm probes (light-oklch → black bg + unreadable text; hex control → correct).
- **Fix:** new `src/terminal/colors.ts` converts `oklch()` to `rgb()/rgba()` with pure math before handing colors to xterm (engine-independent, no DOM). `CliPane` uses it for all four theme colors; anything else passes through untouched, with safe fallback to the raw value.
- **Verification:** converter unit tests use browser-canvas ground truth (4 light + 2 dark vectors match channel-for-channel; 1 LSB canvas noise on one channel, confirmed by an independent Python implementation). Screenshot of the real dock in light mode shows white pane + readable text. `./init.sh` green (42 files / 332 tests; Rust 139/3); `pnpm test:e2e` 76/76. Probe specs deleted.
- **Next:** still 🛑 Checkpoint M3.1 — manual M3-S1-01..07 + commit only on go-ahead and order. No push.

## 2026-11-08: Terminal font fix + auto-close on clean exit (branch `m3-stage-1`, uncommitted)

- **Font (user report: unclear, sparse letters):** root cause was `fontFamily: "var(--font-mono)"` passed raw to xterm.js — canvas 2D rejects `var()` (proven in Chromium and WebKit via Playwright probe: the previous font is kept), so the glyph atlas and cell metrics silently used the wrong font. `CliPane` now resolves the token via `getComputedStyle` with an `SF Mono` fallback. Regression test asserts xterm receives no `var(`.
- **Exit (user report: `exit` stuck at logout):** reproduced the backend path with a new Rust test — the Exit event arrives promptly, so the shell was exiting fine; the dead tab just sat there by design. The dock now auto-closes tabs whose session exits cleanly (code 0, no signal) via an exit subscription in `load()`; abnormal ends stay open with output/error state. Regression tests cover auto-close, keep-on-failure, and the pre-existing guard is structural (no subscription existed before).
- **Docs:** manual spec M3-S1-03 updated (clean exit closes, abnormal stays); spec review file carries a follow-up addendum.
- **Verification:** `./init.sh` green — typecheck + Clippy clean; 41 Vitest files / 323 tests; Rust 139 passed / 3 ignored. `pnpm test:e2e` 76/76 (one transient run aborted at 60 passed under load; two clean reruns 76/76, code unchanged).
- **Next:** still 🛑 Checkpoint M3.1 — manual M3-S1-01..07 + commit only on go-ahead and order. No push.

## 2026-11-08: M3 Stage 1 reviews + manual E2E spec (branch `m3-stage-1`)

- **Reviews:** Task 03 spec review PASS (all 7 ACs, `.agent/reviews/m3-task-03-spec.md`); Stage 1 security review PASS, no vulnerabilities (`.agent/reviews/m3-stage-1-security.md`); code review found 2 Important defects, both fixed and re-reviewed PASS (`.agent/reviews/m3-stage-1-code.md`).
- **Fixes:** close-during-spawn/concurrent-retry orphaned PTYs are now closed via a `pendingSpawns` guard + `closeOrphan` cleanup (live-tab respawn refused); dock-chrome Escape no longer fires from inside terminal input. Regression tests fail on the old behavior and pass now (`dock.test.ts` 9/9, `TerminalDock.test.tsx` 5/5).
- **Manual spec:** added M3-S1-01..07 to `docs/testing/m0-manual-e2e.md` (toggle/survival, modes/resize/persistence, tabs/close, split/swap, restore, entry points, 8-PTY target); marked stale M1-S2-05 terminal-placeholder step superseded.
- **Verification:** `./init.sh` — `=== Verification Complete ===`; typecheck + Clippy clean; 41 Vitest files / 320 tests; Rust 138 passed / 3 ignored; `pnpm test:e2e` 76/76. `cargo fmt --check`, `git diff --check` clean.
- **Next:** 🛑 Checkpoint M3.1 — the user runs M3-S1-01..07. On go-ahead plus commit order: one stage commit (Tasks 01–03) on `m3-stage-1`, fast-forward into `main`. No commit or push now.

## 2026-11-08: M3 Task 03 — Terminal dock (branch `m3-stage-1`)

- **Built:** `src/terminal/dock.ts` store (open, bottom/right/floating/maximized modes, geometry, worktree-bound tabs, selected + second split tab with swap, settings persistence, fresh-shell restore with failure retention) and `src/terminal/TerminalDock.tsx` + `terminal-dock.css` (tab strip, mode radio group, split/swap/new/hide controls, drag + keyboard resize, per-tab retry/close). App renders the dock beside/over the stage; hiding unmounts panes (detach only) so sessions survive.
- **Entry points:** title-bar ❯_ toggle, ⌃` shortcut, palette toggle/new-tab commands, sidebar worktree hover, Files toolbar + context menu, Graph context menu, Changes toolbar + ⋯ menu. The Files context-menu test was updated to the new live contract; agent/deferred items stay disabled.
- **Tests:** `dock.test.ts` 6/6 (mode/geometry persistence + restore, tab lifecycle, split/swap, restore with failed worktree kept, no-worktree refusal, active-worktree default) and `TerminalDock.test.tsx` 4/4 (tab switch, split/swap order, close-vs-hide cleanup, mode switch). Plus a ⌃` global-keys test.
- **Verification:** `pnpm typecheck` clean; full Vitest 41 files / 316 tests pass; Rust 138 passed / 3 ignored; `pnpm test:e2e` 76/76; `./init.sh` `=== Verification Complete ===`.
- **Review:** self-checked all 7 ACs against `.agent/tasks/m3-task-03-terminal-dock.md` (no out-of-scope Terminal screen, panes, profiles, or agents). Formal spec-reviewer PASS still pending.
- **Next:** spec review of Task 03, then Stage 1 review gate + manual E2E spec → 🛑 Checkpoint M3.1. No commit or push.

## 2026-11-08: M3 Task 02 — Shared xterm terminal pane (branch `m3-stage-1`)

- **Built:** Added xterm.js `CliPane` with Fit/WebGL addons, session-filtered byte output, UTF-8 chunk continuity, keystroke forwarding, validated debounced resize, explicit exit/error state, and resource cleanup on unmount without closing the PTY.
- **Attach/replay:** Added typed attach/detach IPC, a bounded 256 KiB output history, completed-session retention until owner cleanup, and monotonic view attachment IDs so late attach/detach requests cannot displace a newer pane. Rust regressions cover output/exit before attach, detach/reattach replay, and stale view cleanup.
- **Review:** Spec review PASS (`.agent/reviews/m3-task-02-cli-pane-spec.md`). The review identified and drove fixes for exit-before-attach replay and overlapping mount cleanup.
- **Verification:** `./init.sh` — `=== Verification Complete ===`; Test Files 39 passed (39), Tests 305 passed (305); Rust 138 passed, 0 failed, 3 ignored; TypeScript and Clippy clean. Generated binding drift, `cargo fmt --check`, and `git diff --check` clean.
- **Next:** M3 Task 03 — Terminal dock. Keep the full-screen Terminal workspace and agent controls out of scope; stop after Tasks 01–03 at the Stage 1 manual checkpoint. No per-task commit.

## 2026-11-08: M3 Task 01 — PTY manager and typed IPC (branch `m3-stage-1`)

- **Built:** Added `portable-pty` manager with registered-worktree login-shell spawn, typed spawn/write/resize/close commands, session-scoped output/exit/error events, input/dimension/session validation, and an eight-session cap. Generated Specta bindings and added `src/ipc/pty.ts` with browser guards and focused IPC tests.
- **Cleanup/security:** Focused security review found that killing only the shell could leave descendants running and hold the reader open. Fixed with Unix process-group termination and Windows Job Object `KILL_ON_JOB_CLOSE`; added controlled-child tests for descendant cleanup on close and manager drop. Coordinator acceptance check PASS against all seven Task 01 criteria.
- **Verification:** `./init.sh` — `=== Verification Complete ===`; TypeScript clean; Test Files 38 passed (38), Tests 299 passed (299); Rust 135 passed, 0 failed, 3 ignored; Clippy clean. `cargo fmt --check` and `git diff --check` clean. Windows cross-build could not run because the macOS host lacks a Windows C toolchain.
- **Next:** Task 02 — shared xterm.js `CliPane`. No per-task commit; stop after Tasks 01–03 at the Stage 1 manual checkpoint.

## 2026-11-08: M3 Task 01 — PTY manager and typed IPC (branch `m3-stage-1`)

- **Plan:** Created `docs/superpowers/plans/2026-11-08-m3-terminal-agents.md` with four stages and 12 tasks derived from spec §§6.5–6.6. Added the active Task 01 acceptance criteria in `.agent/tasks/m3-task-01-pty-manager.md`; future features are registered as not-started.
- **Stage branch:** Created `m3-stage-1` from `main` at Stage 5 commit `1336afb`. No code changes yet.
- **Baseline:** `./init.sh` passed on the unchanged `main` baseline: 37 Vitest files / 297 tests; Rust 128 passed / 3 ignored; TypeScript and Clippy clean.
- **Next:** Implement only M3 Task 01, run targeted and full checks, review IPC/process security, then continue Stage 1 tasks in order. No commit or push.

## 2026-11-08: M2 Stage 5 Task 17 — Graph commit history diffs (branch `m2-stage-5`)

- **Built:** Changed files in the selected-commit inspector are accessible buttons that open/activate commit-specific diff tabs in Graph's main editor. Tabs retain SHA/path, coexist with WIP tabs, stay read-only, and compare with the first parent (root commits against an empty tree). The new Tauri IPC validates the project, registered worktree, commit SHA, and repository-relative path; shared binary/size summaries are reused.
- **Tests:** Rust fixtures cover first-parent and root diffs; Vitest covers IPC, clickable inspector paths, commit-specific tabs beside WIP tabs, switching/closing, and the absence of stage/unstage/revert/line-staging controls. Stage 5 manual check M2-S5-01 is documented.
- **Review:** Code review follow-up PASS after hiding the selected-lines staging button on read-only diffs (`.agent/reviews/m2-stage-5-code-review.md`). Focused security review PASS, no findings (`.agent/reviews/m2-stage-5-security-review.md`).
- **Verification:** `./init.sh` — `=== Verification Complete ===`; typecheck and Clippy clean; Test Files 37 passed (37), Tests 297 passed (297), Rust 128 passed/0 failed/3 ignored. `pnpm test:e2e` — 76 passed. `cargo fmt --check` and `git diff --check` clean.
- **Checkpoint:** The user approved M2-S5-01 and ordered Stage 5 closeout. Create the single stage commit and fast-forward into `main`; do not push. M2 v0.2.0 remains unchanged.

## 2026-11-08: M2 Stage 4 review follow-ups (branch `m2-stage-4`)

- **Fixed:** Failed file create/write/rename attempts now remove their pre-write oplog rows. If `git rebase --abort` fails, the sync row is marked non-undoable before the failure callback refreshes UI state. Regression tests cover both paths.
- **Code review:** Follow-up PASS (`.agent/reviews/m2-stage-4-code-review.md`); all findings from the initial review are fixed.
- **Security review:** PASS, no vulnerabilities found (`.agent/reviews/m2-stage-4-security-review.md`); the final focused review covered the failure-path changes.
- **Verification:** `./init.sh` — `=== Verification Complete ===`; typecheck and Clippy clean; Test Files 37 passed (37), Tests 294 passed (294), Rust 126 passed/0 failed/3 ignored. `pnpm test:e2e` — 76 passed. `cargo fmt --check` and `git diff --check` clean.
- **Performance:** E2E's 5 000-line diff metric was 276.0 ms median / 814.8 ms max under four concurrent dev workers; not comparable to isolated production timing. Native memory under the required two-repository/5 000-line-editor setup remains unverified; `.agent/reviews/m2-stage-4-e2e.md` records the blocker.
- **User decisions:** Confirmed Open Question 5 (defer PR links to M4; keep Blame/History/Diff tabs; View commit opens Graph) and Open Question 7 (undo commit, discard, delete-to-Trash, stash-drop). The plan records both decisions.
- **Checkpoint/release:** User approved M2.4 and ordered the Stage 4 commit while explicitly accepting that manual M2-S4-01..05 and native memory remain unverified. Stage commit `300a23a` is on `main`; release commit `c5e4589` and annotated tag `v0.2.0` complete M2. No push.

## 2026-11-08: M2 Task 16 — Graph working-copy inspector (branch `m2-stage-4`)

- **Spec:** Updated design spec §6.2 and added `.agent/tasks/m2-task-16-graph-wip-inspector.md`. Graph WIP gains selectable status files, independent staged/unstaged diff tabs, quick stage/unstage and shared hunk/line actions. Commit, stash, discard, and full source-control workflows remain in Changes.
- **Built:** New `WipInspector` uses the existing `DiffRenderer`, Changes dispatch, and Files navigation. Tabs close individually and reset on active-worktree changes; failed diff reads report inline.
- **Tests:** 3 focused files, 18 tests passed: WIP tab lifecycle and comparison context, stage/hunk dispatch, worktree reset, Graph integration, and i18n keys. Stage 4 manual check M2-S4-04 added.
- **Review:** Coordinator acceptance review PASS (`.agent/reviews/m2-task-16-spec.md`, all 6 ACs).
- **Gate:** `./init.sh` — `=== Verification Complete ===`; typecheck clean; Test Files 36 passed (36), Tests 292 passed (292); Rust 116 passed, 0 failed, 3 ignored; Clippy clean.
- **Next:** Stage 4 review gate (`.agent/tasks/m2-stage-4-review.md`) → 🛑 Checkpoint M2.4. No commit or push.

## 2026-11-08: M2 Task 15 — Wrap-up polish (branch `m2-stage-4`)

- **Built:** Audited Changes, Files, Editor, and Blame for user-facing literals; localized the UTF-8 fallback and editor language names. Added the exact M3/M4/M6 tooltip strings, palette commands for Changes/Files/Blame, staged-view toggle and confirmed discard-all, and verified `undo.last_action`.
- **Tests:** Palette tests cover rendering and dispatch for the new commands, active-worktree undo, and discard confirmation. The i18n test checks all introduced keys and missing-key warnings. Focused Vitest: 5 files, 90 tests passed.
- **Manual spec:** Added Stage 4 palette, discard/undo, blame/history, and destructive-operation checks to `docs/testing/m2-manual-e2e.md`.
- **Review:** Coordinator acceptance review PASS (`.agent/reviews/m2-task-15-spec.md`, all 5 ACs).
- **Gate:** `./init.sh` — `=== Verification Complete ===`; typecheck clean; Test Files 35 passed (35), Tests 289 passed (289); Rust 116 passed, 0 failed, 3 ignored; Clippy clean.
- **Next:** Stage 4 review gate (code/security/E2E, performance, final manual spec) → stop at Checkpoint M2.4. No commit or push.

## 2026-11-08: M2 Task 14 — Oplog persistence and `undo_last` (branch `m2-stage-4`)

- **Built:** SQLite v2 additive/idempotent `oplog` table and descending worktree index; persisted pre-write records across commit, discard, delete-to-Trash, stash-drop and existing Stage 2/3 oplog writers. Per-row BLOB payloads are capped at 16 MiB; oversized snapshots remain recorded as non-undoable. Added `undo_last` with soft reset, discard snapshot restore, Trash restore/inline file fallback, and stash apply; failed reversals retain their rows.
- **Wired:** Typed Tauri `undo_last` and `op:done`; all oplog-recording forward mutations update toast Undo state. The newest non-undoable row blocks undo rather than skipping backward. Commit/rebase emits after the successful write even if a later push fails. Added the active-worktree `undo.last_action` palette command and replaced the old in-process undo intent.
- **Review:** PASS (`.agent/reviews/m2-task-14-spec.md`, all 8 ACs). Review findings on row ordering, partial push failure, and stage-operation event state were fixed and regression-tested.
- **Tests:** Rust migration/idempotence + catalog-preservation, payload cap, failed-insert abort, all four reverse round-trips, failed-reverse retention, non-undoable ordering, and commit-before-failed-push notification. Vitest verifies palette routing and event-driven toast action state.
- **Gate:** `./init.sh` — Test Files 35 passed (35), Tests 283 passed (283), Rust 116 passed/0 failed/3 ignored, Clippy clean. `cargo fmt --manifest-path src-tauri/Cargo.toml --check` clean.
- **Next:** Task 15 — M2 wrap-up polish. No per-task commit; Stage 4 stops at Checkpoint M2.4.

## 2026-11-08: M2 Task 13 — Blame screen (branch `m2-stage-4`)

- **Built:** `src/screens/blame/` — `BlameScreen.tsx` (`BlameToolbar`/`BlameView`), `blameState.ts` (zustand selected-line store), `blame.css`, `BlameScreen.test.tsx` (7 tests). Three columns: compact read-only file tree, grouped blame gutter (one row per Task 12 `groups` entry, per-line heat stripe for all five `age_bucket`s), detail panel with commit card + `FILE HISTORY`. `View commit` deep-links Graph at the SHA; `View PR` disabled with `ui.deferred_m4`. Toolbar segmented Blame|History|Diff + Open in editor. Files context menu now selects the clicked file before navigating to Blame. 20 `blame.*` keys in `en.ts`.
- **Review:** spec-reviewer **PASS** (`.agent/reviews/m2-task-13-spec.md`), 4 non-blocking nits (compact tree duplicated instead of reusing unexported `TreeNode`; `hours→var(--red)` since no orange token exists; detail message is subject-line only per Task 12 IPC; File-history menu item doesn't auto-scroll on entry).
- **Gate:** coordinator-ran `./init.sh` — `Test Files 34 passed (34)`, `Tests 281 passed (281)`, Rust `104 passed; 0 failed; 3 ignored`. Note: one earlier full-suite run flaked a single test; two subsequent full runs were 281/281.
- **Next:** Task 14 — Oplog persistence and `undo_last`. No per-task commit.

## 2026-11-08: M2 Task 12 — Blame and file history IPC (branch `m2-stage-4`)

- **Resumed** from a prior session whose two executors died on a weekly API limit mid-task. Their partial work was in the tree and sound: `src-tauri/src/blame.rs` (419 lines), `lib.rs` registration, regenerated `bindings.ts`, and the `e2e/m2-stage2-changes.spec.ts` rewrite. Completed the missing piece this session.
- **Built:** `blame` via `git2::Blame` (per-line sha/author/time/summary + `age_bucket` hours/days/weeks/months/older against now, consecutive-SHA `groups` collapse) and `file_history` via `Revwalk` `TOPOLOGICAL|TIME` path-scoped by tree diff with `limit`; `NotFound` on untracked paths; worktree validated via `validate_catalog_worktree`. Rename-follow off by default — libgit2's track-copies flags are documented upstream as unimplemented, so `followRenames: true` sets them as a no-op (module header documents this). Frontend: `src/ipc/blame.ts` (`readBlame`/`readFileHistory`, desktop-app guard like `status.ts`) + `blame.test.ts` contract test (3 tests).
- **AC check (self-review vs `.agent/tasks/m2-task-12.md`):** AC-1…AC-8 all met. Rust tests 4/4 (three-commit SHA-per-line + group ranges, history newest-first + limit, age-bucket boundaries with injected `now`, NotFound for both commands).
- **E2E debt closed:** `e2e/m2-stage2-changes.spec.ts` no longer uses the dead `__bwTest` stub or early-return guards; it drives the real Changes UI through a `__TAURI_INTERNALS__` mock with mutable stage/stash state and `__invokeCalls` assertions — **16/16 passed**.
- **Gate:** `./init.sh` — `Test Files 33 passed (33)`, `Tests 274 passed (274)`, Rust `104 passed; 0 failed; 3 ignored`, Clippy clean; `cargo fmt --check` clean.
- **Next:** Task 13 — Blame screen. No per-task commit; Stage 4 stops at Checkpoint M2.4 after Tasks 12–15 + review gate.

## 2026-11-08: M2 Stage 3 gate → 🛑 Checkpoint M2.3

- **Reviews:** code REQUEST CHANGES ×3 → APPROVE WITH NITS; security FAIL → FAIL (High: predictable temp file followed symlinks) → PASS; e2e PASS (`e2e/files.spec.ts`, stale `stage1-shell` Files test fixed).
- **Fixed in the gate:** binary/UTF-16 files read-only (save destroyed them); buffers moved into the files store keyed by worktree+path (edits lost on navigation/worktree/project switch); dirty guard on every worktree and project switch; discard path for dirty tabs; CRLF preserved; Markdown Source mode; Duplicate (I4) and binary Duplicate refused; Changes double-click opens file; tree refresh on `git:changed`; lazy tree + stale guard (user decision); ⌘P index kept across reloads; `fs_read` 10 MiB cap; rename blocked when dirty; symlink-safe discard snapshot; atomic write with O_EXCL temp + kept permissions + writes through in-worktree symlinks; DOMPurify forbids form/style/etc + Rust `on_navigation` local-only guard; false dirty from app edits; i18n for editor strings.
- **User requests:** diff long lines scroll horizontally per hunk (virtualizer needs fixed rows, so no wrap); sidebar grouped Workspace / Code / AI / GitHub (Inbox stays in Workspace).
- **Decisions:** `trash` 5.3.0 confirmed; lazy tree now.
- **Perf:** main JS gzip +4.10 KB; CodeMirror chunk 309.8 KB gzip lazy; editor first paint ~44 ms (mocked IPC). Cold start + real-IPC paint: manual.
- **Still open:** `e2e/m2-stage2-changes.spec.ts` 17 vacuous tests (dead `__bwTest` mock) — rewrite pending user OK. Minors listed in the review reports.
- **Gate:** `./init.sh` — `Test Files 32 passed (32)`, `Tests 271 passed (271)`, Rust `100 passed; 0 failed; 3 ignored`. Playwright `74 passed`.
- **Next:** user runs `docs/testing/m2-manual-e2e.md` Stage 3; on go-ahead, one Stage 3 commit on `m2-stage-3`, ff into `main`.

## 2026-11-08: M2 Task 11 — CodeMirror editor (branch `m2-stage-3`)

- **Built:** `src/editor/` CodeMirror 6 host (lazy chunk), tabs/breadcrumbs, Git gutter (unstaged, staged fallback), status bar with detected indentation, ⌘S with mtime guard + conflict banner, Diff vs HEAD via new `DiffArea::Head` (Rust) + shared DiffRenderer, external-change re-read of every open file (background dirty tabs park the banner until shown).
- **User-requested extra:** Markdown preview (`marked` + `DOMPurify`, full width, loader). Fixed bug: reopening a cached `.md` stuck on spinner (reset effect ran after cache hit); regression test added.
- **Review:** spec FAIL (8 missing, 2 misread) → FAIL (AC-7 background tab) → PASS.
- **Bundle:** main-entry JS gzip 101.88 → 105.98 KB (+4.10 KB); CodeMirror chunk 309.78 KB gzip, loaded only on Files.
- **Found:** `e2e/stage1-shell.spec.ts` nav test still expects the Files placeholder (stale since Task 10) — fix at Stage 3 gate.
- **Gate:** `./init.sh` — `Test Files 32 passed (32)`, `Tests 253 passed (253)`, Rust `96 passed; 0 failed; 3 ignored`.
- **Next:** Stage 3 gate (code-reviewer, security-reviewer, e2e-testing, manual spec) → 🛑 Checkpoint M2.3.

## 2026-11-07: M2 Task 10 — File manager UI (branch `m2-stage-3`)

- **Built:** Files screen (toolbar, worktree select, ⌘P fuzzy search, OPEN EDITORS, status tree with folder change dots, show-ignored, context menu), `src/state/files.ts`, `<EditorHost/>` placeholder.
- **Parity fixes (coordinator):** disabled ❯_ Terminal button, folder dots, shared toolbar alignment bug in `stage.css` (also fixed Changes).
- **Review:** spec FAIL (title "Files", folder Rename) → PASS. Rename for folders deviates from prototype per AC-3.
- **Found:** `e2e/m2-stage2-changes.spec.ts` mock `window.__bwTest` is dead code; its 17 tests early-return and pass vacuously. Rewrite at Stage 3 gate (pending user OK).
- **Gate:** `./init.sh` — `Test Files 31 passed (31)`, `Tests 202 passed (202)`, Rust `95 passed; 0 failed; 3 ignored`.
- **Next:** Task 11 — CodeMirror editor.

## 2026-11-07: M2 Task 09 — Filesystem IPC (branch `m2-stage-3`)

- **Built:** `src-tauri/src/fs.rs` (`fs_tree`, `fs_read`, `fs_write` with ms mtime guard, `fs_create`, `fs_rename` with inverse oplog row, `fs_delete` via `trash ~5.3.0`, `reveal_in_finder(worktree, path)` via `open -R` argument array); `src/ipc/fs.ts` + contract test.
- **Reviews:** spec PASS after one fix (rename oplog inverse). Security APPROVE WITH FIXES → re-review Clear. Fixed in the shared validator (`diff.rs`): `.git` symlink alias (H1), dangling-symlink write escape (M1); plus L1/L3/L5. Added a leaf-not-followed variant for index ops, discard, delete and rename-from so dangling or `.git`-aliasing links can still be staged and trashed. Deferred: L2 oplog blob cap (Task 14), L4 TOCTOU.
- **Coordinator:** `cargo fmt` on `stash.rs` (formatting only) so AC-6 passes. Fixed `feature_list.json` (Task 08 + Stage 2 review were still `not-started`). Added the Git workflow section to `CLAUDE.md`; deleted local `master`/`dev`; tagged and pushed `v0.1.0` (M1).
- **Gate:** `./init.sh` — `Test Files 30 passed (30)`, `Tests 196 passed (196)`, Rust `95 passed; 0 failed; 3 ignored`, Clippy clean; `cargo fmt --check` clean.
- **Open:** `stage.rs` TODO "discard untracked to Trash" referencing Task 09 not wired — out of Task 09 scope; decide placement.
- **Next:** Task 10 — File manager UI.

## 2026-11-07: M2 Stage 2 gate → 🛑 Checkpoint M2.2

- **Code review** (`.agent/reviews/m2-stage-2-code.md`): APPROVE WITH NITS. All Task 05–08 AC met. Clippy lifetime elision warning in `diff.rs` fixed. N-1 oplog blob cap deferred to Task 14.
- **Security review** (`.agent/reviews/m2-stage-2-security.md`): APPROVE. No vulnerabilities. Minor-1 oplog blob cap (deferred T14); Minor-2 rebase abort error leaks internal path (nit).
- **§9 perf check:** `status::read` on 10k files (200 dirty), 5 runs, median **72.7 ms**, max 73.3 ms — well under 200 ms budget. Test added as `#[ignore]` to `status.rs` (run with `cargo test --release -- --ignored`).
- **E2E:** `e2e/m2-stage2-changes.spec.ts` written (17 tests): stage/unstage/discard, commit/amend/commit-all, stash push/apply/pop/drop, stash@{N} rendering, counter colors, perf proxy. Full suite: **70/70 passed**.
- **Manual doc:** `docs/testing/m2-manual-e2e.md` Stage 2 section added: M2-S2-01 through M2-S2-16.
- **Gate:** `./init.sh` — `Test Files 28 passed (28)`, `Tests 193 passed (193)`, Clippy clean, Rust `84 passed; 0 failed; 3 ignored`. `pnpm test:e2e` — 70/70 passed.
- **Next:** M2 Stage 3 — Files & editor (Task 09, filesystem IPC). Single Stage 2 commit created.

## 2026-11-07: M2 Task 07 — Commit variants and message validator

- Added Rust `commit` / `commit_and_push` / `commit_and_sync` IPC over the user's `git` CLI with argument arrays. Each records the pre-write `HEAD` SHA into the in-process oplog. Empty messages are rejected unless amending; amend with no message uses `--amend --no-edit`; `stage_all` runs `git add -A` first. Sync = `fetch --prune → rebase → optional commit → push` and aborts the rebase on conflict.
- Added `AppError::git_hook` / `git_auth` / `git_conflict`; failures classify hook output, auth errors, and conflicts. Because git hides the failing hook's name when the hook exits silently, classification falls back to the repository's executable hook set.
- Wired `src/ipc/changes.ts` + regenerated Specta bindings. Extended `useChanges.dispatch` with the three commit commands (returns success), and wired the commit box, primary Commit button, ⌘↵, the six-item split-button menu, Commit & Sync, and the branch-line Sync (no new message, draft preserved). `✦ Generate` is disabled with `ui.deferred_m6`; Undo Last Commit shows a deferred toast because `undo_last` is Task 14.
- **Verification:** `./init.sh` — `Test Files 28 passed (28)`, `Tests 186 passed (186)`, Clippy clean, Rust `78 passed; 0 failed; 2 ignored`; `cargo fmt --manifest-path src-tauri/Cargo.toml --check` clean. `src/ipc/bindings.ts` keeps the generator's extra trailing newline so the drift test passes.
- **Next:** M2 Task 08 (stashes). No per-task commit; Stage 2 stops at Checkpoint M2.2 after Tasks 05–08 + review gate.

## 2026-11-07: M2 Task 06 — Stage, unstage, and discard

- Added Rust `stage`/`oplog` modules and IPC: full-file stage/unstage via `git2::Index`, partial hunk/line ops via synthesized unified patches + `git apply --cached --unidiff-zero` under M1 filter isolation, discard with preimage oplog snapshots, path-escape refusal, and deferred untracked Trash branch.
- Wired `src/ipc/changes.ts` + regenerated Specta bindings; widened `useChanges.dispatch` with success/failure toasts; connected Changes file-row/section actions and DiffRenderer hunk/line/stage-selected actions. Kept row-level windowing for a single huge hunk (user-approved N-4).
- **Verification:** `./init.sh` — `Test Files 28 passed (28)`, `Tests 177 passed (177)`, Clippy clean, Rust `71 passed; 0 failed; 2 ignored`; `cargo fmt --manifest-path src-tauri/Cargo.toml --check` clean.
- **Next:** M2 Task 07 (commit variants). No per-task commit; Stage 2 stops at Checkpoint M2.2 after Tasks 05–08 + review gate.

## 2026-11-07: M2 Task 05 — Changes screen scaffold

- Matched the Changes scaffold to the prototype: working list/tree toggle, six commit-menu actions, More placeholder, stubbed row/section actions, status classes/deletion styling, and grouped tree rows. Double-click and Open file dispatch the typed `files.open` intent and route to Files.
- Added `ChangesScreen.test.tsx` coverage for list/tree rendering, 50/51/72/73 counter boundaries, status/deletion styling, file-open intent, six menu entries, and the empty stash count.
- **Acceptance review:** PASS. No real Git write was added.
- **Verification:** `./init.sh` — `Test Files 28 passed (28)`, `Tests 172 passed (172)`, Clippy clean, Rust `60 passed; 0 failed; 2 ignored`; `=== Verification Complete ===`.
- **Next:** Ask the user about N-4 (windowing rows inside a single huge hunk) before Task 06. No Task 05 commit.

## 2026-11-07: M2 Stage 1 approved; Task 05 started

- User approved Checkpoint M2.1 after visual feedback on the Changes screen.
- Created the single Stage 1 commit: `b55d62c feat: add M2 status and diff foundation` (local `.claude/` and `node-compile-cache/` excluded).
- `./init.sh` passed before the commit: Vitest 27 files/166 tests; Clippy clean; Rust 60 passed/2 ignored. `git diff --cached --check` clean.
- Started only M2 Task 05; all Git writes remain stubbed. Next: finish the Changes screen scaffold and its focused tests.

## 2026-11-07: M2 Stage 1 review gate → 🛑 Checkpoint M2.1

- **Changes stub:** `src/screens/changes/ChangesScreen.tsx` shows Staged/Unstaged lists and the selected file's diff through `DiffRenderer`, with live `git:changed` refresh. Read-only.
- **Open questions (user):** OQ1 discard backup = oplog blob; OQ3 external changes = reuse `git:changed` + focus mtime check.
- **Security review** (`.agent/reviews/m2-stage-1-security.md`): PASS, 4 Minor. Fixed #1 (NUL path panic), #2 (unbounded/FIFO working-file read), #3 (`status`/`diff_file` now async). #4 (no line cap) mitigated by windowing.
- **Code review** (`.agent/reviews/m2-stage-1-code.md`): REQUEST CHANGES twice → APPROVE WITH NITS. Fixed: staged large-file deletion bypassed 1 MB truncation; staged diff misread as binary; select/refresh race; stale debounce timer after worktree switch; `dmode` not restored; split view did not pair del/add; ruler clipped; perf fixture collapsed most lines.
- **E2E** (`.agent/reviews/m2-stage-1-e2e.md`): new `e2e/m2-stage1-changes.spec.ts`; full suite 53/53.
- **Perf §9** (prod build, Chromium, i5-1038NG7, realistic 5 000-line diff): 139.6 ms median before → 52 ms median after hunk windowing. Budget met.
- **Gate:** `./init.sh` — `Test Files 27 passed (27)`, `Tests 166 passed (166)`, Clippy clean, Rust `60 passed; 0 failed; 2 ignored`. fmt and `git diff --check` clean.
- **Carried nits:** N-1 Task 05 diff panel must be a non-scrolling full-height child (else ruler residual returns); N-2 one-frame blank on refresh; N-3 tick 0 half-clipped; N-4 a single huge hunk (new/deleted 5 000-line file) renders ~705 ms — user decision; Minor #3–9 in code report. Plan defect: ">7 context collapse" cannot trigger with `context_lines=3, interhunk_lines=0`.
- **Manual spec:** `docs/testing/m2-manual-e2e.md` M2-S1-01…07 (not run; user-only).
- **Next:** user runs the manual checks. On go-ahead: one Stage 1 commit, then Task 05.

## 2026-11-07: M2 Task 04 — Changes store scaffolding

- Added `src/state/changes.ts` + `changes.test.ts`: status/diff read model for the selected file, `select`/`setDiffMode`, `dmode` persisted via `loadSetting`/`saveSetting`, `handleGitChanged` (250 ms per-worktree debounce; Task 05 screen registers `onGitChanged` like `GraphScreen.tsx`), module-scope `useWorktrees.subscribe` clearing state on worktree switch, `ChangesCommand = never`.
- **Spec review:** FAIL on AC-4 (state cleared only inside `refresh()`, no store subscription); executor added the subscription; re-review PASS.
- **Verification:** `./init.sh` — `Test Files 27 passed (27)`, `Tests 163 passed (163)`, Clippy clean, Rust `58 passed; 0 failed; 2 ignored`. Cargo fmt and `git diff --check` clean.
- **Next:** M2 Stage 1 review gate (`.agent/tasks/m2-stage-1-review.md`), then 🛑 Checkpoint M2.1.

## 2026-11-07: M2 Task 03 — Shared diff renderer

- Added `src/diff/DiffRenderer.tsx` + `diff.css`: split/inline rows, hunk header with range, Staged/Unstaged chip and area-correct actions, intraline `<mark>` spans, off-area dimming, collapse of >7 context lines, right-edge overview ruler, binary/truncated summary card. Strings under `diff.*` in `src/i18n/en.ts`. Vitest coverage in `DiffRenderer.test.tsx`.
- **Spec review:** first pass FAIL on AC-1 (extra `hunkAreas`/`fileName` props, needed because Task 02's DiffModel lacks per-hunk area and file name). User chose to amend AC-1; re-review PASS. Notes (unscored): unstaged hunks show Stage + Revert; ruler position approximated (no whole-file line total in DiffModel).
- **Verification:** `./init.sh` — `Test Files 26 passed (26)`, `Tests 158 passed (158)`, Clippy clean, Rust `58 passed; 0 failed; 2 ignored`. Cargo fmt and `git diff --check` clean.
- **Next:** M2 Task 04, Changes store scaffolding (must supply `hunkAreas`/`fileName` to the renderer). No M2 stage commit before the M2.1 manual checkpoint.

## 2026-11-07: M2 Task 02 — DiffModel computation

- Added `diff_file(worktree_path, path, area)` with typed DiffModel/Specta types, patience diffs, staged/unstaged hunks, intraline Unicode-aware spans, binary and >1 MB short-circuits, and path/symlink containment checks. Added IPC wrapper and focused Rust/Vitest tests.
- **Spec review:** PASS; no blockers.
- **Verification:** `./init.sh` — `Test Files 25 passed (25)`, `Tests 150 passed (150)`, Clippy clean, Rust `58 passed; 0 failed; 2 ignored` (including binding drift check). Cargo formatting and `git diff --check` clean.
- **Next:** M2 Task 03, shared diff renderer. No M2 stage commit before the M2.1 manual checkpoint.

## 2026-11-07: M2 Task 01 — Status read model

- Added the typed `status(worktree_path)` command, validated against registered worktrees; it reports deterministic staged/unstaged entries, rename paths, blob sizes, and refuses a locked index. Added the generated IPC wrapper and bindings plus temporary-repository coverage for status categories, partial staging, large files, empty trees, invalid paths, and index locks.
- **Spec review:** no implementation blockers. The reviewer flagged verification as incomplete, but the executed `./init.sh` output below confirms the required gate and focused tests ran.
- **Verification:** `./init.sh` — `Test Files 24 passed (24)`, `Tests 148 passed (148)`, Clippy clean, Rust `53 passed; 0 failed; 2 ignored` (including `export_bindings_matches_checked_in_file`). `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and `git diff --check` clean.
- **Next:** M2 Task 02, Diff computation and `DiffModel` IPC. No M2 stage commit before the M2.1 manual checkpoint.

## 2026-11-07: M2 Task 00 — AppError and generated IPC contract

- Migrated existing IPC commands and frontend wrappers to typed `AppError` and Specta-generated bindings. Added coverage proving typed IPC errors reach the UI as their `message`.
- **Reviews:** spec review PASS after adding IPC rejection and E2E backend-error coverage; security review APPROVE, no vulnerabilities. Inherited clone stderr message behavior noted by security reviewer; unchanged by this task.
- **Verification:** `./init.sh` — `Test Files 23 passed (23)`, `Tests 146 passed (146)`, Clippy clean, Rust `46 passed; 0 failed; 2 ignored`. `pnpm test:e2e` — `51 passed`. `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and `git diff --check` clean.
- **Next:** M2 Task 01, Status read model. No M2 stage commit before the M2.1 manual checkpoint.

## 2026-11-07: M1 Stage 3 committed — M1 complete

- The user approved Checkpoint M1.3 and authorized the commit. Single Stage 3 commit (Tasks 09, 10, 10b, 10c and the review/performance fixes); local `.claude/` excluded.
- M1 is complete. Next: plan M2 (Changes, files, editor) — no plan exists yet.

## 2026-11-07: M1 Task 10c — highlight active worktree branch (user request)

- Graph now highlights the active worktree's branch, GitKraken-style. Commits reachable from its HEAD (full ancestry, plus the WIP row) stay full strength; other rows fade to .45 (filter dim .3 wins when both apply). The active worktree's ⌂ ref pill is solid in its lane color. Switching worktrees in the sidebar moves the highlight immediately (the head comes from the worktree store first, then the page's WIP).
- **Verification:** spec review PASS; one focused unit test (two branches, flips on switch); screenshots verified for main vs feat/auth-oauth. `./init.sh` — `Tests 145 passed (145)`, Clippy clean, Rust `42 passed; 0 failed; 1 ignored`; `pnpm test:e2e` — `50 passed`; `git diff --check` clean.

## 2026-11-07: M1 Stage 3 ready for Checkpoint M1.3

- **Graph performance:** the first page at 100k commits took 11.19 s. libgit2's revwalk walks the whole history before yielding under any sort mode (8.6 s), and `short_id()` added ~2 s. Replaced both: a newest-first heap walk that stops at the page lookahead, topologically ordered per page, and a fixed 7-char short SHA. **Measured: 38.3 ms** (release build, 100k loose commits, Intel i5-1038NG7; budget <300 ms). Virtualization stays bounded (test asserts <80 mounted rows).
- **Stage 3 code review:** "With fixes", 0 critical / 4 important (`.agent/reviews/m1-stage-3-code.md`).
  - I1: page boundaries could repeat or drop a commit under clock skew. Fixed with a per-page topo order; regression test `keeps_pages_consistent_when_a_skewed_child_is_past_the_page_cut` fails on the old code (1201/1202 unique) and passes now.
  - I2: deep pages were slow and blocked the main thread. Partly fixed: each commit is read once and `log_graph` runs as `command(async)`. Deep pages still re-walk from the tips (marked with a `ponytail:` comment).
  - I3/I4: fixed in Task 10b.
- **Task 10b (user report: Graph/Worktrees didn't match the prototype):**
  - Sidebar rows now have a color stripe and a status chip; the picker has its header, left checkboxes and color dots.
  - Graph: filter pill chips that dim instead of hide, author avatar nodes, lane colors with curved edges, lane-tinted refs, short relative time, aligned messages, and prototype inspectors.
  - Also: Retry shown at the list end, `git:changed` reloads the graph, and appended pages are deduped by SHA.
  - Spec review FAIL (2) → fixed → PASS. The sidebar/picker ＋ buttons are omitted because no sidebar create flow exists.
- **Verification:** `./init.sh` — `Test Files 23 passed (23)`, `Tests 144 passed (144)`, Clippy clean, Rust `42 passed; 0 failed; 1 ignored`. `pnpm test:e2e` — `50 passed`. `git diff --check` and `cargo fmt --check` clean. Security review: no vulnerabilities.
- **Manual spec:** Stage 3 checks in `docs/testing/m1-manual-e2e.md` were updated for the new visuals and filter behavior. They have not been run.
- **Next:** 🛑 Checkpoint M1.3. The user runs the manual checks; on approval, make one Stage 3 commit (exclude `.claude/`).

## 2026-11-06: M1 Task 10 complete — Graph screen and inspector

- Replaced the Graph placeholder with a dedicated toolbar and fixed-row virtual list that reads typed 500-commit pages, prefetches near the loaded-list end, and shows loading, empty, retry, and end-of-history states. Added All branches, Worktrees, and Mine; Mine uses configured Git email and clearly reports when none is set. Agent commits remain unavailable until metadata exists.
- Added the WIP inspector and Open in Changes, commit metadata/refs/parents/changed-path inspector, and row context menu. Copy SHA and creating a worktree at the selected commit are enabled; all later-milestone actions are visibly disabled. Added narrow commit-detail IPC and commit-based worktree IPC, reusing the existing path validation and checkout-filter isolation.
- **Verification:** `./init.sh` — typecheck clean, `Test Files 23 passed (23)`, `Tests 140 passed (140)`, Clippy clean, Rust `40 passed; 0 failed`. Focused graph UI/IPC tests — 3 files, 15 tests passed. Focused graph E2E — 1 passed. `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and `git diff --check` clean.
- Task 10 only. No commit/push, full Stage 3 review, performance measurement, full E2E, manual-spec update, or checkpoint was performed; those remain pending outside this request.

## 2026-11-06: M1 Task 09 complete — paged graph read model

- Added the read-only `log_graph` Tauri command, a typed Rust/libgit2 graph model, and a TypeScript IPC wrapper. It returns 500-commit pages with deterministic topological ordering and lane layout, branch/tag refs, linked-worktree head markers, commit metadata/timezone source fields, and the active worktree's staged/unstaged/untracked/conflict summary.
- Temporary-repository tests cover branches, merge lanes, local/remote refs, tags, linked-worktree heads, WIP data, pagination, repeated lane stability, and rejection of an unrelated worktree. **Spec review:** PASS. **Security review:** no vulnerabilities.
- **Verification:** focused graph tests 3/3; graph IPC tests 2/2; `./init.sh` — typecheck clean, 22 Vitest files/131 tests, Clippy clean, Rust 38/38. `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and `git diff --check` clean.
- First-page performance against the 100k-commit/<300 ms budget remains for the Stage 3 gate.
- **Next:** Task 10 — Graph screen and inspector. Stage 3 remains uncommitted pending Checkpoint M1.3.

## 2026-11-06: M1 Stage 2 committed; Task 09 started

- **Stage 2 commit:** `415ce65 feat(m1): complete worktree integration stage 2` (single stage commit; local `.claude/` excluded).
- The user authorized the commit and continuation to the next stage. Stage 2's security finding was resolved and re-reviewed; spec/code/E2E review and automated gates passed.
- **Unverified:** the manual UI checks were not recorded, and the spec §9 status-refresh measurement (<200 ms for about 10,000 files) remains outstanding.
- **Started Task 09:** created `.agent/tasks/m1-task-09.md` from the active plan/spec; implement the paged Rust graph read model and its specified tests only.

## 2026-11-06: M1 Stage 2 ready for Checkpoint M1.2

- **Task 08:** completed the worktree sidebar/picker, matching-path `git:changed` refresh, and create/pin/select/restore E2E. Task 08 spec review PASS.
- **Stage reviews:** code review found no significant issues; E2E passed 49/49. Security review identified a HIGH checkout-filter execution risk in worktree creation; fixed by isolating system/global Git configuration and overriding configured local/worktree `smudge` and `process` filters. Sentinel regression passed; security re-review confirmed the finding resolved and reported no remaining vulnerabilities.
- **Manual spec:** added M1-S2-01…M1-S2-05 in `docs/testing/m0-manual-e2e.md`, including the §9 status-refresh performance check (<200 ms for about 10,000 files).
- **Verification:** `./init.sh` — typecheck clean, `Test Files 21 passed (21)`, `Tests 129 passed (129)`, Clippy clean, `test result: ok. 35 passed; 0 failed`. Focused worktree E2E: 1/1; full `pnpm test:e2e`: 49 passed. `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and `git diff --check` clean.
- **Checkpoint:** Stage 2 remains uncommitted. Awaiting user manual verification and approval at Checkpoint M1.2; do not start Task 09 or commit before approval.

## 2026-11-06: M1 Task 07 complete — worktree lifecycle and pin persistence

- Added typed worktree create/remove/prune commands using Git argument arrays with repository hooks disabled. Creation validates paths, creates a new local branch from the main worktree HEAD, creates missing parents, and auto-pins. Removal rejects the main/arbitrary worktrees, lets Git refuse dirty trees, and clears the pin only after successful removal.
- Pinning now verifies the path is the selected project's main or linked worktree. Pin persistence was verified across reopening the SQLite store.
- **Spec review:** PASS. Added regression coverage for failed pin persistence rollback and its error reporting.
- **Verification:** `./init.sh` — `Test Files 21 passed (21)`, `Tests 121 passed (121)`, Clippy clean, `test result: ok. 34 passed; 0 failed`. `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and `git diff --check` clean.
- Task 07 plan checklist complete; no per-task commit.
- **Next:** Task 08 — worktree sidebar and picker.

## 2026-11-06: M1 Task 06 complete — worktree reads and watcher

- Added typed worktree metadata reads, linked-worktree listing, and per-worktree debounced `git:changed` notifications. Watchers cover metadata/ref updates and files in existing or newly created top-level directories while excluding `.git/objects`; `index.lock` defers notifications.
- Added tests for filesystem notifications, new directories, independent coalescing, ahead/behind, conflict/rebase, lock retry, and watcher errors. Spec review PASS.
- **Verification:** `./init.sh` — `Test Files 21 passed (21)`, `Tests 119 passed (119)`, Clippy clean, `test result: ok. 28 passed; 0 failed`; `cargo fmt --manifest-path src-tauri/Cargo.toml --check` and `git diff --check` clean.
- Task 06 plan heading marked complete. No per-task commit; Stage 2 remains uncommitted until Checkpoint M1.2 approval.
- **Next:** Task 07 — worktree lifecycle and pin persistence.

## 2026-11-06: M1 Stage 1 approved at Checkpoint M1.1

- **05j:** Added per-group Add repository, repository-folder warning, and clarified clone-folder editing. New-group form omits clone-folder input/Browse and keeps `~/clients/{repo}`; editing retains the folder controls. Footer Open repository now leaves newly opened repositories Ungrouped.
- **Reviews:** spec review PASS (all six ACs); code review found no significant issues; security review found no vulnerabilities.
- **Verification:** `./init.sh` — typecheck clean, 20 Vitest files/117 tests passed, Clippy clean, Rust tests 18/18 passed. `cargo fmt --manifest-path src-tauri/Cargo.toml --check` clean. `pnpm test:e2e` — 48 passed.
- **Manual spec:** M1-S1-02 updated for Open repository → Ungrouped; M1-S1-04 updated for create/edit forms; M1-S1-13 covers Add repository from a collapsed group.
- **Checkpoint:** User approved proceeding and authorized the Stage 1 commit.
- **Next:** Commit M1 Stage 1, then start Stage 2 Task 06.

## 2026-11-06: M1 Stage 2 started — Task 06

- Stage 1 commit: `6c69746 feat(m1): complete repository groups stage 1`.
- Created `.agent/tasks/m1-task-06.md` from the active plan and design spec because the local task brief was missing.
- **Baseline:** post-commit `./init.sh` green — typecheck clean, 20 Vitest files/117 tests passed, Clippy clean, Rust tests 18/18 passed.
- **Completed:** see Task 06 and Task 07 completion entries above.

## 2026-11-06: M1 Stage 1 follow-up tasks 05b–05h complete

- **05b (review fixes):** clone runs off the main thread (`command(async)`), `GIT_TERMINAL_PROMPT=0` + HTTP low-speed abort; `~` expansion in Rust; missing clone parent allowed (git creates it, `..` rejected); open requires absolute path; chip/＋ toggle closes popover; Undo of group delete restores active group; error toasts use ⚠. Spec PASS; security re-review Clear.
- **05c (user request):** native folder picker for Open repository via `tauri-plugin-dialog` 2.8.4, capability `dialog:allow-open` only. Spec PASS; security Clear (tripwire: re-review asset scope if `protocol-asset` or fs plugin is enabled).
- **05d (user request):** × on project tabs hides the tab (`openProjectIds` persisted). Spec PASS.
- **05e (user request):** collapsible group sections (`collapsedGroupIds`); all `repos` writes go through `persistRepos`. Spec PASS.
- **05g (user bug):** opened repos missing from the switcher. Root causes: projects with a groupId not in the loaded groups rendered nowhere; `load()` discarded data when a selection happened mid-load. Fixed with regression tests written first. Spec PASS. Debt: a stale in-flight load can re-add a group deleted mid-load (in-memory only).
- **05f (user request):** Remove from Branchwork (catalog only, disk untouched) with confirm + Undo. Spec PASS; security Clear.
- **05h (user request):** group clone folder chosen via Browse… (stored as `<folder>/{repo}`). Spec PASS.
- **Gate (after 05h):** vitest 105/105, cargo test 17/17, `pnpm test:e2e` 35/35.
- **Next:** follow-up code review + e2e extension, then 🛑 Checkpoint M1.1.

## 2026-11-06: M1 Task 05 complete — group and project switcher

- `GroupSwitcher` chip + popover in the title bar: search across groups/projects/Ungrouped, group create/edit (name, 7 swatches, clone path template), Move-to menu, Open/Clone repository via `ask()`, confirmed group delete with Undo toast, ＋ entry point, Escape/outside-click dismissal.
- New IPC wrappers `openRepository`/`cloneRepository` (reject outside Tauri); store actions on `useRepos`.
- **Spec review:** FAIL (1 extra: `moveProject` updates active group) → AC amended by coordinator → re-review PASS.
- **Security review:** APPROVE. Minor fixed: `{repo}` replacement now function-form (regression test added). Deferred: clone timeout/`GIT_TERMINAL_PROMPT=0`/main-thread blocking; protocol allowlist before untrusted clone URLs; narrow `project_move` command before M3.
- **Verification:** `./init.sh` — Test Files 20 passed, Tests 78 passed, Clippy clean, Rust tests 13/13.
- **Next:** M1 Stage 1 batch review → manual spec → Checkpoint M1.1.

## 2026-11-06: M1 Task 04 complete — repository state and project navigation

- Added `useRepos` store (`src/state/repos.ts`): loads groups/projects, restores persisted selection (settings key `repos`) with fallback (group's first project → first project → null), explicit load errors with toast while keeping prior data.
- Title bar renders project tabs (`role="tablist"`) for the active group; switching projects leaves stage/settings untouched.
- Bug found during implementation: zustand selector returning a fresh array caused a max-update-depth loop; fixed with `useMemo` in `TitleBar`.
- **Spec review:** PASS. No security surfaces touched.
- **Verification:** `./init.sh` — typecheck clean, 19 Vitest files/67 tests passed, Clippy clean, Rust tests 13/13 passed.
- **Next:** M1 Task 05 (group and project switcher).

## 2026-11-06: M1 Task 03 complete — open and clone repositories

- Added typed repository discovery/open and Git CLI clone operations; successfully opened/cloned repositories are registered in the catalog, and occupied destinations are preserved.
- **Spec review:** PASS. **Security review:** APPROVE.
- **Verification:** `./init.sh` — typecheck clean, 17 Vitest files/58 tests passed, Clippy clean, Rust tests 13/13 passed. `cargo fmt --manifest-path src-tauri/Cargo.toml --check` passed.
- **Next:** M1 Task 04 (repository state and project navigation).

## 2026-11-06: M1 started — plan established

- M0 Stage 4 was approved by the user and committed as `a3e9952` (one commit for the stage).
- Added the M1 plan for repository catalog/groups, open/clone, worktrees/file watcher, and paged commit graph, with three manual checkpoints and explicit deferrals.
- **Task 01 complete:** added versioned SQLite schema for groups, projects, and pins while preserving settings.
- **Spec review:** PASS. **Verification:** `./init.sh` green (typecheck clean, 16 Vitest files/56 tests, Clippy clean, Rust tests 5/5).
- **Task 02 complete:** typed catalog persistence/commands and frontend IPC wrappers with browser fallback.
- **Review:** spec review PASS; security review APPROVE.
- **Verification:** `./init.sh` green (typecheck clean, 17 Vitest files/58 tests, Clippy clean, Rust tests 9/9).
- **Active:** M1 Task 03 (open and clone repositories).

## 2026-11-06: M0 complete — Stage 4 approved

- Task 15b adds persisted sidebar collapse/restore through ⌘B, the title-bar button, and a palette command; the collapsed rail retains accessible labels/tooltips and existing split interactions.
- **Stage code review:** APPROVE after fixing two Medium findings: protect sidebar state from a stale startup load and contain keyboard focus in the modal palette. Re-review approved. No security-sensitive surfaces were touched.
- **Verification:** `./init.sh` — typecheck clean, 16 Vitest files/56 tests passed, Clippy clean, Rust tests 2/2 passed. `pnpm test:e2e` — 25 passed. `pnpm build` — main JS 251.63 KB / 78.65 KB gzip; CSS 15.61 KB / 4.05 KB gzip.
- **Performance:** isolated browser first-render proxy 1,922 ms; actual native cold start remains unmeasured (spec budget <1.5 s). Recorded in `.agent/reviews/m0-stage-4-code.md` and `m0-stage-4-e2e.md`.
- **Manual spec:** added Stage 4 checks S4-01..S4-04 in `docs/testing/m0-manual-e2e.md`, including the native cold-start budget measurement.
- **Checkpoint:** user approved proceeding without a recorded native manual-test result; native cold start remains unverified.
- **Next:** M0 stage commit created as `a3e9952`; M1 planning started.

## 2026-11-06: M0 Task 15 complete — global keyboard map

- Added global shortcuts for palette, split toggles, Changes navigation, and screen number keys; registered keyboard and title-bar palette events through `useGlobalKeys()` in `App`.
- **Spec review:** PASS; all five specified tests present. Plan steps checked off, commit step skipped per no-commit rule.
- **Verification:** `pnpm test src/keys` — 1 file, 5 tests passed. `pnpm typecheck && pnpm test && (cd src-tauri && cargo clippy -- -D warnings && cargo test)` — typecheck clean, 15 Vitest files/54 tests passed, Clippy clean, Rust tests 2/2 passed. `pnpm test:e2e` — 25 passed.
- **Next:** implement M0 Task 15b (collapse/show sidebar).

## 2026-11-06: M0 Task 14 complete — command palette

- Added the palette store, localized navigation/split/theme/Ask commands, fuzzy-filtered palette UI and CSS; mounted it in `App` while retaining existing effects and hosts.
- **Spec review:** implementation PASS; Task 14 plan steps checked off, commit step marked skipped per no-commit rule.
- **Verification:** `pnpm test src/palette` — 2 files, 8 tests passed. `./init.sh` — typecheck clean, 14 Vitest files/49 tests passed, Clippy clean, Rust tests 2/2 passed. `pnpm test:e2e` — 25 passed.
- **Next:** start M0 Task 15 (global keyboard map).

## 2026-11-06: M0 Task 13 complete — fuzzy ranking

- Implemented case-insensitive subsequence scoring and stable ranking/filtering in `src/palette/fuzzy.ts`; all four specified tests pass.
- **spec-reviewer:** PASS.
- **Verification:** `pnpm test src/palette` — 1 file, 4 tests passed. `./init.sh` — typecheck clean, 13 Vitest files/45 tests passed, Clippy clean, Rust tests 2/2 passed.
- **Next:** start M0 Task 14 (command list, palette store, Palette UI).

## 2026-11-06: Checkpoint 3 manual test, drag & drop bug

- **Bug (S3-01):** dragging a sidebar item onto the stage did nothing in the native window.
- **Diagnosis:** a real-mouse drag in Playwright works in both Chromium and WebKit, so the frontend is correct. Tauri's internal webview drag-drop handler swallows the HTML5 drag events.
- **Fix (task 12b):** `"dragDropEnabled": false` in the window config. Trade-off: no Tauri file-drop events; use HTML5 `dataTransfer.files` when needed.
- **Learned:** the stage3 e2e uses synthetic drag events, so it cannot catch native-webview issues. Manual check S3-01 stays essential.

## 2026-11-06: M0 Stage 3 complete → 🛑 Checkpoint 3

- Stages 1–2 committed as `b2bc1cf` (the user asked for a commit per stage). Harness rule updated: one commit per stage, after user go-ahead.
- Tasks 09–12 done (spec PASS each), checked off in the plan.
- **Approved fix:** `toggleSplit` closes the focused pane. The plan text was wrong; plan corrected.
- **code-reviewer:** APPROVE. Important item: the Task 14 palette `split:close` conflicted with the fix above. Plan and task file corrected to `closePane(s.focus)` before Task 14 runs.
- **Deferred minors:**
  - the saved ratio is not clamped on load
  - memoize `Pane` before heavy screens arrive
  - check drop-zone flicker and ⌃-click behaviour in the native webview at the checkpoint
- **e2e:** stage3-split.spec 11/11, full suite 25/25.
- **Gate:** vitest 41/41, init.sh green. Bundle 77.1 KB gzip (+2.2 KB).
- **Manual spec:** docs/testing/m0-manual-e2e.md Stage 3 (S3-01…S3-08).

## 2026-11-06: M0 Stage 2 complete → 🛑 Checkpoint 2

- Tasks 05–08 done (spec PASS each). The syncNativeTheme exception is honoured in the settings store.
- **code-reviewer:** CHANGES REQUESTED. Fixed in task 08b:
  - IPC integration test (`mockIPC`), approved as an extra test
  - `settings.accentHue` i18n key
  - reduce-transparency in Light mode
  - stage 1 e2e update for the now-real Settings screen
- **security-reviewer:** PASS. Deferred until before executable settings or untrusted content:
  - a Rust-side allowlist for settings keys
  - shape validation of the loaded theme
  - a key/value size cap
  - Stage 1 M1/M2 (opener:default, core:default)
- **Deferred minors for M1:**
  - a corrupt `app.db` aborts the app silently at launch
  - spec §3.4 path says `Branchwork/`, actual is `dev.branchwork.app/` (fix the spec)
- **Gate:** init.sh green; vitest 20/20; e2e 14/14. Bundle 238 KB / 74.9 KB gzip (+3.1 KB).
- **Plan:** Tasks 1–8 checked off in the plan file.
- **Manual spec:** docs/testing/m0-manual-e2e.md Stage 2 (S2-01…S2-07).

## 2026-11-06: Checkpoint 1 manual test, bug fixed

- **Bug (S1-02):** with macOS in Light appearance, the native vibrancy material was light while the app theme was dark, so the sidebar text was unreadable.
- **Fix (task 04c):** `syncNativeTheme()` in `src/theme/native.ts` calls `getCurrentWindow().setTheme`. The window config gets `"theme": "Dark"` and the capability `core:window:allow-set-theme`. Regression test `src/theme/native.test.ts`; vitest 10/10.
- **Verified by the user:** the 2nd screenshot shows dark glass with every label readable.
- **Stage 2 note:** call `syncNativeTheme` from the settings store whenever the theme mode changes.

## 2026-11-06: M0 Stage 1 complete → 🛑 Checkpoint 1

- Tasks 01–04 done (each spec-reviewer PASS). Approved exception: tsconfig `lib` + `ES2021.String`.
- Batch review:
  - **code-reviewer:** APPROVE. Its 2 Important items were fixed in task 04b: `--fg3` now meets WCAG AA (dark 6.78:1, light 6.36:1), and the crate is renamed `branchwork`/`branchwork_lib`. `index.html` title and icon are fixed too.
  - **security-reviewer:** PASS. 4 minor notes, deferred: drop `opener:default` and narrow `core:default` before rendering untrusted content; add a CSP hardening line; add a release smoke test.
  - **e2e-testing:** PASS, 5/5. Playwright `e2e/stage1-shell.spec.ts`, `pnpm test:e2e`, first render 499 ms.
- **Performance:** JS 228 KB raw / 72 KB gzip, CSS 5.7 KB. Native cold start is measured manually (S1-09).
- **Gate:** `./init.sh` green (typecheck, 9 vitest tests, clippy -D warnings, cargo test). `pnpm test:e2e` 5 passed.
- **Manual test spec:** `docs/testing/m0-manual-e2e.md` (Stage 1, S1-01…S1-09).
- **Next:** user runs the manual test. On go-ahead, start Stage 2 (m0-task-05).

## 2026-11-06: Harness + M0 Stage 1 (in progress)

- **Done:** brainstorming, prototype (`docs/design/prototype.html`), spec, M0 plan (all committed earlier on branch `docs/branchwork-design`; from now on there are **no commits** per the user's rule).
- **Harness added:** `CLAUDE.md`, `feature_list.json`, `progress.md`, `session-handoff.md`, `init.sh` (via the harness-creator skill).
- **m0-task-01 (scaffold):** DONE. Spec-reviewer PASS. `pnpm typecheck` exit 0. `pnpm test` reports "No test files found" (expected).
- **m0-task-02 (window config):** edits applied (`tauri.conf.json` productName/overlay/vibrancy/CSP, `tauri` `macos-private-api` feature, `core:window:allow-start-dragging`). The executor hit an API rate limit while `cargo check` was compiling, so it is **not yet verified or spec-reviewed**.
- **Next:** run `cd src-tauri && cargo check`, then spec-review m0-task-02, then m0-task-03.
