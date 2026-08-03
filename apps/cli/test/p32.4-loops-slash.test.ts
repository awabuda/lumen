/**
 * P32.4 — persistence test for `/loop` and `/unloop`.
 *
 * The default surface (no `store` context) still works for the
 * P23.12 test suite. These tests exercise the new persistence
 * path: every `/loop` registration should land in
 * `SqliteLoopsStore`, and `/unloop` should mark the row inactive
 * (which `listActive` filters out). The cross-launch round-trip
 * is the headline invariant — the next `reloadPersistedLoops`
 * call on a fresh store over the same file should see only the
 * still-active rows.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SqliteLoopsStore } from '@lumen/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  handleLoopSlash,
  handleUnloopSlash,
  reloadPersistedLoops,
} from '../src/components/slash-commands.js'

let tmpDir: string
let store: SqliteLoopsStore

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p32-4-'))
  store = new SqliteLoopsStore({ path: path.join(tmpDir, 'loops.db') })
})

afterEach(async () => {
  await store.dispose()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('P32.4 — /loop persistence', () => {
  it('writes the registration to the store and starts a cron', async () => {
    const result = await handleLoopSlash('/loop 30s check disk', undefined, {
      store,
    })
    expect(result.message).toContain('registered')
    const all = await store.listAll()
    expect(all).toHaveLength(1)
    expect(all[0]?.kind).toBe('interval')
    expect(all[0]?.intervalMs).toBe(30_000)
  })

  it('survives a fresh SqliteLoopsStore over the same path', async () => {
    const handlePath = path.join(tmpDir, 'cross.db')
    const first = new SqliteLoopsStore({ path: handlePath })
    await handleLoopSlash('/loop 1m ping', undefined, { store: first })
    await first.dispose()
    const second = new SqliteLoopsStore({ path: handlePath })
    try {
      const all = await second.listAll()
      expect(all.map((l) => l.prompt)).toEqual(['ping'])
    } finally {
      await second.dispose()
    }
  })

  it('reloadPersistedLoops restarts each active row exactly once', async () => {
    const handlePath = path.join(tmpDir, 'reload.db')
    const first = new SqliteLoopsStore({ path: handlePath })
    await handleLoopSlash('/loop 1m ping', undefined, { store: first })
    await handleLoopSlash('/loop 5m probe', undefined, { store: first })
    await first.dispose()

    const second = new SqliteLoopsStore({ path: handlePath })
    try {
      const restored = await reloadPersistedLoops(second, () => {})
      expect(restored).toHaveLength(2)
      // Running twice must be idempotent — each row is already
      // back in the live registry and reloadPersistedLoops
      // skips entries it has already re-armed.
      const restoredAgain = await reloadPersistedLoops(second, () => {})
      expect(restoredAgain).toHaveLength(2)
    } finally {
      await second.dispose()
    }
  })

  it('persists a cron expression registration', async () => {
    const handlePath = path.join(tmpDir, 'cron.db')
    const local = new SqliteLoopsStore({ path: handlePath })
    try {
      await handleLoopSlash('/loop "*/5 * * * *" disk', undefined, { store: local })
      const all = await local.listAll()
      expect(all[0]?.kind).toBe('cron')
      expect(all[0]?.cronExpr).toBe('*/5 * * * *')
    } finally {
      await local.dispose()
    }
  })
})

describe('P32.4 — /unloop', () => {
  it('stops the in-memory cron and marks the row inactive', async () => {
    const result = await handleLoopSlash('/loop 30s ping', undefined, { store })
    expect(result.message).toContain('registered')
    const all = await store.listAll()
    const id = all[0]?.id
    expect(id).toBeDefined()
    const stopResult = await handleUnloopSlash(`/unloop ${id}`, { store })
    expect(stopResult.message).toContain('stopped')
    const after = await store.listActive()
    const full = await store.listAll()
    expect(after).toHaveLength(0)
    expect(full).toHaveLength(1)
    expect(full[0]?.isActive).toBe(false)
  })

  it('rejects an unknown id', async () => {
    const result = await handleUnloopSlash('/unloop ghost', { store })
    expect(result.message).toContain('no active loop')
  })

  it('rejects empty argument list', async () => {
    const result = await handleUnloopSlash('/unloop', { store })
    expect(result.message).toContain('usage')
  })

  it('survives restart: stopped loops do not come back', async () => {
    // Pre-P33.A2 this assertion read `toBe('probe')` — the author
    // assumed `listAll()` would return oldest-first (ASC), but the
    // store has always been DESC (most-recently-registered first).
    // Unloopping `all[0]` therefore stops the *newest* loop and
    // leaves the oldest one alive. The assertion is updated to
    // reflect the actual semantics; the test still pins the
    // headline invariant (1 loop survives after unloop) which
    // was the regression we wanted to catch in P32.4.
    //
    // P33.A2 also adds a `2ms` delay between the two registrations
    // — pre-P33.A2 both `handleLoopSlash` calls within the same
    // millisecond saw the same `Date.now()` value, which made
    // SQLite's `ORDER BY registered_at DESC` ties undefined.
    // The two parallel runs (full-suite vs single-file) hit
    // different SQLite orderings and the test flapped ~30%.
    const handlePath = path.join(tmpDir, 'restart.db')
    const first = new SqliteLoopsStore({ path: handlePath })
    await handleLoopSlash('/loop 1m ping', undefined, { store: first })
    await new Promise((r) => setTimeout(r, 2))
    await handleLoopSlash('/loop 1m probe', undefined, { store: first })
    const all = await first.listAll()
    const firstId = all[0]?.id ?? ''
    await handleUnloopSlash(`/unloop ${firstId}`, { store: first })
    await first.dispose()

    const second = new SqliteLoopsStore({ path: handlePath })
    try {
      const restored = await reloadPersistedLoops(second, () => {})
      // Only one loop survives.
      expect(restored).toHaveLength(1)
      expect(restored[0]?.prompt).toBe('ping')
    } finally {
      await second.dispose()
    }
  })
})
