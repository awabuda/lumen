/**
 * Tests for {@link ListDirTool}.
 *
 * Covers: non-recursive listing, recursive listing, maxDepth cap, and
 * classification of files vs directories in the entries.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ListDirTool } from '../src/fs/list-dir.js'
import type { ToolContext } from '@lumen/core'

let tmpDir: string
let ctx: ToolContext

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-tools-list-'))
  ctx = { cwd: tmpDir, signal: new AbortController().signal, sessionId: 'test' }
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('ListDirTool', () => {
  it('lists immediate children with type and size', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'hello', 'utf8')
    await fs.mkdir(path.join(tmpDir, 'sub'))
    const tool = new ListDirTool()
    const result = (await tool.call({ path: '.' }, ctx)) as {
      entries: Array<{ name: string; type: string; size?: number }>
    }
    const byName = new Map(result.entries.map((e) => [e.name, e]))
    expect(byName.get('a.txt')?.type).toBe('file')
    expect(byName.get('a.txt')?.size).toBe(5)
    expect(byName.get('sub')?.type).toBe('dir')
  })

  it('descends recursively when recursive=true', async () => {
    await fs.writeFile(path.join(tmpDir, 'top.txt'), 'x', 'utf8')
    await fs.mkdir(path.join(tmpDir, 'inner'))
    await fs.writeFile(path.join(tmpDir, 'inner', 'deep.txt'), 'y', 'utf8')
    const tool = new ListDirTool()
    const result = (await tool.call({ path: '.', recursive: true }, ctx)) as {
      entries: Array<{ name: string; type: string }>
    }
    const names = result.entries.map((e) => e.name).sort()
    expect(names).toContain('top.txt')
    expect(names).toContain(path.join('inner', 'deep.txt'))
    // inner itself should be a dir entry
    expect(result.entries.find((e) => e.name === 'inner')?.type).toBe('dir')
  })

  it('respects maxDepth and does not descend beyond it', async () => {
    // depth0 = root; depth1 = a; depth2 = a/b; depth3 = a/b/c
    await fs.mkdir(path.join(tmpDir, 'a', 'b', 'c'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'a', 'b', 'c', 'leaf.txt'), 'z', 'utf8')
    const tool = new ListDirTool()
    const result = (await tool.call(
      { path: '.', recursive: true, maxDepth: 2 },
      ctx,
    )) as { entries: Array<{ name: string; type: string }> }
    const names = result.entries.map((e) => e.name)
    expect(names).toContain('a')
    expect(names).toContain(path.join('a', 'b'))
    // depth 3 file and dir must NOT be listed
    expect(names).not.toContain(path.join('a', 'b', 'c'))
    expect(names).not.toContain(path.join('a', 'b', 'c', 'leaf.txt'))
  })

  it('returns an empty list for an empty directory', async () => {
    const tool = new ListDirTool()
    const result = (await tool.call({ path: '.' }, ctx)) as { entries: unknown[] }
    expect(result.entries).toEqual([])
  })

  it('throws PathKindError when the path is a file, not a directory', async () => {
    const file = path.join(tmpDir, 'not-a-dir.txt')
    await fs.writeFile(file, 'x', 'utf8')
    const tool = new ListDirTool()
    await expect(tool.call({ path: 'not-a-dir.txt' }, ctx)).rejects.toThrow(/not a dir/i)
  })
})
