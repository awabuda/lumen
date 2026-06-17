/**
 * P10 schema validation tests.
 *
 * These tests exercise every schema in `packages/memory/src/schemas.ts`
 * to confirm:
 *   1. valid input round-trips with the expected shape
 *   2. invalid input throws `ValidationError` (from `@lumen/core`),
 *      not a generic `Error`
 *   3. the `cause` chain carries the underlying `ZodError` for logs
 *   4. the field path is reflected in the error message
 *
 * Together with the contract suite and the per-entry-point tests
 * (sqlite-file / in-memory / rag), these are the test guarantee
 * that the public surface of `@lumen/memory` rejects bad input
 * before it reaches better-sqlite3, the embedder, or the chunker.
 */

import { ValidationError } from '@lumen/core'
import { describe, expect, it } from 'vitest'
import { ZodError, z } from 'zod'
import {
  IngestInputSchema,
  MemoryQuerySchema,
  ProviderEmbedderOptionsSchema,
  RagPipelineOptionsSchema,
  RetrieveInputSchema,
  SqliteStoreConfigSchema,
  parseOrThrow,
} from '../src/schemas.js'

// ---------------------------------------------------------------------------
// parseOrThrow helper
// ---------------------------------------------------------------------------

describe('parseOrThrow helper', () => {
  it('returns the parsed data on success', () => {
    const out = parseOrThrow(z.string(), 'hello', 'sample')
    expect(out).toBe('hello')
  })

  it('throws ValidationError on failure', () => {
    let caught: unknown
    try {
      parseOrThrow(z.string(), 42, 'sample')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ValidationError)
    const v = caught as ValidationError
    expect(v.field).toBe('sample')
    expect(v.message).toContain('schema for sample')
    expect(v.cause).toBeInstanceOf(ZodError)
  })

  it('embeds the field path in the error message', () => {
    expect(() =>
      parseOrThrow(z.object({ a: z.object({ b: z.string() }) }), { a: { b: 42 } }, 'cfg'),
    ).toThrow(/a\.b/)
  })
})

// ---------------------------------------------------------------------------
// SqliteStoreConfigSchema
// ---------------------------------------------------------------------------

