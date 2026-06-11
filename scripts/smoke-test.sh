#!/usr/bin/env bash
# Real-scenario smoke test: build, doctor, run, tools, model, config.
# Run from the repo root: bash scripts/smoke-test.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== 1. Build ==="
pnpm --filter @lumen/cli build

echo ""
echo "=== 2. Doctor ==="
node apps/cli/dist/index.js doctor

echo ""
echo "=== 3. Tools list ==="
node apps/cli/dist/index.js tools list

echo ""
echo "=== 4. Tools --toolset ==="
node apps/cli/dist/index.js tools list --toolset

echo ""
echo "=== 5. Model list ==="
node apps/cli/dist/index.js model list

echo ""
echo "=== 6. Config path ==="
node apps/cli/dist/index.js config path

echo ""
echo "=== 7. Session list ==="
node apps/cli/dist/index.js session list 2>&1 || true

echo ""
echo "=== 8. Skills list ==="
node apps/cli/dist/index.js skills list 2>&1 || true

echo ""
echo "=== 9. Typecheck ==="
pnpm -r typecheck

echo ""
echo "=== 10. Full test suite ==="
pnpm -r --workspace-concurrency=1 test

echo ""
echo "All smoke tests passed."
