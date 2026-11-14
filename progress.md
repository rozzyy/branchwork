# Progress Log

Append newest entries at the top. Each entry: date, task, what changed, verification evidence, next step.

## 2026-11-14: Automatically recover stale linked worktrees

- Release closeout: stage commit `43a9a80` and release commit `58deca6` are on `main`; `v0.6.0` is an annotated tag at `58deca6`. Both `origin/main` and `origin/v0.6.0` were pushed and verified. Local `m7-stage-1` was deleted after merge. Working tree was clean at verification. M6-S5 and other native desktop checklists remain pending.

- User reported a repository failing to load worktrees because a linked worktree base under `/private/tmp/claude-501/...` no longer existed. `worktree::prune_path` now runs before repository registration and before `worktree::list` / `worktree::summary` reads, so Git removes stale administrative records before they can break refresh or Launchpad summaries. Git's prune only removes registrations whose worktree directories are gone; existing worktrees remain registered.
- Added Rust regression tests for repository add and worktree refresh. Focused tests passed: 2/2. `./init.sh` passed: Vitest 82 files / 692 tests, Rust 316 passed / 3 ignored, TypeScript and Clippy clean. Scoped `rustfmt --check`, `git diff --check`, and JSON validation passed after the last edit; summary path change was compiled by the focused Rust run.
- Runtime estimate: each add/refresh/summary read now launches one fixed-argument `git worktree prune --expire=now`; Git scans worktree metadata (O(W) in registered worktrees) and uses bounded metadata memory relative to W. No untrusted argument is passed to Git. Native app verification remains pending.

## 2026-11-14: Complete M6 Stage 5 Compare on `m7-stage-1`

- Followed the user's direction to keep this work aligned with `m7-stage-1`; preserved the pre-existing M7 prototype-parity diff.
- M6-13: added typed same-repository worktree comparison IPC, tracked dirty snapshots that preserve HEAD/index/files, explicit untracked exclusion, same-path/repository validation, and caps on file count, diff size, timeout, and patch output. Reused existing diff model helpers and regenerated typed bindings.
- M6-14: added accessible A/B comparison dialog with include-uncommitted switch, file/stat list, shared split renderer, and bounded Copy patch. Enabled Graph's Compare with working tree context action and added Compare for each Race result; existing Keep and confirmed Discard behavior remains.
- Added focused Rust, IPC, Compare dialog and Graph entry tests. Updated the M6 plan, manual E2E checklist, feature list, and this handoff.
- Final `./init.sh` after including all current tracked changes: exit 0, Vitest 82 files / 692 tests, Rust 316 passed / 3 ignored, TypeScript and Clippy clean. Focused CompareDialog/Graph/Agents/IPC suites passed (4 files / 54 tests). Detector returned `[]`; `git diff --check` and feature JSON validation passed.
- User explicitly ordered merging, commit, push and tagging. Stage commit `43a9a80` was fast-forwarded onto `main`; release manifests are now `0.6.0` and are being committed/tagged as `v0.6.0`. M6-S5's desktop checklist remains pending and is not represented as passed.
- `src-tauri/src/repository.rs` and `src-tauri/src/worktree.rs` acquired a separate stale-worktree-pruning diff during final verification; it is outside M6-13/14 and was preserved for follow-up.
- Manual native M6-S5 flows remain pending: real desktop worktree state, patch application, and Race keep/discard lifecycle.

## 2026-11-12: M5-01 manual checkpoint approved

- User confirmed the Launchpad and Inbox manual flows at desktop and narrow widths are OK. Marked M5-01 `done` in `feature_list.json`; automated review and acceptance coverage were already complete.
- **Verification on record:** `pnpm test` 68 files / 606 tests passed; focused Launchpad/Inbox tests 17/17; typecheck, Clippy, `git diff --check`, and feature JSON validation passed. `./init.sh` Rust phase and serial retry each had 10 macOS FSEvent watcher failures (206 passed / 10 failed / 3 ignored); retained as an environment gap, unrelated to this UI task.
- **Next:** no M5 work remains. Do not commit or merge until explicitly ordered. Separate Finder file-drop and packaged-app `clear` retests remain follow-ups.

## 2026-11-12: M5-01 implementation and coverage review

- Completed the remaining acceptance-test coverage for Inbox loading/empty feedback, low-quota retry, CI/Agent filtering, and unknown GitHub reasons. Memoized Launchpad view data by project payload, indexed worktree paths for agent matching, and memoized Inbox filtered rows by data/filter so session-only updates do not redo CI sorting and KPI derivation.
- **Verification:** full Vitest 68 files / 606 tests passed; Launchpad + Inbox tests 2 files / 17 tests passed; `pnpm typecheck`, `git diff --check`, and feature JSON validation passed. `./init.sh` passed typecheck, full Vitest, and Clippy, but Rust tests had 10 macOS FSEvent watcher failures (206 passed / 10 failed / 3 ignored); a serial retry had the same failures.
- M5 implementation and automated review are ready for the manual checkpoint. Desktop/narrow-stage visual checks and manual actions remain unchecked: neither Superset browser nor the Cua Driver daemon is available in this session. **Next:** user verifies `docs/testing/m5-manual-e2e.md` and approves the M5 checkpoint. No commit or push.

## 2026-11-12: Issue #3 profile-switch recurrence

- Checked the initial-command attach race specifically during agent profile switching. `startSession` waited for `CliPane` to attach before writing the command, but `switchProfile` spawned a replacement PTY and wrote its resume command immediately. That could lose the first command if pane attachment had not completed.
- `switchProfile` now publishes the replacement PTY ID, waits on the same attach handshake, then writes the resume/fresh-launch command. Added a regression test that holds attachment open and confirms the write happens only after release. No new IPC or external-input boundary; the extra handshake is constant work per switch, with existing profile lookup and PTY operations unchanged.
- **Verification:** `pnpm exec vitest run src/agents/sessions.test.ts` passed (39 tests); `pnpm typecheck` and `git diff --check` passed. Post-fix `./init.sh` passed typecheck, all 68 Vitest files / 603 tests, and Clippy; its parallel Rust test phase hit 10 macOS FSEvent startup failures (206 passed / 10 failed / 3 ignored). GUI retest is unavailable because the Cua Driver daemon is not running.
- **Next:** manually switch profiles in the running app when GUI control is available. No commit or push.

## 2026-11-12: M5 spec — Launchpad and Inbox prototype parity

- Continued M5-01 implementation after reviewing the task spec. Launchpad now has toolbar scope/refresh/New Worktree actions, hero KPIs with passed/total CI, a three-column card layout, and the existing confirmed CI rerun route. Inbox now has All/Review/Mention/CI/Agent filters, selected-item detail, relative GitHub age, 24-hour snooze, and responsive list/detail behavior.
- Plan audit: M5 Stage 1 contains only M5-01. The separately tracked Finder file-drop and packaged-app `clear` checks remain pending manual verification.
- **Verification:** `git diff --check` passed before the latest UI/state-doc edits. No tests or app visual checks have been run. Typecheck and manual desktop/narrow-stage review remain.
- **Next:** finish static review, then run only verification authorized by the task workflow; record remaining gaps before the M5 manual checkpoint.

- Created `docs/superpowers/specs/2026-11-12-m5-launchpad-inbox-ui-parity.md` and `docs/superpowers/plans/2026-11-12-m5-ui-parity.md` on `m5-stage-1`, based on the released local `main`/`v0.4.0`.
- The spec maps Launchpad to the prototype's 3-column hero/KPI/card grid and Inbox to its 400px list plus detail pane. It preserves existing bounded data, safe routes, and actions, keeps UI copy English, and specifies visual checks at desktop and narrow stage widths.
- **Verification:** JSON validation and `git diff --check` passed. No implementation or application tests were run; this request was spec-only.
- **Next:** review the M5 task spec before implementation.

## 2026-11-12: M4 release v0.4.0 merged and tagged

- User approved M4.4 after manual verification of M4-S4-01..04. Fast-forwarded `main` to stage commit `be814ca`; applied the synchronized `0.4.0` version bump and created annotated tag `v0.4.0` per the release workflow.
- **Verification:** `cargo metadata --manifest-path src-tauri/Cargo.toml --no-deps --locked --format-version 1` passed; version fields in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json` match; `git diff --check` passed.
- **Publishing:** M4 stage branch is pushed. `main` and tag `v0.4.0` are local; they have not been pushed.
- **Next:** publish `main` and `v0.4.0` if requested; issue #2 packaged-app retest remains a separate follow-up.

## 2026-11-12: M4.4 manual checkpoint approved

- User confirmed M4-S4-01..04 manual verification is OK. Recorded all four as passed in `docs/testing/m0-manual-e2e.md`; updated the M4 plan and Stage 4 review evidence.
- **Checkpoint:** M4.4 is approved. Stage 4 implementation and reviews are complete. No commit, merge, release tag, or version bump performed; those actions still require explicit authorization under the session handoff.
- **Next:** await explicit commit/merge/tag authorization for M4.4.

## 2026-11-12: Issue #2 TERM default; resolve issues #1 and #3

- **Issue #2 fix:** PTY shell spawn now sets `TERM=xterm-256color` before applying caller-provided session variables, so explicit profile values still win. The regression test runs `clear` in a child PTY and asserts the terminal type is present with no missing-TERM warning.
- **Verification:** focused Rust test `pty::tests::applied_env_reaches_the_child` passed (1/1); `cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings` passed; `rustfmt --check src-tauri/src/pty.rs --edition 2024`, JSON validation, and `git diff --check` passed. Baseline `./init.sh` stopped at an unrelated timeout in `GraphScreen.test.tsx` (HTMLCanvasElement canvas warnings); `cargo fmt --check` also reports pre-existing formatting drift in `src-tauri/src/fs.rs`.
- **GitHub status:** issue #1's fix is already on `a9f8e59`; issue #3's initial-command startup fix was previously verified in-app. Attempts to close #1 and #3 failed because the authenticated GitHub user lacks `CloseIssue` permission. They remain open pending a maintainer with permission.
- **Next:** verify #2 in the packaged app and have a GitHub maintainer close issues #1 and #3. No commit or push.

## 2026-11-12: M4-12 Launchpad complete; Stage 4 at manual checkpoint

- M4-10 Poller/cache/quota, M4-11 Inbox, and M4-12 Launchpad are implemented and reviewed. Launchpad collection is capped at 8 projects, with ≤3 concurrent GitHub calls per project, ≤30 runs and ≤200 worktree metadata rows per project; worktree summary reports exact totals with bounded metadata. Issue context reaches the agent as initial prompt text, not a shell command.
- Reviews: M4-12 spec PASS; Stage 4 code review PASS; security review PASS; automated E2E review PASS. Reports are under `.agent/reviews/m4-task-12-spec.md` and `.agent/reviews/m4-stage-4-*.md`. Manual steps M4-S4-01..04 are ready in `docs/testing/m0-manual-e2e.md`.
- Final verification: `./init.sh` passed typecheck, Vitest 68 files / 593 tests, and Clippy. Parallel Rust had 10 macOS FSEvent startup failures (206 passed, 3 ignored); serial full Rust library suite passed 216 / 0 failed / 3 ignored. `./init.sh` exits nonzero in this environment despite the serial Rust pass.
- **Next:** user runs M4-S4-01..04 in the live app and reports outcomes. Stage 4 remains at Checkpoint M4.4; do not commit, merge, or tag before user approval and separate authorization.

## 2026-11-12: Fix issue #1 — preserve file search across unreadable folders

- **Root cause:** Files `⌘P` builds a breadth-first index with up to six directory reads in parallel. A single `fs_tree` rejection propagated through `Promise.all`, discarding the entire batch and leaving unrelated readable folders out of the searchable list.
- **Fix:** Isolate read failures per directory and continue indexing siblings. Added a regression test with one denied folder and a searchable file in a readable sibling.
- **Complexity/security:** `N` directories and `F` entries remain O(N + F) traversal, with at most six simultaneous IPC reads. Existing `fs_tree` worktree/path validation and ignored-file policy remain unchanged; failed folders contribute no entries.
- **Verification:** FilesScreen tests pass (14/14); `git diff --check` clean. `./init.sh` baseline passed typecheck but full Vitest had 12 unrelated timeouts/failures (568/580 passed) under parallel load. The worktree initially lacked `node_modules`; a temporary symlink to the existing checkout dependencies enabled checks. No filesystem/backend authorization rules changed.
- **Next:** Commit the issue fix on `fix/issue-1` and fast-forward it into `main` as requested; keep the separate uncommitted M4-10 work in the `m4-stage-4` worktree untouched.

## 2026-11-12: M4-10 poller, cache, and quota handling (branch `m4-stage-4`, uncommitted)

- **Implemented:** bounded in-memory GitHub response cache (256 entries, 16 MiB total, 512 KiB per entry), account/owner/repo/resource partitioning, 5-minute freshness, REST ETag/304 reuse, mutation and manual-refresh invalidation, active screen polling every 60 seconds, quota-aware poll backoff, and retry-time status banner. Generated IPC bindings and wrappers updated.
- **Performance/security:** O(1) average cache lookup; eviction scans are capped at 256 entries. Cache stores response JSON only (no credentials); credentials remain in the existing curl stdin config. UI does not issue polling requests while quota is below 10%.
- **Verification:** `npm run typecheck` passed; repo/UI IPC tests 24/24 passed; targeted Rust GitHub tests 34/34 passed; Clippy with `-D warnings` passed; `git diff --check` passed. `./init.sh` ran typecheck, then Vitest reported 63/64 files and 580/581 tests passed; one unrelated Graph virtualized-history test failed under the full parallel suite, then passed in isolation. Initial cargo test baseline had 10 macOS FSEvent stream failures under parallel execution; serial Rust suite passed 210/3 ignored before implementation.
- **Next:** M4-11 Inbox. The user has asked to continue through M4 tasks until the M4 tag checkpoint. Changes are uncommitted and not pushed.

## 2026-11-11: Headless Repo trace + frame inspection (branch `m4-stage-1`, uncommitted)

- **Trace:** entry RepoView → remote `rozzyy/branchwork` (SSH alias `github-pribadi`) → account resolution (no memory for owner → username match) → `gh_repo_meta(owner, repo, account=rozzyy)` asserted via recorded IPC args → Keychain token → `graphql` → `api_json` → `api_failure` (401 surfaces invalid-token text; genuine invisibility keeps "Could not resolve") → header/tabs/file table/sidebar/Issues header.
- **Exercise:** throwaway Playwright spec (deleted after) against `pnpm dev` + full `__TAURI_INTERNALS__` invoke stub with live-shaped fixtures: 2 passed, 0 page errors; load ~1185 ms, issues tab ~155 ms, actions tab ~60 ms. Four screenshots inspected pixel-by-pixel in `/tmp/bw-repo-{code,issues,actions,error}.png`: underline tabs + Issues 2 badge, bordered file/commit/README boxes, sidebar stats + Latest pill + language bar, issues header "2 Open / 1 Closed" + status icons + Start buttons, actions chips + Re-run, honest invalid-token error with no mask.
- **Conclusion:** current build is prototype-faithful; user's "jauh beda" matches a stale frontend (`dist/` not rebuilt). Needs: user re-links both tokens + full `pnpm tauri build` + restart.
- **Next:** M4-10 Poller after user confirms. No commit or push.

## 2026-11-11: Dead-token error misdiagnosis + prototype pass (branch `m4-stage-1`, uncommitted)

- **Root cause:** both stored GitHub tokens return 401 "Bad credentials" (revoked/expired), but `api_json` only surfaced GraphQL `errors[]`, so dead tokens fell through to a fabricated "Could not resolve to a Repository" in `repo_meta`. Fixed: new pure `api_failure` surfaces REST-style `message` errors, mapping "Bad credentials" to "GitHub rejected the stored token (invalid or revoked) - link the account again in Settings" (+ test). Account resolution/memory verified correct (DB: rozzyy default, only `shopfoodie → rozzyrahmanda`).
- **User action needed:** link ulang kedua token di Settings → GitHub (keduanya mati), lalu rebuild + restart app.
- **Prototype pass:** underline tabs with icons + Issues count; file list + commit header in bordered box (author avatar, sha · age); README box with header + license; sidebar homepage row, stars/watching/forks lines, counts in Releases/Contributors headings; Issues box header with both Open/Closed totals (extra totals query) + status icons; Public pill; owner tinted accent. No new theme tokens/CSP changes (initial discs, no remote images).
- **Verification:** `pnpm typecheck` clean; `./init.sh` — `=== Verification Complete ===`; Test Files 62 passed (62), Tests 558 passed (558); Rust 198 passed, 0 failed, 3 ignored; Clippy clean; `git diff --check` clean.
- **Next:** user re-links tokens + rebuilds, then retests branchwork/kantor repos. M4-10 Poller after that. No commit or push.

## 2026-11-11: Repo casing + prototype tidy follow-up (branch `m4-stage-1`, uncommitted)

- **Report:** org repos showed lowercase (`shopfoodie/...`) although the remote spells `Shopfoodie/...`; Repo UI needed prototype alignment.
- **Fix:** `split_remote_host`/`parse_github_remote_with` keep owner/repo casing (host match `eq_ignore_ascii_case`, `.git` stripped case-insensitively, `ssh -G` retry with lowered alias); header renders owner/repo spans + Private pill; Issues IPC returns `{total, issues}` with totals on filter buttons + tab; `GhRepoMeta.is_private`, `GhRelease.is_latest` (Latest pill), `GhRun.actor_avatar`; compact counts (12.4k); per-login avatar colors (initial discs, no remote images → CSP unchanged); per-owner memory keys stay lowercased by design (case-insensitive). Tests updated (Rust casing cases, IPC shape, component casing/totals/Latest).
- **Verification:** `pnpm typecheck` clean; `./init.sh` — `=== Verification Complete ===`; Test Files 62 passed (62), Tests 558 passed (558); Rust 197 passed, 0 failed, 3 ignored; `git diff --check` clean.
- **Next:** M4-10 Poller. Manual M4-S1-01/02 (browser + network) still open. Rebuild/restart app for Rust + frontend changes to take effect. No commit or push.

## 2026-11-10: M4-04 PR list (branch `m4-stage-1`, uncommitted)

- **Built:** `gh_repo_remote` (catalog-validated worktree → `git remote get-url origin` → owner/repo/URL, scp/https/ssh) + `gh_prs` (one GraphQL round-trip, states per filter, backend-side mine/review-requested filtering, 60 s per-repo cache) + `PrsScreen` (filter tabs, chips, account badge, loading/empty/error/no-remote/no-account states, selection note) wired into nav; 17 `prs.*` strings.
- **Review:** spec-reviewer PASS all 6 ACs (`.agent/reviews/m4-task-04-spec.md`); post-review hardening (reject leading-dot owner/repo segments + tests).
- **Verification:** `pnpm typecheck` clean; `./init.sh` — `=== Verification Complete ===`; Test Files 61 passed (61), Tests 551 passed (551); Rust 188 passed, 0 failed, 3 ignored; Clippy clean; `git diff --check` clean.
- **Next:** M4-05 PR detail. Live GraphQL test pending (needs network + linked account). Checkpoint M4.1 manual UI (device flow/PAT) still open. No commit or push.

## 2026-11-10: Device flow opens the verification URI (checkpoint feedback, uncommitted)

- **Request:** app should open the device-flow URI instead of forcing copy-paste.
- **Fix:** `gh_open_url` command (strict allowlist: only `https://github.com/login/device*`, validated in pure `validate_open_url`; `open`/`xdg-open`/`cmd start` argv, no shell) + `openGithubUrl` wrapper; `DeviceFlowBox` auto-opens on start and offers an "Open in browser" button, URI stays visible as manual fallback. Tests: allowlist accept/reject, IPC routing, auto-open assertion.
- **Verification:** focused suites green (Rust `gh::` 10 passed; TS 25 passed); `pnpm typecheck` clean; `./init.sh` — `=== Verification Complete ===` (60 files / 544 tests; Rust 183 passed); Clippy + `diff --check` clean.
- **Next:** Rebuild, retry device flow (enable Device Flow on the OAuth App first). No commit or push.

