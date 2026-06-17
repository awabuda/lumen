# @lumen/core

The agent runtime. Defines the contracts that every other package
implements, and ships the `Agent` class that ties them together.

`@lumen/core` is deliberately ignorant of concrete implementations: no
provider URLs, no tool names, no filesystem paths. You compose the
runtime at the composition root (typically the CLI) by passing concrete
collaborators into `Agent`.

```ts
import { Agent, type BaseProvider, type BaseTool, BaseMemoryStore } from '@lumen/core'
```

## What's in this package

| Symbol | Where | Stable? |
|---|---|---|
| `BaseProvider` | `message/provider.ts` | yes |
| `BaseTool` | `tools/index.ts` | yes |
| `BaseMemoryStore` | `memory/index.ts` | yes |
| `BaseVectorMemoryStore` | `memory/index.ts` (P7) | yes |
| `BaseProviderPool` | `agent/pool.ts` (P6) | yes |
| `BaseMutex` | `concurrency/mutex.ts` (P7) | yes |
| `Hook` / `HookRegistry` | `hooks/index.ts` | yes |
| `Agent` | `agent/agent.ts` | yes |
| `Budget` | `budget/index.ts` | yes |
| `BaseLogger` / `PinoLogger` | `logging/index.ts` | yes |
| `TelemetryCollector` | `telemetry/index.ts` | yes |
| `CronScheduler` | `cron/index.ts` | yes |
| `MultiUserRuntime` | `multi-user/index.ts` | yes |
| `StaticPlanner` / `LLMPlanner` | `plan/index.ts` | yes |
| `BaseSubAgent` | `agent/sub-agent.ts` | yes |

Anything exported from a `base.ts` file is **stable** (semver-protected).
Other files are implementation detail and may move.

## Quick start

```ts
import {
  Agent,
  type BaseProvider,
  type BaseTool,
  type BaseMemoryStore,
  HookRegistry,
  NoopTelemetryBackend,
  ConsoleLogger,
} from '@lumen/core'
import { createOpenAIProvider } from '@lumen/llm'
import { SqliteStore } from '@lumen/memory'
import { StaticToolset } from '@lumen/tools'

const provider: BaseProvider = createOpenAIProvider({
  apiKey: (() => {
    const k = process.env.OPENAI_API_KEY
    if (!k) throw new Error('OPENAI_API_KEY is required')
    return k
  })(),
  defaultModel: 'gpt-4o-mini',
})

const memory: BaseMemoryStore = new SqliteStore({ path: '~/.lumen/memory.db' })
await memory.init()

const tools: BaseTool[] = [] // your tools

const agent = new Agent({
  provider,
  tools,
  memory,
  hooks: new HookRegistry(),
  logger: new ConsoleLogger(),
  telemetry: new NoopTelemetryBackend(),
})

const result = await agent.run({ input: 'Summarize this file.' })
console.log(result.output)
```

## Concurrency

`@lumen/core/concurrency` ships a FIFO async mutex for code that needs
to serialize state across `await` points (P7.2). Used internally by
`ProviderPool` to keep the round-robin cursor read-modify-write atomic
under concurrent `chat` / `stream` calls.

```ts
import { Mutex, AcquireTimeoutError } from '@lumen/core'

const mutex = new Mutex({ name: 'my-resource', timeoutMs: 5_000 })

await mutex.runExclusive(async () => {
  // serialized critical section
})
```

## License

MIT
