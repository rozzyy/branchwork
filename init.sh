#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "=== Harness Initialization ==="

echo "=== pnpm typecheck ==="
pnpm typecheck

echo "=== pnpm test ==="
pnpm test

echo "=== cd src-tauri && cargo clippy -- -D warnings && cargo test ==="
# Rust tests drive the git CLI with the user's config (spec §2); isolate them from the
# developer's global/system git config so results don't depend on the machine.
(cd src-tauri && cargo clippy -- -D warnings && GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 cargo test)

echo "=== Verification Complete ==="
echo ""
echo "Next steps:"
echo "1. Read feature_list.json to see current feature state"
echo "2. Pick ONE unfinished feature to work on"
echo "3. Implement only that feature"
echo "4. Re-run verification before claiming done"
