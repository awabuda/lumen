/**
 * Scenario: parallel sub-agent wall-clock (P19.7.2).
 *
 * Mirror of P19.7.1 for the parallel orchestrator. We expect
 * the wall-clock to be **close to** the per-task cost, not 3×
 * the per-task cost, because `Promise.all` lets the three
 * sub-agent runs overlap on the event loop.
 *
 * Comparison vs P19.7.1:
 *   - If `parallel` p50 < `sequential` p50, the orchestrator
 *     is delivering the latency win the design promises.
 *   - If `parallel` p50 ≈ `sequential` p50, the wins are
 *     hidden by the in-process provider being too fast; the
 *     comparison is more meaningful on a real provider with
 *     measurable per-call latency. The P19.7.5 quality axis
 *     + per-provider bench will be the authoritative number.
 *
 * Opt in: LUMEN_BENCH=1.
 */

import {
  type AssistantMessage,
  BaseProvider,
  type ChatRequest,
  type ChatResponse,
  type ProviderCapabilities,
  type StreamEvent,
  type SubAgentTask,
  ToolRegistry,
  createParallelSubAgent,
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
    _options?: { signal?: AbortSignal },
  ): Promise<ChatResponse> {
    const message = this.script[this.index] ?? this.script[this.script.length - 1]
    if (!message) {
      throw new Error('bench-fake: empty script')
    }
    this.index += 1
    if (this.index >= this.script.length) {
      this.index = this.script.length - 1
    }
    return { message, latencyMs: 0 }
  }
  public override async *stream(): AsyncGenerator<StreamEvent, void, void> {
    yield { type: 'message_complete', message: this.script[0] ?? { role: 'assistant', content: '', toolCalls: [] } }
  }
}

const TASK_COUNT = 3
const RUNS = Number.parseInt(process.env.LUMEN_BENCH_RUNS ?? '20', 10)

const buildTasks = (): ReadonlyArray<SubAgentTask> =>
  Array.from({ length: TASK_COUNT }, (_, i) => ({
    spec: {
      name: `worker-${i}`,
      description: `worker ${i}`,
      systemPrompt: 'You do work.',
    },
    prompt: `task ${i}`,
  }))

describe('parallel sub-agent wall-clock (P19.7.2)', () => {
  it.skipIf(!benchEnabled())(
    `reports mean / p50 / max ms over ${RUNS} iterations of N=${TASK_COUNT}`,
    async () => {
      const samples: number[] = []
      for (let i = 0; i < RUNS; i += 1) {
        const provider = new ScriptedProvider(
          Array.from({ length: TASK_COUNT }, (_, j) => ({
            role: 'assistant',
            content: `result-${j}`,
            toolCalls: [],
          })) as ReadonlyArray<AssistantMessage>,
        )
        const par = createParallelSubAgent({
          parent: { provider, tools: new ToolRegistry() },
          tasks: buildTasks(),
        })
        const { durationMs } = await timeAsync(() => par.run())
        samples.push(durationMs)
      }
      const stats = summariseLatency(samples)
      // eslint-disable-next-line no-console
      console.log(BENCH_TABLE_HEADER)
      // eslint-disable-next-line no-console
      console.log(
        benchTableRow('fake', 'parallel-subagent-n3', {
          count: stats.count,
          p50Ms: stats.p50Ms,
          p95Ms: stats.p95Ms,
          maxMs: stats.maxMs,
          meanMs: stats.meanMs,
        }),
      )
    },
  )
})
