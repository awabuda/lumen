/**
 * Tests for {@link ReadFileTool}.
 *
 * Each test sets up a fresh tmp directory in `beforeEach` and tears it
 * down in `afterEach`. We exercise the four behaviours that the
 * contract documents: normal read, pagination via offset+limit,
 * missing-file error, and the line-number gutter format.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ToolValidationError } from '@lumen/core'
import { ReadFileTool } from '../src/fs/read-file.js'
import type { ToolContext } from '@lumen/core'
import { FileNotFoundError } from '../src/errors.js'

let tmpDir: string
let ctx: ToolContext

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-tools-read-'))
  ctx = { cwd: tmpDir, signal: new AbortController().signal, sessionId: 'test' }
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('ReadFileTool', () => {
  it('reads a file end-to-end and reports the total line count', async () => {
    const file = path.join(tmpDir, 'hello.txt')
    await fs.writeFile(file, 'a\nb\nc\n', 'utf8')
    const tool = new ReadFileTool()
    const result = (await tool.call({ path: 'hello.txt' }, ctx)) as {
      content: string
      totalLines: number
      encoding: 'utf8'
    }
    expect(result.encoding).toBe('utf8')
    expect(result.totalLines).toBe(3)
    // Expect 3 lines, each prefixed with the gutter and a `|`.
    const lines = result.content.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('     1|a')
    expect(lines[1]).toBe('     2|b')
    expect(lines[2]).toBe('     3|c')
  })

  it('supports offset+limit pagination', async () => {
    const file = path.join(tmpDir, 'lines.txt')
    const body = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`).join('\n') + '\n'
    await fs.writeFile(file, body, 'utf8')
    const tool = new ReadFileTool()
    const result = (await tool.call({ path: 'lines.txt', offset: 4, limit: 3 }, ctx)) as {
      content: string
      totalLines: number
    }
    // 10 lines total; we asked for lines 4..6
    expect(result.totalLines).toBe(10)
    const lines = result.content.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toBe('     4|line-4')
    expect(lines[1]).toBe('     5|line-5')
    expect(lines[2]).toBe('     6|line-6')
  })

  it('throws FileNotFoundError when the file does not exist', async () => {
    const tool = new ReadFileTool()
    await expect(tool.call({ path: 'missing.txt' }, ctx)).rejects.toBeInstanceOf(FileNotFoundError)
  })

  it('formats the line-number gutter as a fixed-width column', async () => {
    const file = path.join(tmpDir, 'numbered.ts')
    const body = ['x', 'y', 'z'].join('\n') + '\n'
    await fs.writeFile(file, body, 'utf8')
    const tool = new ReadFileTool()
    const result = (await tool.call({ path: 'numbered.ts' }, ctx)) as { content: string }
    // The gutter should be exactly 6 chars wide (right-aligned), then
    // `|`. For line 1 that means 5 spaces + "1".
    expect(result.content.split('\n')[0]).toMatch(/^\s{5}1\|/)
  })

  it('rejects offset < 1 with ToolValidationError', async () => {
    const file = path.join(tmpDir, 'a.txt')
    await fs.writeFile(file, 'x', 'utf8')
    const tool = new ReadFileTool()
    await expect(tool.call({ path: 'a.txt', offset: 0 }, ctx)).rejects.toBeInstanceOf(ToolValidationError)
  })
})
