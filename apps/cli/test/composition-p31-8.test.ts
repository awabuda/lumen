/**
 * P31.8 — composition-root wiring of the layered system
 * prompt.
 *
 * Pins the contract that `composeSystemPromptContext`
 * builds a `SectionContext` from the cwd + sessionId +
 * model and that `buildAgent` route through the
 * `systemPromptContext` + `systemPromptCache` fields on
 * `CreateAgentConfig` (P31.6 / P31.6C), so the layered
 * prompt finally reaches the agent construction site
 * rather than being orphaned in `@lumen/core`.
 */

import { describe, expect, it } from 'vitest'
import {
  composeSystemPromptContext,
  getSharedPromptCache,
  _resetSharedPromptCacheForTests,
} from '../src/composition.js'

describe('P31.8 composeSystemPromptContext', () => {
  it('builds a SectionContext with the runtime inputs populated', async () => {
    const ctx = await composeSystemPromptContext(
      '/repo',
      's-test',
      'fake-model',
    )
    expect(ctx.runtime.sessionId).toBe('s-test')
    expect(ctx.runtime.cwd).toBe('/repo')
    expect(ctx.runtime.model).toBe('fake-model')
    expect(ctx.runtime.capturedAtIso).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // Profile defaults: all flags off when none provided.
    expect(ctx.profile.persona).toBe(false)
    expect(ctx.profile.bootstrap).toBe(false)
    expect(ctx.profile.skillsIndex).toBe(false)
    expect(ctx.profile.memorySnapshot).toBe(false)
  })

  it('captures profile flags when the caller opts in', async () => {
    const ctx = await composeSystemPromptContext('/repo', 's', 'm', {
      persona: true,
      bootstrap: true,
      skillsIndex: true,
      memorySnapshot: true,
    })
    expect(ctx.profile.persona).toBe(true)
    expect(ctx.profile.bootstrap).toBe(true)
    expect(ctx.profile.skillsIndex).toBe(true)
    expect(ctx.profile.memorySnapshot).toBe(true)
  })

  it('runtime differs per call (so chat with multiple sessions dispatches distinct contexts)', async () => {
    const a = await composeSystemPromptContext('/a', 's-a', 'm')
    const b = await composeSystemPromptContext('/b', 's-b', 'm')
    expect(a.runtime.cwd).toBe('/a')
    expect(b.runtime.cwd).toBe('/b')
    expect(a.runtime.sessionId).toBe("s-a")
    expect(b.runtime.sessionId).toBe("s-b")
  })
})

describe('P31.8 shared chat cache', () => {
  it('returns the same instance across calls', () => {
    _resetSharedPromptCacheForTests()
    const a = getSharedPromptCache()
    const b = getSharedPromptCache()
    expect(a).toBe(b)
  })

  it('re-creates the cache after the test reset hook', () => {
    _resetSharedPromptCacheForTests()
    const a = getSharedPromptCache()
    _resetSharedPromptCacheForTests()
    const b = getSharedPromptCache()
    expect(a).not.toBe(b)
  })
})
