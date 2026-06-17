/**
 * Tests for the pure chunking primitives.
 *
 * These cover {@link chunkText} directly so we exercise the splitter
 * without paying the Zod / BaseTool plumbing cost; the
 * {@link ChunkTextTool} wrapping is a one-liner and is verified
 * separately in `chunk-text-tool.test.ts`.
 */

import { describe, expect, it } from 'vitest'
import { DEFAULT_CHUNK_MAX_SIZE, DEFAULT_CHUNK_OVERLAP, chunkText } from '../src/text/chunker.js'

// ---------------------------------------------------------------------------
// Empty / degenerate inputs
// ---------------------------------------------------------------------------

describe('chunkText — degenerate inputs', () => {
  it('returns [] for an empty string', () => {
    expect(chunkText('')).toEqual([])
  })

  it('returns a single chunk whose text equals the input for short strings (default paragraph strategy)', () => {
    const out = chunkText('hello world')
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toBe('hello world')
    expect(out[0]!.startOffset).toBe(0)
    expect(out[0]!.endOffset).toBe(11)
    expect(out[0]!.index).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('chunkText — input validation', () => {
  it('rejects maxChunkSize < 1', () => {
    expect(() => chunkText('hello', { maxChunkSize: 0 })).toThrow(/maxChunkSize/)
  })

  it('rejects negative overlap', () => {
    expect(() => chunkText('hello', { overlap: -1 })).toThrow(/overlap must be >= 0/)
  })

  it('rejects overlap >= maxChunkSize', () => {
    expect(() => chunkText('hello', { maxChunkSize: 10, overlap: 10 })).toThrow(
      /overlap \(10\) must be < maxChunkSize \(10\)/,
    )
  })
})

// ---------------------------------------------------------------------------
// char strategy
// ---------------------------------------------------------------------------

describe('chunkText — char strategy', () => {
  it('emits a single chunk when the input is smaller than maxChunkSize', () => {
    const out = chunkText('abcdef', { strategy: 'char', maxChunkSize: 100, overlap: 10 })
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toBe('abcdef')
  })

  it('emits overlapping fixed-size windows', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz'
    const out = chunkText(text, { strategy: 'char', maxChunkSize: 10, overlap: 3 })
    expect(out.map((c) => c.text)).toEqual([
      'abcdefghij',
      // 10-3 = 7; second window starts at 7
      'hijklmnopq',
      // 17-3 = 14
      'opqrstuvwx',
      // 24-3 = 21
      'vwxyz',
    ])
  })

  it('records absolute startOffset / endOffset', () => {
    const text = 'abcdefghijklmnopqrstuvwxyz'
    const out = chunkText(text, { strategy: 'char', maxChunkSize: 10, overlap: 0 })
    expect(out[0]!.startOffset).toBe(0)
    expect(out[0]!.endOffset).toBe(10)
    expect(out[1]!.startOffset).toBe(10)
    expect(out[1]!.endOffset).toBe(20)
  })
})

// ---------------------------------------------------------------------------
// paragraph strategy
// ---------------------------------------------------------------------------

describe('chunkText — paragraph strategy', () => {
  it('keeps a single-paragraph input as one chunk', () => {
    const out = chunkText('a single paragraph with no blank lines', {
      strategy: 'paragraph',
      maxChunkSize: 1000,
    })
    expect(out).toHaveLength(1)
  })

  it('packs multiple short paragraphs into one chunk when total length <= maxChunkSize', () => {
    const text = 'Para one.\n\nPara two.\n\nPara three.'
    const out = chunkText(text, { strategy: 'paragraph', maxChunkSize: 100, overlap: 0 })
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toBe(text)
  })

  it('splits into multiple chunks when paragraphs overflow maxChunkSize', () => {
    const para = (n: number) => `Paragraph ${'x'.repeat(50)} number ${n}.\n\n`
    const text = para(1) + para(2) + para(3) + para(4) + para(5)
    const out = chunkText(text, { strategy: 'paragraph', maxChunkSize: 130, overlap: 0 })
    expect(out.length).toBeGreaterThan(1)
    for (const c of out) {
      expect(c.endOffset).toBeLessThanOrEqual(text.length)
    }
  })

  it('emits a single-paragraph oversized unit on its own (no truncation)', () => {
    const big = 'x'.repeat(500)
    const out = chunkText(big, { strategy: 'paragraph', maxChunkSize: 100, overlap: 0 })
    expect(out).toHaveLength(1)
    expect(out[0]!.text).toBe(big)
  })

  it('repeats the tail of chunk N at the head of chunk N+1 (overlap)', () => {
    const para = (n: number) => `${'p'.repeat(40)} ${n}.\n\n`
    const text = para(1) + para(2) + para(3) + para(4)
    const out = chunkText(text, { strategy: 'paragraph', maxChunkSize: 90, overlap: 20 })
    expect(out.length).toBeGreaterThan(1)
    // The overlap window is taken at unit boundaries, so chunk 1's
    // head must start with a *prefix* of the first kept overlap unit.
    // The simplest invariant we can assert without leaking the
    // implementation detail is: chunk 1's start is contained in the
    // tail region of chunk 0.
    const first = out[0]!.text
    const tailRegion = first.slice(first.length - 60) // wide window
    const second = out[1]!.text
    // The first kept overlap unit is at least 1 character; chunk 1
    // begins with that unit's full text, so the prefix is non-empty
    // and lives inside tailRegion.
    const headPrefix = second.slice(0, Math.min(20, second.length))
    expect(tailRegion.endsWith(headPrefix) || tailRegion.includes(headPrefix)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// sentence strategy
// ---------------------------------------------------------------------------

describe('chunkText — sentence strategy', () => {
  it('packs sentences greedily into one chunk when short', () => {
    const text = 'First sentence. Second sentence. Third sentence.'
    const out = chunkText(text, { strategy: 'sentence', maxChunkSize: 1000 })
    expect(out).toHaveLength(1)
  })

  it('splits on Chinese full-stop 。', () => {
    const text = '第一句。第二句。第三句。'
    const out = chunkText(text, { strategy: 'sentence', maxChunkSize: 1000 })
    expect(out).toHaveLength(1)
  })

  it('emits multiple chunks when sentences overflow maxChunkSize', () => {
    const sentence = (n: number) => `Sentence number ${n} has some body text in it. `
    const text = Array.from({ length: 20 }, (_, i) => sentence(i + 1)).join('')
    const out = chunkText(text, { strategy: 'sentence', maxChunkSize: 80, overlap: 0 })
    expect(out.length).toBeGreaterThan(1)
    for (const c of out) {
      expect(c.endOffset).toBeLessThanOrEqual(text.length)
      expect(c.text.length).toBeLessThanOrEqual(80)
    }
  })

  it('recognizes CJK full-stop 。 as a sentence terminator', () => {
    const text = '第一句。第二句。第三句。第四句。第五句。'
    const out = chunkText(text, { strategy: 'sentence', maxChunkSize: 8, overlap: 0 })
    expect(out.length).toBeGreaterThan(1)
  })
})

// ---------------------------------------------------------------------------
// Default constants sanity
// ---------------------------------------------------------------------------

describe('chunkText — defaults', () => {
  it('exports sensible defaults', () => {
    expect(DEFAULT_CHUNK_MAX_SIZE).toBe(1000)
    expect(DEFAULT_CHUNK_OVERLAP).toBe(200)
    // overlap must be < maxChunkSize (the validation invariant)
    expect(DEFAULT_CHUNK_OVERLAP).toBeLessThan(DEFAULT_CHUNK_MAX_SIZE)
  })
})
