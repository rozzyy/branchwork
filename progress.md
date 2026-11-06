# Progress Log

Append newest entries at the top. Each entry: date, task, what changed, verification evidence, next step.

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
