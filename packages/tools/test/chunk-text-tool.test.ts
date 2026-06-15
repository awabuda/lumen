/**
 * Tests for the `ChunkTextTool` wrapper.
 *
 * The splitting logic is exhaustively covered in `chunker.test.ts` —
 * here we just verify the BaseTool plumbing (input validation,
 * output shape, default values) and prove the tool is registered
 * with the correct name / risk / version.
 */

import { describe, expect, it } from 'vitest'
import { ChunkTextTool } from '../src/text/chunk-text.js'
import type { ToolContext } from '@lumen/core'

const ctx: ToolContext = {
  cwd: '/tmp',
  signal: new AbortController().signal,
  env: {},
}

describe('ChunkTextTool', () => {
  it('advertises the right name, risk, and version', () => {
    const tool = new ChunkTextTool()
    expect(tool.name).toBe('chunk_text')
    expect(tool.risk).toBe('safe')
    expect(tool.version).toBe('0.1.0')
  })

  it('chunks a multi-paragraph input with defaults', async () => {
    const tool = new ChunkTextTool()
    const text = 'Para one.\n\nPara two.\n\nPara three.'
    const out = await tool.execute({ text }, ctx)
    expect(out.totalChunks).toBeGreaterThan(0)
    expect(out.chunks).toHaveLength(out.totalChunks)
    expect(out.strategy).toBe('paragraph')
    expect(out.maxChunkSize).toBe(1000)
    expect(out.overlap).toBe(200)
  })

  it('passes through the strategy / maxChunkSize / overlap options', async () => {
    const tool = new ChunkTextTool()
    const out = await tool.execute(
      { text: 'a. b. c. d. e. f. g. h. i. j.', strategy: 'sentence', maxChunkSize: 8, overlap: 2 },
      ctx,
    )
    expect(out.strategy).toBe('sentence')
    expect(out.maxChunkSize).toBe(8)
    expect(out.overlap).toBe(2)
  })

  it('returns totalChunks: 0 for empty input', async () => {
    const tool = new ChunkTextTool()
    const out = await tool.execute({ text: '' }, ctx)
    expect(out.totalChunks).toBe(0)
    expect(out.chunks).toEqual([])
  })

  it('every chunk has a non-negative startOffset and endOffset', async () => {
    const tool = new ChunkTextTool()
    const text = 'P1.\n\nP2.\n\nP3.\n\nP4.\n\nP5.'
    const out = await tool.execute({ text, maxChunkSize: 8, overlap: 2 }, ctx)
    for (const c of out.chunks) {
      expect(c.startOffset).toBeGreaterThanOrEqual(0)
      expect(c.endOffset).toBeGreaterThan(c.startOffset)
      expect(c.endOffset).toBeLessThanOrEqual(text.length)
    }
  })
})
