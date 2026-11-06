# Progress Log

Append newest entries at the top. Each entry: date, task, what changed, verification evidence, next step.

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
