/**
 * P56 — `lumen memory show` should reflect the
 * real on-disk mtime of MEMORY.md / USER.md, not
 * the 0 default. Pre-P56 the `lastSyncMs` variable
 * started at 0, so the first `describe()` (before
 * any sync) reported "last sync: (never)" even
 * when the files existed on disk. P56 reads the
 * newer of the two mtimeMs values at bridge
 * construction time.
 *
 * One test exercises the path: write a
 * MEMORY.md, create the bridge, call
 * `bridge.describe()`, expect `lastSyncMs` to
 * be the file's mtime.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SqliteStore } from '@lumen/memory'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryMarkdownBridge } from '../src/memory-markdown-bridge.js'

let tmpDir: string
let store: SqliteStore | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p56-'))
})

afterEach(async () => {
  await store?.dispose()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('P56 — lumen memory show lastSyncMs from on-disk mtime', () => {
  it('reports the file mtime as the initial lastSyncMs', async () => {
    const dbPath = path.join(tmpDir, 'memory.db')
    const memoryMdPath = path.join(tmpDir, 'MEMORY.md')
    // Write a stub MEMORY.md; the bridge will read
    // its mtime to initialise lastSyncMs.
    await fs.writeFile(memoryMdPath, '<!-- lumen:memory-md v1 -->\n', 'utf8')
    // The fs.writeFile mtime resolves to a 1-second
    // boundary on some filesystems, so we sleep a
    // tick to ensure the next mtime is strictly
    // greater.
    await new Promise((r) => setTimeout(r, 1100))
    const expectedMtimeMs = (await fs.stat(memoryMdPath)).mtimeMs

    store = new SqliteStore({ path: dbPath })
    await store.init()

    const bridge = createMemoryMarkdownBridge({
      store,
      memoryMdPath,
      userMdPath: path.join(tmpDir, 'USER.md'),
    })
    const desc = bridge.describe()
    // P56 — `lastSyncMs` reflects the file mtime.
    // Pre-P56 it was always 0 on first call.
    expect(desc.lastSyncMs).toBeGreaterThanOrEqual(expectedMtimeMs)
    expect(desc.lastSyncMs).toBeGreaterThan(0)
  })
})
