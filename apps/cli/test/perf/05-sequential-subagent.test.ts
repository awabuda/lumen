/**
 * Scenario: sequential sub-agent wall-clock (P19.7.1).
 *
 * Measures how long it takes to run N=3 sub-agents in sequence
 * via `createSequentialSubAgent`. The headline number is the
 * sum of N sub-agent run-times; we report mean, p50, max.
 *
 * Why a benchmark for this:
 *   - Sequential sub-agents are the common case for "do these
 *     three research tasks in order" workflows. Knowing the
 *     wall-clock cost of a 3-step pipeline tells operators
 *     whether to switch to parallel mode (P19.7.2) for latency.
 *   - The benchmark is deliberately local (FakeProvider) so
 *     it runs in CI without burning API credits. The relative
 *     cost of sequential vs. parallel orchestration is what we
 *     care about; absolute timing on a real provider is a
 *     separate concern.
 *
 * Methodology:
 *   - We construct a SequentialSubAgent with N=3 sub-agents
 *     that each take a single FakeProvider scripted response.
 *   - `benchRuns()` iterations record the wall-clock of the
 *     entire `seq.run()` call.
 *
 * Opt in: LUMEN_BENCH=1. Real-model benchmarks are not
 *         required for this scenario because the orchestration
 *         overhead is independent of provider latency.
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
  createSequentialSubAgent,
} from '@lumen/core'
import { describe, it } from 'vitest'
import {
  BENCH_TABLE_HEADER,
  benchEnabled,
  benchTableRow,
  summariseLatency,
  timeAsync,
} from './helpers.js'

/**
 * Local FakeProvider inline here so the bench file does not need
 * to import from a different test directory. The bench scenarios
 * run under `vitest` and `real-model` lives in a different root;
 * pulling the cross-package fake across adds config overhead.
 */
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
    _options?: StreamOptions,
  ): Promise<ChatResponse> {
    const message = this.script[this.index] ?? this.script[this.script.length - 1]
    if (!message) {
      throw new Error('bench-fake: empty script')
    }
    this.index += 1
    if (this.index >= this.script.length) {
      // Allow infinite reads of the final script entry so the
      // agent loop can terminate without exhausting the script.
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

describe('sequential sub-agent wall-clock (P19.7.1)', () => {
  it.skipIf(!benchEnabled())(
    `reports mean / p50 / max ms over ${RUNS} iterations of N=${TASK_COUNT}`,
    async () => {
      const samples: number[] = []
      for (let i = 0; i < RUNS; i += 1) {
        const provider: BaseProvider = new ScriptedProvider(
          Array.from({ length: TASK_COUNT }, (_, j) => ({
            role: 'assistant',
            content: `result-${j}`,
            toolCalls: [],
          })) as ReadonlyArray<AssistantMessage>,
        )
        const seq = createSequentialSubAgent({
          parent: { provider, tools: new ToolRegistry() },
          tasks: buildTasks(),
        })
        const { durationMs } = await timeAsync(() => seq.run())
        samples.push(durationMs)
      }
      const stats = summariseLatency(samples)
      // eslint-disable-next-line no-console
      console.log(BENCH_TABLE_HEADER)
      // eslint-disable-next-line no-console
      console.log(
        benchTableRow('fake', 'sequential-subagent-n3', {
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