describe('SqliteStoreConfigSchema', () => {
  it('accepts a minimal valid config', () => {
    const r = SqliteStoreConfigSchema.safeParse({ path: ':memory:' })
    expect(r.success).toBe(true)
  })

  it('rejects an empty path', () => {
    const r = SqliteStoreConfigSchema.safeParse({ path: '' })
    expect(r.success).toBe(false)
  })

  it('rejects an unknown field (strict mode)', () => {
    const r = SqliteStoreConfigSchema.safeParse({ path: 'x.db', bogus: 1 })
    expect(r.success).toBe(false)
  })

  it('accepts verbose as a function', () => {
    const r = SqliteStoreConfigSchema.safeParse({
      path: 'x.db',
      verbose: (_sql: string) => undefined,
    })
    expect(r.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// ProviderEmbedderOptionsSchema
// ---------------------------------------------------------------------------

describe('ProviderEmbedderOptionsSchema', () => {
  it('accepts a minimal config with just model', () => {
    const r = ProviderEmbedderOptionsSchema.safeParse({ model: 'mistral-embed' })
    expect(r.success).toBe(true)
  })

  it('rejects empty model', () => {
    const r = ProviderEmbedderOptionsSchema.safeParse({ model: '' })
    expect(r.success).toBe(false)
  })

  it('rejects non-positive dimensions', () => {
    expect(ProviderEmbedderOptionsSchema.safeParse({ model: 'm', dimensions: 0 }).success).toBe(
      false,
    )
    expect(ProviderEmbedderOptionsSchema.safeParse({ model: 'm', dimensions: -1 }).success).toBe(
      false,
    )
  })

  it('rejects non-integer dimensions', () => {
    const r = ProviderEmbedderOptionsSchema.safeParse({ model: 'm', dimensions: 1.5 })
    expect(r.success).toBe(false)
  })

  it('accepts AbortSignal instance', () => {
    const ac = new AbortController()
    const r = ProviderEmbedderOptionsSchema.safeParse({ model: 'm', signal: ac.signal })
    expect(r.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// RagPipelineOptionsSchema
// ---------------------------------------------------------------------------

describe('RagPipelineOptionsSchema', () => {
  it('accepts any object (collaborators are duck-typed)', () => {
    const r = RagPipelineOptionsSchema.safeParse({
      embedder: () => Promise.resolve([]),
      backend: { upsert: () => Promise.resolve() },
      chunker: () => [],
    })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown extra key (strict mode)', () => {
    const r = RagPipelineOptionsSchema.safeParse({
      embedder: () => undefined,
      backend: {},
      chunker: () => [],
      bonus: true,
    })
    expect(r.success).toBe(false)
  })

  it('does not enforce presence of the three keys (they are z.unknown and optional)', () => {
    // z.unknown() is implicitly optional. The schema is a structural
    // guard, not a presence guard; TypeScript enforces presence at
    // the call site. We test here that an empty object parses
    // successfully — the runtime contract is "extra keys rejected,
    // not 'all three required'".
    const r = RagPipelineOptionsSchema.safeParse({})
    expect(r.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// MemoryQuerySchema
// ---------------------------------------------------------------------------

describe('MemoryQuerySchema', () => {
  it('accepts an empty object', () => {
    const r = MemoryQuerySchema.safeParse({})
    expect(r.success).toBe(true)
  })

  it('rejects minTrust outside [0, 1]', () => {
    expect(MemoryQuerySchema.safeParse({ minTrust: -0.1 }).success).toBe(false)
    expect(MemoryQuerySchema.safeParse({ minTrust: 1.5 }).success).toBe(false)
    expect(MemoryQuerySchema.safeParse({ minTrust: 0 }).success).toBe(true)
    expect(MemoryQuerySchema.safeParse({ minTrust: 1 }).success).toBe(true)
  })

  it('rejects non-positive limit', () => {
    expect(MemoryQuerySchema.safeParse({ limit: 0 }).success).toBe(false)
    expect(MemoryQuerySchema.safeParse({ limit: -5 }).success).toBe(false)
    expect(MemoryQuerySchema.safeParse({ limit: 1.5 }).success).toBe(false)
  })

  it('rejects a non-string tag', () => {
    const r = MemoryQuerySchema.safeParse({ tags: [1, 2] })
    expect(r.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// IngestInputSchema
// ---------------------------------------------------------------------------

describe('IngestInputSchema', () => {
  it('accepts a minimal input', () => {
    const r = IngestInputSchema.safeParse({ documentId: 'doc-1', text: 'hello' })
    expect(r.success).toBe(true)
  })

  it('rejects empty documentId', () => {
    const r = IngestInputSchema.safeParse({ documentId: '', text: 'x' })
    expect(r.success).toBe(false)
  })

  it('rejects chunks with empty text', () => {
    const r = IngestInputSchema.safeParse({
      documentId: 'doc-1',
      text: 'ignored',
      chunks: [{ text: '', startOffset: 0, endOffset: 1, index: 0 }],
    })
    expect(r.success).toBe(false)
  })

  it('rejects chunks where endOffset < startOffset', () => {
    const r = IngestInputSchema.safeParse({
      documentId: 'doc-1',
      text: 'ignored',
      chunks: [{ text: 'x', startOffset: 5, endOffset: 3, index: 0 }],
    })
    expect(r.success).toBe(false)
  })

  it('accepts chunks with endOffset == startOffset (empty but valid range)', () => {
    const r = IngestInputSchema.safeParse({
      documentId: 'doc-1',
      text: 'ignored',
      chunks: [{ text: 'x', startOffset: 0, endOffset: 0, index: 0 }],
    })
    expect(r.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// RetrieveInputSchema
// ---------------------------------------------------------------------------

describe('RetrieveInputSchema', () => {
  it('accepts a query without limit', () => {
    const r = RetrieveInputSchema.safeParse({ query: 'hello' })
    expect(r.success).toBe(true)
  })

  it('rejects empty query', () => {
    const r = RetrieveInputSchema.safeParse({ query: '' })
    expect(r.success).toBe(false)
  })

  it('rejects non-positive limit', () => {
    expect(RetrieveInputSchema.safeParse({ query: 'x', limit: 0 }).success).toBe(false)
    expect(RetrieveInputSchema.safeParse({ query: 'x', limit: -1 }).success).toBe(false)
  })
})
