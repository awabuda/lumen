/**
 * Tests for {@link PatchTool}.
 *
 * Covers: normal single replacement, missing oldString, ambiguous match
 * (multiple occurrences with replaceAll=false), replaceAll=true,
 * fuzzy whitespace matching, and atomic write behavior (no .tmp
 * left behind).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { PatchTool } from '../src/fs/patch.js'
import type { ToolContext } from '@lumen/core'

let tmpDir: string
let ctx: ToolContext

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-tools-patch-'))
  ctx = { cwd: tmpDir, signal: new AbortController().signal, sessionId: 'test' }
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('PatchTool', () => {
  it('replaces a unique occurrence and reports the count', async () => {
    const file = path.join(tmpDir, 'a.txt')
    await fs.writeFile(file, 'hello world\n', 'utf8')
    const tool = new PatchTool()
    const result = (await tool.call(
      { path: 'a.txt', oldString: 'world', newString: 'lumen' },
      ctx,
    )) as { replacements: number; path: string }
    expect(result.replacements).toBe(1)
    expect(await fs.readFile(file, 'utf8')).toBe('hello lumen\n')
  })

  it('throws when oldString is not present', async () => {
    const file = path.join(tmpDir, 'b.txt')
    await fs.writeFile(file, 'hello\n', 'utf8')
    const tool = new PatchTool()
    await expect(
      tool.call({ path: 'b.txt', oldString: 'absent', newString: 'X' }, ctx),
    ).rejects.toThrow(/not found/i)
  })

  it('throws when oldString appears multiple times and replaceAll=false', async () => {
    const file = path.join(tmpDir, 'c.txt')
    await fs.writeFile(file, 'foo bar foo\n', 'utf8')
    const tool = new PatchTool()
    await expect(
      tool.call({ path: 'c.txt', oldString: 'foo', newString: 'baz' }, ctx),
    ).rejects.toThrow(/replaceAll=false/)
    // File must not be modified.
    expect(await fs.readFile(file, 'utf8')).toBe('foo bar foo\n')
  })

  it('replaces all occurrences when replaceAll=true', async () => {
    const file = path.join(tmpDir, 'd.txt')
    await fs.writeFile(file, 'foo bar foo\n', 'utf8')
    const tool = new PatchTool()
    const result = (await tool.call(
      { path: 'd.txt', oldString: 'foo', newString: 'baz', replaceAll: true },
      ctx,
    )) as { replacements: number }
    expect(result.replacements).toBe(2)
    expect(await fs.readFile(file, 'utf8')).toBe('baz bar baz\n')
  })

  it('falls back to fuzzy whitespace matching when exact match fails', async () => {
    const file = path.join(tmpDir, 'e.txt')
    // The file uses 2-space indent; the caller's oldString uses tabs.
    // Whitespace-only differences should be tolerated.
    await fs.writeFile(file, 'if (x) {\n  doSomething(x)\n}\n', 'utf8')
    const tool = new PatchTool()
    const result = (await tool.call(
      {
        path: 'e.txt',
        oldString: 'if (x) {\n\tdoSomething(x)\n}',
        newString: 'if (x) {\n  doSomething(x!)\n}',
      },
      ctx,
    )) as { replacements: number }
    expect(result.replacements).toBe(1)
    const onDisk = await fs.readFile(file, 'utf8')
    expect(onDisk).toBe('if (x) {\n  doSomething(x!)\n}\n')
  })

  it('performs the write atomically (no .tmp leftover)', async () => {
    const file = path.join(tmpDir, 'f.txt')
    await fs.writeFile(file, 'one\n', 'utf8')
    const tool = new PatchTool()
    await tool.call({ path: 'f.txt', oldString: 'one', newString: 'two' }, ctx)
    await expect(fs.stat(`${file}.tmp`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readFile(file, 'utf8')).toBe('two\n')
  })
})
