/**
 * Tests for {@link WriteFileTool}.
 *
 * Covers the three behaviours the contract documents: normal write,
 * atomic mode (no `.tmp` left behind), and overwriting an existing
 * file. We also exercise a write that creates missing parent
 * directories.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { WriteFileTool } from '../src/fs/write-file.js'
import type { ToolContext } from '@lumen/core'

let tmpDir: string
let ctx: ToolContext

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-tools-write-'))
  ctx = { cwd: tmpDir, signal: new AbortController().signal, sessionId: 'test' }
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('WriteFileTool', () => {
  it('writes a new file and reports the byte count', async () => {
    const tool = new WriteFileTool()
    const result = (await tool.call(
      { path: 'a.txt', content: 'hello' },
      ctx,
    )) as { bytesWritten: number; path: string }
    expect(result.bytesWritten).toBe(5)
    expect(result.path).toBe(path.join(tmpDir, 'a.txt'))
    const onDisk = await fs.readFile(path.join(tmpDir, 'a.txt'), 'utf8')
    expect(onDisk).toBe('hello')
  })

  it('writes atomically and does not leave a .tmp file behind', async () => {
    const tool = new WriteFileTool()
    const target = path.join(tmpDir, 'atomic.txt')
    const result = (await tool.call(
      { path: 'atomic.txt', content: 'atomic-content', atomic: true },
      ctx,
    )) as { bytesWritten: number; path: string }
    expect(result.bytesWritten).toBe(14)
    // The final file should exist and have the right contents.
    expect(await fs.readFile(target, 'utf8')).toBe('atomic-content')
    // The .tmp should be cleaned up.
    await expect(fs.stat(`${target}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('overwrites an existing file', async () => {
    const target = path.join(tmpDir, 'over.txt')
    await fs.writeFile(target, 'old', 'utf8')
    const tool = new WriteFileTool()
    await tool.call({ path: 'over.txt', content: 'new' }, ctx)
    expect(await fs.readFile(target, 'utf8')).toBe('new')
  })

  it('creates missing parent directories', async () => {
    const tool = new WriteFileTool()
    await tool.call({ path: 'nested/dir/file.txt', content: 'x' }, ctx)
    const onDisk = await fs.readFile(path.join(tmpDir, 'nested/dir/file.txt'), 'utf8')
    expect(onDisk).toBe('x')
  })

  it('non-atomic mode writes the file directly', async () => {
    const tool = new WriteFileTool()
    await tool.call({ path: 'na.txt', content: 'plain', atomic: false }, ctx)
    expect(await fs.readFile(path.join(tmpDir, 'na.txt'), 'utf8')).toBe('plain')
  })
})
