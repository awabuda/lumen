# Lumen Architecture

> **The single most important doc in this repo.** Read this before changing anything.

## Design philosophy

Lumen is built on three first principles:

1. **Pluggable at every seam.** Every component that varies between deployments
   (model provider, tool set, memory backend, skill store, MCP transport) is
   defined as an abstract base class or interface, and concrete implementations
   are registered through a discovery mechanism. Nothing is hard-wired.

2. **Inheritable, not configurable.** When a user wants to customize behavior, the
   primary path is *subclassing a base and overriding a method*, not threading
   options through a config object. Configuration is for tuning; inheritance is
   for behavior.

3. **Standalone packages.** Every package under `packages/` is independently
   publishable. A consumer should be able to `npm install @lumen/llm` and use it
   without pulling in `@lumen/core`, `@lumen/mcp`, or the CLI.

## Dependency graph

```
                      ┌──────────────────┐
                      │   @lumen/cli     │
                      │  (apps/cli)      │
                      └────────┬─────────┘
                               │
            ┌─────────┬────────┼────────┬──────────┐
            ▼         ▼        ▼        ▼          ▼
       ┌────────┐ ┌──────┐ ┌──────┐ ┌───────┐ ┌────────┐
       │ core   │ │ tools│ │memory│ │skills │ │  mcp   │
       └───┬────┘ └──┬───┘ └──┬───┘ └───┬───┘ └───┬────┘
           │         │        │         │         │
           └────┬────┴────────┴────┬────┴─────────┘
                ▼                 ▼
            ┌──────┐         ┌────────┐
            │  llm │         │ config │
            └──────┘         └────────┘

**Adjacent bridges** (consume the framework; do not import each other):
- `@lumen/server` — HTTP + WebSocket adapter (apps and remote clients).
- `@lumen/desktop-bridge` — Tauri-based desktop client bridge.
- `@lumen/editor-bridge` — Editor extension bridge (VSCode, JetBrains).
```

**Rule:** arrows point from dependent to dependency. Lower packages never import
from higher ones. `@lumen/config` is at the bottom because everyone reads config.

## Core abstractions

### The five base contracts

These are the seams. Every pluggable thing in Lumen conforms to one of them.

| Contract | Location | Purpose |
|---|---|---|
| `BaseProvider` | `packages/llm/src/base.ts` | Chat + stream + embed |
| `BaseTool` | `packages/tools/src/base.ts` | One callable capability |
| `BaseMemoryStore` | `packages/memory/src/base.ts` | Persist + retrieve facts/sessions |
| `BaseVectorMemoryStore` | `packages/core/src/memory/index.ts` | `BaseMemoryStore` + `vectorSearch(embedding, k?)`. Subclass when you need vector retrieval. |
| `BaseSkill` | `packages/skills/src/base.ts` | A named, invokable capability |
| `BaseTransport` | `packages/mcp/src/base.ts` | MCP wire transport (stdio/http) |
| `BaseProviderPool` | `packages/core/src/agent/pool.ts` | Multi-backend provider with `round-robin` / `name` / `capability` / `weighted` strategies and automatic failover. Extends `BaseProvider` so pools drop into `Agent` like a single provider. |
| `BaseMutex` | `packages/core/src/concurrency/mutex.ts` | FIFO async mutex (promise-chain). Public extension surface for code that needs to serialize critical sections across `await` points. |

Each base contract has:
- A **lifecycle**: `init()` → ready → `dispose()`.
- A **typed schema** for inputs and outputs (Zod, exported so callers can reuse it).
- A **metadata block** (name, version, capabilities) that the registry uses for
  discovery and routing.

### The registry pattern

```
ToolRegistry
  .register(BaseTool subclass instance)
  .get('read_file') -> BaseTool
  .list() -> ToolDescriptor[]
```

The registry is dumb on purpose. It indexes by name, delegates everything else to
the instance. The agent core asks the registry for a tool by name when the LLM
calls it; the tool itself owns execution, validation, and error semantics.

### Inversion of control in the agent loop

The agent core (`packages/core/src/agent.ts`) does **not** know what tools exist,
what model is in use, or where memory lives. It accepts four collaborators via
constructor injection:

```ts
new Agent({
  provider: BaseProvider,     // any LLM
  tools: BaseTool[],           // any capabilities
  memory: BaseMemoryStore,     // any persistence
  hooks: HookRegistry,         // observers / extensions
})
```

This is the **Composition Root** pattern. The CLI is the composition root in
production; tests use their own composition root with mock collaborators.

## Extension points

Lumen is extensible in five ways, listed from cheapest to most powerful:

1. **Tools** — drop a `BaseTool` subclass into `~/.lumen/tools/` and the registry
   picks it up. No code change.
2. **Skills** — drop a `SKILL.md` into `~/.lumen/skills/`. Same mechanism.
3. **MCP servers** — add an entry to `~/.lumen/mcp.json`. The MCP client spawns
   the process and proxies its tools into the registry.
4. **Provider plugins** — install a `@lumen/provider-*` package. Auto-registered
   via package metadata.
5. **Subclassing a base contract** — for behaviors that don't fit the
   discovery-driven model, subclass the base and inject your instance at the
   composition root.

## What is intentionally NOT in core

- **No hard-coded model names.** All model IDs are configuration.
- **No filesystem-specific code in memory.** The default is SQLite, but the
  base contract is storage-agnostic.
- **No tool implementations in core.** Core defines the `BaseTool` contract;
  `tools` package ships defaults.
- **No HTTP in core.** All network I/O is in `llm` (provider calls) and `mcp`.
- **No global locks.** `BaseMutex` lives in `packages/core/src/concurrency/`
  for code that needs to serialize state across `await` boundaries (e.g.
  `ProviderPool` uses one to make the round-robin cursor read-modify-write
  atomic). The mutex is opt-in, not a global re-entrant lock.

## Testing strategy

- **Unit tests** for every base contract and every concrete subclass.
- **Contract tests** that any `BaseProvider` must pass (chat, stream, tool use).
- **Integration tests** that spin up a real SQLite + a stub provider + a real
  tool, and exercise the agent loop end-to-end.
- **Property tests** for parsers (message parsing, JSON-RPC framing).
- **Snapshot tests** for tool I/O schemas.

## Versioning & stability

- The base contracts in `*.base.ts` files are **stable** (semver-protected).
- Concrete implementations may evolve faster.
- Breaking a base contract requires a major version bump across all packages.
