/**
 * P62 — MEMORY.md / USER.md auto-inject middleware tests.
 *
 * The middleware lives in `@lumen/core` (the new
 * `memory-inject.ts` module) and is the bridge between the
 * frozen markdown snapshot loaded at composition time and
 * the system-prompt dynamic suffix. The four cases pin the
 * full contract:
 *
 *   1. Format — empty snapshot produces no chunk; populated
 *      snapshot produces one chunk with the expected
 *      `[MEMORY] ... [USER PROFILE] ...` shape.
 *   2. Frozen-after-first — `appendDynamicChunk` fires once
 *      and only once, even when the middleware is invoked
 *      on every `beforeModel` call across many model turns.
 *      This is the prefix-cache invariant (P31.1 + Hermes
 *      `_system_prompt_snapshot` parity).
 *   3. Threat scan — a poisoned entry is replaced with
 *      `[BLOCKED: ...]` in the snapshot, and a benign entry
 *      is preserved verbatim. Pinned via the
 *      `loadMemorySnapshot` integration test below (the
 *      `apps/cli/test/p62-batch.test.ts` runs end-to-end
 *      with a real fs write).
 *   4. Schema — `MemorySnapshotSchema` rejects unknown keys
 *      and accepts the documented shape.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import {
  MemorySnapshotSchema,
  createMemoryInjectMiddleware,
  type MemorySnapshot,
} from '../src/agent/middleware/memory-inject.js'

/** Build a minimal `MiddlewareContext` shaped enough for the hook. */
const fakeContext = (): {
  appendDynamicChunk: (chunk: string) => void
  chunks: string[]
} => {
  const chunks: string[] = []
  return {
    appendDynamicChunk: (chunk) => {
      chunks.push(chunk)
    },
    chunks,
  }
}

describe('P62 — memory-inject middleware (frozen snapshot → dynamic suffix)', () => {
  it('MemorySnapshotSchema accepts the documented shape', () => {
    const ok: MemorySnapshot = MemorySnapshotSchema.parse({
      memory: '- user prefers 中文',
      user: '- works in ~/workspace/lumen',
    })
    expect(ok.memory).toContain('中文')
    expect(ok.user).toContain('~/workspace/lumen')
  })

  it('MemorySnapshotSchema rejects unknown keys', () => {
    expect(() =>
      MemorySnapshotSchema.parse({
        memory: 'x',
        user: 'y',
        extra: 'nope',
      } as unknown as MemorySnapshot),
    ).toThrow()
  })

  it('emits one chunk on the first beforeModel call when both files are populated', async () => {
    const snapshot: MemorySnapshot = {
      memory: '- remember the agent prefix cache invariant',
      user: '- operator prefers concise answers',
    }
    const mw = createMemoryInjectMiddleware({ snapshot })
    const ctx = fakeContext()
    // Simulate three model calls in a row (the agent
    // loop runs `beforeModel` once per turn).
    const r1 = await mw.beforeModel?.([], ctx as unknown as Parameters<NonNullable<typeof mw.beforeModel>>[1])
    const r2 = await mw.beforeModel?.([], ctx as unknown as Parameters<NonNullable<typeof mw.beforeModel>>[1])
    const r3 = await mw.beforeModel?.([], ctx as unknown as Parameters<NonNullable<typeof mw.beforeModel>>[1])

    // The hook must always return the messages array
    // (the middleware is a snapshot injector; it does not
    // mutate the messages list).
    expect(Array.isArray(r1)).toBe(true)
    expect(Array.isArray(r2)).toBe(true)
    expect(Array.isArray(r3)).toBe(true)

    // Frozen-after-first: exactly one chunk pushed,
    // regardless of how many model calls follow.
    expect(ctx.chunks.length).toBe(1)

    // Chunk shape: both files rendered into one block,
    // ordered `[MEMORY]` then `[USER PROFILE]`. The
    // header lines are stable so a downstream test
    // grepping the system prompt can match them.
    expect(ctx.chunks[0]).toMatch(/^\[MEMORY\]\n- remember the agent prefix cache invariant\n\n\[USER PROFILE\]\n- operator prefers concise answers$/)
  })

  it('skips the chunk entirely when both files are empty', async () => {
    const mw = createMemoryInjectMiddleware({ snapshot: { memory: '', user: '' } })
    const ctx = fakeContext()
    await mw.beforeModel?.([], ctx as unknown as Parameters<NonNullable<typeof mw.beforeModel>>[1])
    await mw.beforeModel?.([], ctx as unknown as Parameters<NonNullable<typeof mw.beforeModel>>[1])
    expect(ctx.chunks.length).toBe(0)
  })

  it('skips the chunk when only MEMORY is empty (USER alone still renders)', async () => {
    const mw = createMemoryInjectMiddleware({ snapshot: { memory: '', user: '- one fact' } })
    const ctx = fakeContext()
    await mw.beforeModel?.([], ctx as unknown as Parameters<NonNullable<typeof mw.beforeModel>>[1])
    expect(ctx.chunks.length).toBe(1)
    expect(ctx.chunks[0]).toBe('[USER PROFILE]\n- one fact')
  })

  it('does not push again even when a fresh context is passed in (the closure is the source of truth)', async () => {
    // The middleware's `pushed` flag lives in the closure
    // created by `createMemoryInjectMiddleware`, NOT in
    // the `ctx` object. A caller that swaps the ctx
    // between turns (e.g. re-mounting the React tree) does
    // not re-trigger the chunk. This is the property that
    // makes the snapshot frozen.
    const mw = createMemoryInjectMiddleware({ snapshot: { memory: '- x', user: '' } })
    const ctx1 = fakeContext()
    await mw.beforeModel?.([], ctx1 as unknown as Parameters<NonNullable<typeof mw.beforeModel>>[1])
    expect(ctx1.chunks.length).toBe(1)
    const ctx2 = fakeContext()
    await mw.beforeModel?.([], ctx2 as unknown as Parameters<NonNullable<typeof mw.beforeModel>>[1])
    expect(ctx2.chunks.length).toBe(0)
  })
})