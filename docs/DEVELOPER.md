# Lumen Developer Guide

## Architecture

Lumen is a monorepo with 8 packages arranged in three tiers:

```
Tier 1 (no deps)     Tier 2 (depends on Tier 1)    Tier 3 (apps)
─────────────────    ─────────────────────────    ────────────
config                core                          cli
                      ├── llm
                      ├── tools
                      ├── memory
                      ├── skills
                      └── mcp
```

### Dependency rules

- Tier 1 packages never import from other Lumen packages.
- Tier 2 packages may import from `@lumen/core` and `@lumen/config`.
- `@lumen/cli` (Tier 3) imports from everything.

### Package responsibilities

| Package | Responsibility |
|---------|---------------|
| `config` | YAML config loading, Zod schema, hot-reload, profile switching |
| `core` | Agent loop, message types, BaseProvider, BaseTool, BaseMemoryStore, BaseLogger, hooks, budget |
| `llm` | OpenAI-compatible, Anthropic, Ollama providers |
| `tools` | Filesystem tools, terminal, git, gh, meta tools, ShellSandbox, Docker sandbox |
| `memory` | InMemoryStore, SqliteStore (FTS5+WAL), vector backend, retriever, reflector, conflict detector |
| `skills` | SKILL.md parser, MarkdownSkill, SkillRegistry, trigger, evolver |
| `mcp` | MCP client, stdio transport, Streamable HTTP transport |
| `cli` | Commander CLI, Ink/React TUI, composition root |

## Adding a new provider

1. Extend `BaseProvider` from `@lumen/core`.
2. Implement `chat()`, `stream()`, and `embed()`.
3. Add to `packages/llm/src/index.ts`.
4. Write ≥10 tests using fake fetch.
5. Run `pnpm --filter @lumen/llm test`.

## Adding a new tool

1. Extend `BaseTool` from `@lumen/core`.
2. Define a Zod input schema.
3. Implement `call(input, ctx)`.
4. Register in `packages/tools/src/index.ts`.
5. Write tests covering happy path + error path + AbortSignal.

## Adding a new memory store

1. Extend `BaseMemoryStore` from `@lumen/core`.
2. Implement all abstract methods.
3. Run the contract suite: `packages/memory/test/contract-suite.ts`.
4. Wire into `buildAgent()` in `apps/cli/src/composition.ts`.

## Running tests

```bash
pnpm -r test                    # All packages
pnpm --filter @lumen/core test  # Single package
pnpm --filter @lumen/cli test   # CLI tests (includes snapshot)
```

## Type checking

```bash
pnpm -r typecheck               # All packages
pnpm --filter @lumen/core typecheck
```

## Building

```bash
pnpm -r build                   # All packages
pnpm --filter @lumen/cli build  # CLI only
```

## Code style

- TypeScript strict + `noUncheckedIndexedAccess`
- Every public symbol has a JSDoc block
- No `any` — use `unknown` and narrow
- Import order: node builtins → external → workspace
- Prefer `readonly`, `as const`, discriminated unions
- Every new function needs tests (≥80% line coverage target)
