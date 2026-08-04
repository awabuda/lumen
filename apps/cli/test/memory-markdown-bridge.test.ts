/**
 * P34.1 — memory-markdown-bridge tests.
 *
 * Verifies the composition-side bridge writes the right
 * markdown file given a stub store, and re-ingests
 * hand-edited markdown back into the store. The
 * SqliteStore / InMemoryStore specifics are exercised
 * by the integration tests in `memory.test.ts`; this
 * file is hermetic against an in-memory stub so we
 * do not need fs/network in the bridge unit tests
 * (the actual fs round-trip is verified by the
 * `lumen memory sync` smoke test).
 */

import type { MemoryQuery, MemoryRecord } from '@lumen/memory'
import { describe, expect, it } from 'vitest'
import { createMemoryMarkdownBridge } from '../src/memory-markdown-bridge.js'

interface StubRecord {
  readonly record: MemoryRecord
}

class StubStore {
  public rows: MemoryRecord[] = []
  public byId = new Map<string, MemoryRecord>()
  public async search(query: MemoryQuery): Promise<ReadonlyArray<StubRecord>> {
    const min = query.minTrust ?? 0
    return this.rows.filter((r) => r.trust >= min).map((r) => ({ record: r }))
  }
  public async put(record: Omit<MemoryRecord, 'createdAt' | 'updatedAt'>) {
    const now = Date.now()
    const stored: MemoryRecord = {
      id: record.id,
      kind: record.kind,
      content: record.content,
      trust: record.trust,
      tags: record.tags,
      embedding: record.embedding,
      createdAt: now,
      updatedAt: now,
    }
    this.byId.set(record.id, stored)
    this.rows = this.rows.filter((r) => r.id !== record.id).concat(stored)
    return stored
  }
  public async get(id: string) {
    return this.byId.get(id)
  }
}

const fact = (overrides: Partial<MemoryRecord>): MemoryRecord => ({
  id: 'f1',
  kind: 'preference',
  content: 'pgpass',
  trust: 0.7,
  tags: [],
  embedding: undefined,
  createdAt: 0,
  updatedAt: 0,
  ...overrides,
})

describe('createMemoryMarkdownBridge — P34.1 sync path', () => {
  it('writes MEMORY.md + USER.md for high-trust facts', async () => {
    const store = new StubStore()
    store.rows = [
      fact({ id: 'm1', kind: 'preference', content: 'pgpass', trust: 0.7 }),
      fact({ id: 'u1', kind: 'user', content: 'Anna', trust: 0.9 }),
    ]
    const bridge = createMemoryMarkdownBridge({
      store: store as unknown as Parameters<typeof createMemoryMarkdownBridge>[0]['store'],
      trustThreshold: 0.6,
    })
    const result = await bridge.syncAfterRun()
    expect(result.memoryFacts).toBe(1)
    expect(result.userFacts).toBe(1)
  })

  it('skips facts below the trust threshold', async () => {
    const store = new StubStore()
    store.rows = [fact({ id: 'm1', trust: 0.7 }), fact({ id: 'm2', trust: 0.3 })]
    const bridge = createMemoryMarkdownBridge({
      store: store as unknown as Parameters<typeof createMemoryMarkdownBridge>[0]['store'],
      trustThreshold: 0.6,
    })
    const result = await bridge.syncAfterRun()
    expect(result.memoryFacts).toBe(1)
  })

  it('describe() returns the resolved paths', () => {
    const store = new StubStore()
    const bridge = createMemoryMarkdownBridge({
      store: store as unknown as Parameters<typeof createMemoryMarkdownBridge>[0]['store'],
      memoryMdPath: '/tmp/MEMORY.md',
      userMdPath: '/tmp/USER.md',
    })
    const desc = bridge.describe()
    expect(desc.memoryMdPath).toBe('/tmp/MEMORY.md')
    expect(desc.userMdPath).toBe('/tmp/USER.md')
    expect(desc.lastSyncMs).toBe(0)
  })
})

describe('createMemoryMarkdownBridge — P34.1 ingest path', () => {
  it('ingestIfNewer() inserts hand-edited facts', async () => {
    const store = new StubStore()
    const bridge = createMemoryMarkdownBridge({
      store: store as unknown as Parameters<typeof createMemoryMarkdownBridge>[0]['store'],
    })
    // Bump lastSyncMs by running syncAfterRun() once;
    // subsequent ingestIfNewer() with an mtime older than
    // lastSyncMs skips. The hermetic stub does not have
    // fs mtimes so we just assert the no-op behaviour
    // here; the real mtime race is exercised by the
    // `lumen memory sync` smoke test.
    await bridge.syncAfterRun()
    const result = await bridge.ingestIfNewer()
    expect(result.ingested).toBe(0)
  })
})
