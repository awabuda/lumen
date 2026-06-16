/**
 * Tests for {@link SearchFilesTool}.
 *
 * These tests use the pure-Node fallback path because `rg` may not be
 * installed in CI; the result shape is the same either way. We also
 * force the fallback by stubbing `process.execPath` is not practical;
 * instead, we rely on the fact that ripgrep is best-effort and the
 * fallback is correct.
 *
 * Covers: matching lines, no-match case, glob filter, and regex
 * validation.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { SearchFilesTool } from '../src/fs/search-files.js'
import type { ToolContext } from '@lumen/core'

let tmpDir: string
let ctx: ToolContext

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-tools-search-'))
  ctx = { cwd: tmpDir, signal: new AbortController().signal, sessionId: 'test' }
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('SearchFilesTool', () => {
  it('finds matching lines with file, line, and content', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'first\nhit here\nlast\n', 'utf8')
    const tool = new SearchFilesTool()
    const result = (await tool.call({ pattern: 'hit', path: '.' }, ctx)) as {
      matches: Array<{ file: string; line: number; content: string }>
    }
    expect(result.matches).toHaveLength(1)
    const m = result.matches[0] as { file: string; line: number; content: string }
    expect(m.file).toBe(path.join(tmpDir, 'a.txt'))
    expect(m.line).toBe(2)
    expect(m.content).toBe('hit here')
  })

  it('returns an empty match list when nothing matches', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'abc\n', 'utf8')
    const tool = new SearchFilesTool()
    const result = (await tool.call({ pattern: 'nope', path: '.' }, ctx)) as { matches: unknown[] }
    expect(result.matches).toEqual([])
  })

  it('filters files by glob', async () => {
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'TARGET\n', 'utf8')
    await fs.writeFile(path.join(tmpDir, 'b.md'), 'TARGET\n', 'utf8')
    const tool = new SearchFilesTool()
    const result = (await tool.call({ pattern: 'TARGET', path: '.', glob: '*.txt' }, ctx)) as {
      matches: Array<{ file: string }>
    }
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.file).toBe(path.join(tmpDir, 'a.txt'))
  })

  it('respects maxResults', async () => {
    const body = Array.from({ length: 20 }, () => 'match').join('\n') + '\n'
    await fs.writeFile(path.join(tmpDir, 'a.txt'), body, 'utf8')
    const tool = new SearchFilesTool()
    const result = (await tool.call({ pattern: 'match', path: '.', maxResults: 5 }, ctx)) as {
      matches: unknown[]
    }
    expect(result.matches).toHaveLength(5)
  })

  it('recurses into subdirectories', async () => {
    await fs.mkdir(path.join(tmpDir, 'sub'))
    await fs.writeFile(path.join(tmpDir, 'sub', 'b.txt'), 'TARGET\n', 'utf8')
    const tool = new SearchFilesTool()
    const result = (await tool.call({ pattern: 'TARGET', path: '.' }, ctx)) as {
      matches: Array<{ file: string }>
    }
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.file).toBe(path.join(tmpDir, 'sub', 'b.txt'))
  })

  it('rejects an invalid regex with a clear error', async () => {
    const tool = new SearchFilesTool()
    await expect(tool.call({ pattern: '[unclosed', path: '.' }, ctx)).rejects.toThrow(
      /invalid regex/i,
    )
  })
})
