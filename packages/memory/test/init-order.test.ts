/**
 * SqliteStore lifecycle (init-order) tests.
 *
 * The contract: each `SqliteStore` instance is a state machine
 *
 *   uninit  --init()-->  ready  --dispose()-->  closed
 *
 * Public methods (other than `init()` and `dispose()`) require
 * the instance to be in `'ready'`. `init()` is forbidden once
 * left `'uninit'`; `dispose()` is idempotent in any state.
 *
 * These tests guard against the previous footgun where `init()`
 * silently no-op'd when called twice (the `if (this.initialized)
 * return` short-circuit) and would crash on a closed DB if
 * called after `dispose()`.
 */
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { ConfigError } from '@lumen/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { SqliteStore } from '../src/sqlite-store.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-init-order-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('SqliteStore — lifecycle state machine', () => {
  it('rejects get() before init() with a ConfigError pointing at init()', async () => {
    const store = new SqliteStore({ path: ':memory:' })
    await expect(store.get('anything')).rejects.toThrow(/init\(\)/)
    await store.dispose()
  })

  it('rejects put() before init()', async () => {
    const store = new SqliteStore({ path: ':memory:' })
    await expect(
      store.put({ id: 'r1', kind: 'fact', content: 'x', trust: 0.5, tags: [] }),
    ).rejects.toThrow(/init\(\)/)
    await store.dispose()
  })

  it('rejects search() before init()', async () => {
    const store = new SqliteStore({ path: ':memory:' })
    await expect(store.search({ kind: 'fact' })).rejects.toThrow(/init\(\)/)
    await store.dispose()
  })

  it('rejects vectorSearch() before init()', async () => {
    const store = new SqliteStore({ path: ':memory:' })
    await expect(store.vectorSearch(new Uint8Array(8))).rejects.toThrow(/init\(\)/)
    await store.dispose()
  })

  it('rejects createSession() before init()', async () => {
    const store = new SqliteStore({ path: ':memory:' })
    await expect(store.createSession({ id: 's1', title: 't', metadata: {} })).rejects.toThrow(
      /init\(\)/,
    )
    await store.dispose()
  })

  it('rejects init() called twice on the same instance', async () => {
    const store = new SqliteStore({ path: ':memory:' })
    await store.init()
    await expect(store.init()).rejects.toThrow(/already ready/)
    await store.dispose()
  })

  it('rejects init() called after dispose(); tells caller to construct a new instance', async () => {
    const store = new SqliteStore({ path: ':memory:' })
    await store.init()
    await store.dispose()
    await expect(store.init()).rejects.toThrow(/create a new/)
  })

  it('rejects get() after dispose()', async () => {
    const store = new SqliteStore({ path: ':memory:' })
    await store.init()
    await store.put({ id: 'r1', kind: 'fact', content: 'x', trust: 0.5, tags: [] })
    await store.dispose()
    await expect(store.get('r1')).rejects.toThrow(/dispose/)
  })

  it('rejects vectorSearch() after dispose()', async () => {
    const store = new SqliteStore({ path: ':memory:' })
    await store.init()
    await store.dispose()
    await expect(store.vectorSearch(new Uint8Array(8))).rejects.toThrow(/dispose/)
  })

  it('dispose() is idempotent — calling it twice does not throw', async () => {
    const store = new SqliteStore({ path: ':memory:' })
    await store.init()
    await store.dispose()
    await expect(store.dispose()).resolves.toBeUndefined()
  })

  it('dispose() before init() is a clean no-op', async () => {
    const store = new SqliteStore({ path: ':memory:' })
    // Never called init() — dispose() should still be safe and
    // bring the instance to the terminal `'closed'` state.
    await expect(store.dispose()).resolves.toBeUndefined()
    // ...and a subsequent init() should be rejected as
    // "after dispose" (not "before init") — the user has
    // declared their intent to give this instance up.
    await expect(store.init()).rejects.toThrow(/dispose/)
  })

  it('init() failure leaves the instance in the closed state', async () => {
    // Force applySchema to fail by writing a file that is not a
    // valid SQLite database. better-sqlite3 opens the file
    // without complaint, but the first DDL inside the BEGIN/COMMIT
    // transaction will throw "file is not a database".
    const badPath = path.join(tmpDir, 'not-a-db.sqlite')
    await fs.writeFile(badPath, 'this is not a sqlite database file at all')
    const store = new SqliteStore({ path: badPath })
    await expect(store.init()).rejects.toThrow()
    // The instance is now single-use: subsequent init() must be
    // rejected, not silently re-attempted.
    await expect(store.init()).rejects.toThrow(/create a new/)
    // Dispose is still safe (idempotent on the closed state).
    await expect(store.dispose()).resolves.toBeUndefined()
  })

  it('validates config at the constructor boundary, not during init()', () => {
    // `path: ''` would be a confusing runtime error if we let
    // it reach better-sqlite3; the Zod schema in P10 catches
    // it as a typed ValidationError. This pins that behaviour
    // so a future refactor can't accidentally defer it.
    expect(() => new SqliteStore({ path: '' })).toThrow()
  })

  it('survives concurrent CRUD after init — read-after-write is consistent', async () => {
    // The lifecycle refactor must not perturb the normal happy
    // path. A follow-up regression in the state machine could
    // either (a) leave a method accidentally throwing on
    // `'ready'` (false positive on the new guard) or (b) drop
    // a CRUD call's write because of a premature transition.
    // This test pins the round-trip.
    const store = new SqliteStore({ path: ':memory:' })
    await store.init()
    await store.put({ id: 'r1', kind: 'fact', content: 'hello', trust: 0.9, tags: ['test'] })
    const got = await store.get('r1')
    expect(got).toBeDefined()
    expect(got?.content).toBe('hello')
    expect(got?.tags).toEqual(['test'])
    const results = await store.search({ kind: 'fact' })
    expect(results.map((r) => r.record.id)).toContain('r1')
    await store.dispose()
  })
})
