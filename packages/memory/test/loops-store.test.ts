/**
 * P32.4 — unit tests for `SqliteLoopsStore`.
 *
 * The store is the durable backend for `/loop` registrations. The
 * pre-P32.4 failure mode was: registering a loop, closing the TUI,
 * relaunching — every registration was gone because live cron
 * state lived in module-scoped Maps. These tests pin the new
 * invariant: a loop row survives a fresh `SqliteLoopsStore` over
 * the same path, and `stop(id)` flips `isActive` to false while
 * the row stays visible via `listAll()` for history.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { PersistedLoop } from '@lumen/memory'
import { SqliteLoopsStore } from '@lumen/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let tmpDir: string
let dbPath: string
let store: SqliteLoopsStore

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-loops-test-'))
  dbPath = path.join(tmpDir, 'loops.db')
  store = new SqliteLoopsStore({ path: dbPath })
})

afterEach(async () => {
  await store.dispose()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const cp = (overrides: Partial<PersistedLoop> = {}): PersistedLoop => ({
  id: 'loop-1',
  kind: 'interval',
  intervalMs: 60_000,
  prompt: 'ping',
  registeredAt: Date.now(),
  isActive: true,
  ...overrides,
})

describe('SqliteLoopsStore.save', () => {
  it('persists and lists one loop', async () => {
    await store.save(cp())
    const all = await store.listAll()
    expect(all).toHaveLength(1)
    expect(all[0]?.id).toBe('loop-1')
    expect(all[0]?.kind).toBe('interval')
    expect(all[0]?.intervalMs).toBe(60_000)
  })

  it('survives a fresh store over the same path (cross-process round-trip)', async () => {
    await store.save(cp({ id: 'cross-1', intervalMs: 30_000 }))
    await store.dispose()
    const reopened = new SqliteLoopsStore({ path: dbPath })
    try {
      const all = await reopened.listAll()
      expect(all.map((l) => l.id)).toEqual(['cross-1'])
    } finally {
      await reopened.dispose()
    }
  })

  it('upserts on id conflict (re-saving the same id updates fields)', async () => {
    await store.save(cp({ id: 'upsert', intervalMs: 60_000 }))
    await store.save(cp({ id: 'upsert', intervalMs: 30_000, prompt: 'newer' }))
    const all = await store.listAll()
    expect(all).toHaveLength(1)
    expect(all[0]?.intervalMs).toBe(30_000)
    expect(all[0]?.prompt).toBe('newer')
  })

  it('creates the parent directory when nested under a fresh dir', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'c', 'loops.db')
    const local = new SqliteLoopsStore({ path: nested })
    try {
      await local.save(cp({ id: 'nested-1' }))
      const stat = await fs.stat(nested)
      expect(stat.isFile()).toBe(true)
    } finally {
      await local.dispose()
    }
  })
})

describe('SqliteLoopsStore.stop', () => {
  it('marks the loop inactive but leaves the row in listAll', async () => {
    await store.save(cp({ id: 'to-stop' }))
    const updated = await store.stop('to-stop')
    expect(updated).toBe(true)
    const active = await store.listActive()
    const all = await store.listAll()
    expect(active.map((l) => l.id)).toEqual([])
    expect(all.map((l) => l.id)).toEqual(['to-stop'])
    expect(all[0]?.isActive).toBe(false)
  })

  it('returns false when the id has no row', async () => {
    expect(await store.stop('nope')).toBe(false)
  })
})

describe('SqliteLoopsStore.recordTick', () => {
  it('updates last_tick_at for one loop', async () => {
    await store.save(cp({ id: 'tick-1' }))
    const t0 = 1_700_000_000_000
    await store.recordTick('tick-1', t0)
    const all = await store.listAll()
    expect(all[0]?.lastTickAt).toBe(t0)
  })

  it('defaults recordTick to Date.now()', async () => {
    await store.save(cp({ id: 'tick-2' }))
    const before = Date.now()
    await store.recordTick('tick-2')
    const after = Date.now()
    const all = await store.listAll()
    const ts = all[0]?.lastTickAt
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after)
  })
})

describe('SqliteLoopsStore.listActive', () => {
  it('returns only rows without stopped_at, newest first', async () => {
    await store.save(cp({ id: 'a', registeredAt: 1_000 }))
    await store.save(cp({ id: 'b', registeredAt: 2_000 }))
    await store.save(cp({ id: 'c', registeredAt: 3_000 }))
    await store.stop('a')
    const active = await store.listActive()
    expect(active.map((l) => l.id)).toEqual(['c', 'b'])
  })
})

describe('SqliteLoopsStore — kind= cron', () => {
  it('round-trips cron_expr and leaves interval_ms null', async () => {
    await store.save(
      cp({
        id: 'cron-1',
        kind: 'cron',
        cronExpr: '*/5 * * * *',
        intervalMs: undefined,
      }),
    )
    const all = await store.listAll()
    expect(all[0]?.kind).toBe('cron')
    expect(all[0]?.cronExpr).toBe('*/5 * * * *')
    expect(all[0]?.intervalMs).toBeUndefined()
  })
})
