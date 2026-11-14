# Session Handoff

- **Last Updated:** 2026-11-14
- **Current Objective:** 🛑 Checkpoint M6.4 (Interactive rebase). User runs `docs/testing/m6-manual-e2e.md` Stage 4 (M6-S4-01..09) on `m6-stage-4`; the Stage 2/3 manual checks (M6-S2, M6-S3) on `main` are also still pending.
- **Milestone / stage:** M1–M5 released (`v0.5.0`). M6 Stages 1–3 on `main`; Stage 4 implemented, reviewed (code + security follow-ups PASS) and verified; Stage 5 (compare) remains, then the M6 review gate and `v0.6.0`. M7 (UI/UX redesign) designed and approved, starts after Stage 4 is merged.
- **Branch:** `m6-stage-4` (main checkout). Commits on top of `main` (`3649feb`): `21feaad`, `3d3ec85` (agent session usage, token saver, quota meter). Stage 4 work is uncommitted. Feature worktree `../branchwork-agent-session-token-saver` (`feat/agent-session-token-saver`) still exists. Commit/push only on user order.
- **Open user decisions:** pre-existing M1 medium (`configured_checkout_filters` misses `include.path` filters); 11 pre-existing Playwright failures from the M5 Launchpad redesign; local branches `fix/issue-1`, `fix/issue-5` remain; remove the agent-session worktree/branch?

## Recommended Next Step

After the user approves M6.4: one Stage 4 commit on `m6-stage-4`, `git switch main && git merge --ff-only m6-stage-4 && git branch -d m6-stage-4`. Then either M6 Stage 5 (compare) or, if the user prefers, M7 Stage 1 from the redesign plan (`docs/superpowers/specs/2026-11-14-ui-redesign-design-system-design.md`).

## M2 structure

- Stage 1 — Status read model + shared diff renderer (Tasks 01–04) → Checkpoint M2.1 ✅ committed
- Stage 2 — Changes screen: staging, commit variants, stashes (Tasks 05–08) → Checkpoint M2.2 ✅ committed
- Stage 3 — Files & editor: fs IPC, File manager UI, CodeMirror (Tasks 09–11) → Checkpoint M2.3 ✅ committed `ad0ff87`
- Stage 4 — Blame, history, oplog undo, polish, Graph WIP inspector (Tasks 12–16) → Checkpoint M2.4 ✅ committed `300a23a`; M2 release `v0.2.0`
- Stage 5 follow-up — Graph commit history diff inspector (Task 17) → committed as `1336afb` and fast-forwarded into `main`, no push
- M3 Stage 1 — PTY foundation and terminal dock (Tasks 01–03) → ✅ committed `a95e38f`, merged into `main`
- M3 Stage 2 — Full-screen Terminal workspace (Tasks 04–05) → ✅ manual OK, committed, merged into `main`
- M3 Stage 3 — Agent registry and session lifecycle (Tasks 06–10) → all done and reviewed ✅; manual M3-S3-01..07 pending
- M3 Stage 4 — Agent workflows (Tasks 11–12) → not started

## Decisions this session (user)

- `trash` crate 5.3.0 accepted (plan Open Question 2 resolved).
- File tree loads lazily now (I7).
- Sidebar grouped Workspace / Code / AI / GitHub; Inbox stays in Workspace (number keys 1–9 keep the spec order).
- Diff long lines scroll horizontally per hunk (no wrap: the virtualizer needs fixed 20px rows).
- Open Question 5: defer PR links to M4; keep Blame/History/Diff tabs; View commit opens Graph.
- Open Question 7: Undo Last Action covers commit, discard, delete-to-Trash, and stash-drop.

## Blockers / notes

