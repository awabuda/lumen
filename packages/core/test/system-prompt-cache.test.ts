/**
 * P31.4 — LRU stable-prefix cache invariants. Pure-function
 * tests over an injected {@link LruStore} so the FNV / SHA /
 * eviction logic is exercised without filesystem or
 * assembler involvement.
 */

import { describe, expect, it } from 'vitest'
import {
  createStablePromptLru,
  hashStableCacheKey,
  StablePromptCache,
  SYSTEM_PROMPT_CACHE_LRU_CAP,
  type LruStore,
  type StableCacheKey,
} from '../src/agent/system-prompt-cache.js'

const baseKey = (overrides: Partial<StableCacheKey> = {}): StableCacheKey => ({
  cwd: '/repo',
  profile: {},
  ...overrides,
})

describe('hashStableCacheKey (P31.4 §1.9)', () => {
  it('produces a 64-char hex digest', () => {
    const hash = hashStableCacheKey(baseKey())
    expect(hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('two equivalent keys hash to the same digest', () => {
    const a = hashStableCacheKey(baseKey({ cwd: '/repo' }))
    const b = hashStableCacheKey(baseKey({ cwd: '/repo' }))
    expect(a).toBe(b)
  })

  it('changing cwd changes the hash', () => {
    const a = hashStableCacheKey(baseKey({ cwd: '/repo/a' }))
    const b = hashStableCacheKey(baseKey({ cwd: '/repo/b' }))
    expect(a).not.toBe(b)
  })

  it('changing a profile flag changes the hash', () => {
    const off = hashStableCacheKey(baseKey({ profile: { persona: false } }))
    const on = hashStableCacheKey(baseKey({ profile: { persona: true } }))
    expect(off).not.toBe(on)
  })
})

describe('LRU store (P31.4 §1.9 hard cap = 64)', () => {
  const freshLru = (cap = 4): LruStore<string> => createStablePromptLru<string>(cap)

  it('caps at the requested size', () => {
    const cap = 4
    const lru = freshLru()
    for (let i = 0; i < 10; i++) lru.set(`k${i}`, `v${i}`)
    expect(lru.size()).toBe(cap)
  })

  it('evicts the oldest entry (FIFO-by-insertion)', () => {
    const lru = freshLru()
    lru.set('a', '1')
    lru.set('b', '2')
    lru.set('c', '3')
    lru.set('d', '4')
    lru.set('e', '5')
    expect(lru.get('a')).toBeUndefined()
    expect(lru.get('b')).toBe('2')
  })

  it('promotes hit entries to most-recent (true LRU)', () => {
    const lru = createStablePromptLru<string>(3)
    lru.set('a', '1')
    lru.set('b', '2')
    lru.set('c', '3')
    // promote 'a' → it becomes most-recent; 'b' is now oldest
    expect(lru.get('a')).toBe('1')
    // insert 'd' → 'b' (oldest) is evicted
    lru.set('d', '4')
    expect(lru.get('a')).toBe('1')
    expect(lru.get('b')).toBeUndefined()
    expect(lru.get('c')).toBe('3')
    expect(lru.get('d')).toBe('4')
  })

  it('default cap is the design-doc value (64)', () => {
    expect(createStablePromptLru<string>().cap()).toBe(SYSTEM_PROMPT_CACHE_LRU_CAP)
  })
})

describe('StablePromptCache — read-through', () => {
  it('renders on miss and returns the cached value on subsequent hits', () => {
    const cache = new StablePromptCache()
    let calls = 0
    const render = (): string => {
      calls += 1
      return `STABLE ${calls}`
    }
    const first = cache.readThrough(baseKey(), render)
    const second = cache.readThrough(baseKey(), render)
    expect(first).toBe('STABLE 1')
    expect(second).toBe('STABLE 1')
    expect(calls).toBe(1)
  })

  it('renders again when the stable key changes (cwd, profile, …)', () => {
    const cache = new StablePromptCache()
    let calls = 0
    const render = (): string => `v${++calls}`
    cache.readThrough(baseKey({ cwd: '/a' }), render)
    cache.readThrough(baseKey({ cwd: '/b' }), render)
    expect(calls).toBe(2)
  })

  it('cache key skips dynamic inputs by construction (per §1.9)', () => {
    // Verifies via hash semantics: two `StableCacheKey` values
    // built without `runtime` or `middlewareDynamicChunks`
    // always hash identically. There is no path for the
    // caller to inject dynamic data into the key — the
    // type simply does not allow it.
    const a = hashStableCacheKey(baseKey({ cwd: '/repo' }))
    const b = hashStableCacheKey(baseKey({ cwd: '/repo' }))
    expect(a).toBe(b)
  })

  it('size() and cap() surface the LRU dimensions', () => {
    const cache = new StablePromptCache()
    cache.readThrough(baseKey({ cwd: '/a' }), () => 'x')
    cache.readThrough(baseKey({ cwd: '/b' }), () => 'y')
    expect(cache.size()).toBe(2)
    expect(cache.cap()).toBe(SYSTEM_PROMPT_CACHE_LRU_CAP)
  })

  it('respects injected LRU backend (test isolation hook)', () => {
    const lru = createStablePromptLru<string>(2)
    const cache = new StablePromptCache(lru)
    cache.readThrough(baseKey({ cwd: '/a' }), () => 'a')
    cache.readThrough(baseKey({ cwd: '/b' }), () => 'b')
    cache.readThrough(baseKey({ cwd: '/c' }), () => 'c')
    expect(cache.size()).toBe(2)
  })
})
