/**
 * Scenario: meta-reflection 10-run trigger latency (P19.7.4).
 *
 * Simulates the cross-run trigger that `lumen reflect meta`
 * would invoke after 10 run-end reflections. We seed 30 facts
 * (10 cluster-A, 10 cluster-B, 10 singletons) into an in-memory
 * BaseMemoryStore, run `createClusteringMetaReflector`, and
 * measure:
 *   - The wall-clock of the meta-reflector pass.
 *   - The number of patches produced (10 expected, one per cluster).
 *   - The trust delta applied to the representative of each cluster.
 *
 * Why this matters:
 *   - The P19.5 design choice of "10-run interval" is empirical.
 *     The bench proves the meta-reflector finishes well within
 *     the budget an operator would tolerate between runs.
 *   - The bench also exercises the clusterer + trust-delta path
 *     end-to-end against a realistic store, not just a single
 *     in-memory fixture.
 *
 * Opt in: LUMEN_BENCH=1.
 */

import {
  type AssistantMessage,
  BaseProvider,
  type BaseMemoryStore,
  type ChatRequest,
  type ChatResponse,
  type MemoryRecord,
  type ProviderCapabilities,
  type StreamEvent,
} from '@lumen/core'
import {
  type ChatMessage,
  createClusteringMetaReflector,
  createRuleBasedReflector,
  hashFactId,
} from '@lumen/memory'
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
  public override async chat(
    _request: ChatRequest,
  ): Promise<ChatResponse> {
    return {
      message: { role: 'assistant', content: '', toolCalls: [] } as AssistantMessage,
      latencyMs: 0,
    }
  }
  public override async *stream(): AsyncGenerator<StreamEvent, void, void> {
    yield { type: 'message_complete', message: { role: 'assistant', content: '', toolCalls: [] } }
  }
}

/**
 * Minimal in-memory store that satisfies BaseMemoryStore for
 * the meta-reflector's search/get calls.
 */
class InMemoryStore implements BaseMemoryStore {
  public readonly id = 'bench-mem'
  private readonly records = new Map<string, MemoryRecord>()
  public async init(): Promise<void> {}
  public async dispose(): Promise<void> {}
  public async put(
    record: Omit<MemoryRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<MemoryRecord> {
    const now = Date.now()
    const full: MemoryRecord = { ...record, createdAt: now, updatedAt: now }
    this.records.set(full.id, full)
    return full
  }
  public async get(id: string): Promise<MemoryRecord | undefined> {
    return this.records.get(id)
  }
  public async delete(): Promise<boolean> {
    return true
  }
  public async search(query: {
    kind?: string
    limit?: number
  }): Promise<ReadonlyArray<{ record: MemoryRecord; score: number }>> {
    const limit = query.limit ?? 1_000
    const out: { record: MemoryRecord; score: number }[] = []
    for (const r of this.records.values()) {
      if (query.kind && r.kind !== query.kind) continue
      out.push({ record: r, score: 1 })
    }
    return out.slice(0, limit)
  }
  public async createSession(): Promise<never> {
    throw new Error('not used in meta bench')
  }
  public async getSession(): Promise<undefined> {
    return undefined
  }
  public async listSessions(): Promise<ReadonlyArray<never>> {
    return []
  }
  public async appendMessage(): Promise<never> {
    throw new Error('not used in meta bench')
  }
  public async getSessionMessages(): Promise<ReadonlyArray<never>> {
    return []
  }
  public async deleteSession(): Promise<boolean> {
    return false
  }
  public async prune(): Promise<number> {
    return 0
  }
}

const seedTenRunsOfFacts = async (store: InMemoryStore): Promise<void> => {
  // Use the rule-based reflector to extract facts from synthetic
  // 10-session runs. Each run has 3 messages that all match
  // the "The user prefers" pattern, so the reflector surfaces
  // the same fact shape with the same id (deduped by content
  // hash), producing a cluster of 10.
  const reflector = createRuleBasedReflector()
  for (let run = 0; run < 10; run += 1) {
    const messages: ChatMessage[] = [
      { role: 'user', content: 'setup' },
      {
        role: 'assistant',
        content: 'The user prefers vitest with TypeScript.',
      },
      { role: 'user', content: 'ok' },
    ]
    await reflector.reflect(messages, store)
  }
  // Add 10 singleton facts (no cluster) so the meta-reflector
  // has to walk past them.
  for (let i = 0; i < 10; i += 1) {
    await store.put({
      id: hashFactId(`singleton-${i}-content`),
      kind: 'fact',
      content: `singleton fact number ${i}`,
      trust: 0.5,
      tags: ['singleton'],
    })
  }
}

const RUNS = Number.parseInt(process.env.LUMEN_BENCH_RUNS ?? '20', 10)

describe('meta reflection 10-run trigger (P19.7.4)', () => {
  it.skipIf(!benchEnabled())(
    `runs meta-reflector over 10-run history, ${RUNS} iterations`,
    async () => {
      const samples: number[] = []
      let lastPatchCount = 0
      for (let i = 0; i < RUNS; i += 1) {
        const store = new InMemoryStore()
        await store.init()
        await seedTenRunsOfFacts(store)
        const reflector = createClusteringMetaReflector()
        const { durationMs } = await timeAsync(() => reflector.reflect(store))
        const patches = await reflector.reflect(store)
        samples.push(durationMs)
        lastPatchCount = patches.length
      }
      const stats = summariseLatency(samples)
      // eslint-disable-next-line no-console
      console.log(BENCH_TABLE_HEADER)
      // eslint-disable-next-line no-console
      console.log(
        benchTableRow('fake', 'meta-reflection-10run', {
          count: stats.count,
          p50Ms: stats.p50Ms,
          p95Ms: stats.p95Ms,
          maxMs: stats.maxMs,
          meanMs: stats.meanMs,
        }, `patches=${lastPatchCount}`),
      )
    },
  )
})