## 2026-11-10: M4 Stage 1 review — code + security PASS, manual spec written (branch `m4-stage-1`, uncommitted)

- **Reviews:** code-reviewer PASS (`.agent/reviews/m4-stage-1-code-review.md`, 3 medium findings fixed: sign-out prune-on-error, PENDING sweep + cap + hashed request ids, pure `should_poll` + tests; drive-bys: case-insensitive dedupe/host, PAT placeholder, test rename; `cli.rs` hunks kept as canonical fmt). Security-reviewer PASS (`.agent/reviews/m4-stage-1-security.md`; `ps`-visibility + no-zeroing documented accepted).
- **Manual spec:** `M4-S1-01`/`M4-S1-02` + result table in `docs/testing/m0-manual-e2e.md`.
- **Verification:** `pnpm typecheck` clean; `./init.sh` — `=== Verification Complete ===`; Test Files 60 passed (60), Tests 544 passed (544); Rust 182 passed, 0 failed, 3 ignored; Clippy clean; `git diff --check` clean.
- **Next:** 🛑 MANUAL TEST CHECKPOINT M4.1 — run M4-S1-01/02 in the app (needs browser + network). No commit, no push, no Stage 2 until user approves.

## 2026-11-10: M4-03 Auth UI in Settings (branch `m4-stage-1`, uncommitted)

- **Built:** `GithubAccounts` section in Settings (account rows with live status + silent stale prune + retry, device-flow box with code/URI + interval polling + cancel, PAT box with password field, danger-confirmed sign-out, default set/clear) wired into `SettingsView`; 10 new `settings.github*` strings.
- **Review:** spec-reviewer PASS all 6 ACs (`.agent/reviews/m4-task-03-spec.md`); advisories addressed (cancel comment, dead branch removed, +5 tests: cancel/expired/prune-false/prune-throw/default toggle).
- **Verification:** `pnpm typecheck` clean; `./init.sh` — `=== Verification Complete ===`; Test Files 60 passed (60), Tests 544 passed (544); Rust 180 passed, 0 failed, 3 ignored; Clippy clean; `git diff --check` clean.
- **Next:** M4 Stage 1 review task (manual device-flow/PAT UI test needs browser + network). No commit or push.

## 2026-11-10: M4-02 Device flow + PAT, multi-account (branch `m4-stage-1`, uncommitted)

- **Built:** `gh_auth_start` (device_code backend-only in pending map) + interval-enforced `gh_auth_poll` (slow_down backoff, terminal states) + `gh_auth_pat` verify-and-store, per-account `TokenStore`/`set/status/sign_out`, `curl`-argv-only HTTP (30 s cap), `resolveAccountForRemote` + owner parser, `useGithubAccounts` username-only index persisted via settings.
- **Review:** first spec-review FAIL on criterion 6 only (index unwired) → added `store.ts` + tests → re-review PASS all 7 ACs (`.agent/reviews/m4-task-02-spec.md`). Scope clean (no UI/poller); credential safety clean.
- **Verification:** `pnpm typecheck` clean; `./init.sh` — `=== Verification Complete ===`; Test Files 59 passed (59), Tests 532 passed (532); Rust 180 passed, 0 failed, 3 ignored; Clippy clean; `git diff --check` clean.
- **Next:** M4-03 auth UI in Settings. Manual device-flow/PAT test still pending (needs browser + network). No commit or push.

## 2026-11-10: M4-01 Keychain token store + IPC (branch `m4-stage-1`, uncommitted)

- **Built:** `src-tauri/src/gh.rs` (`TokenStore` trait; `KeychainStore` via `security` CLI, `MemoryStore` cfg(test); single `dev.branchwork.app`/`github-token` entry; argv-only invocation, validated input) + `gh_auth_set_token/status/sign_out` commands, regen bindings, `src/ipc/github.ts` wrapper + routing tests.
- **Review:** spec-reviewer PASS on all 5 ACs (`.agent/reviews/m4-task-01-spec.md`); scope clean (no UI/device flow); `cli.rs` diff is rustfmt-only.
- **Verification:** `pnpm typecheck` clean; `./init.sh` — `=== Verification Complete ===`; Test Files 57 passed (57), Tests 521 passed (521); Rust 177 passed, 0 failed, 3 ignored; Clippy clean; `git diff --check` clean.
- **Next:** M4-02 device flow + PAT. No commit or push.

## 2026-11-10: M3 Stage 6 committed and merged (user-ordered, no push)

## 2026-11-10: M3 Stage 6 committed and merged (user-ordered, no push)

- **Commit:** one stage commit on `m3-stage-6`, fast-forwarded into `main`, branch deleted. Covers the right-side project rail, title-bar context/toggle, New Agent dialog login reuse, agent-pane login hint, login-detected setup guidance, and the Claude onboarding seed IPC. Untracked agent-memory dirs (`.claude/`, `src-tauri/.claude/`) and `node-compile-cache/` left out of the commit.
- **Verification at commit:** `pnpm typecheck` clean; `./init.sh` `=== Verification Complete ===` (56 files / 519 tests; Rust 173 passed, 0 failed, 3 ignored); `git diff --check` clean; user approved manual M3-S6-01 and the Claude login retest.
- **Next:** Await user direction. Do not push.

## 2026-11-10: Login-detected toast points at Claude's setup wizard (uncommitted)

- **Report:** fresh `claude auth login` prints "Login successful", then the same terminal lands on "Select login method" — read as another login request.
- **Cause:** the probe turns true the moment the browser step completes, while the second `claude` command still runs the one-time setup wizard (flag missing on old profile dirs). The success toast arrived with no mention of the wizard.
- **Fix:** `monitorLogin` in `src/agents/profiles.ts` adds `detail: t("agents.loginFinishSetup")` (new key in `src/i18n/en.ts`) for Claude: the login is done, answer the setup screen once in the terminal. Regression test asserts the detail on the detected toast (failed with the change stashed, passes with it).
- **Verification:** `pnpm typecheck` clean; `./init.sh` — `=== Verification Complete ===`; Test Files 56 passed (56), Tests 519 passed (519); Rust 173 passed, 0 failed, 3 ignored; `git diff --check` clean.
- **Next:** Rebuild, redo the login, follow the toast: answer the wizard once (option 1). No commit or push.

## 2026-11-10: Seed Claude onboarding flag so verified logins skip the wizard (uncommitted)

- **Cause (proven):** the interactive `claude` TUI runs its Welcome/theme/login-method wizard whenever the profile config lacks `hasCompletedOnboarding` — even with valid OAuth (`auth status` → logged in, `claude -p` authenticates). Real-pty captures: profile without flag → picker; host with flag → straight to prompt; test copy with only the flag added → straight to prompt (copy deleted; real credential file never read/written). A `settings.json` flag is ignored by the vendor — only `.claude.json` counts, and that file holds the OAuth secret.
- **Fix:** new `cli_seed_onboarding` IPC (`src-tauri/src/cli.rs` + `src-tauri/src/lib.rs`, bindings regen) exclusive-creates (atomic `create_new`) the profile `.claude.json` with only `{"hasCompletedOnboarding":true}`; never reads, merges, overwrites, or logs — existing tokens can't be observed or clobbered, and the vendor merges keys on later writes (verified). Called best-effort from `createProfile` and `loginProfile` for claude only (`src/agents/profiles.ts` + `src/ipc/cli.ts` wrapper). New profiles never land on the picker; pre-existing flagless dirs (e.g. claude-personal) still need the one-time in-pane setup the banner describes — they can't be repaired without reading secrets.
- **Coverage:** Rust tests (create-once, repeat no-op preserves content, rejects non-claude/bad slugs); `src/ipc/cli.test.ts` routing; `src/agents/profiles.test.ts` (seeded at creation, re-seeded on login reopen, never for other CLIs, survives failure). The two positive seed tests failed with the `profiles.ts` change stashed.
- **Verification:** `pnpm typecheck` clean; `./init.sh` — `=== Verification Complete ===`; Test Files 56 passed (56), Tests 518 passed (518); Rust 173 passed, 0 failed, 3 ignored; `git diff --check` clean. New profiles must be created after this change to carry the seed (restart not required for the frontend part; backend change needs a rebuilt app).
- **Next:** Retest: create a new Claude profile → login → Add Agent → straight to prompt. Existing personal profile: finish one-time setup in the agent pane once; note weekly limit until Nov 12. No commit or push.

## 2026-11-10: Login-screen picker on a verified-logged-in Claude profile (uncommitted)

