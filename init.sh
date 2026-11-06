#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "=== Harness Initialization ==="

echo "=== pnpm typecheck ==="
pnpm typecheck

echo "=== pnpm test ==="
pnpm test

echo "=== cd src-tauri && cargo clippy -- -D warnings && cargo test ==="
(cd src-tauri && cargo clippy -- -D warnings && cargo test)

echo "=== Verification Complete ==="
echo ""
echo "Next steps:"
echo "1. Read feature_list.json to see current feature state"
echo "2. Pick ONE unfinished feature to work on"
echo "3. Implement only that feature"
echo "4. Re-run verification before claiming done"
