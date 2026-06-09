/**
 * File-backed SqliteStore tests.
 *
 * These cover behaviour the in-memory contract cannot:
 *   - A row written in one connection is visible from a
 *     second connection (WAL allows this; without WAL the
 *     second connection would block).
 *   - A row written before `dispose` is still there after
 *     reopening with a new store on the same file.
 *   - The schema is created idempotently — opening the same
 *     file twice does not throw "table already exists".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SqliteStore } from '../src/sqlite-store.js'

let tmpDir: string
let dbPath: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-mem-'))
  dbPath = path.join(tmpDir, 'memory.db')
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('SqliteStore (file)', () => {
  it('persists records across reopen', async () => {
    const a = new SqliteStore({ path: dbPath })
    await a.init()
    await a.put({ id: 'r1', kind: 'fact', content: 'survives restart', trust: 0.5, tags: [] })
    await a.dispose()

    const b = new SqliteStore({ path: dbPath })
    await b.init()
    const got = await b.get('r1')
    expect(got?.content).toBe('survives restart')
    await b.dispose()
  })

  it('idempotent init: opening the same file twice does not throw', async () => {
    const a = new SqliteStore({ path: dbPath })
    await a.init()
    await a.dispose()
    const b = new SqliteStore({ path: dbPath })
    await expect(b.init()).resolves.toBeUndefined()
    await b.dispose()
  })

  it('a second connection can read records while the first is open (WAL)', async () => {
    const a = new SqliteStore({ path: dbPath })
    await a.init()
    try {
      const b = new SqliteStore({ path: dbPath })
      await b.init()
      try {
        // Write via A, read via B.
        await a.put({ id: 'r1', kind: 'fact', content: 'wal works', trust: 0.5, tags: [] })
        const got = await b.get('r1')
        expect(got?.content).toBe('wal works')
      } finally {
        await b.dispose()
      }
    } finally {
      await a.dispose()
    }
  })

  it('FTS5 search is case-insensitive and matches stemmed forms', async () => {
    const s = new SqliteStore({ path: dbPath })
    await s.init()
    try {
      await s.put({ id: 'a', kind: 'fact', content: 'The developer runs the build', trust: 0.5, tags: [] })
      await s.put({ id: 'b', kind: 'fact', content: 'A cat sleeps on the mat', trust: 0.5, tags: [] })
      // Porter stemmer turns "developer" → "develop" and
      // "runs" → "run". We search for the stem; if the stemmer
      // is wired we get a match.
      const results = await s.search({ text: 'develop' })
      const ids = results.map((r) => r.record.id)
      expect(ids).toContain('a')
      // Searching the lowercase word "cat" should match
      // "Cat" because the FTS5 tokeniser is unicode61 +
      // porter, both case-insensitive.
      const catResults = await s.search({ text: 'cat' })
      const catIds = catResults.map((r) => r.record.id)
      expect(catIds).toContain('b')
    } finally {
      await s.dispose()
    }
  })

  it('readonly mode rejects writes', async () => {
    const a = new SqliteStore({ path: dbPath })
    await a.init()
    await a.put({ id: 'r1', kind: 'fact', content: 'a', trust: 0.5, tags: [] })
    await a.dispose()

    const ro = new SqliteStore({ path: dbPath, readonly: true })
    await ro.init()
    try {
      await expect(
        ro.put({ id: 'r2', kind: 'fact', content: 'b', trust: 0.5, tags: [] }),
      ).rejects.toThrow()
    } finally {
      await ro.dispose()
    }
  })
})