- **Report:** Agents → New Agent with the correct (logged-in) Claude profile still opened Claude's "Select login method" picker.
- **Root cause (proven on this host):** the profile dir has valid OAuth (`auth status --json` → `loggedIn: true`, `claude -p` authenticates) but never completed interactive onboarding — profile `.claude.json` lacks `hasCompletedOnboarding` (host has it and skips onboarding). The TUI therefore runs Welcome → theme → login-method picker, which is visually identical to a logged-out state. Verified with real-pty captures: profile → picker; host (flag set) → straight to workspace trust; a copy of the profile with only the flag added → straight to trust (copy deleted afterwards; real credential file untouched). Separately, `claude -p` reports this account hit its weekly limit (resets Nov 12), so API calls stay refused even after onboarding until reset/account switch.
- **Fix:** `AgentPaneBody` in `src/screens/agents/AgentsScreen.tsx` shows an inline notice when a Claude session is `waiting` while its profile probe is verified linked: finish the one-time setup in the pane (no re-login needed), plus a warning that a usage-limit report means the account is at its cap, with an "Open login terminal" action (`loginProfile`). New strings `agents.loggedInWaiting` / `agents.openLoginTerminal` in `src/i18n/en.ts`.
- **Coverage:** two pane tests (banner shown when linked, hidden when not) + the two dialog tests; the three positive tests were observed failing with the fix stashed and pass with it.
- **Verification:** `pnpm typecheck` clean; `./init.sh` — `=== Verification Complete ===`; Test Files 56 passed (56), Tests 515 passed (515); Rust 171 passed, 0 failed, 3 ignored; `git diff --check` clean.
- **Next:** In the agent pane, finish the one-time Claude setup (theme → login method #1 → browser auth for the same account). Note the weekly limit until Nov 12: use the host account/another profile or wait. No commit or push.

## 2026-11-10: New Agent dialog reuses the Settings login (uncommitted)

- **Cause:** The New Agent dialog always defaulted the profile selector to "New profile…", so opening it after a Settings login created/selected a fresh logged-out profile dir. The spawn guard then correctly blocked with "Log in … first", which looked like the Settings login was ignored. The probe itself was verified per-profile on this host (`CLAUDE_CONFIG_DIR=…/claude-personal` → `loggedIn: true`).
- **Fix:** `src/screens/agents/AgentsScreen.tsx` preselects `resolveProfile(cliId)` (global/cli default, else first profile) on open and on CLI switch; shows live `Logged in` / `Not logged in` + inline `Sign in again` for the selected profile (same `checkProfileLogin` the guard uses, 5 s repoll); Start is disabled only when verified logged-out (`linked === false`), unknown providers stay enabled.
- **Coverage:** Two regression tests in `src/screens/agents/AgentsScreen.test.tsx` failed before (`__new` vs `personal`) and pass now.
- **Verification:** `pnpm typecheck` clean; `./init.sh` — `=== Verification Complete ===`; Test Files 56 passed (56), Tests 513 passed (513); Rust 171 passed, 0 failed, 3 ignored; `git diff --check` clean.
- **Next:** Restart/reload lalu ulangi langkah user: Settings → login Claude → Agents → tambah agent → profil yang sudah login langsung terpilih + Start aktif. No commit or push.

## 2026-11-10: Right project-sidebar prototype + account-removal hardening (uncommitted)

- **Prototype:** Updated `docs/design/prototype.html` with a searchable right-side project rail, collapsible groups, active-project state, group/project actions, a compact context breadcrumb, and a responsive overlay layout. Left navigation and worktrees remain separate. Playwright interaction check passed for search, selection, and context updates.
- **Security fixes:** Account removal now requires native confirmation at the Tauri IPC boundary; the confirmation explains that Muse sign-out affects every Muse profile on the device. Muse vendor logout no longer runs for a missing/non-directory profile. Declining native confirmation preserves the account record.
- **Verification:** `./init.sh` — `=== Verification Complete ===`; typecheck clean; Test Files 55 passed (55), Tests 507 passed (507); Rust 171 passed, 0 failed, 3 ignored; Clippy clean. `cargo fmt -- --check` and `git diff --check` clean.
- **Next:** Review `docs/design/prototype.html` before any production sidebar changes; restart the app for manual Settings account-flow retest. No commit or push.

## 2026-11-10: Settings profile login and management follow-up (uncommitted)

- **Changed:** Settings Add profile now creates the profile in place and shows its account row with a Log in action rather than navigating immediately. Log in remains available for an unavailable/unknown status and while a login is pending. Added Edit (renames the display label, preserving the profile slug/folder) and Remove profile actions for every account state. Settings layout now uses the full available width.
- **Coverage:** Added Settings tests for in-place profile creation, retry on unavailable/pending login, rename with stable slug, and Edit/Remove availability; added profile-store rename validation tests.
- **Verification:** `./init.sh` exit 0 — typecheck and Clippy clean; 55 Vitest files / 499 tests passed; Rust 165 passed, 0 failed, 3 ignored; `git diff --check` clean.
- **Next:** Restart/reload and verify Settings → Add profile → Log in, retry after cancel, rename/remove, and full-width layout. No commit or push.

## 2026-11-10: Login terminal was hidden; blocked agent creation left a dead pane (uncommitted)

- **Cause:** Profile login created a Terminal-screen tab but did not navigate to that screen, leaving the interactive vendor login inaccessible. If a Terminal tab was created before the screen's initial settings load, that load could also overwrite the new tab. Separately, Add Agent treated a login-blocked attempt as a created session, closing the dialog and leaving a dead pane.
- **Fix:** Login now loads and opens the Terminal screen before starting the vendor command; terminal settings load is idempotent and `openHere` loads before adding a tab. Login-blocked starts now return no session and remove the temporary pane; the newly created profile stays selected in the dialog.
- **Verification:** `./init.sh` exit 0 — typecheck and Clippy clean; 55 Vitest files / 494 tests passed; Rust 165 passed, 0 failed, 3 ignored.
- **Next:** Restart the app; use Claude's Settings login and verify the Terminal screen opens visibly, complete login, then try Add Agent with that profile. No commit or push.

## 2026-11-10: Claude profile login status mismatch (uncommitted)

- **Cause:** Settings probed Claude's host-default config while agent sessions and login used the selected profile's `CLAUDE_CONFIG_DIR`. The host could report logged in while the isolated profile still needed login/onboarding.
- **Fix:** Settings now probes the same profile environment as the agent, keeps each Claude profile's identity separate, and shows unknown separately from logged out when the probe cannot verify status. Starting Claude is blocked only when that profile probe explicitly reports logged out, with the existing Log in action; an unknown probe does not falsely claim the user is logged out.
- **Regression coverage:** Added Settings coverage for host logged-in/profile logged-out mismatch and session coverage for both refusal and successful launch with the same profile environment.
- **Verification:** `./init.sh` exit 0 — typecheck clean; 55 Vitest files / 493 tests passed; Rust 165 passed, 0 failed, 3 ignored; Clippy clean.
- **Next:** Restart the app, confirm the prior Claude profile shows `Not logged in`, then complete login through that profile's Settings action and start an agent. No commit or push.

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

## 2026-11-08: Checkpoint M3.1 approved → Stage 1 committed, Stage 2 started

- **Manual OK:** user approved M3-S1-01..07 and ordered "commit & lanjut Stage 2".
- **Stage commit:** `a95e38f feat: complete M3 Stage 1` (39 files, +4014/-36) on `m3-stage-1`, fast-forwarded into `main`, branch deleted. No push.
- **Stage 2:** branch `m3-stage-2` from `a95e38f`; `m3-stage-1-review` → done; `m3-task-04-layout-reducer` → in-progress.
- **Next:** M3-04 pure layout-tree reducer (spec §6.5a) + unit tests, then M3-05. No commit/push until Stage 2 checkpoint approval + order.

## 2026-11-08: M3 Stage 2 implementation complete → 🛑 Checkpoint M3.2

- **M3-04 layout reducer** (`src/terminal/layout.ts` + 18 tests): split/nest, close/collapse, gutter clamp 8%, equalize, edge-bordered focus, maximize toggle, deep-freeze immutability. Spec PASS. M3-04 file authored from spec §6.5a (was missing).
- **M3-05 Terminal screen**: store (`screen.ts`, 19 tests), UI (`TerminalScreen.tsx`, 3 tests, `terminal-screen.css`), CliPane input/resize hooks, dock adopt/detach + ⤴ move button, 5 palette commands, Files/Graph/Changes "Open in Terminal screen" items, `VIEWS.terminal` wired, `screen.*` i18n. Reviews: task spec PASS, stage code PASS (fixed gutter-drag reference-box defect), security PASS (no new IPC/backend; cd quoting tested).
- **Deferred:** shell display name (backend reports no shell), "Run Claude Code here" (Stage 3), sidebar-hover/toolbar screen entries (context menus + palette covered).
- **Gate:** `./init.sh` green — 45 Vitest files / 376 tests; Rust 139 passed / 3 ignored; typecheck + Clippy clean. `pnpm test:e2e` 76/76 (nav assertion updated for the real screen).
- **Manual spec:** M3-S2-01..07 written in `docs/testing/m0-manual-e2e.md`.
- **Next:** user runs manual M3-S2-01..07 (+ M3-S1 regression). On go-ahead + order: single stage commit on `m3-stage-2`, ff into `main`. No push. Never start Stage 3 without go-ahead.

## 2026-11-08: Checkpoint M3.2 approved → Stage 2 committed, Stage 3 starting

- **Manual OK:** user approved M3-S2-01..07 and ordered "commit & lanjutkan".
- Tracking finalized: `m3-stage-2-review` → done; handoff/progress moved to Stage 3.

## 2026-11-08: M3-06 + M3-07 done; brand logo wired

- **M3-06 CLI registry** (+ Copilot & Muse per user order, flags verified: copilot 1.0.107 `--continue`, muse 1.4.14 `resume --last`; gemini unverified). `cli_resolve` + `cli_profile_dir`, typed wrappers, regenerated bindings. Review PASS.
- **M3-07 profiles**: store (CRUD, defaults, resolution order, `ask()` logout deleting only declared credential files, login terminal with profile env), `pty_spawn` env extension with validation, credential layouts verified by file existence only (claude `.claude.json`, codex `auth.json`). No credential handling anywhere (tested). Review PASS.
- **Gate:** `./init.sh` green — 48 files / 395 tests; Rust cli 7/7, pty 13/13; typecheck+Clippy clean. Fixed a parallel-test temp-dir collision found by the full gate.
- **Brand logo**: user-supplied mark → transparent `public/branchwork-mark.png` (white) + `branchwork-mark-dark.png`; titlebar `.app-mark` via CSS mask (auto dark/light), favicon, README `<picture>` logo. Verified with Playwright screenshots in both themes.
- **Next:** M3-08 agent sessions. No commit/push (Stage 3 rule).

## 2026-11-08: M3-08 solo-pane default full view

- **User order:** sesi agent tunggal tampil full width + full height sampai di-split.
- **Fix:** `AgentsView` tambah class `agent-solo` saat tepat 1 sesi berslot `auto` (default sesi baru); CSS `.agent-solo .agent-grid` 1 kolom `height: 100%`, pane `min-height: 100%`. Pin slot eksplisit dan 2+ sesi tetap grid normal.
- **Test:** 1 test baru (`agent-solo`); agents suites 30/30, typecheck bersih.
- **Belum commit** (aturan Stage 3: tunggu checkpoint + order).

## 2026-11-08: Agents edge-to-edge

- **User order:** tombol New agent dan grid mentok ke pinggir.
- **Fix:** `.agent-screen` padding 10px → 0; `.pane-tool:has(.agent-grp)` padding-right 0 (hanya header Agents, chrome shared lain tak tersentuh). Screenshot header memastikan tombol nempel kanan.
- **Belum commit** (aturan Stage 3).

## 2026-11-08: Solo-pane height fix (growth loop)

- **User lapor:** input box agent melebar ke bawah terus setelah perubahan solo full-view.
- **Fix:** `height: auto + min-height: 100%` (tinggi mengikuti konten, rawan loop) diganti baris grid pasti `1fr + align-items: stretch`; pane tetap isi penuh tapi tingginya deterministik.
- **Tests:** agents 5/5 hijau.

## 2026-11-08: Grid split full-height

- **User order:** split 2 agen tingginya kembali setengah (340px); harusnya tetap penuh.
- **Fix:** `.agent-grid` baris `minmax(310px, 1fr) + height: 100%` (ikut prototype `.agrid`); pane `height: auto, min-height: 310px` agar stretch isi baris. 2 pane → masing-masing penuh tinggi; 3+ pane → berbagi tinggi, scroll bila lewat minimum.
- **Tests:** agents 5/5 hijau.

## 2026-11-08: Semua header full-width

- **User order:** tombol di setiap header halaman full width / ke pinggir.
- **Fix:** `.pane-tool` padding kanan 12px → 0 (global, stage.css); aturan anti-split-margin diperluas ke `.pane-ctl ~ .pane-ctl` agar toolbar Terminal/Agents (grup `.pane-ctl` sendiri) tidak berbagi ruang dengan PaneControls — tombol ＋ Terminal yang tadinya melayang di tengah kini mengelompok kanan. Aturan `:has` khusus Agents dihapus (redundan).
- **Verifikasi:** screenshot header Agents, Graph, Terminal — tombol mentok kanan. Tests stage+shell+agents 62/62.

## 2026-11-08: Auto-close agent pane on clean exit + muse login note

- **User order:** pane agent harus langsung tutup saat proses keluar (ketik `exit`).
- **Fix:** exit PTY bersih (code 0, tanpa signal) → `closeSession` otomatis (toast Undo tetap ada); exit abnormal → pane dipertahankan agar error terlihat; close record yang sudah exit tidak lagi memanggil `pty_stop` (backend melaporkan gone). 2 test.sessions diperbarui/ditambah; agents 31/31.
- **muse login:** error `macOS Keychain did not answer within 5 s` berasal dari CLI `muse` vs Keychain (timeout 5 dtk milik vendor, sering karena approval akses pertama). Tidak ada knob non-Keychain di `muse` (cek `auth set --help`, settings keys). Saran: ulangi `muse login` di pane yang sama (klik Always Allow bila macOS meminta), atau pakai `META_API_KEY` yang diketik sendiri di pane. Tidak ada perubahan kode — kredensial tetap hanya diketik ke vendor CLI.
- **Belum commit** (aturan Stage 3).

## 2026-11-08: muse pakai metode Orca (tanpa sandbox HOME)

- **User lapor:** `muse login` di profile terisolasi tetap gagal (Keychain timeout).
- **Investigasi:** env sesi Orca menunjukkan HOME asli + isolasi hanya via env var resmi vendor (`CLAUDE_CONFIG_DIR` untuk claude; tanpa itu jalan dengan env asli). Keychain `muse` hanya bekerja di HOME asli.
- **Fix:** `CLI_REGISTRY.muse.profileEnv` → `{}` (warisi environment user, tanpa sandbox HOME). Logout tetap no-op. Registry test disesuaikan; agents 26/26 hijau.
- **Belum commit** (aturan Stage 3).

## 2026-11-08: M3-08 done — Stage 3 implementation complete

- **M3-08 agent sessions:** store, New Agent dialog (7 CLIs), session grid, `pty_stop` (SIGINT → force 3s), close confirm + Undo resume relaunch, dock sharing, clean-exit auto-close, `useSessions.load()` fix, Agents h1 convention fix, solo/grid full-height + edge-to-edge headers. Reviews: spec PASS, code PASS (2 fixed), security PASS.
- **Gate:** `./init.sh` green — 50 files / 411 tests, `=== Verification Complete ===`; `pnpm test:e2e` 76/76. Reviews: `.agent/reviews/m3-task-08-spec.md`, `m3-stage-3-code.md`, `m3-stage-3-security.md`. Manual: M3-S3-01..05 in `docs/testing/m0-manual-e2e.md`.
- **Next:** M3-09 session status (then M3-10, stage review + manual M3-S3-01..05 checkpoint). On checkpoint approval + order: single stage commit on `m3-stage-3`, then ff into main. No push.
- **Belum commit** (menunggu approval checkpoint + order).

## 2026-11-08: M3-09 done — session status + notifications

- **M3-09:** status field (idle/running/waiting/done), `branchwork-notify` sidecar + Unix socket + validation, Claude hooks merge (profile dir only, user keys preserved), heuristics (per-CLI patterns matched on fresh output only + 4 s idle), sidebar badge, yellow `st-waiting` outline, toast + macOS notification while unfocused.
- **Verified:** sidecar delivers over a real socket (exit 0/1/2 paths); Rust notify 3/3, full Rust 153, Clippy clean; typecheck clean; init.sh 51 files/423 tests; e2e 76/76. Spec PASS. Hook delivery by a real CLI left to manual M3-S3-06.
- **Honest limits:** CLI-specific patterns empty pending interactive verification (generic cues only); codex hook shape unverified (heuristics cover it); Launchpad cards deferred (no Launchpad screen).
- **Next:** M3-10 agent lifecycle + profile switching. No commit/push (stage rule).

## 2026-11-08: M3-10 done — Stage 3 tasks complete

- **M3-10:** chip profile menu (✓ current, add, manage→Settings), switchProfile (confirm-if-running, dock-shared refused, stop→close→relaunch resume + dim line), switchToNextProfile cycle, `/account` interception, limitPatterns + banner/toast + auto-switch (default on, persisted), no usage bars (hidden, none exposed).
- **Fixed in review:** zustand selector fresh-array infinite loop (subscribe raw + filter in render). SkipConfirm only on consent-carrying paths.
- **Gate:** init.sh 51 files/434 tests, e2e 76/76, Rust 153, Clippy clean, typecheck clean. Spec PASS; stage-3 code+security addenda PASS. Manual M3-S3-07 written.
- **Next:** user runs manual M3-S3-01..07 checkpoint. On approval + order: single stage commit on m3-stage-3, ff into main. No push.

## 2026-11-08: Fix `cargo run` ambiguity (tauri dev)

- **Error:** `cargo run could not determine which binary to run` — sidecar `branchwork-notify` menambah binary kedua.
- **Fix:** `default-run = "branchwork"` di `src-tauri/Cargo.toml`. Manifest terparse, `cargo check --all-targets` bersih. (Verifikasi `cargo run` langsung tidak dilakukan — akan membuka GUI.)

## 2026-11-08: Stage 3 committed + merged (user ordered)

- **Gate re-run before commit:** init.sh green (51 files / 434 tests), e2e 76/76.
- **Commit:** single stage commit on m3-stage-3 (user ordered; no push), ff into main.
- **Next:** M3 Stage 4 (handover, race) — derive task file first.

## 2026-11-08: Stage 3 committed (c110d42) + merged to main

- **Commit** `c110d42` (user ordered; no push): 49 files, Stage 3 (06-10). `m3-stage-3` ff into main, branch deleted.
- **Next:** M3 Stage 4 — handover (11), race (12).

## 2026-11-09: M3-11 handover implemented — WIP committed on m3-stage-4 (user ordered, no push)

- **M3-11:** HandoverDialog per agent pane (From/To/Where, source CLI disabled, profile select, same/new worktree + branch default `handover/<branch>-<cli>`), editable note prefilled with changed files + optional last-50 output tail (200-line rolling buffer) + optional capped git diff, preview of launch command, Start gated on target CLI + profile + worktree; backend `handover.rs` (note + `.git/info/exclude`, traversal-safe via catalog validation, caps 200k/100k) with 4/4 Rust tests; `closeSession(id, {confirm})` for stop-source.
- **Gate:** init.sh green (52 Vitest files / 440 tests; Rust 157 passed / 3 ignored; typecheck + Clippy clean); e2e 76/76. `cargo fmt --check` diff in `branchwork-notify.rs` is pre-existing (verified via stash), untouched.
- **Commit:** WIP on `m3-stage-4` per user order (no push, no merge — stage commit still pending checkpoint + M3-12 + reviews).
- **Next:** M3-11 spec review + Stage-4 code/security addenda, manual M3-S4 steps, then M3-12 Race (task file `.agent/tasks/m3-task-12-race.md` does not exist yet — derive from spec §6.6.x/plan line 41).

## 2026-11-09: M3-11 addenda reviews — code + security APPROVE

- **Code** (`.agent/reviews/m3-task-11-code.md`): APPROVE, no blocking issues. Null paths in handover flow already toast; `checkBinaries` can't reject. 2 deferred minors: `/`-split parent derivation (macOS-correct, backend re-canonicalizes), duplicated local `slugify`.
- **Security** (`.agent/reviews/m3-task-11-security.md`): APPROVE, no findings. Both new commands catalog-validate + canonicalize paths; fixed filenames; 200k/100k caps; append-only exclude; strict `.git` file parse; argv-only git (no shell); branch ref-name validation in `create_from`; diff/note never touch HTML.
- **Next:** manual M3-S4 steps, then derive `.agent/tasks/m3-task-12-race.md` and work M3-12. No commit/push (not ordered).

## 2026-11-09: Fix Agents page not following active worktree/project (user report)

- **Bug:** `AgentsView` rendered all sessions regardless of context; switching project/worktree kept showing the previous sessions. Files/Changes/Graph/Blame already follow `activePath` — only Agents did not.
- **Fix:** `AgentsView` filters sessions to `activePath` (null = no project open → show all, preserving old behavior there). Handover-to-new-worktree now does `load(project)` + `select(created.path)` (same pattern as Graph) so the target session stays visible and the sidebar follows.
- **Tests (durable):** 2 new focused tests in `AgentsScreen.test.tsx` — worktree filter + switch, and handover selecting the created worktree. Both failed before the fix (authentic red). Mock-fidelity fixes: `writeTerminal`/`stopTerminal`/`closeTerminal`/`saveSetting` mocks now return promises like the real IPC wrappers (the `saveSetting` one was the actual blocker: `select()` does `void saveSetting(...).catch(...)`).
- **Gate:** init.sh green (52 files / 442 tests; Rust 157 passed / 3 ignored; typecheck + Clippy clean); e2e 76/76. No commit/push (not ordered).

## 2026-11-09: Fix garbled terminal + stray input on project switch (user report)

- **Cause:** worktree filter unmounted/remounted every pane on project switch → 256 KiB output replay + resize/SIGWINCH storm garbles full-screen CLI apps (messy display, stray redraw chars in the input line).
- **Fix:** off-worktree panes stay mounted but hidden (`agent-off`, `display:none`); grid always renders; empty state keys off visible count. `CliPane.syncSize` now skips duplicate dims (sends once; clears on failure so the next pass retries) — hide/show with unchanged size sends zero resizes.
- **Tests:** rewrote the 2 scoping tests to mounted-but-hidden semantics + new empty-state-per-worktree test; CliPane debounce tests still green (single send preserved). Gate: init.sh 52 files/443 tests, Rust 157, typecheck + Clippy clean; e2e 76/76. No commit/push (not ordered).

## 2026-11-09: Committed + continued (user ordered)

- **Commit** `a8b289c` on `m3-stage-4` (user ordered; no push/merge): worktree scoping without remounts + preview note path + reviews are gitignored under `.agent/`.
- **Manual spec:** M3-S4-01..04 + Stage 4 result table written to `docs/testing/m0-manual-e2e.md` (uncommitted).
- **Next:** M3-12 Race — `.agent/tasks/m3-task-12-race.md` derived from spec §6.6.6 (prompt via `prefix`, unpin helper shared with handover, branch-deleting discard, no §6.8 compare yet). Not started.

## 2026-11-09: M3-12 Race implemented (user ordered)

- **Race:** ⚑ toolbar button + RaceDialog (prompt, CLI multi-select with binary gating, default profiles, missing-profile block, slug `race/<slug>-<cli>`), per-CLI unpinned worktrees via `createUnpinnedWorktree` (handover adopts it too), prompt as first input via `NewAgentRequest.prompt` → existing `prefix` mechanism, entries with live status + changed counts, Keep/Discard (confirm → stop → remove worktree AND branch → reload).
- **Backend:** `worktree::remove(..., delete_branch)` — pre-removal branch resolve, main-branch refusal, detached skip, `branch -D`, explicit partial-failure error. 4 new Rust tests. `src/ipc/bindings.ts` regenerated via official ignored-test path.
- **Gate:** init.sh green (52 files/449 tests; Rust 161 passed/3 ignored; typecheck + Clippy clean — one collapsible_if fixed); e2e 76/76. Spec review PASS. No commit/push (not ordered).
- **Next:** Stage 4 code/security review, then user runs manual M3-S3+M3-S4 checkpoint. Single stage commit + ff into main only after approval + order.

## 2026-11-09: Stage 4 reviews done (code+security+e2e) + modal tidy

- **Reviews:** `.agent/reviews/m3-stage-4-code.md` APPROVE, `m3-stage-4-security.md` APPROVE (no findings), `m3-stage-4-e2e.md` automated 76/76 PASS. Two review-driven fixes: discard-without-project guard + empty-grid collapse (both tested).
- **Modal tidy (user order):** `.dlg-wide` (560px) for New agent/Handover/Race, one-line ellipsis CLI card names with full-name titles, Contestants empty hint (`agents.raceEmpty`). Detector: no new findings (only pre-existing `--spring` warnings).
- **Gate:** init.sh exit 0 + Verification Complete (52 files/450 tests; Rust 161/3 ignored; typecheck + Clippy clean); e2e 76/76. No commit/push (not ordered).
- **Awaiting user:** manual M3-S3-01..07 + M3-S4-01..04, then stage commit order.

## 2026-11-09: Committed Stage 4 progress + specced 2 gaps (user ordered)

- **Commit** `b1e6004` on `m3-stage-4` (no push/merge — manual checkpoint still pending): M3-12 race, discard, modal tidy, M3-S4 manual spec, Stage 4 reviews.
- **Gap specs (new Stage 5):** `.agent/tasks/m3-task-13-pane-cli-switcher.md` (header CLI dropdown → handover preset; spec §6.6 line 358) and `.agent/tasks/m3-task-14-settings-accounts.md` (Settings per-CLI add/list/default/logout; spec line 566; per-repo/group default UI deferred, usage stays hidden). Entries added to `feature_list.json` (stage 17). Not started — needs Stage 4 checkpoint go-ahead first.

## 2026-11-09: Stage 4 checkpoint approved + merged (user ran manual OK)

- **Manual:** user ran M3-S3-01..07 + M3-S4-01..04 — OK.
- **Tasks 11/12 + stage-4-review → done.** Stage branch merged to main (ff-only, branch deleted, no push).
- **Next:** M3 Stage 5 (13 CLI switcher → 14 settings accounts → 15 provider icons → review).

## 2026-11-09: M3-13 CLI switcher implemented (Stage 5)

- **Switcher:** agent pane chip → `select.agent-cli-switch` (all agent CLIs, current selected); choosing another CLI opens Handover with the target preset, nothing runs before Start. Re-select = no-op; disabled while its dialog is open. Preset cleared on every dialog close path.
- **Gate (focused):** 21/21 agents tests + typecheck clean. Spec review PASS. No commit/push (not ordered).
- **Next:** M3-14 Settings accounts, then M3-15 icons, then Stage 5 review.

## 2026-11-09: M3-14 Settings accounts implemented

- **Accounts card:** per-CLI add (login-terminal flow), rows with name + profile-dir path + Default badge, set/clear default (resolveProfile follows), confirmed logout deleting only declared credential files. Auto-switch untouched.
- **Gate (focused):** 4/4 settings tests + typecheck clean. Spec review PASS. No commit/push (not ordered).
- **Next:** M3-15 provider icons, then Stage 5 review.

## 2026-11-09: M3-15 provider icons implemented

- **Marks:** `CliIcon` inline SVGs (7 abstract stroke glyphs, currentColor, theme-safe); registry unicode glyphs deleted; rewired chip, switcher (name-only in native options), 3 card grids, race entries, Settings rows, 8 toast/ask sites (toast/ask icon widened to ReactNode).
- **Gate:** init.sh exit 0 + Verification Complete (53 files/458 tests; Rust suite green; typecheck + Clippy clean). Spec review PASS. No commit/push (not ordered).
- **Next:** Stage 5 review (code + security + e2e), then user manual checkpoint.

## 2026-11-09: M3-15 switched to real provider icons (user order)

- **Real artwork:** Simple Icons paths (Claude, OpenAI, OpenCode, Gemini, Copilot, Meta; CC0, trademarks belong to owners) embedded inline, monochrome currentColor; custom CLI keeps an abstract terminal glyph. Unicode glyphs gone everywhere.
- **Gate:** init.sh exit 0 + Verification Complete (53 files/458 tests); e2e 76/76. Spec review PASS (review file updated to real-artwork verdict). No commit/push (not ordered).

## 2026-11-09: Stage 5 reviews done (code+security+e2e) + manual spec

- **Reviews:** `.agent/reviews/m3-stage-5-code.md` APPROVE, `m3-stage-5-security.md` APPROVE (no findings), `m3-stage-5-e2e.md` automated 76/76 PASS. No new review-driven code changes.
- **Manual spec:** M3-S5-01..03 + result table in `docs/testing/m0-manual-e2e.md`.
- **Gate:** init.sh exit 0 + Verification Complete (53 files/458 tests; Rust 161; typecheck + Clippy clean); e2e 76/76. No commit/push (not ordered).
- **Awaiting user:** manual M3-S5-01..03, then stage commit order.

## 2026-11-09: M3-13/14/15 marked done; Stage 5 merge ON HOLD

- Tasks 13/14/15 → done (implemented, spec PASS each, gate green at completion).
- `m3-stage-5-review` stays in-progress: automated part PASS, manual M3-S5-01..03 has no user result yet. Merge to main (and any stage commit) waits for the manual checkpoint approval per the no-commit-without-checkpoint rule.

## 2026-11-09: Stage 5 checkpoint approved + merged (user ran manual OK)

- **Manual:** user ran M3-S5-01..03 — OK.
- **Tasks 13/14/15 + m3-stage-5-review → done.** All 87 features done → M3 complete.
- **Next:** M3 release (0.3.0 bump + tag) only on user order; no push.

## 2026-11-09: M3 released as v0.3.0 (user ordered push + tag)

- **Release:** version bump 0.2.0 → 0.3.0 (`package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`; `Cargo.lock` follows), commit `chore(release): v0.3.0`, tag `v0.3.0` ("M3: Terminal & Agents").
- Pushed `main` + tag to origin per explicit user order.

## 2026-11-09: Post-M3 account-login + usage-bar fix (uncommitted)

- **Report:** Add account hanya menambah profil tanpa login sungguhan; Settings perlu kelola akun sebenarnya + progress bar monitoring token ala prototype.
- **Fix 1 — real login:** `addProfile` kini mendaratkan pane ke `loginCmd ?? launch[0]` (claude/opencode/gemini masuk ke TUI vendor, bukan shell kosong) + rollback profil bila `resolveProfileDir`/`newTab`/write gagal; custom tanpa override → toast jelas, bukan unhandled rejection. Test: rollback + custom + claude-lands-in-CLI.
- **Fix 2 — usage bar (spec §6.6.4, no-fabrication):** store `usage` ephemeral (tidak dipersist) + `setProfileUsage` (clamp 0–100) via `src/agents/usage.tsx` (`UsageBar`, threshold prototype ≥90/≥70); tampil di chip profil Agents, menu profil (extra %), dan baris akun Settings (`Limit {window} · {%}` / `No usage data`). Angka hanya muncul bila hook CLI melaporkannya.
- **Gate:** init.sh exit 0 (53 files / 465 tests; Rust 161 passed / 3 ignored; typecheck + Clippy clean); `pnpm test:e2e` 76/76.
- **Belum:** commit menunggu perintah user (aturan no-commit). Belum ada wiring parser status/usage CLI sungguhan — itu lanjutan bila format CLI terverifikasi.

## 2026-11-09: Login ala Orca untuk seluruh provider (uncommitted)

- **Investigasi:** `orca account add --help` → Orca menjalankan login vendor di terminal (`claude login` / `codex login`, device flow untuk codex; `opencode auth login --standalone` untuk OpenCode 2; `devin auth login --force-manual-token-flow`), lalu mendaftarkan akun (email, authMethod, home isolasi per akun). `orca account list --json` terverifikasi di host ini.
- **Koreksi registry (terverifikasi via `--help` asli):** claude `null` → `"claude auth login"` (`claude auth login/logout/status [--json]` ada di 2.1.280 — komentar lama "in-app /login" terbukti basi); opencode `null` → `"opencode auth login"` (picker interaktif jalan di PTY login; `--standalone` hanya OpenCode 2, tidak ada di 1.19.3 terinstal); gemini tetap `null` (CLI tidak punya argv login — grep 0 hasil; auth selesai di dalam TUI). codex/copilot/muse sudah benar.
- **Bonus terverifikasi (belum di-wiring):** `muse usage [--json]` (subscription allowance sungguhan), `claude auth status --json`, `codex login status` — sumber data jujur untuk usage bar & label akun.
- **Test:** claude/opencode/gemini login-case baru + registry suite (23 passed); **Gate:** init.sh exit 0 (53 files / 467 tests; Rust 161/3 ignored); e2e 76/76. Belum commit — menunggu perintah user.

## 2026-11-09: Baris akun tidak lagi terlihat terhubung sebelum login (uncommitted)

- **Laporan:** setelah Add account, baris (mis. Personal) langsung menampilkan Log out seolah sudah terkoneksi, padahal login belum selesai.
- **Akar masalah:** profil dicatat di store sebelum login PTY selesai; UI menyamakan "ada profil" = "terhubung".
- **Perbaikan:** perintah Rust baru `cli_has_credentials` (file kredensial mana pun dari registry ada di profile dir; validasi nama file sama ketatnya dengan logout) + `profileHasCredentials` di IPC + aksi `loginProfile` (buka ulang PTY login untuk profil yang ada; hasil refactor `openLoginTab` bersama addProfile). Baris Settings memeriksa kredensial saat mount dan fail-closed: Logout hanya bila terverifikasi; bila belum → tombol Log in (lanjutkan login di PTY) + Remove (konfirmasi danger, hanya hapus record); provider tanpa declared paths (copilot/muse/opencode/gemini) tetap seperti semula. Saat memeriksa, tombol Logout nonaktif.
- **Test:** Rust `has_credentials_reports_only_declared_files` (+ traversal); IPC routing; `loginProfile` sukses/unknown; Settings: baris belum-login (Log in + Remove, tanpa Log out), remove terkonfirmasi. Scope regresi ini dipertahankan bersama proyek.
- **Gate:** init.sh exit 0 (53 files / 471 tests; Rust 162 passed / 3 ignored; typecheck + Clippy bersih); e2e 76/76. Belum commit — menunggu perintah user.

## 2026-11-09: Status baris akun tidak refresh sesudah logout (uncommitted)

- **Laporan:** sesudah klik Log out, tombol Logout tetap ada sampai reload.
- **Akar masalah:** status `linked` hanya dihitung saat mount; sesudah logout tidak di-cek ulang. Selain itu, saat pemeriksaan berjalan sempat tampil tombol Logout nonaktif yang terlihat seperti sudah terhubung.
- **Perbaikan (`SettingsScreen.tsx`):** cek kredensial diekstrak jadi `check()`; dipanggil ulang sesudah `logoutProfile` berhasil; polling 5 detik selama `linked === false` agar baris berbalik jadi Logout sendiri setelah login diselesaikan di PTY tanpa reload; saat `linked === null` tidak ada affordance Logout sama sekali (key `settings.checkingAccount` yang tak terpakai dihapus).
- **Test:** regresi "flips to Log in right after logout without a reload" dipertahankan bersama proyek.
- **Gate:** init.sh exit 0 (53 files / 472 tests; Rust 162/3 ignored); e2e 76/76. Belum commit — menunggu perintah user. Catatan: perubahan Rust (`cli_has_credentials`) butuh restart penuh aplikasi, HMR saja tidak cukup.

## 2026-11-09: Guard sesi terhadap profil belum login + sesi basi (uncommitted)

- **Laporan (screenshot 20:57):** sesi Rozzy yang profilnya sudah terhubung tetap onboarding ("Let's get started") — sesi itu lahir sebelum kredensial ada; claude yang sudah jalan tidak pernah membaca ulang kredensial. Verifikasi: `claude auth status --json` dengan `CLAUDE_CONFIG_DIR` profil Rozzy → `loggedIn: true` (isolasi env benar, bukan bug env).
- **Perbaikan:** `spawnAgentShell` (satu-satunya pintu start/switch/race) menolak profil yang file kredensialnya belum ada — tanpa membakar PTY; toast berisi tombol Log in (buka PTY login), record sesi menyimpan error yang terlihat di pane. i18n: `agents.loginRequired`, `agents.loginNow`.
- **Test:** "refuses to start on a profile that never completed login" (tanpa spawn/write, error + toast action); mock `profileHasCredentials` ditambahkan ke `AgentsScreen.test.tsx` (ini yang membuat gate sempat merah 1 test). Scope regresi dipertahankan.
- **Gate:** init.sh exit 0 (53 files / 473 tests; Rust 162/3 ignored); e2e 76/76. Sesi basi yang sudah telanjur jalan harus ditutup manual (×) lalu New agent lagi. Belum commit — menunggu perintah user.

## 2026-11-09: Claude pindah ke HOME sandbox + loader login (uncommitted)

- **Akar relogin (terbukti):** token OAuth claude ada di `~/.claude/.credentials.json` (HOME), BUKAN di `CLAUDE_CONFIG_DIR`. Uji decisive: HOME kosong + CLAUDE_CONFIG_DIR=profil berisi oauth state → `loggedIn:false`. Jadi isolasi lama tidak pernah bisa memisahkan akun; sesi selalu jatuh ke onboarding. Klaim "Verified" lama di registry tidak valid dan sudah dikoreksi.
- **Perbaikan:** `profileEnv` claude → `HOME=$profileDir/home` (metode Orca; sama seperti codex/copilot/opencode/gemini). `credentialPaths` → `["home/.claude/.credentials.json"]` (hanya file token: sinyal presisi + logout aman). Rust: validasi `valid_credential_path` per-segmen (`..`, absolut, segmen kosong ditolak; satu level nesting diizinkan) dipakai logout + has_credentials. Hooks claude pindah ke `{profile}/home/.claude.json` (file yang benar-benar dibaca claude sandbox).
- **Dampak:** profil claude lama (Personal/Rozzy) harus login SEKALI lagi di dalam sandbox (tombol Log in di Settings); login host utama tidak tersentuh. Logout kini menghapus token sandbox, bukan kredensial host.
- **Loader:** `BusyButton` (spinner `currentColor`, hormati prefers-reduced-motion) dipakai di Add account + Log in; spinner `role=status` saat cek kredensial. Menu chip + toast action tidak bisa menampung loader (ditutup/tidak ada slot) — feedbacknya berupa tab PTY yang terbuka.
- **Test:** BusyButton busy/reject; Settings pending spinner; registry env claude; Rust nesting/traversal + hooks path; guard sesi tetap hijau. Scope regresi dipertahankan.
- **Gate:** init.sh exit 0 (54 files / 476 tests; Rust 162/3 ignored; typecheck + Clippy bersih); e2e 76/76. Belum commit — butuh restart penuh (Rust berubah).

## 2026-11-09: Dialog Keychain → claude kembali ke state-isolation (uncommitted)

- **Laporan (screenshot 22:18):** login claude di sandbox HOME memicu dialog macOS "Keychain Not Found ... to store 'apple'"; sandbox tetap kosong (login gagal total).
- **Investigasi:** isi rumah per-akun Orca ternyata symlink massal ke `~/.claude/` asli + tanpa `.credentials.json` per-akun — Orca pun tidak mengisolasi token (auth dishare, state dipisah). Keychain item "Claude Code" tidak ada; dialog berasal dari proses sandbox yang kehilangan akses ke login keychain (path keychain diturunkan dari HOME).
- **Keputusan:** claude kembali ke `CLAUDE_CONFIG_DIR` (isolasi state: settings/history/projects per profil) + `credentialPaths: []` (auth = login host bersama; status unknown → baris selalu tawarkan Logout, guard sesi tidak memblokir). Revert: `ensure_claude_hooks` → `settings.json` (+test), validasi nested-path dihapus (kembali file-only + traversal test awal). Klaim "Verified" keliru di registry dikoreksi dengan bukti (HOME kosong → loggedIn:false; sandbox → dialog Keychain).
- **Jujur untuk user:** profil claude = profil state terisolasi + login host bersama (keterbatasan vendor, sama seperti Orca). Tidak ada lagi dialog Keychain (login berjalan dengan HOME asli).
- **Gate:** init.sh exit 0 (54 files / 476 tests; Rust 162/3 ignored; typecheck + Clippy bersih); e2e 76/76. Belum commit — butuh restart penuh. Jangan klik "Reset To Defaults" bila dialog masih muncul dari proses lama.

## 2026-11-09: Notifikasi "needs input" berulang (uncommitted)

- **Laporan:** toast "Claude needs input" muncul terus-menerus, bahkan saat melihat agent lain.
- **Akar masalah:** `noteSessionActivity` mengembalikan status ke `running` pada *setiap* output baru, lalu diam 4 dtk → `waiting` + toast lagi. Agen yang cerewet me-notif tiap beberapa detik selamanya. Toast bersifat global sehingga terlihat dari pane agent mana pun.
- **Perbaikan (`sessions.ts`):** status tetap bolak-balik running↔waiting seperti biasa (badge jujur), tetapi toast + OS ping hanya sekali per sesi (`notifiedWaiting`, dibersihkan di `clearSessionWatch` yang dipakai semua jalur tutup/selesai).
- **Test:** "raises the waiting toast only once no matter how often the loop cycles" (pola → waiting → output → pola lagi → hook event; toast tetap 1).
- **Gate:** init.sh exit 0 + Verification Complete (55 files / 491 tests; Rust 165 passed / 3 ignored; clippy bersih); e2e 76/76. Belum commit — menunggu perintah user.

## 2026-11-10: M3 Stage 6 right-side project/group navigation (uncommitted)

- Implemented the production right rail from `docs/design/prototype.html`, retaining the left navigation/worktree sidebar and replacing title-bar project tabs with active group/project context.
- Added searchable, collapsible group sections, active-project selection, group/project actions through the existing management popover, persisted rail visibility, and a narrow-window overlay below the title bar. All new visible strings are localized in `src/i18n/en.ts`.
- Added focused component/store tests and updated the repository Playwright flow to exercise the new sidebar instead of removed project tabs.
- **Review:** M3 Task 16 spec/code review PASS; no security surfaces changed. Reports: `.agent/reviews/m3-task-16-spec.md`, `.agent/reviews/m3-task-16-code-review.md`, `.agent/reviews/m3-task-16-e2e.md`.
- **Validation:** `./init.sh` passed (56 Vitest files / 511 tests; Rust 171 passed / 3 ignored; typecheck and Clippy clean); `pnpm test:e2e` passed 74/74. Manual M3-S6 checkpoint remains pending user verification. No commit or push.

## 2026-11-10: PR list dukung SSH-alias remote (uncommitted, di atas M4-04)

- **Laporan user:** tab PR menampilkan "The active worktree is not on a GitHub repo" padahal repo ada di GitHub — `origin` = `git@github-pribadi:rozzyy/branchwork.git` (SSH alias multi-akun), parser hanya menerima host persis `github.com`.
- **Perbaikan backend (`src-tauri/src/gh.rs`):** `split_remote_host` + `parse_github_remote_with` (host policy injectable); `repo_remote` menyelesaikan alias via `ssh -G <host>` (resolusi config lokal, tanpa koneksi; fixed argv, tanpa shell) lalu parse ulang. `parse_github_remote` strict kini `#[cfg(test)]`.
- **Perbaikan frontend:** `resolveAccountForOwner` baru di `src/github/accounts.ts` (`resolveAccountForRemote` mendelegasikan); `PrsView` memakai `remote.owner` tervalidasi backend, bukan parse ulang URL.
- **Test:** `ssh_alias_hosts_resolve_to_github`, `ssh_alias_resolver_rejects_bad_hostnames`, `resolveAccountForOwner` (2). Alur: test gagal dulu → fix → focused pass.
- **Gate:** `cargo test --lib gh::` 17 passed; clippy + fmt bersih; vitest fokus 15 passed; `pnpm typecheck` bersih; `./init.sh` = `=== Verification Complete ===`; `git diff --check` bersih. Belum commit — menunggu perintah user.

## 2026-11-10: Tab PR bisa pilih akun per repo-owner (uncommitted)

- **Laporan user:** repo kantor `Shopfoodie/hiiboss-selly` (remote `git@github-work:...`) error "Could not resolve to a Repository" karena chip akun menampilkan `rozzyy` (pribadi, tanpa akses), seharusnya `rozzyrahmanda` (kantor). Akar masalah: owner org tidak cocok dengan username akun mana pun sehingga auto-resolve jatuh ke akun default.
- **Perbaikan:** dropdown Account di tab PR (hanya bila >1 akun; 1 akun tetap chip seperti dulu) + ingatan pilihan per repo-owner di `useGithubAccounts.ownerAccounts` (persist di settings, username saja), + hint "Not visible to this account? Pick another account above." saat error Could-not-resolve.
- **Test:** `setAccountForOwner`/load-filter per-entry, pilih akun memicu `ghPrs` dengan akun baru, hint muncul. Alur: 4 test gagal dulu → fix → focused pass (24 passed).
- **Gate:** `pnpm typecheck` bersih; `./init.sh` exit 0; `git diff --check` bersih. Belum commit — menunggu perintah user.

## 2026-11-10: Menu Pull Request dihapus per perintah user (uncommitted)

- **Perintah user:** hapus menu Pull Request (PR sudah ada di menu repository). Dengan akun rozzyy + repo branchwork menu PR sempat jalan (kosong, benar tidak ada PR).
- **Dihapus total (satu slice vertikal):** `src/screens/prs/` (screen + 9 test), wiring `registry.ts`/`views.tsx`, `nav.prs` + 20 kunci `prs.*`, `ghPrs`/`ghRepoRemote` di `src/ipc/github.ts` (+test), slice backend `gh.rs` (GhRemote/PrSummary/PrFilter, parse/filter/cache, `prs`/`repo_remote`, SSH-alias resolver + 6 test), 2 command `lib.rs`, bindings regen, memori per-owner + `resolveAccountFor*` (+test). Auth GitHub (token/device flow/PAT/Settings) tidak tersentuh.
- **Aman:** `isValidStage` menolak layout tersimpan berisi `prs` → fallback default, tanpa crash/migrasi.
- **Meta:** feature_list M4-04 done+catatan hapus; M4-05/06 + m4-stage-2-review done-batal (bukti tertulis); plan Stage 2 ditandai REMOVED; berikut: m4-task-07 Repository screen.
- **Gate:** `pnpm typecheck` bersih; `cargo clippy -D warnings` + `cargo fmt --check` bersih; `./init.sh` exit 0; `git diff --check` bersih. Belum commit — menunggu perintah user.

## 2026-11-10: M4-07 Repository screen (uncommitted)

- Implemented per `.agent/tasks/m4-task-07.md` (new): backend `gh_repo_remote` (SSH-alias aware) + `gh_repo_meta`/`gh_repo_contributors`/`gh_repo_set_starred|watched`/`gh_repo_fork` + new `repogit` local-git module (branches/latest-commit/tree with per-file history, catalog-validated, fixed argv); Rust fixture + temp-repo tests (incl. validate_ref/subdir guards).
- Frontend `src/ipc/repo.ts` (+routing/mapping tests), `RepoScreen` (header Star/Watch/Fork + Code tab with branch selector, counts, Go to file, clone-URL copy, latest-commit bar, file table with drill-in, README via MarkdownPreview; sidebar About/topics/license/counts/releases/contributors/languages) wired to `VIEWS.repo`; 27 `repo.*` i18n keys; 6 component tests. CSP-safe: no external images/links (initials, text).
- Out of scope respected: no Issues/Actions tabs, no PR refs, no Add file, default/first account serves all repos.
- **Gate:** `pnpm typecheck` clean; `cargo clippy -D warnings` + `cargo fmt --check` clean; `./init.sh` = `=== Verification Complete ===` (62 files/547 tests; Rust 193 passed/3 ignored); `git diff --check` clean. Belum commit — menunggu perintah user.

## 2026-11-10: M4-08 Issues + Start → worktree (uncommitted)

- Implemented per `.agent/tasks/m4-task-08.md` (new): backend `gh_repo_issues` (GraphQL open/closed, fixture parse tests + bad-state guard); RepoScreen Issues tab (Open/Closed tabs, label dropdown, comment counts, agent badge when `fix/issue-<n>` worktree has a live session); Start creates `fix/issue-<n>` branch + pinned worktree + terminal tab, reuses the existing worktree, toasts `Closes #n` + issue URL (PR-body paste stays web-side since the PR menu was removed).
- Tests: 5 new component tests (list/filter/label/badge/create/reuse); fixed own test bugs (label text collision, project fixture casing).
- **Gate:** `pnpm typecheck` clean; `cargo clippy -D warnings` + `cargo fmt --check` clean; `./init.sh` = `=== Verification Complete ===` (62 files/552 tests; Rust 195 passed/3 ignored); `git diff --check` clean. Belum commit — menunggu perintah user.

## 2026-11-10: M4-09 Actions (uncommitted)

- Implemented per `.agent/tasks/m4-task-09.md` (new): backend `gh_repo_runs` (REST `/actions/runs`, capped 30, parse tests incl. first-commit-line + bad-row filtering) + `gh_repo_rerun` (`rerun-failed-jobs`, zero-id guard, empty-body 201 handled without JSON parse); RepoScreen Actions tab (status chips queued/in-progress/success/failure/neutral, Re-run with confirm dialog on failed runs, age/actor/SHA); 3 component tests + IPC routing tests.
- Fixed live bug from user report: `REPO_META_QUERY` had `node` outside `edges{}` ("Field 'node' doesn't exist on type 'LanguageConnection'"); brace balance verified programmatically.
- **Gate:** `pnpm typecheck` clean; `cargo clippy -D warnings` + `cargo fmt --check` clean; `./init.sh` = `=== Verification Complete ===` (62 files/555 tests; Rust 197 passed/3 ignored); `git diff --check` clean. Belum commit — menunggu perintah user.

## 2026-11-10: Pemilih akun kembali di tab Repository (uncommitted)

- **Laporan user:** `Shopfoodie/hiiboss-core-api` error Could-not-resolve sementara branchwork tampil — penyebab: owner org tidak cocok username mana pun sehingga akun default (`rozzyy`, tanpa akses org) dipakai.
- **Perbaikan:** ingatan akun per repo-owner + dropdown Account di header repo (khusus multi-akun; 1 akun tetap chip). Pilihan tersimpan di settings (username saja) dan dipakai lintas Code/Issues/Actions.
- **Test:** store (ingat/persist/filter-load) + komponen (default dulu untuk org, ganti akun memicu fetch ulang + tersimpan). Alur: tambah test dulu → implement → focused pass (25 passed).
- **Gate:** `pnpm typecheck` bersih; `cargo clippy -D warnings` + `cargo fmt --check` bersih; `./init.sh` = `=== Verification Complete ===` (62 files/558 tests; Rust 197 passed/3 ignored); `git diff --check` bersih. Belum commit — menunggu perintah user.

## 2026-11-11: M4-09b Repository navigation and Stage 3 review

- Implemented the prototype Repository navigation, in-app Pull requests list and filters, fixed external GitHub routes, compact account switcher/header actions, selected-ref README reads, safe rerun HTTP-status handling, and stale-refresh/status guards.
- Review fixes: workflow reruns require HTTP 201; refresh responses are discarded after worktree changes; README reads the selected ref with a 10 MiB cap; unknown Actions statuses and non-success/failure conclusions are neutral. Updated stale Playwright selectors for the moved Pull requests menu, Repository empty state, and Settings dialog.
- **Reviews:** M4-09b spec PASS; Stage 3 code review PASS; security review found no exploitable vulnerabilities; E2E report records 74/74 Playwright tests passing. Reports: `.agent/reviews/m4-task-09b-spec.md`, `.agent/reviews/m4-stage-3-code-review.md`, `.agent/reviews/m4-stage-3-security.md`, `.agent/reviews/m4-stage-3-e2e.md`.
- **Gate:** `./init.sh` → `=== Verification Complete ===` (62 Vitest files / 562 tests; Rust 208 passed / 3 ignored; TypeScript and Clippy clean); `cargo fmt --check` and `git diff --check` clean. The first final attempt hit a timing-sensitive worktree event test; the isolated test and full retry passed.
- M4-09b is done. Stage 3 review is at the M4.3 manual checkpoint; user verification of M4-S3-01..03 is pending. No commit, push, or M4-10 work without user go-ahead.

## 2026-11-11: Repository menu scope follow-up

- Per user request, removed Projects, Wiki, Security, Insights, and Settings from Repository navigation, along with their tab strings/styles. Pull-request links and the fixed-route backend remain unchanged.
- Updated M4-09b acceptance text and the manual checkpoint to M4-S3-01..03. Added a screen regression test asserting the five sections are absent. Focused `RepoScreen` tests: 19 passed; typecheck clean.
- Still paused at Checkpoint M4.3. No commit, push, or M4-10 work.

## 2026-11-11: Private repository authentication follow-up

- Verified the Orca session's GitHub CLI account `rozzyrahmanda` can query the private repository, and SSH authenticates as the same user and can read its Git refs.
- Branchwork now prefers `gh auth token --user <selected-account>` for API requests when available, verifies the token's GitHub identity, keeps it memory-only, and falls back to its existing Keychain token. SSH remains unsuitable for GraphQL.
- Moved authorization headers and OAuth device-flow fields to curl's stdin config to remove secrets from process arguments; security re-review confirmed the finding fixed and no remaining issues.
- Added the private organization repository check to M4-S3-01. `./init.sh` passed: 62 Vitest files / 562 tests; Rust 210 passed / 3 ignored; TypeScript and Clippy clean. `cargo fmt --check`, `git diff --check`, and feature-list JSON validation passed. App restart and manual M4.3 verification are still required; no commit, push, or M4-10 work.

## 2026-11-11: UI loading follow-up

- Added immediate accessible loading feedback for Repository data and first-load states in Changes, Files, Graph, Blame, Agents, and Terminal. Moved Changes diff-mode preference loading from the app shell into its screen consumers; kept global shell state global.
- Focused Repository tests: 21 passed. `pnpm typecheck` and `git diff --check` passed. `./init.sh` → `=== Verification Complete ===` (62 Vitest files / 567 tests; Rust 210 passed / 3 ignored; TypeScript and Clippy clean).
- Still paused at the M4.3 manual checkpoint; restart the app and run M4-S3-01..03. No commit, push, or M4-10 work.

## 2026-11-11: Repository navigation + Terminal project-switch follow-up

- Repository view is now lazy behind a lightweight destination boundary: clicking Repository paints the title/loading state before importing the data screen or starting repository requests. A route regression test verifies the shell is visible before `ghRepoRemote` starts and stays visible while it is pending.
- Full-screen Terminal now renders only tabs whose panes belong to the selected project's root/worktrees. Switching projects hides (but retains) foreign tabs and sessions; unscoped new tabs use the active project path rather than a stale focused pane from the previous project.
- Focused validation: `pnpm exec vitest run src/screens/repo/RepoNavigation.test.tsx src/terminal/TerminalScreen.test.tsx` → 2 files / 7 tests passed; `pnpm typecheck` clean; `git diff --check` clean.
- Regression validation: `./init.sh` → `=== Verification Complete ===`; 63 Vitest files / 570 tests passed; Rust 210 passed / 3 ignored; TypeScript and Clippy clean.
- M4.3 manual checkpoint remains pending. Preserve `m4-stage-1`; no commit, push, or M4-10 work.

## 2026-11-11: Agent feature audit

- Audited the agent CLI registry, profile/login flows, session lifecycle and PTY attachment, status hooks/heuristics, profile switching/limits, handover, race, Settings, and provider icons against their task criteria and automated coverage.
- Fixed two gaps: restored profile/default objects are now allowlisted and sanitized so unknown fields (including credential-shaped keys) are not retained or re-persisted; done hook events and abnormal PTY exits now raise a single toast as well as an unfocused notification.
- Agent-focused regression tests: 7 files / 119 passed. `./init.sh` → `=== Verification Complete ===` (63 Vitest files / 572 tests; Rust 210 passed / 3 ignored; TypeScript and Clippy clean). `pnpm test:e2e` passed 74/74.
- Found one incomplete surface: Custom appears in the CLI picker, but no Settings control persists/applies its launch override, so New Agent blocks it. Making Custom usable needs a product/UI decision; existing registry override composition is tested in isolation.
- Real vendor login/provider interactions were not re-run during this audit; those depend on the user's CLI installation and account state. Existing M3 manual checkpoints remain recorded as approved. No commit or push; M4.3 remains pending.

## 2026-11-11: Hide unsupported Custom CLI from Agent pickers

- Removed Custom from the New Agent and Handover CLI pickers while keeping it in the registry and Settings account list; updated focused tests to cover both dialogs.
- `pnpm exec vitest run src/screens/agents/AgentsScreen.test.tsx` passed (27 tests); `pnpm typecheck` and `git diff --check` passed.
- `./init.sh` → `=== Verification Complete ===` (63 Vitest files / 572 tests; Rust 210 passed / 3 ignored; TypeScript and Clippy clean). M4.3 remains pending; no commit or push.

## 2026-11-11: User-reported fixes during M4.3 manual testing

- Removed the "…needs input" in-app toast per user order: waiting status now only flips the pane status dot and sidebar badge, and the one-shot OS ping still fires when the app is unfocused. Sessions tests updated to assert no waiting toast ever appears.
- Fixed the agent profile-switch glitch the user reported: `switchProfile` used to stop the old terminal before resolving resume argv and the login gate, so a refused switch (logged-out target, resume error) killed the running session. The launch is now prepared (profile dir, login gate, env) before the old terminal is stopped; the switch also hardens the undo path's `resolveCli` call. Regression test: a logged-out target refuses the switch with the old session left running.
- UI per user order: all inner UI borders are square (`border-radius: 0` override in tokens.css, keeping no exceptions) and section spacing is thinner in Settings (`h3` margins 22/10 → 12/6, screen padding 20/28/40 → 14/20/28, `opt` rows 12/16 → 8/14) and the Repository screen (gap 12 → 8, padding 16 → 12).
- `./init.sh` → `=== Verification Complete ===` (63 Vitest files / 573 tests; Rust 210 passed / 3 ignored; TypeScript and Clippy clean). M4.3 remains pending; no commit or push.

## 2026-11-12: Switch hardening, status-blink gate, resume fallback, button radius restore

- Second round of user-reported glitches, fixed and verified live in the running app via cua-driver GUI control:
  - Status kedip-kedip: waiting→running flips now require ≥1024 cumulative output bytes within a 1500 ms window (`outputVolume` in `sessions.ts`), tiny TUI redraw bursts can no longer fake running, and the idle heuristic is skipped while a hook waiting event is active (`hookActive`). Verified: the dot stays stable across snapshots (fresh idle claude = steady "waiting", switch = steady "running" then stable).
  - Dim `↻ …` switch line removed entirely (no shell prefix at all); i18n key `agents.switchLine` deleted. Verified: no `m↻: command not found` garbage in the terminal.
  - Resume fallback: every CLI got `resumeLine` with a `|| <fresh launch>` fallback (claude `claude --continue || claude`, codex `codex resume --last || codex`, opencode/copilot/muse analogous, gemini/custom null). The switch types one raw shell line, so a profile without history falls through to a fresh launch instead of stranding the pane at a shell prompt. Verified: `claude --continue || claude` → "No conversation found to continue" → fresh Claude banner appeared automatically.
  - Profile switch verified end-to-end in-app: Personal → Work-3 confirm dialog → old session stopped, Work-3 pane spawned with its own `CLAUDE_CONFIG_DIR`, no quoted-argv error, no "needs input" toast (stop notice toast is by design).
- UI per user feedback: the blanket square-override kept squashing buttons, so controls now keep their shape per UI best practice — `.btn`/`.seg`/`.chip`/`.switch`/`.group-chip`/`.search` stay 999 px pills, dots/avatars/spinner/switch knob stay 50% circles, small icon controls (`.icon-btn`, tabs, close buttons, `.kbd`, `.repo-account`, `.agent-grp`) keep a 7 px (icon tiles 3 px) radius; sections/cards/inputs stay square. Verified in-app: pills and circles round, containers meet at right angles.
- `pnpm typecheck` clean; agent tests pass (43 in sessions.test.ts + registry tests); full vitest count now 63 files / 575 tests. M4.3 manual checkpoint remains pending; no commit or push.

## 2026-11-12: Native file drag-and-drop in agent and terminal panes

- Root cause: `src-tauri/tauri.conf.json` explicitly set `dragDropEnabled: false`, disabling Tauri native file-drop events throughout the app.
- Enabled native Tauri drops and routed dropped paths to the pane under the cursor. Paths are inserted quoted, without Enter; drop handling accepts at most 8 paths of at most 2048 characters and rejects control characters. No file bytes are loaded into the WebView. Per drop handling cost is O(panes + dropped path bytes) across mounted terminal panes; temporary memory is O(dropped path bytes), bounded by 8 × 2048 characters.
- Provider inventory (official docs checked 2026-11-12): Claude Code documents dropping images into its terminal; Copilot CLI explicitly supports drag-and-drop file and image prompts; Codex supports `--image` and interactive image paste but docs do not specify file drag/drop; OpenCode TUI documents `@` file references (its explicit drag-and-drop attachment doc applies to desktop/web clients); Gemini CLI documents `@path` file inclusion, with binary image attachment not established by that path feature; Muse and Custom have no verified attachment contract. The app now inserts paths for any terminal provider; whether a given CLI treats a path as an image attachment still depends on that CLI's documented syntax/model.
- Tests: targeted terminal/drop tests 15/15; typecheck clean; full Vitest 64 files / 580 tests passed; Clippy clean. Both `./init.sh` runs had 10 unrelated macOS FSEvent watcher failures (unable to start FSEvent stream); direct `cargo test --manifest-path src-tauri/Cargo.toml` passed once (210 passed / 3 ignored), so the Rust suite is not consistently green in this sandbox. `git diff --check` clean.
- Manual GUI drop from Finder is still needed to verify native macOS delivery on the running app. No commit or push.

## 2026-11-12: Empty agent pane root cause, radius refinement bookkeeping

- Reproduced the user's "agent pane goes empty seconds after a switch" report live via cua-driver: the pane went blank the moment Claude reached `waiting` on a logged-in profile. Root cause was layout, not the PTY: `.agent-pane-body` was a row flexbox, so the "already logged in" banner (`flex: none`, long text) and the `CliPane` sat side by side and the terminal collapsed to 0 width (the limit banner would do the same). Fix: `flex-direction: column` on `.agent-pane-body` (`src/screens/agents/agents.css`). Verified in-app after HMR: Claude TUI renders under the banner; Personal → Work-3 → Personal switch round keeps the pane visible throughout (Work-3 falls through `claude --continue || claude` to a fresh "Not logged in" Claude as expected).
- No regression test: the defect is pure CSS layout, which Vitest/jsdom cannot observe and the Playwright e2e has no live PTY. Covered by the manual E2E switch step instead.
- Two confirmed non-bugs recorded for the manual report: (1) `agentSessions` is persisted write-only (`saveSetting` in `sessions.ts`, never loaded), so a webview reload (dev HMR) drops the session list while the Rust PTYs keep running. Spec §3.4 only requires the terminal dock to restore (fresh shells), so this is a dev-only artifact, not a stage defect. (2) `Could not detach terminal after pane unmount … notFound` console noise when a pane unmounts after its PTY already exited; harmless.
- Radius refinement per user: modal `.dlg` 22 px (`.dlg-ic` 13 px, `.dlg-meta` 10 px), toast 14 px (`.toast-ic` 8 px), icon tiles 7 px / `.file-icon` 3 px stay rounded; card sections and the terminal (including `.term-dock-newtab`, `.term-screen-tab`, `.term-screen-tab-close`) stay square. Verified in the switch confirm dialog screenshot.
- Gate: `pnpm typecheck` clean; `git diff --check` clean; `src/screens/agents/AgentsScreen.test.tsx` 27/27. M4.3 manual checkpoint remains pending; no commit or push.

## 2026-11-12: Issue #3 recurrence and agent restore startup race

- Rechecked GitHub issue #3: it remains closed. The initial-command code still waits for terminal attach before writing the vendor command, and focused agent/terminal tests pass. Native GUI reproduction was unavailable because the Cua Driver daemon is not running.
- Found why agents could disappear after reopening: Launchpad/Inbox can request `sessions.load()` before App finishes hydrating saved agent profiles. Restore then sees an empty profile list, records an error, and marks sessions loaded; App's later call is ignored.
- `sessions.load()` now hydrates profiles before reading/restoring agent sessions. Added a startup-race regression test and a general saved-session resume test.
- Verification: `pnpm exec vitest run src/agents/sessions.test.ts src/screens/agents/AgentsScreen.test.tsx src/terminal/CliPane.test.tsx` passed 3 files / 77 tests; `git diff --check` passed. `./init.sh` and `pnpm typecheck` fail on the same existing M5 Launchpad errors at `LaunchpadScreen.tsx:385,389,395`; this follow-up introduced no reported TypeScript errors. Session restore still traverses N persisted session records serially (O(N) time, O(N) retained state); profile hydration adds one existing settings read, with no per-session I/O fan-out. Persisted profile/session inputs remain validated by existing allowlists and parsers.
- No commit or push. App relaunch/manual GUI verification remains pending.

## 2026-11-12: User confirmed issue #3/session restore fix

- User confirmed the fix works in the app. The manual app verification gap recorded above is closed; GitHub issue #3 remains closed. No commit or push.

## 2026-11-12: M5 committed and released as v0.5.0

- User ordered the M5 stage commit and release. M5 stage commit `93b36bf` (Launchpad/Inbox parity, issue #3 restore race fix, M5 docs, M6 plan) was fast-forwarded into `main`; `m5-stage-1` deleted. A clean leftover worktree at `/private/tmp/branchwork-main-merge` that held `main` was removed.
- Pre-commit gate: `pnpm typecheck` clean; Vitest 68 files / 606 tests passed; `git diff --check` clean.
- Version bumped to `0.5.0` (package.json, Cargo.toml/Cargo.lock, tauri.conf.json) and tagged `v0.5.0`. No push.

## 2026-11-12: M6 Stage 1 started — M6-01 Remote sync IPC + UI

- Branch `m6-stage-1` from `main` (`a9f937f`, v0.5.0). Task files `.agent/tasks/m6-task-01..03` and `feature_list.json` entries added; milestone/plan switched to M6. Baseline `./init.sh` green (606 Vitest; Rust 216/3 ignored).
- Finding: every git CLI write used `GIT_CONFIG_GLOBAL=/dev/null` + `GIT_CONFIG_NOSYSTEM=1` (M1 filter-isolation hardening), which drops credential helpers (e.g. osxkeychain), global identity and signing. New `worktree::invoke_git_remote` keeps user config for fetch/pull/push (spec §2) while keeping `GIT_TERMINAL_PROMPT=0` and local checkout-filter neutralization. Existing commit/commit-and-push/sync paths still use isolated config — tracked as a follow-up, not changed in M6-01.
- Rust `sync.rs`: `git_fetch` (`fetch --prune`), `git_pull` (`pull --no-edit`, oplog `pull` with `beforeHead`/`afterHead`; up-to-date removes the entry; undo = `reset --keep` after HEAD check), `git_push` (`push`, or `--set-upstream origin HEAD` when no upstream). Detached HEAD rejected. stderr in `detail` capped at 16 KiB. New `Network` classification split out of auth (connection failures were previously reported as `GitAuth`; the old test was renamed accordingly).
- UI: toast "Show details" disclosure (12 s for detail toasts); `useSync` store (one op per worktree, auth failure → "Open terminal to authenticate", pull → Undo, worktree list reload for ahead/behind); Graph toolbar Fetch / Pull (behind) / Push (ahead) enabled; Changes ⋯ adds Pull / Push / Fetch / Pop latest stash. `ui.deferred_m6` → `ui.deferred_m7` per Decision 1.
- Complexity: one git process per user action, O(1) extra IPC (one worktree-list reload); detail memory ≤16 KiB per failure.
- `./init.sh` → `=== Verification Complete ===` (Vitest 69 files / 611 tests; Rust 223 passed / 3 ignored; Clippy/typecheck clean); `cargo fmt --check` clean. Spec review pending. No commit or push.
- Spec review: first pass FAIL (criterion 5: fallback-classified failures — e.g. a rejected non-fast-forward push — had no `detail` and uncapped stderr in the message). Fixed in `sync::require_success` (short message + capped stdout/stderr detail; conflict details include stdout), plus non-blocking fixes (record cleanup on post-pull HEAD read failure and unborn-branch pull; worktree reload scoped to the synced worktree). Regression test `rejected_non_fast_forward_push_keeps_stderr_in_detail`. Re-review PASS. `./init.sh` green (611 Vitest; Rust 224 passed / 3 ignored). **M6-01 done.**

## 2026-11-12: fix commit — user git config for commit/push/sync/stash

- Per user order, the follow-up from M6-01 landed on `main` as its own commit `0d7e0b0` (`fix(git): keep user git config for commit, push, sync and stash`), made in a temporary worktree off `main` (since removed). `invoke_git_allowing_hooks` now keeps global/system config (identity, osxkeychain credential helper, signing); local checkout filters stay neutralized; worktree add / `git apply` stay isolated. Regression test `user_facing_writes_keep_global_config_and_internal_writes_isolate_it`. Rust 217 passed / 3 ignored and Clippy clean in the fix worktree.
- `m6-stage-1` fast-forwarded to `0d7e0b0`; M6-01's `invoke_git_remote` dropped in favour of the now-equivalent `invoke_git_allowing_hooks`. `./init.sh` green (611 Vitest; Rust 225 passed / 3 ignored). No push.

## 2026-11-12: M6-02 Checkout, branch, cherry-pick, revert

- Task file refined with acceptance criteria. Rust `gitops.rs`: `git_checkout` (branch via `git switch`, commit via `switch --detach`, never forced), `git_branch_create` (`git branch` / `switch -c` at a validated SHA), `git_cherry_pick`, `git_revert --no-edit`. Branch names validated by `check-ref-format --branch` plus leading-dash/`@{` refusal; SHAs must be full hex and resolve; merge commits rejected. Dirty-tree checkout and branch-in-other-worktree → `Conflict`; pick conflicts → `GitConflict` with stdout+stderr detail, conflict state left for Stage 2.
- Oplog: `checkout` (undo switches back to `beforeBranch` or detached `beforeHead` after a HEAD check), `cherry_pick`/`revert` (undo `reset --keep`). `recorded_write` removes the entry when HEAD did not move (checkout keeps it).
- UI: shared `state/gitActions.ts` (success/Undo and failure/details toasts, worktree reload; `useSync` refactored onto it). Graph menu enables Checkout (first local branch, else confirmed detached), Create branch here (create & check out), Cherry-pick, Revert; inspector Cherry-pick/Revert enabled; Changes ⋯ Checkout… prompt.
- Complexity: one git process per action plus O(1) validation (one `check-ref-format`, one git2 lookup).
- `./init.sh` → `=== Verification Complete ===` (Vitest 69 files / 614 tests; Rust 234 passed / 3 ignored). Spec review pending. No commit or push.
- Spec review PASS (no blocking). Fixed non-blocking: no-op checkout of the current branch no longer records an Undo (regression test), checkout undo uses `switch --no-guess`. Deferred: undo checks commit not branch; English-only conflict phrase matching (also M6-01); "Create branch" label. `./init.sh` green (614 Vitest; Rust 235 passed / 3 ignored). **M6-02 done.**

## 2026-11-12: M6-03 Graph cross-screen actions

- Graph menu: "Open on GitHub" (new allowlisted `gh_open_commit` → `github.com/{owner}/{repo}/commit/{sha}`, owner/repo/SHA validated in Rust; plan deviation from "Open pull request via gh_open_url" recorded in the task file and plan row) and "Blame files" (first changed path via `graph_commit_detail` → editor tab + Blame screen). Terminal already enabled; Compare / Rebase / Agent stay deferred.
- Spec review PASS; plan note and unused `graph.openPullRequest` key fixed. `./init.sh` green (Vitest 69 files / 615 tests; Rust 236 passed / 3 ignored). **M6-03 done — all Stage 1 tasks done.** Manual spec: `docs/testing/m6-manual-e2e.md` (M6-S1-01..20).

## 2026-11-12: M6 Stage 1 review gate

- Security review PASS (`.agent/reviews/m6-stage-1-security-review.md`): no M6 medium+. Pre-existing M1 medium reported: `worktree::configured_checkout_filters` scans `git config --local/--worktree` without `--includes`, so a smudge filter defined via `include.path` in `.git/config` escapes neutralization (needs attacker control of `.git/config`). Awaiting user decision (proposed separate `fix:` on `main`).
- Code review first pass FAIL (`.agent/reviews/m6-stage-1-code-review.md`): conflicts in pull/cherry-pick/revert were classified as hook/auth failures when output mentioned e.g. `.pre-commit-config.yaml` or `403`. Fixed: conflict-first classification from repository state, stderr-only hook/auth/network matching, HTTP 401/403 only in git's wording; regression test. Also fixed: undo uses the filtered git invocation; single `run_git`/`require_success`/`bounded` (16 KiB cap and "Show details" now also for Changes commit/push failures); shared `recorded_write` for pull; per-worktree in-flight guard for all git writes (regression test); `GIT_EDITOR`/`GIT_SEQUENCE_EDITOR=true`; `init.sh` isolates Rust tests from global git config; checkout prompt wording; CSS dedupe. Re-review pending.
- E2E (`.agent/reviews/m6-stage-1-e2e.md`): Playwright 63 passed / 11 failed; all 11 reproduce on `v0.5.0` (stale `Launchpad` heading selectors after the M5 redesign) — pre-existing, not M6.
- `./init.sh` → `=== Verification Complete ===` (Vitest 69 files / 616 tests; Rust 237 passed / 3 ignored). No commit or push.
- Code re-review PASS. Nit R1 fixed (hook detection requires git's "`<hook> hook`" wording). Remaining nits deferred: busy guard does not cover Changes commit/stash/toast Undo (R2); double worktree reload and 12 s detail toast (R3). Final `./init.sh` → `=== Verification Complete ===` (Vitest 69 files / 616 tests; Rust 237 passed / 3 ignored); fmt/diff/JSON checks clean. 🛑 Checkpoint M6.1 reached — waiting for the user's manual run of `docs/testing/m6-manual-e2e.md`. No commit or push.

## 2026-11-12: Issue #3 recurrence in packaged builds — root cause and fix

- User report: issue #3 (agent's first command echoed but not executed) is gone under `pnpm tauri dev` but returns in the built app.
- Root cause (reproduced outside the app): the PTY spawns the user's login shell (`/bin/bash` 3.2). `~/.bash_profile` starts with Kiro CLI's shell-integration pre block, which re-execs bash inside `kiro-cli-term` when `Q_TERM` is unset; its typeahead rescue is skipped on bash ≤3, so input written before the re-exec is echoed and discarded. `pnpm tauri dev` inherits `Q_TERM=2.25.0` from the Kiro-wrapped terminal (no re-exec, works); a Finder/Dock-launched app gets launchd's env without `Q_TERM` (re-exec, fails). Branchwork wrote the launch line as soon as the pane attached, i.e. before the shell was ready. Repro matrix (80×24 PTY): no `Q_TERM` + immediate write → echoed, not executed; ≥1 s delay or `Q_TERM` set → executed.
- Fix: `PtyManager::wait_ready(session, quiet_ms, timeout_ms)` (first output, then quiet ≥ `quiet_ms`; bounded ≤10 s; 25 ms polling, O(1) memory) + `pty_wait_ready` command + `waitTerminalReady()`; awaited (300 ms quiet / 5 s cap, writes anyway on timeout) before the agent launch line, the profile Log in command, and the restored-pane `cd`. Generic for any typeahead-discarding shell wrapper, not Kiro-specific.
- Tests: Rust `pty::tests::wait_ready_lets_the_first_command_survive_a_typeahead_discarding_startup` (simulated discarding startup; asserts the early write is lost and the waited write runs); Vitest "writes the launch line only after the shell reports ready". Real-environment check (login bash + Kiro, no `Q_TERM`): 5/5 executed after ~1.2 s wait.
- `./init.sh` → `=== Verification Complete ===` (Vitest 69 files / 617 tests; Rust 238 passed / 3 ignored). Uncommitted on `m6-stage-1` alongside Stage 1; packaged-app retest pending. No commit or push.
- Per user order: committed as `142c243 fix(terminal): wait for shell readiness before typing the first command` on `main` (made in a temporary worktree with only the issue #3 hunks; bindings regenerated there; `./init.sh` green there: Vitest 68 files / 607 tests, Rust 218 passed / 3 ignored) and **pushed** `origin/main` `a9f8e59..142c243` (this also published the 5 previously local-only commits through `0d7e0b0`; tags not pushed). `m6-stage-1` fast-forwarded to `142c243` with Stage 1 work restored; `./init.sh` green (617 Vitest; Rust 238 passed / 3 ignored). Packaged-app retest pending.

## 2026-11-13: Checkpoint M6.1 approved

- User confirmed the issue #3 fix in the packaged app and approved the Stage 1 manual checkpoint (`docs/testing/m6-manual-e2e.md` M6-S1-01..20). Stage 1 committed on `m6-stage-1` and fast-forwarded into `main` (not pushed). Next: Stage 2 (conflict resolver) on `m6-stage-2`, starting with M6-04.

## 2026-11-13: M6 Stage 2 started — M6-04 Conflict read model IPC

- Stage 1 committed `2fad157` and fast-forwarded into `main` (not pushed); branch `m6-stage-2` created. Task file `.agent/tasks/m6-task-04-conflict-read-model.md`; feature_list entries for M6-04..06.
- `conflict.rs`: `conflict_list` (operation from repository state + conflicted index paths with kind, sorted, cap 1000) and `conflict_read` (index stages 1/2/3 → libgit2 `merge_file` in diff3 style with 31-char labelled markers → context/conflict regions with exact text; empty base for add/add; summaries for binary, >1 MB sides, deleted-by-us/them, >500 regions). Path validation via `diff::validate_file_path`; non-conflicted path → NotFound. No git process, no writes; ≤3 blobs of ≤1 MB per read.
- 5 Rust tests. `./init.sh` → `=== Verification Complete ===` (Vitest 69 files / 617 tests; Rust 243 passed / 3 ignored). Spec review pending.
- Spec review PASS. Fixed findings: libgit2's added newline on an EOF conflict section is trimmed when the side had none (regression test); symlink (120000) and submodule (160000) conflicts return `symlink` / `submodule` summaries instead of text merge / NotFound (regression test); sizes come from ODB headers so oversized blobs are never loaded; tests tightened. Notes carried to M6-05: rebase "ours" is upstream; write through git (filters) not raw bytes where possible. `./init.sh` green (617 Vitest; Rust 245 passed / 3 ignored). **M6-04 done.**

## 2026-11-13: Issue #5 — design and plan (M6 Stage 3)

- Brainstormed GitHub issue #5 with the user. Finding: Git repos without a remote already open; only non-Git folders are refused, and every screen/IPC is built on registered Git worktrees. User chose Approach A (confirmed `git init` on add) over true non-Git projects; first publish push uses the selected account's token via the git child environment only; delivered as M6 Stage 3 in `v0.6.0` (Rebase → Stage 4, Compare → Stage 5, tasks renumbered M6-10..14).
- Design approved: `docs/superpowers/specs/2026-11-13-local-project-init-publish-design.md` (builder check done). Plan: `docs/superpowers/plans/2026-11-13-m6-stage3-init-publish.md`; M6 plan table updated. Not committed.
- M6-05 review fixes remain applied but uncompiled/untested (see 2026-11-13 M6-05 notes); resume there next.

## 2026-11-13: M6-05 Resolve, abort, continue IPC — done

- `conflict_resolve` (stamp-checked; `regions` choices ours/theirs/both/manual or `file` ours/theirs/delete; worktree-boundary + symlink-leaf checks; `git add`, then file re-materialized from the index so eol attributes apply; gitlinks via `update-index --cacheinfo`), `conflict_abort` (merge/cherry-pick/revert `--abort`), `conflict_continue` (refused while conflicted; `commit --no-edit` / `cherry-pick --continue` / `revert --continue`; emptied pick explained). `conflict_read` gained `stamp` and the `notUtf8` summary reason.
- Spec review: first FAIL (submodule theirs staged ours; non-UTF-8 text corrupted to U+FFFD), fixed with regression tests; re-review PASS; follow-ups (no-op eol checkout, empty-pick wording) fixed with regression tests. 17 conflict tests. `./init.sh` green (617 Vitest; Rust 255 passed / 3 ignored); `worktree::coalesces_events_independently_per_worktree` flaked once under parallel load (passes alone 4/4 and on rerun). **M6-05 done.** Next: M6-06 Conflicts screen.

## 2026-11-13: M6-06 Conflicts screen — implemented

- `src/ipc/conflicts.ts`; `useConflicts` store (list/select/choose/undo with previous-choice history) and `ConflictWatcher` (mounted in App: reload on worktree switch + debounced `git:changed`); `ConflictsToolbar` (branch · operation, remaining chip, Terminal, confirmed Abort for merge/cherry-pick/revert) and `ConflictsView` (file tabs with unresolved count, Ours | Result | Theirs columns, click side or ← Ours / Both / Theirs → / Edit, Undo, Save resolution with overwrite note, summarized-file Use ours / Use theirs / Accept deletion, disabled ✦ Explain, Mark resolved & commit → Graph). Sidebar Conflicts badge; `GitConflict` toasts offer Resolve conflicts.
- Vitest: 6 screen tests + sidebar badge + toast action. `./init.sh` → `=== Verification Complete ===` (Vitest 70 files / 625 tests; Rust 255 passed / 3 ignored). Spec review pending.
- Spec review PASS; fixed Result line numbering, failed-save choice wipe (regression test; only a stale-stamp `Conflict` re-reads), summary stale-stamp refresh, footer layout, rebase captions/wording, truncated count, duplicate undo entries. `./init.sh` green (626 Vitest; Rust 255 passed / 3 ignored). **M6-06 done — all Stage 2 tasks done.** Next: Stage 2 review gate.

## 2026-11-13: M6 Stage 2 review gate — 🛑 Checkpoint M6.2

- Security review first FAIL (high: conflicted paths reached git as pathspecs, so `*` / `[id]` names touched other files — reproduced data loss), fixed with `:(literal)` on every add/checkout/rm (regression test, verified to fail without the fix); low: marker-like content now summarized (`markerLike`, regression test); TOCTOU low accepted. Re-review PASS.
- Code review PASS with should-fixes, all fixed: emptied cherry-pick/revert continue points to `git <cmd> --skip` (regression test for revert); `undo_last` refused while a merge/cherry-pick/revert/rebase is in progress (regression test); stash conflict toasts offer Resolve conflicts. Re-review PASS; remaining nits recorded in the report.
- E2E: `.agent/reviews/m6-stage-2-e2e.md` — Playwright 63/11 (same pre-existing M5 failures). Several full runs flaked on unrelated UI timeouts at machine load ~235 from outside processes; `vitest --maxWorkers=2` 626/626 and canonical `./init.sh` green at lower load (Vitest 70 files / 626 tests; Rust 259 passed / 3 ignored). Test-only: GraphScreen deep-page wait timeout 5 s.
- Manual spec: `docs/testing/m6-manual-e2e.md` Stage 2 (M6-S2-01..10). Waiting for the user. No commit or push.

## 2026-11-13: Stage 2 committed by user order (before Checkpoint M6.2)

- User ordered committing the pre-issue-#5 work before continuing issue #5. Stage 2 (M6-04..06 + review fixes) and the issue #5 design/plan docs committed on `m6-stage-2`. Checkpoint M6.2 manual run (`docs/testing/m6-manual-e2e.md` Stage 2) is still pending, so the branch is not fast-forwarded into `main` yet. Last `./init.sh` on this tree green (Vitest 70 files / 626 tests; Rust 259 passed / 3 ignored). No push.
- Also per user order: the accidental `~/.git` (150 commits, 6 branches, no remote, 954 MB) was moved to `~/.Trash/home-dotgit-2026-11-13` (recoverable), not deleted; no working files touched.

## 2026-11-13: M6 Stage 3 (issue #5) started before Stage 2 by user order

- Stage 2 (conflict resolver) stays uncommitted on `m6-stage-2` in the main checkout, waiting for Checkpoint M6.2. Stage 3 runs in worktree `/Users/apple/orca/projects/branchwork-m6-stage-3` on `m6-stage-3` from `main` (`2fad157`), later fast-forwarded onto the Stage 2 commit `de62b34`; M6 plan updated there (Stage 3 inserted, M6-07 now depends on M6-03). Baseline `./init.sh` green apart from the known watcher timing flake (passes alone).
- M6-07 Initialize on add: `repository_classify` (`FolderKind`) + `repository_init` (`git init` via the user's git CLI, registers the project); `openRepo` confirms init for non-Git folders, offers the enclosing repo when inside one, errors for invalid. Spec review FAIL: a malformed `.git` above or a surrounding bare repo classified as "not a repository" and allowed a nested `git init` — fixed (only `NotFound` → NotRepository; bare/unreadable → Invalid; home/root → Invalid so no init dialog), regression assertions added.
- Open user decision from that review: the user's `$HOME` (`/Users/apple`) is itself a Git repository, so every new folder under `~` classifies as "inside /Users/apple" and the init offer never appears.
- M6-08 Repositories with no commits: `worktree::unborn_branch`; worktree list/summary, Graph WIP branch, file history handle an unborn HEAD; worktree creation requires a first commit; Graph empty state with Open in Changes. 5 Rust tests + 1 Vitest. Test-only: GraphScreen deep-page wait 5 s (same change as on `m6-stage-2`).
- `./init.sh` → `=== Verification Complete ===` (Vitest 69 files / 621 tests; Rust 246 passed / 3 ignored). No commit or push.
- M6-07 re-review PASS; M6-08 spec review PASS (nits fixed). `./init.sh` green on the tree rebased onto `de62b34` (Vitest 70 files / 630 tests; Rust 267 passed / 3 ignored). **M6-07 and M6-08 done.** Next: M6-09 Publish to GitHub.
- M6-09 Publish to GitHub implemented: `publish.rs` (`publish_with` refuses existing origin / no first commit / detached HEAD before any API call; GraphQL `createRepository` with ownerId from `gh_publish_owners`; clone URL must equal `https://github.com/<owner>/<name>.git`; `git remote add origin`; first push via `worktree::invoke_git_with_extra_config` with `http.https://github.com/.extraheader` passed only in the child `GIT_CONFIG_*` env, trace vars removed; push failure → `{pushed:false, pushError}` with repo kept). `sync::require_first_commit` gives Push/Pull a clear message on an empty repo. UI: `PublishDialog` (account/owner/name/Private-Public/description; disabled without a first commit), entry in the Repository no-remote state and Changes ⋯ (only without origin). Deviation: repo-name sanitizer lives in the UI (`sanitizeRepoName`), tested in Vitest.
- `./init.sh` → `=== Verification Complete ===` (Vitest 71 files / 634 tests; Rust 274 passed / 3 ignored). Spec review pending.
- M6-09 spec review FAIL → fixed (origin check for any host via `git_has_origin`; validated/trimmed request to createRepository; regression tests) → re-review PASS; R1 hardening: GIT_TRACE2* set to 0 for the token push. `./init.sh` green (635 Vitest; Rust 277 passed / 3 ignored). **M6-09 done — all Stage 3 tasks done.** Manual spec: `docs/testing/m6-manual-e2e.md` Stage 3 (M6-S3-01..09).

## 2026-11-13: M6 Stage 3 review gate — 🛑 Checkpoint M6.3

- Security review PASS (no medium+). Accepted lows, recorded: a pre-push hook inherits the publish header env during the first push (hooks stay enabled by design; a malicious hook can already read `gh auth token`); `repository_init` accepts sensitive folders like `~/.ssh` (no new capability over the terminal; Private default). Info: push has no timeout (same as existing sync).
- Code review PASS; should-fixes applied: a failure after GitHub creation now says "Created <owner>/<name> on GitHub…" (regression test); init/open failure toasts include git's details; push-failure toast offers Open terminal to authenticate for `gitAuth`. Nits recorded in the report.
- E2E: `.agent/reviews/m6-stage-3-e2e.md` — Playwright 63/11 (same pre-existing M5 failures). `./init.sh` → `=== Verification Complete ===` (Vitest 71 files / 635 tests; Rust 278 passed / 3 ignored).
- Manual spec: `docs/testing/m6-manual-e2e.md` Stage 3 (M6-S3-01..09). Waiting for the user. Stage 2's Checkpoint M6.2 also pending. No commit or push for Stage 3.

## 2026-11-13: Stages 2 and 3 merged into main by user order

- User ordered merging Stage 2 and Stage 3 before their manual checkpoints (M6.2, M6.3 still to be run on `main`). Stage 3 committed on `m6-stage-3`; `main` fast-forwarded to `m6-stage-2` (`de62b34`) and then to the Stage 3 commit; stage branches deleted and the Stage 3 worktree removed. No push; GitHub issue #5 left open.
- Per user order: pushed `main` (`142c243..3649feb`; tags not pushed). Removed the clean worktrees `fix-issue-5` and `fix-issue-1` (their commits are already in `main`; local branches `fix/issue-1`, `fix/issue-5` kept). Closing GitHub issue #5 failed: the active gh account `rozzyrahmanda` lacks permission; using the owner account `rozzyy` was blocked by the permission classifier — left for the user.
- Issue #5 closed on GitHub as `rozzyy` (user-authorized) with a resolution comment pointing to 3649feb; active gh account switched back to `rozzyrahmanda`.

## 2026-11-13: M6 Stage 4 (Interactive rebase) started

- Branch `m6-stage-4` from `main` (`3649feb`). M6-10 Rebase plan read IPC done: `rebase_plan(worktree, base)` → branch, `base..HEAD` oldest first (cap 500, `truncated`), `isMerge`, `pushed` (merge-base of HEAD and upstream strictly after base). Spec review PASS; nits fixed. Cap test now builds 500 commits in-process (was 26 s of `git commit` processes that loaded the parallel suite).
- Decision 2 amended by the user (option A): the rebase sequence-editor helper is the app binary itself (`--branchwork-rebase-todo`), because the `branchwork-notify` sidecar isn't in `bundle.externalBin` and likely isn't packaged (follow-up).
- M6-11 Rebase execution IPC done: app-binary sequence editor (`--branchwork-rebase-todo`), server-side plan rebuild + validation, backup ref, todo/messages, oplog undo, progress events, continue/abort, force-with-lease push. Review FAIL (reword lost after a conflict) → fixed (messages in the git dir until the rebase ends; regression test) → PASS; R1: lease targets the upstream ref. `./init.sh` green (635 Vitest; Rust 289 passed / 3 ignored).
- M6-12 Rebase screen implemented: Graph "Rebase from here" (menu + inspector) sets the base; rows oldest first with drag/↑↓ reorder, action select, inline reword, auto-squash for fixup!/squash!, result count + preview, pushed warning, backup note; Start with progress; done → Undo toast (+ confirmed force-with-lease push for pushed branches); conflict → Resolve conflicts; in-progress panel with Continue / confirmed Abort. 7 Vitest + Graph test. `./init.sh` green (Vitest 72 files / 643 tests; Rust 289 passed / 3 ignored). Spec review pending.
- M6-12 spec review FAIL (Continue → done skipped the lease offer and kept the stale plan; two tests missing) → fixed (shared done handling in `useRebaseUi`, per-worktree base/pushed flag, autosquash edge cases, custom drag type, duplicate Graph assertion removed) → re-review PASS; leftovers fixed (per-worktree pushed flag, no meld into dropped targets, realistic Continue mock). `./init.sh` green (Vitest 72 files / 645 tests; Rust 289 passed / 3 ignored). **M6-12 done — all Stage 4 tasks done.** Next: Stage 4 review gate.

## 2026-11-14: M6 Stage 4 review fixes verified — 🛑 Checkpoint M6.4

- Stage 4 review findings (code B1, S1–S5; security S4-M1, L1–L4, I1–I2) were already fixed in the working tree but not recorded; verified them against the reports, each with its regression test (reword keeps the body; no-op rebase not undoable; lease push refused for a branch tracking another name). Follow-up sections appended to `.agent/reviews/m6-stage-4-code-review.md` and `-security-review.md` (both PASS; self re-review, no fresh reviewer agent this session). Deferred minors: lease dialog doesn't name the target (backend now restricts it to the same-named branch), N2 progress denominator, N7, N8 stale plan reload, N9.
- `m6-stage-4` now also carries the agent-session commits `21feaad` (session usage + token saver) and `3d3ec85` (Orca-style quota meter + labelled saver badges), fast-forwarded from `feat/agent-session-token-saver` by user order.
- `./init.sh` → `=== Verification Complete ===` (Vitest 74 files / 662 tests; Rust 304 passed / 3 ignored). `cargo test --lib rebase` 13 passed.
- UI/UX redesign: design approved (`docs/superpowers/specs/2026-11-14-ui-redesign-design-system-design.md`, prototype `docs/design/redesign-prototype.html`); it becomes milestone M7 and starts after M6 Stage 4 is approved and merged (user decision).
- **Next:** user runs `docs/testing/m6-manual-e2e.md` Stage 4 (M6-S4-01..09) and approves Checkpoint M6.4; then the Stage 4 commit on `m6-stage-4` and fast-forward into `main`. No commit or push before that.
- Agent usage follow-up (user request): `cb7ed59` fast-forwarded into `m6-stage-4` — live Claude quota from the statusline `rate_limits` (sidecar `branchwork-saver statusline` → `<profile>/branchwork-quota.json`, installed only when the profile has no user statusline), newer-of live/cache reader, pane header always shows the 5h window (0% "reset" after its reset time) plus the tightest other window. `./init.sh` green on `m6-stage-4` (Vitest 664; Rust 308 passed / 3 ignored).
- M7 plan written (`docs/superpowers/plans/2026-11-14-m7-ui-redesign.md`, 12 tasks / 4 stages); user approved it with subagent-driven execution, starting after Checkpoint M6.4.
- **Checkpoint M6.4 approved** by the user (2026-11-14; manual M6-S4-01..09 not reported, recorded as unverified). Stage 4 committed on `m6-stage-4` and fast-forwarded into `main`; then M7 docs committed on `main` and M7 Stage 1 started on `m7-stage-1`.

## 2026-11-14: Resume M7 Stage 1 Task 03 handover

- Continued from `.branchwork/handover.md` on `m7-stage-1`. Fixed the reported Task 03 review issues in `src/ui/ui.css`: count/kbd and small metadata text now meet the 12px floor; interactive switch, chips, and `.ib2` buttons meet the 24px hit target; segmented controls use an inset focus-visible ring so `.seg` overflow does not clip it.
- `git diff --check` passed. `./init.sh`: TypeScript passed; Vitest 78 files / 677 tests passed; Clippy passed; Rust 298 passed / 10 failed / 3 ignored. Every Rust failure was an existing worktree test unable to start a macOS FSEvent stream. No IPC or Rust code changed.
- Task 03 requires independent re-review, then Stage 1 code review and manual E2E spec review. Native `pnpm tauri dev` visual check remains unrun. Stop at Checkpoint M7.1; no commit or push.

## 2026-11-14: M7 Stage 1 re-review and accessibility fixes

- Stage 1 code review PASS after multiple fix/re-review rounds; report: `.agent/reviews/m7-stage-1-code-review.md`. Fixed the segmented focus-ring mismatch, Large text sizing on sidebar/worktree/pane-header/Changes/Settings surfaces, input and shadowed-control focus rings, and CountBadge accessible role/name. Added targeted CSS regression assertions.
- Final targeted gate: `pnpm vitest run src/ui` → 7 files / 15 tests passed; `pnpm typecheck` and `git diff --check` passed.
- Final `RUST_TEST_THREADS=1 ./init.sh`: TypeScript passed; Vitest 78 files / 679 tests passed; Clippy passed; Rust 298 passed / 10 failed / 3 ignored. All 10 failures are existing worktree tests reporting `unable to start FSEvent stream`, and persist with serialized tests. Full init gate remains red for this macOS environment limitation.
- Native `pnpm tauri dev` visual verification is still unrun; `docs/testing/m7-manual-e2e.md` remains unchecked. Stage 1 is not at a completed checkpoint; no commit or push.

## 2026-11-14: M7 Stage 1 environment follow-up

- Retried a failing watcher test with `TMPDIR=/private/tmp`; it still failed with `unable to start FSEvent stream`, confirming the issue is not specific to the default `/private/var/...` temp directory. No product Rust changes made.
- `pnpm tauri dev` compiled and started the app successfully. Cua Driver `permissions status` reported that its app did not answer, so native window inspection could not be performed. The dev session started for this check was stopped cleanly.
- M7.1 remains pending native visual/manual checks and an accepted or resolved full-init Rust gate. No commit/push; Stage 2 not started.

## 2026-11-14: Recheck M7 against the approved design spec

- Re-read `docs/superpowers/specs/2026-11-14-ui-redesign-design-system-design.md` as the normative source (the plan/prototype are subordinate implementation aids). The current branch is still only M7 Stage 1 Tasks 01–03; the navigation/shell/Home/History/split redesign from the full spec is not yet implemented and remains in later stages.
- Found a direct Stage 1 component mismatch: `.input` used a 10px panel radius and raised fill. Updated it to the spec's 6px control radius, `--bg` fill and strong border; the global focus ring remains. Added regression assertions. `pnpm vitest run src/ui`: 7 files / 15 tests passed; `git diff --check` passed.
- Full spec constraints such as the app-wide 12px floor and remaining screen migration are not yet complete at this intermediate stage. M7.1 remains pending the full verification/environment issue and manual native UI checks; no commit/push or Stage 2 work.

## 2026-11-14: M7 Stage 1 gate recovered; Task 04 started by user order

- `./init.sh` was rerun outside the sandbox after the earlier FSEvent startup failures. Exact result: `=== Verification Complete ===`; Vitest 78 files / 679 tests; Rust 308 passed / 3 ignored; typecheck and Clippy clean.
- User explicitly ordered continuing through all M7 spec tasks, authorizing progression past manual stage checkpoints. Stage 1 code review is PASS; native/manual UI checks remain unverified due Cua Driver not responding. No stage commit or push was ordered.
- Stage 1 Tasks 01–03 recorded done. M7 Task 04 (screen registry, migration and container screens) is now active. Stage 2+ work remains serialized by plan/dependencies.

## 2026-11-14: M7 full spec implementation completed

- Completed M7 Tasks 04–12 against `docs/superpowers/specs/2026-11-14-ui-redesign-design-system-design.md`: screen migration and History/Home containers; worktree-first sidebar and project picker; breadcrumb/status bar; navigation shortcuts; Home attention feed; History base/commit/blame workflows; contextual operation banner; Open beside and per-worktree layouts; flush panes and app-wide typography restyle. Updated `feature_list.json` to mark M7 Tasks 04–12 done.
- Final `./init.sh` exit 0 (`=== Verification Complete ===`): Vitest 78 files / 679 tests passed; Rust 308 passed / 3 ignored; TypeScript and Clippy clean. `git diff --check` passed.
- Performance bounds: per-worktree saved layouts capped at 200, pane IDs sanitized/deduplicated and capped at 32, BasePicker ancestry list capped at 50. No M7 Rust/IPC changes.
- Native visual/manual checks in `docs/testing/m7-manual-e2e.md` remain unchecked because Cua Driver did not answer during the earlier attempt. Do not claim native appearance, navigation, or terminal regression checks passed. No commit or push.

## 2026-11-14: Commit/push M7 and close the next eligible reviews

- Per user order, committed all M7 implementation and state changes as `7509c71` (`feat: implement M7 UI redesign`) on `m7-stage-1`, then pushed and configured tracking to `origin/m7-stage-1`.
- Followed the first unfinished feature in `feature_list.json`: `followup-terminal-file-drop`. Reviewed bounded, quoted PTY path insertion and targeted pane logic; prior focused 15-test suite is recorded. Manual Finder drop could not be observed because `cua-driver permissions status` returned “the app didn't answer”. User had authorized continuing across manual checkpoints; status is recorded done with this gap explicit.
- Then reviewed `followup-issue-2-term-env`: default `TERM=xterm-256color` is applied before per-session overrides; regression test verifies the child sees TERM and `clear` has no warning.
- Current baseline `./init.sh` exit 0: TypeScript and Clippy clean; Vitest 80 files / 687 tests passed; Rust 308 passed / 3 ignored. Packaged-app TERM and manual Finder drop checks remain unverified. No additional code change or commit was made after the M7 push.

## 2026-11-14: Fix clipped agent pane header after split

- Bug: splitting an agent pane left/right clipped the header's trailing actions (layout toggles, ±, ⤴, ↗, ✕). Root cause: every `.agent-phd` child is `flex-shrink: 0`, the quota meter (two windows) plus saver badges made the row's intrinsic width exceed a half-width pane, and `.agent-pane { overflow: hidden }` cut off the right end.
- Fix: moved `QuotaMeter` and `SaverBadges` into a new `.agent-phm` strip directly under the header (wraps, popovers still open downward inside the pane); header now holds identity + actions only, and `.agent-wt` / `.agent-cli-switch` may shrink so the buttons never clip. Regression test added in `AgentsScreen.test.tsx` ("meters live in a strip below the header…").
- `./init.sh` exit 0: TypeScript and Clippy clean; Vitest 80 files / 688 tests passed; Rust 308 passed / 3 ignored. Uncommitted on `m7-stage-1`.

## 2026-11-14: Fix agent panes not filling the view height in Full layout

- Bug report: Grid and Full layouts fill only the width, not the height. Measured with a headless Playwright page using the real `stage.css` + `agents.css` + `terminal.css` (760px view): solo 760, grid left+right 760/760, **full 420** — Grid already fills; only Full was capped by `.agent-full .agent-pane { height: 420px }` (from `c110d42`).
- Fix: removed the fixed height so Full rows use the same `minmax(310px, 1fr)` sizing as Grid. After: full 1 pane 760; full 2 panes 380/380 sharing the view instead of 420/420 overflowing. No test added: jsdom cannot measure layout; the measurement script lived in the session scratchpad.
- `./init.sh` exit 0: TypeScript and Clippy clean; Vitest 80 files / 688 tests passed; Rust 308 passed / 3 ignored. `git diff --check` clean. Uncommitted on `m7-stage-1`.

## 2026-11-14: Match the UI to docs/design/redesign-prototype.html (worktree list excluded)

- Compared headless screenshots of the prototype (all screens) with the running Vite app. Root cause of the drift: shell, Home and Settings still used the pre-redesign glass/rounded chrome and the Launchpad+Inbox layout; the M7 tasks restyled tokens but not those structures.
- Shell: 44px solid title bar with location crumb (no brand text), bordered rectangular search, ☾/☀ theme + ? only; flush 232px sidebar with bordered project card (mark, "{group} · N projects"), "For this worktree" heading, screen rows with count badges and ⌘1–⌘7 hints; status bar ⎇ branch · changes · ↑↓ · agents · "❯ Terminal Ctrl+`". Stage: lone pane is a 12px-inset bordered panel with a 44px header; split / Agents / Terminal stay flush. Worktree list untouched per request.
- Home: greeting row with primary "＋ New worktree", three KPI panels, "Needs your attention" panel (Inbox rows with icon tile, primary action, snooze, done; tabs All/Review/Mention/CI/Agents), then Issues for you ("Start → worktree") and CI feed · 24h. The open-PR list and agents card were dropped to match the prototype (PR count stays in the KPI).
- Agents: toolbar "N sessions · M waiting", segmented layout, small Race / primary New agent; pane header shows bold CLI, faint worktree, status label (Running / Waiting for you / Done / Idle), profile chip; "± Review beside" moved into the meter strip. Settings: 760px column of panels with section headers and one-line hints. "Open beside" uses the ghost small button.
- Tests updated for the new structure (TitleBar, Launchpad, Inbox, Agents status text, ui type-scale rule). `./init.sh` exit 0: TypeScript and Clippy clean; Vitest 80 files / 687 tests passed; Rust 308 passed / 3 ignored. `git diff --check` clean. Not verified: native Tauri window, light theme, and screens that need a real repo/agent session (Changes, History, Files, agent panes) — only empty states were screenshotted. Uncommitted on `m7-stage-1`.
