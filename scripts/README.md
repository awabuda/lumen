# Install `lumen` globally

The repo ships a wrapper at `scripts/lumen` that forces Node 25.9.0
to match the better-sqlite3 ABI 141 binary.

## Install

```bash
# 1. Symlink the wrapper to a PATH directory.
ln -sf "$(pwd)/scripts/lumen" /usr/local/bin/lumen

# 2. Verify
lumen doctor --no-api-key
# ... should show "better-sqlite3 ABI matches current Node (modules=141)"
```

## Why a wrapper

The default `#!/usr/bin/env node` shebang picks up the first
`node` on PATH. On a machine with both brew's Node 25.9.0 (ABI 141)
and nvm's Node 24.14.1 (ABI 137) on PATH, `env node` resolves to
nvm's Node 24 — but the better-sqlite3 binary was rebuilt under
brew's Node 25. Loading an ABI 141 binary from a Node 24 process
crashes with "NODE_MODULE_VERSION 137" mismatch.

The wrapper hard-codes the absolute path to brew's Node 25.9.0,
so the ABI is always correct regardless of PATH order.
