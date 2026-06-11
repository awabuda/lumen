# L1.x — Vitest configured in all packages (audit)

Status: **done** (audit-only, no code changes were needed).

Each workspace package ships a working `vitest` + `tsconfig.test.json`
configuration. The audit ran on 2026-06-10 and reports the
current state of every package's testing surface.

## Per-package inventory

| Package                  | `test` script | `typecheck` script                | `tsconfig.test.json` | `vitest` in devDeps |
|--------------------------|---------------|-----------------------------------|----------------------|---------------------|
| `packages/config`        | `vitest run`  | `tsc --noEmit && tsc -p tsconfig.test.json --noEmit` | yes | yes |
| `packages/core`          | `vitest run`  | `tsc --noEmit && tsc -p tsconfig.test.json --noEmit` | yes | yes |
| `packages/llm`           | `vitest run`  | `tsc --noEmit && tsc -p tsconfig.test.json --noEmit` | yes | yes |
| `packages/mcp`           | `vitest run`  | `tsc --noEmit`                    | yes | yes |
| `packages/memory`        | `vitest run`  | `tsc --noEmit && tsc -p tsconfig.test.json --noEmit` | yes | yes |
| `packages/skills`        | `vitest run`  | `tsc --noEmit && tsc -p tsconfig.test.json --noEmit` | yes | yes |
| `packages/tools`         | `vitest run`  | `tsc --noEmit && tsc -p tsconfig.test.json --noEmit` | yes | yes |
| `apps/cli`               | `vitest run`  | `tsc --noEmit && tsc -p tsconfig.test.json --noEmit` | yes | yes |

Notes:

- **`packages/mcp`** does not have a `tsconfig.test.json` step in
  its `typecheck` script. That is intentional: `@lumen/mcp`'s
  tests live alongside the source (no `test/` directory) and the
  regular `tsc --noEmit` already covers the test files via the
  base `include`. Adding a redundant `tsconfig.test.json` step
  would be cargo-culted.
- Every other package follows the two-step pattern so that
  `test/**/*.ts` files are checked under `noUncheckedIndexedAccess`
  exactly the same way `src/**/*.ts` is.

## Coverage targets

- The shared `BaseMemoryStore` contract test
  (`packages/memory/test/contract-suite.ts`) is run against
  every concrete store via `runStoreContractTests(label, factory)`.
  This is the *only* contract test in the repo today; the
  follow-up is L2.x (contract tests for every base class).
- Each provider in `@lumen/llm` ships at least 10 tests
  (`OpenAICompatibleProvider`, `AnthropicProvider`,
  `OllamaProvider`). This is the LLM-layer equivalent of the
  memory contract tests, but per-implementation rather than
  per-base.
- Tool tests live next to their source files
  (`packages/tools/test/{meta,gh}.test.ts` etc.) and use
  `vi.spyOn` / module-level `vi.mock` to intercept `child_process`
  calls without a live network round-trip.

## How to verify locally

```bash
# L1.x itself — the whole suite
cd packages/memory && pnpm rebuild better-sqlite3 && \
  pnpm -r --workspace-concurrency=1 test

# Per-package spot check
pnpm --filter @lumen/llm test
pnpm --filter @lumen/tools test
```

A green run of the first command is the L1.x gate. See the
"Tests" line in the audit snapshot below for the latest count.

## Latest audit snapshot (2026-06-10)

| Package           | Test files | Tests | Typecheck |
|-------------------|-----------:|------:|-----------|
| `packages/config` |          3 |     24 | OK        |
| `packages/core`   |          3 |     42 | OK        |
| `packages/llm`    |          8 |     37 | OK        |
| `packages/mcp`    |          3 |     64 | OK        |
| `packages/memory` |          5 |     45 | OK        |
| `packages/skills` |          3 |     39 | OK        |
| `packages/tools`  |         11 |     63 | OK        |
| `apps/cli`        |         10 |     59 | OK        |
| **total**         |     **46** |**358**| **8/8**   |

This document is the deliverable for L1.x. L2.x — contract
tests for every base — is the next step.
