# M10 — Multi-window: Implementation Plan

> Native execution (user: "lanjutkan"). One stage commit after the checkpoint.

**Goal:** Independent workspace windows. **Spec:** `docs/superpowers/specs/2026-11-14-m10-multi-window-design.md`.

## Global Constraints
- Labels `main` and `ws-<n>` (1–9999), validated in Rust; capability `windows: ["main", "ws-*"]` with the same permissions plus `allow-destroy` / `allow-get-all-windows`.
- Window-scoped keys: `repos`, `activeWorktrees`, `stage`, `agentSessions`, `terminalDock`, `terminalScreen`, `sidebar` (`ws-<n>:<key>`; `main` keeps plain keys).

## Review Focus
1. Two windows never restore the same agent sessions (scoped `agentSessions`).
2. Closing a secondary window stops its agents and terminals and it does not reopen; quitting keeps it.
3. Invalid labels from the webview are rejected (`windows.rs` tests).
4. A closed window's scoped settings are deleted without touching `ws-10` when closing `ws-1`.
5. Browser mode (e2e) behaves as a single `main` window.

### Task 1 (M10-01): Rust window commands ✅
- [x] `windows.rs` open/restore/forget, `Store::delete_settings_with_prefix`, commands, capability; 3 Rust tests; bindings regenerated.
### Task 2 (M10-02): Scoped settings + window lifecycle ✅
- [x] `ipc/settings.ts` scoping + global-save hook; `state/windows.ts` (seeded open, move pane, restore, close cleanup, settings sync); 3 unit tests.
### Task 3 (M10-03): Entry points ✅
- [x] ⌘⇧N, palette New window / Move to new window, pane ⧉ control (desktop only); strings.
- [x] `./init.sh` + Playwright green.

## Stage end
- code + security review → `.agent/reviews/m10-stage-1-review.md`; manual checks `docs/testing/m10-manual-e2e.md`; 🛑 checkpoint M10.1.
