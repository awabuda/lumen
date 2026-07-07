/**
 * Scenario: reflection overhead (P19.7.3).
 *
 * Measures the wall-clock and message-history size overhead of
 * the three reflection modes (inline / step-level / run-end)
 * plus a no-reflection baseline. We expect:
 *
 *   - inline:        +1 token per assistant message (the
 *                    `[confidence: 0.55]` suffix)
 *   - step-level:    +0 per-message overhead, but N messages of
 *                    internal reflection state every
 *                    `stepInterval` steps
 *   - run-end:       +0 per-message overhead, +1 reflection
 *                    record persisted to BaseMemoryStore
 *   - none:          +0 across the board
 *
 * The output reports wall-clock for each mode plus a final row
 * counting how many messages each mode emitted, so a regression
 * detector can flag a "reflection middleware started emitting
 * 2 tokens per message" style bug.
 *
 * Opt in: LUMEN_BENCH=1.
 */

import {
  Agent,
  type AssistantMessage,
  BaseProvider,
  type ChatRequest,
  type ChatResponse,
  type ProviderCapabilities,
  type StreamEvent,
  ToolRegistry,
  createAgent,
  createReflectionMiddleware,
} from '@lumen/core'
import { describe, it } from 'vitest'
import {
  BENCH_TABLE_HEADER,
  benchEnabled,
  benchTableRow,
  summariseLatency,
  timeAsync,
} from './helpers.js'

class ScriptedProvider extends BaseProvider {
  public readonly id = 'bench-fake'
  public readonly capabilities: ProviderCapabilities = {
    streaming: false,
    embeddings: false,
    toolUse: false,
    vision: false,
    reasoning: false,
    promptCaching: false,
    structuredOutput: false,
    maxContextTokens: 8000,
  }
  private readonly script: ReadonlyArray<AssistantMessage>
  private index = 0
  public constructor(script: ReadonlyArray<AssistantMessage>) {
    super()
    this.script = script
  }
  public override async chat(
    _request: ChatRequest,
  ): Promise<ChatResponse> {
    const message = this.script[this.index] ?? this.script[this.script.length - 1]
    if (!message) throw new Error('bench-fake: empty script')
    this.index += 1
    if (this.index >= this.script.length) this.index = this.script.length - 1
    return { message, latencyMs: 0 }
  }
  public override async *stream(): AsyncGenerator<StreamEvent, void, void> {
    yield { type: 'message_complete', message: this.script[0] ?? { role: 'assistant', content: '', toolCalls: [] } }
  }
}

const SCRIPT: ReadonlyArray<AssistantMessage> = Array.from({ length: 4 }, (_, i) => ({
  role: 'assistant',
  content: `step-${i} result`,
  toolCalls: [],
}))

const RUNS = Number.parseInt(process.env.LUMEN_BENCH_RUNS ?? '20', 10)

const runMode = async (mode: 'none' | 'inline' | 'step' | 'runend'): Promise<{ ms: number; messageCount: number }> => {
  const provider = new ScriptedProvider(SCRIPT)
  const middleware: Parameters<typeof createAgent>[0]['middleware'] =
    mode === 'none'
      ? []
      : mode === 'inline'
        ? [createReflectionMiddleware({ inline: true, runEnd: 'off' })]
        : mode === 'step'
          ? [
              createReflectionMiddleware({
                inline: false,
                stepInterval: 2,
                runEnd: 'off',
              }),
            ]
          : [
              createReflectionMiddleware({
                inline: false,
                runEnd: 'rule',
              }),
            ]
  const agent: Agent = createAgent({
    provider,
    tools: new ToolRegistry(),
    middleware,
  })
  const { durationMs } = await timeAsync(() => agent.run({ userMessage: 'go' }))
  // Count assistant messages in the final history.
  const result = await agent.run({ userMessage: 'go-2' })
  return { ms: durationMs, messageCount: result.messages.filter((m) => m.role === 'assistant').length }
}

describe('reflection overhead (P19.7.3)', () => {
  it.skipIf(!benchEnabled())(
    `reports wall-clock + message-count per mode over ${RUNS} iterations`,
    async () => {
      for (const mode of ['none', 'inline', 'step', 'runend'] as const) {
        const samples: number[] = []
        let lastMessageCount = 0
        for (let i = 0; i < RUNS; i += 1) {
          const { ms, messageCount } = await runMode(mode)
          samples.push(ms)
          lastMessageCount = messageCount
        }
        const stats = summariseLatency(samples)
        // eslint-disable-next-line no-console
        console.log(BENCH_TABLE_HEADER)
        // eslint-disable-next-line no-console
        console.log(
          benchTableRow('fake', `reflection-${mode}`, {
            count: stats.count,
            p50Ms: stats.p50Ms,
            p95Ms: stats.p95Ms,
            maxMs: stats.maxMs,
            meanMs: stats.meanMs,
          }, `msgs=${lastMessageCount}`),
        )
      }
    },
  )
})
