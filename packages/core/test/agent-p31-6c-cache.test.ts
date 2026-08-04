/**
 * P31.6C — `AgentConfig.systemPromptCache` integration.
 *
 * Mirrors design doc §1.9 + P31.6 follow-up list: when
 * the cache is supplied, two Agents with the same stable
 * inputs share the rendered string instead of re-running
 * the assembler. The cache key is the SHA-256 of the
 * stable subset of `SectionContext` (cwd / profile flags /
 * layer texts); runtime + middleware dynamic chunks
 * never participate in the key per the closed
 * `StableCacheKey` shape.
 */

import { describe, expect, it } from 'vitest'
import {
  Agent,
  type AgentConfig,
  type ChatRequest,
} from '../src/index.js'
import type { Message } from '../src/message/index.js'
import { StablePromptCache } from '../src/agent/system-prompt-cache.js'

const minimalProvider = {
  id: 'fake',
  capabilities: {
    maxContextTokens: 8192,
    toolCalls: true,
    parallelToolCalls: true,
    promptCaching: false,
    streamable: false,
    vision: false,
    jsonMode: false,
  },
  chat: async (
    _request: ChatRequest,
  ): Promise<{ content: string; messages: ReadonlyArray<Message> }> => {
    return { content: 'ok', messages: [] }
  },
  embed: undefined,
  stream: undefined,
} as unknown as AgentConfig['provider']

const baseRuntime = {
  sessionId: 's',
  cwd: '/repo',
  model: 'fake',
  capturedAtIso: '2026-08-03T00:00:00Z',
}

const buildCfg = (
  systemPromptContext: AgentConfig['systemPromptContext'],
  cache?: AgentConfig['systemPromptCache'],
): AgentConfig => {
  const cfg: AgentConfig = {
    provider: minimalProvider,
    // biome-ignore lint/suspicious/noExplicitAny: test scaffolding only.
    tools: {} as any,
    cwd: '/repo',
    systemPromptContext,
  }
  if (cache !== undefined) cfg.systemPromptCache = cache
  return cfg
}

const revealPrompt = (agent: Agent): string =>
  (agent as unknown as { systemPrompt: string }).systemPrompt

describe('P31.6C — systemPromptCache integration', () => {
  it('renders and caches when a cache is supplied', () => {
    const cache = new StablePromptCache()
    const agent = new Agent(
      buildCfg({ profile: {}, projectText: 'PROJ-1', runtime: baseRuntime }, cache),
    )
    expect(cache.size()).toBe(1)
    const first = revealPrompt(agent)
    expect(first).toContain('PROJ-1')
    expect(first).toContain('<!-- LUMEN_CACHE_BOUNDARY -->')
  })

  it('two Agents with the same stable inputs hit the cache', () => {
    const cache = new StablePromptCache()
    const ctx = { profile: {}, projectText: 'PROJ-SAME', runtime: baseRuntime }
    const a = new Agent(buildCfg(ctx, cache))
    const b = new Agent(buildCfg(ctx, cache))
    expect(cache.size()).toBe(1)
    expect(revealPrompt(a)).toBe(revealPrompt(b))
  })

  it('two Agents with different stable inputs miss the cache', () => {
    const cache = new StablePromptCache()
    const a = new Agent(
      buildCfg({ profile: {}, projectText: 'PROJ-A', runtime: baseRuntime }, cache),
    )
    const b = new Agent(
      buildCfg({ profile: {}, projectText: 'PROJ-B', runtime: baseRuntime }, cache),
    )
    expect(cache.size()).toBe(2)
    expect(revealPrompt(a)).toContain('PROJ-A')
    expect(revealPrompt(b)).toContain('PROJ-B')
  })

  it('runtime changes do not bust the cache (per StableCacheKey closed shape)', () => {
    // The cache key abstracts the runtime surface per §1.9 —
    // two `SectionContext` values that differ only on
    // `runtime` hash to the same digest. The dynamic runtime
    // chunk is re-emitted per turn via P31.6B's
    // `appendDynamicChunk` path, so cache-stability here
    // is the intended design.
    const cache = new StablePromptCache()
    const a = new Agent(
      buildCfg(
        {
          profile: {},
          projectText: 'PROJ',
          runtime: { ...baseRuntime, sessionId: 's1', capturedAtIso: '2026-08-03T00:00:00Z' },
        },
        cache,
      ),
    )
    const b = new Agent(
      buildCfg(
        {
          profile: {},
          projectText: 'PROJ',
          runtime: { ...baseRuntime, sessionId: 's2', capturedAtIso: '2026-08-03T00:00:01Z' },
        },
        cache,
      ),
    )
    expect(cache.size()).toBe(1)
    expect(revealPrompt(a)).toBe(revealPrompt(b))
  })

  it('no cache → no systemPromptCache reads; the constructor still renders', () => {
    const cfg = buildCfg({
      profile: {},
      projectText: 'NO-CACHE',
      runtime: baseRuntime,
    })
    const agent = new Agent(cfg)
    expect(revealPrompt(agent)).toContain('NO-CACHE')
  })
})
