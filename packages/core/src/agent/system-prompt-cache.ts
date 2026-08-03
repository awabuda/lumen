/**
 * P31.4 — LRU stable-prefix cache for the system prompt.
 *
 * Mirrors design doc §1.9: the stable prefix is invariant
 * across any operation that does not touch a layer's
 * source (cwd, project file mtime, profile toggles,
 * guidance version, skills index). The cache hashes those
 * stable inputs only — never `git status`, `time`, plan
 * state, memory recall, or any other D1/D2 surface — and
 * returns the cached rendered prefix on hit. Miss → the
 * caller renders and inserts. LRU cap is fixed at 64
 * entries; the most-recent miss-key pushes the oldest-key
 * out (true LRU, not MRU-by-insertion).
 */

import { createHash } from 'node:crypto'

/** Per §1.9 hard cap. */
export const SYSTEM_PROMPT_CACHE_LRU_CAP = 64

/**
 * The subset of `SectionContext` inputs that the design
 * doc §1.9 says belong to the stable hash. We export the
 * type explicitly so callers (P31.6 Agent.run,
 * composition roots, sub-agent prompts) can construct the
 * key without picking fields by hand.
 *
 * The list is closed:
 *
 *   - `cwd`
 *   - `profile` flags (`persona`, `bootstrap`,
 *     `skillsIndex`, `memorySnapshot`)
 *   - `kernelIdentityOverride`
 *   - `projectText` (P1; mtime is captured by the loader
 *     already so the *body* is what the cache cares about)
 *   - `personaText`, `guidanceText`, `skillsIndexText`,
 *     `bootstrapText`, `memorySnapshotText`
 *
 * Notably absent (intentionally — see §1.9 "Dynamic never
 * re-used"):
 *
 *   - `runtime` (D1: session_id / cwd echo / model /
 *     capturedAtIso / git status)
 *   - `middlewareDynamicChunks` (D2: plan / per-turn
 *     skill-hits / recall)
 */
export interface StableCacheKey {
  readonly cwd: string
  readonly profile: {
    readonly persona?: boolean
    readonly bootstrap?: boolean
    readonly skillsIndex?: boolean
    readonly memorySnapshot?: boolean
  }
  readonly kernelIdentityOverride?: string
  readonly projectText?: string
  readonly personaText?: string
  readonly guidanceText?: string
  readonly skillsIndexText?: string
  readonly bootstrapText?: string
  readonly memorySnapshotText?: string
}

/**
 * Compute the SHA-256 hex digest of a stable cache key. The
 * serialisation is intentionally canonical (sorted keys,
 * no whitespace) so two callers building equivalent keys
 * hash to the same digest.
 */
export const hashStableCacheKey = (key: StableCacheKey): string => {
  const canonical = canonicaliseKey(key)
  return createHash('sha256').update(canonical).digest('hex')
}

const canonicaliseKey = (key: StableCacheKey): string => {
  // Order matters: JSON.stringify on a plain object emits
  // keys in their insertion order, which we control
  // explicitly here.
  const out: Record<string, unknown> = {
    cwd: key.cwd,
    profile: {
      persona: key.profile.persona ?? false,
      bootstrap: key.profile.bootstrap ?? false,
      skillsIndex: key.profile.skillsIndex ?? false,
      memorySnapshot: key.profile.memorySnapshot ?? false,
    },
    kernelIdentityOverride: key.kernelIdentityOverride ?? '',
    projectText: key.projectText ?? '',
    personaText: key.personaText ?? '',
    guidanceText: key.guidanceText ?? '',
    skillsIndexText: key.skillsIndexText ?? '',
    bootstrapText: key.bootstrapText ?? '',
    memorySnapshotText: key.memorySnapshotText ?? '',
  }
  return JSON.stringify(out)
}

/**
 * Minimal LRU map. Insertion-order linked list semantics —
 * every read promotes the entry to the most-recent slot;
 * every insert that overflows the cap evicts the oldest.
 *
 * We hand-roll this instead of pulling in a dependency
 * because the Lumen tree keeps dependencies tight (CLAUDE.md
 * rule #2) and 30 lines of doubly-linked logic beats a
 * npm install for one hot-path helper.
 */
export interface LruStore<V> {
  get(key: string): V | undefined
  set(key: string, value: V): void
  size(): number
  cap(): number
  /** Test-only — clear all entries. */
  clear(): void
}

export const createStablePromptLru = <V>(cap = SYSTEM_PROMPT_CACHE_LRU_CAP): LruStore<V> => {
  // Doubly-linked list using Maps so we don't need a real
  // linked-list allocation. `oldest` keeps insertion
  // order; we rebuild it via `delete + set` on a hit.
  const store = new Map<string, V>()
  return {
    get(key) {
      const v = store.get(key)
      if (v === undefined) return undefined
      // Promote on hit: re-insert to move to most-recent.
      store.delete(key)
      store.set(key, v)
      return v
    },
    set(key, value) {
      // If key already exists, delete first so the new
      // value is the most-recent insertion order entry.
      if (store.has(key)) store.delete(key)
      store.set(key, value)
      while (store.size > cap) {
        // Evict the oldest (first-inserted) entry. Map
        // iteration order is insertion order so the first
        // key is the oldest.
        const oldestKey = store.keys().next().value
        if (oldestKey === undefined) break
        store.delete(oldestKey)
      }
    },
    size: () => store.size,
    cap: () => cap,
    clear: () => store.clear(),
  }
}

/**
 * Convenience wrapper that pulls the `stable` rendering out
 * of the cache. Pure aside from the LRU side-effect; the
 * `render` callback is the assembler call (kept outside so
 * the cache stays layer-agnostic and easy to test).
 */
export class StablePromptCache {
  private readonly lru: LruStore<string>

  constructor(lru?: LruStore<string>) {
    this.lru = lru ?? createStablePromptLru<string>()
  }

  /**
   * Compute the cache key for a `StableCacheKey` payload.
   * Exposed for callers that want to ship the hash with
   * telemetry (e.g. log a hit/miss counter keyed by hash).
   */
  keyFor(stableKey: StableCacheKey): string {
    return hashStableCacheKey(stableKey)
  }

  /**
   * Read-through cache. On hit, returns the cached stable
   * prefix without re-rendering. On miss, calls `render`,
   * inserts under `stableKey`'s hash, and returns the
   * freshly rendered value.
   */
  readThrough(stableKey: StableCacheKey, render: () => string): string {
    const hash = this.keyFor(stableKey)
    const cached = this.lru.get(hash)
    if (cached !== undefined) return cached
    const value = render()
    this.lru.set(hash, value)
    return value
  }

  size(): number {
    return this.lru.size()
  }

  cap(): number {
    return this.lru.cap()
  }
}
