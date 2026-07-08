# Lumen — Getting Started

> **Lumen** is a self-improving TypeScript agent framework. It ships
> the full agent loop (tool calls, retries, fallbacks, plan/act
> modes, reflection, sub-agents, checkpoints, skills, tracing)
> with a tier-isolated monorepo and a CLI that runs in 60 s.

This guide gets you from `git clone` to a working agent in
under five minutes. For the full architecture, see
[ARCHITECTURE.md](./ARCHITECTURE.md); for the 89-clause
developer policy, see [DEVELOPER.md](./DEVELOPER.md).

---

## 1. Install

```bash
git clone https://github.com/awabuda/lumen.git
cd lumen
pnpm install
pnpm -r build
```

Requirements: Node 20+, pnpm 9+, an `OPENAI_API_KEY` (or any
provider key — see [Section 4](#4-providers)).

> **Sandbox note**: the workspace runs a sandboxed shell.
> `git push` to a fresh remote is gated by a pre-push hook;
> `pnpm publish` is gated by `NODE_AUTH_TOKEN`. Both are user
> opt-in, not framework defaults.

---

## 2. First run (one prompt)

```bash
export OPENAI_API_KEY=sk-...your-key-here...
pnpm --filter @lumen/cli start -- run "summarise the README"
```

The CLI composes an `Agent` with the OpenAI-compatible provider,
the filesystem tools, and a SQLite memory store at
`~/.lumen/memory.db`. The default `lumen run` is a single
prompt; it returns the final assistant message and exits.

To start an **interactive TUI** instead:

```bash
pnpm --filter @lumen/cli start -- chat
```

The TUI uses Ink/React, streams events as they arrive, and
persists every turn to the memory store.

---

## 3. First configuration

`~/.lumen/config.yaml`:

```yaml
defaultModel: gpt-4o-mini
providers:
  - id: openai
    apiKey: sk-...
    baseUrl: https://api.openai.com/v1
memory:
  path: ~/.lumen/memory.db
```

The loader is hot-reload-safe; the CLI watches the file and
re-builds the composition root on change (no restart needed).

---

## 4. Providers

Lumen ships five concrete providers in `@lumen/llm`:

| Provider | Class | Notes |
|---|---|---|
| OpenAI-compatible | `OpenAICompatibleProvider` | Default; works with OpenAI, Groq, Together, etc. |
| Anthropic | `AnthropicProvider` | Native Messages API |
| Mistral | `MistralProvider` | |
| Ollama | `OllamaProvider` | Local, no API key |
| llama.cpp | `LlamaCppProvider` | Local, no API key |

For a multi-provider setup with automatic failover, wire a
`ProviderPool`:

```ts
import { ProviderPool } from '@lumen/core'

const pool = new ProviderPool({
  providers: [
    { provider: openaiPrimary, weight: 1 },
    { provider: anthropicBackup, weight: 1 },
  ],
  strategy: 'round-robin',
})

const agent = createAgent({ provider: pool, tools, ... })
```

When the primary provider throws a retryable error, the pool
transparently falls back to the backup. If every provider
exhausts, the run throws `PoolExhaustedError`; the P20.4
checkpoint path auto-saves a snapshot so the caller can resume.

---

## 5. Five things you can do in 60 seconds

### 5.1 Plan + act with one command

```bash
lumen run --plan auto "refactor the auth middleware"
```

`--plan auto` runs through `createPlanMiddleware({ mode: 'auto' })`:
the first turn produces a plan, the second turn executes it.

### 5.2 Pause a long-running run, resume later

```bash
lumen run --checkpoint ~/.lumen/checkpoints.db "long task..."
# run aborts on Ctrl-C; the checkpoint is auto-saved
lumen checkpoint list --plans-path ~/.lumen/checkpoints.db
lumen checkpoint show <id>  # inspect what was saved
# resume: pass --resume-from <id> back to lumen run
```

The checkpoint includes the full message history, so resume
picks up exactly where the abort happened.

### 5.3 Reflect on the last run

```bash
lumen reflect run                # rule-based facts from the last session
lumen reflect meta --interval 5  # cross-run trust-delta pass
```

`lumen reflect meta` clusters similar facts and applies a
bounded ±0.1 trust adjustment to the most-representative fact
in each cluster. See
[docs/p19.5-meta-reflector-design-basis.md](./p19.5-meta-reflector-design-basis.md)
for the design basis (4-framework comparison, including
Hermes fact_feedback as the closest real-world reference).

### 5.4 Run a multi-agent team

```bash
lumen run --team ./team.json "review this PR"
```

Where `team.json` declares 4 sub-agents (lint, type-check,
test-run, review) and the orchestration shape:

```json
{
  "team": [
    { "name": "lint", "mode": "sequential" },
    { "name": "type-check", "mode": "sequential" },
    { "name": "test-run", "mode": "parallel" },
    { "name": "review", "mode": "handoff", "to": "main" }
  ]
}
```

See [docs/P20.7-agent-team.md](./P20.7-agent-team.md) for the
design baseline.

### 5.5 Bound the run to a budget

```ts
import { createHeartbeat } from '@lumen/core'

const heartbeat = createHeartbeat({ intervalMs: 30_000, timeoutMs: 60_000 })
try {
  await agent.run({ userMessage: '...', signal: heartbeat.signal })
} finally {
  heartbeat.stop()
}
```

The run aborts after 60 s of inactivity. The P20.4.2 catch
path auto-saves a checkpoint before the throw propagates.

---

## 6. Next steps

| You want to ... | Read |
|---|---|
| Understand the agent loop | [ARCHITECTURE.md](./ARCHITECTURE.md) |
| Add a new provider | [DEVELOPER.md](./DEVELOPER.md#adding-a-new-provider) |
| Add a new tool | [DEVELOPER.md](./DEVELOPER.md#adding-a-new-tool) |
| See why P19 chose middleware over config flags | [P19-DESIGN.md](./P19-DESIGN.md) |
| See why P20.5 picks trust-delta over rewriting | [p19.5-meta-reflector-design-basis.md](./p19.5-meta-reflector-design-basis.md) |
| Understand the agent-team pattern | [P20.7-agent-team.md](./P20.7-agent-team.md) |
| See known footguns | [PITFALLS.md](./PITFALLS.md) |

---

## 7. CLI command map

```
lumen run <prompt>           single-shot agent run
lumen chat                   interactive TUI
lumen doctor                 local install diagnostics
lumen session list/show/delete/prune
lumen plan list/approve/reject
lumen checkpoint list/show/delete
lumen reflect run/meta       rule-based + cross-run reflection
lumen config                 show / edit config
lumen model list             show available providers
lumen tools list             show registered tools
lumen skills list            show registered skills
lumen update                 check for newer releases
```

---

## 8. Pinned design commitments

- **Middleware > config flags** (P19+ rule 11): any extension
  to the agent loop is a middleware, not an `AgentConfig`
  boolean. Adding `enablePlan: true` to `AgentConfig` is the
  wrong shape; add `createPlanMiddleware({ mode: 'auto' })` to
  the `middleware: []` array instead.
- **Helper function > abstract class** (P19+ rule 15): the
  reflection / planning / sub-agent systems are interfaces
  with helper functions, not abstract classes with one
  implementation. An abstract class earns its inheritance
  cost only when it has at least two non-wrapper
  implementations.
- **Tier isolation**: `core` never imports from `memory` /
  `skills` / `tools` / `mcp` / `llm`. Callers wire concrete
  implementations through DI (the `createAgent` factory or
  the composition root in `apps/cli/src/composition.ts`).
- **No SaaS**: lumen does not depend on LangSmith, OpenClaw
  hosted, or any external telemetry. The trace context (P20.8)
  is the local-only observability hook; a future
  `toOtelContext` adapter is the only sanctioned bridge to
  external systems.

---

*Last updated: 2026-07-07. If this guide disagrees with the
code, the code is right; please open an issue.*