- Stage 4 review reports: `.agent/reviews/m2-stage-4-code-review.md` (follow-up PASS), `.agent/reviews/m2-stage-4-security-review.md` (PASS, no findings), and `.agent/reviews/m2-stage-4-e2e.md` (76/76 automated E2E, memory condition unverified).
- The final `./init.sh` is green: typecheck and Clippy clean; 37 Vitest files / 294 tests passed; Rust 126 passed / 3 ignored. `cargo fmt --check` and `git diff --check` clean.
- The user approved Checkpoint M2.4 while accepting that manual M2-S4-01..05 and the native memory budget remain unverified. `.agent/reviews/m2-stage-4-e2e.md` records this explicitly; the unknown-state process sample is not valid evidence.
- `e2e/m2-stage2-changes.spec.ts`: rewritten (real `__TAURI_INTERNALS__` mock, invoke-call assertions) — 16/16 pass, debt closed in Stage 4.
- Prior Stage 3 deferred nits remain recorded in `.agent/reviews/m2-stage-3-code-review.md`; no new Stage 3 scope was changed.
- M2 Stage 4's manual E2E and native memory checks remain unverified by user approval. Do not alter the v0.2.0 release; this follow-up is tracked separately. Do not push.
- Stage 5 validation: `./init.sh` passed (37 Vitest files / 297 tests; Rust 128 passed / 3 ignored; Clippy/typecheck clean); `pnpm test:e2e` passed 76/76; `cargo fmt --check` and `git diff --check` clean. See `.agent/reviews/m2-stage-5-code-review.md`, `.agent/reviews/m2-stage-5-security-review.md`, and `.agent/reviews/m2-stage-5-e2e.md`.
- Manual M2-S5-01 and Checkpoint M2.5 were approved by the user; Stage 5 commit and fast-forward are authorized. Do not push.
- M3 Task 16 implementation is complete on `m3-stage-6`: responsive project rail, title-bar group/project context and toggle, existing group/project management flows reused, and persistence added. Spec/code review PASS; full `./init.sh` and 74/74 Playwright E2E passed. Manual M3-S6 checkpoint remains pending; no commit or push.
- M3 plan: `docs/superpowers/plans/2026-11-08-m3-terminal-agents.md`; Stage 1 Task 03 is active. `./init.sh` passed before implementation (37 Vitest files / 297 tests; Rust 128 passed / 3 ignored; typecheck and Clippy clean).
- Task 03 implementation is complete and verified: dock store + UI, 4 modes, tabs, split/swap, persistence/restore, all Stage 1 entry points. `./init.sh` green (41 Vitest files / 316 tests; Rust 138 passed / 3 ignored); `pnpm test:e2e` 76/76. Formal Task 03 spec review still pending; no commit or push.
- Task 01 is complete: PTY manager/IPC, generated bindings, and tests are implemented. The focused security review found that killing only the shell could leave descendants alive; cleanup now kills the Unix process group or Windows Job Object. Regression tests verify descendant cleanup and reader termination.
- `./init.sh` after Task 01: `=== Verification Complete ===`; typecheck clean; Test Files 38 passed (38), Tests 299 passed (299); Rust 135 passed, 0 failed, 3 ignored; Clippy clean. `cargo fmt --check` and `git diff --check` clean.
- Task 02 is complete and spec-reviewed PASS. `./init.sh`: `=== Verification Complete ===`; 39 Vitest files / 305 tests; Rust 138 passed / 3 ignored; TypeScript and Clippy clean. See `.agent/reviews/m3-task-02-cli-pane-spec.md`.
- Task 02 PTY replay retains bounded output for reattachment. Abnormally ended sessions remain until the dock owner closes them; cleanly exited shells now auto-close their tab. Task 03 must close sessions when tabs are explicitly closed and preserve sessions when the dock is merely hidden.
- Windows cross-build remains unverified on this macOS host: `libz-sys` requires a Windows C toolchain. The Windows Job Object path is present and must receive platform CI coverage.
- Post-M3 fix + Orca-parity login (2026-11-09, uncommitted): Add account kini login sungguhan (`loginCmd ?? launch[0]` + rollback profil; custom tanpa override → toast). Usage bar prototype-parity di chip/menu Agents + Settings (`Limit {window} · {%}` / `No usage data`), ephemeral, hanya bila hook CLI melaporkan (spec §6.6.4, no fabrication). Gate: init.sh exit 0 (53 files/465 tests; Rust 161/3 ignored), e2e 76/76. Belum commit — menunggu perintah user.
- Login seluruh provider kini ala Orca (registry loginCmd terverifikasi --help): claude `claude auth login`, opencode `opencode auth login`, gemini fallback TUI; codex/copilot/muse tak berubah. Gate: init.sh exit 0 (467 tests), e2e 76/76. Belum commit — menunggu perintah user.
- Baris akun Settings kini fail-closed: Logout hanya bila file kredensial terverifikasi (`cli_has_credentials`); profil yang belum login menampilkan Log in + Remove. Gate: init.sh exit 0 (471 tests; Rust 162/3 ignored), e2e 76/76. Belum commit — menunggu perintah user.
- Status baris akun kini refresh sesudah logout + polling 5 dtk saat belum terhubung; tanpa tombol Logout selama pemeriksaan. Gate: init.sh exit 0 (472 tests; Rust 162/3 ignored), e2e 76/76. Belum commit — menunggu perintah user. Rust berubah → aplikasi harus direstart penuh.
- Guard spawn sesi terhadap profil belum login (toast + tombol Log in, tanpa bakar PTY); sesi basi harus ditutup manual. Gate: init.sh exit 0 (473 tests; Rust 162/3 ignored), e2e 76/76. Belum commit.
- Claude ke HOME sandbox (credentialPaths token-only, hooks ikut pindah) + BusyButton loader di Add account/Log in/cek kredensial. Gate: init.sh exit 0 (476 tests; Rust 162/3 ignored), e2e 76/76. Belum commit; butuh restart penuh. Profil claude lama wajib login ulang sekali.
- Claude revert ke CLAUDE_CONFIG_DIR + credentialPaths [] (auth host bersama; dialog Keychain hilang). Gate: init.sh exit 0 (476 tests; Rust 162/3 ignored), e2e 76/76. Belum commit; butuh restart penuh.
- Waiting toast kini one-shot per sesi (status/badge tak berubah). Gate: init.sh exit 0 (491 tests; Rust 165/3 ignored), e2e 76/76. Belum commit.
- Claude login mismatch fixed: Settings probes with the selected profile's `CLAUDE_CONFIG_DIR`; status and identity are scoped to that profile, and confirmed logged-out profiles are blocked from agent startup and get the existing login action. `./init.sh` exit 0 (55 Vitest files/493 tests; Rust 165 passed/3 ignored; Clippy/typecheck clean). Manual restart/login retest pending; no commit/push.
- Follow-up to user report: login-created terminal tabs were not navigating to the Terminal screen, and the initial screen load could overwrite them. Login now loads/opens Terminal before launching the vendor command; `openHere` follows the same load-before-create ordering. A login-blocked Add Agent now leaves no failed session pane and keeps the new profile selected. `./init.sh` exit 0 (55 Vitest files/494 tests; Rust 165 passed/3 ignored; Clippy/typecheck clean). Manual restart/login/agent retest pending; no commit/push.
- Settings follow-up: Add profile creates its profile row without leaving Settings so the user can click Log in there; login retry remains available when the probe is unavailable and during pending status. Every row has Edit (display name only, stable slug) and Remove profile. Settings width is no longer capped at 760px. `./init.sh` exit 0 (55 Vitest files/499 tests; Rust 165 passed/3 ignored; Clippy/typecheck clean), `git diff --check` clean. Manual UX retest pending; no commit/push.
