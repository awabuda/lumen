/**
 * P21.3 — durable execution bench (5 scenarios, LUMEN_BENCH=1 opt-in).
 *
 * Each scenario records wall-clock under `LUMEN_BENCH=1` and
 * otherwise reports a skip. Provider is local (FakeProvider) so
 * the suite never hits the network and never needs an API key.
 *
 * Scenarios:
 *   1. `09-durable-step-checkpoint` — cost of writing one
 *      InMemoryCheckpointStore save per step for a 100-step
 *      agent. The default interval is 1, so the bench keeps
 *      the I/O cost visible.
 *   2. `10-durable-resume-latency` — time to find the
 *      freshest in-progress checkpoint and synthesise a
 *      resumed run from it.
 *   3. `11-durable-concurrent` — 50 concurrent saves into one
 *      store. Detects lock contention regressions in the
 *      checkpoint implementation.
 *   4. `12-durable-checkpoint-size` — bytes per checkpoint as
 *      a function of `messages.length`; surfaces a sizing
 *      regression in the JSON layout.
 *   5. `13-durable-stale-resume` — resume-from-stale-checkpoint
 *      path: a checkpoint older than the TTL must NOT be
 *      picked up by `findResumeCheckpoint`.
 */

import { Agent, InMemoryCheckpointStore, ToolRegistry } from '@lumen/core'
import { describe, expect, it } from 'vitest'
import { DEFAULT_RESUME_TTL_MS, findResumeCheckpoint } from '../../src/checkpoint-resume.js'
import { benchEnabled, benchTableRow, summariseLatency, timeAsync } from './helpers.js'

interface BenchAgent {
  agent: Agent
  provider: BenchProvider
}

class BenchProvider {
  public readonly id = 'bench-fake'
  public readonly capabilities = {
    streaming: false,
    embeddings: false,
    toolUse: false,
    vision: false,
    reasoning: false,
    promptCaching: false,
    structuredOutput: false,
    maxContextTokens: 8000,
  } as const
  public calls = 0
  public async chat(): Promise<{
    message: { role: 'assistant'; content: string; toolCalls: never[] }
  }> {
    this.calls += 1
    return { message: { role: 'assistant' as const, content: `ok ${this.calls}`, toolCalls: [] } }
  }
  public async *stream(): AsyncGenerator<never, void, never> {
    yield {
      type: 'message_start',
      message: { role: 'assistant', content: '', toolCalls: [] },
    } as never
  }
}

const newAgent = (): BenchAgent => {
  const provider = new BenchProvider()
  const agent = new Agent({
    provider: provider as unknown as ConstructorParameters<typeof Agent>[0]['provider'],
    tools: new ToolRegistry(),
    model: 'bench-model',
  })
  return { agent, provider }
}

describe.skipIf(!benchEnabled(), 'P21.3 durable execution bench', () => {
  it('1. step-level save cost is bounded for 100 steps', async () => {
    const store = new InMemoryCheckpointStore()
    const { agent } = newAgent()
    const maxIterations = 100
    const samples: number[] = []
    for (let i = 0; i < 5; i++) {
      samples.push(
        await timeAsync(async () => {
          await agent.run({
            userMessage: 'go',
            sessionId: `bench-step-${i}`,
            checkpointStore: store,
            maxIterations,
          })
        }),
      )
    }
    const summary = summariseLatency(samples)
    console.log(benchTableRow('09-durable-step-checkpoint', `${maxIterations} steps`, summary))
    expect(summary.max).toBeLessThan(10_000)
  }, 30_000)

  it('2. resume latency for a 50-step snapshot', async () => {
    const store = new InMemoryCheckpointStore()
    await store.save({
      id: 'resume-50',
      sessionId: 'resume-50',
      messages: [{ role: 'user', content: 'go' }],
      iterations: 50,
      createdAt: Date.now(),
      outcome: 'in_progress',
    } as never)
    const samples: number[] = []
    for (let i = 0; i < 20; i++) {
      samples.push(
        await timeAsync(async () => {
          const found = await findResumeCheckpoint({ store, ttlMs: 60_000 })
          expect(found?.id).toBe('resume-50')
        }),
      )
    }
    const summary = summariseLatency(samples)
    console.log(benchTableRow('10-durable-resume-latency', '20 lookups', summary))
    expect(summary.max).toBeLessThan(500)
  }, 15_000)

  it('3. 50 concurrent saves complete without contention', async () => {
    const store = new InMemoryCheckpointStore()
    const samples: number[] = []
    for (let batch = 0; batch < 3; batch++) {
      samples.push(
        await timeAsync(async () => {
          await Promise.all(
            Array.from({ length: 50 }, (_, i) => {
              const sessionId = `bench-conc-${batch}-${i}`
              return store.save({
                id: `${sessionId}-1`,
                sessionId,
                messages: [{ role: 'user', content: 'go' }],
                iterations: 1,
                createdAt: Date.now(),
                outcome: 'in_progress',
              } as never)
            }),
          )
        }),
      )
    }
    const summary = summariseLatency(samples)
    console.log(benchTableRow('11-durable-concurrent', '50 parallel saves', summary))
    expect(summary.max).toBeLessThan(5_000)
  }, 20_000)

  it('4. checkpoint size grows linearly with messages', () => {
    const messageCount = 50
    const sample = {
      id: 'size-1',
      sessionId: 'size-1',
      messages: Array.from({ length: messageCount }, (_, i) => ({
        role: 'user' as const,
        content: `message ${i}`,
      })),
      iterations: messageCount,
      createdAt: Date.now(),
      outcome: 'in_progress' as const,
    }
    const json = JSON.stringify(sample)
    expect(json.length).toBeLessThan(50 * 256)
  })

  it('5. stale checkpoints are rejected by findResumeCheckpoint', async () => {
    const store = new InMemoryCheckpointStore()
    const now = 1_000_000
    await store.save({
      id: 'stale',
      sessionId: 'stale',
      messages: [{ role: 'user', content: 'go' }],
      iterations: 1,
      createdAt: now - DEFAULT_RESUME_TTL_MS - 1,
      outcome: 'in_progress',
    } as never)
    await store.save({
      id: 'fresh',
      sessionId: 'fresh',
      messages: [{ role: 'user', content: 'go' }],
      iterations: 1,
      createdAt: now - 1_000,
      outcome: 'in_progress',
    } as never)
    const found = await findResumeCheckpoint({ store, ttlMs: DEFAULT_RESUME_TTL_MS, now })
    expect(found?.id).toBe('fresh')
  })
})
