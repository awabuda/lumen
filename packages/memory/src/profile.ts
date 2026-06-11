/**
 * Long-term user profile — aggregates facts across
 * sessions into a stable user model.
 *
 * The profile is a structured record of the user's
 * preferences, identity, environment, and recurring
 * patterns. It is built from facts extracted by the
 * {@link BaseReflector} and stored in the memory store
 * under a reserved `kind: 'profile'`.
 *
 * The profile is intentionally a flat key-value map
 * so the agent loop can inject it into the system
 * prompt as a compact block.
 */

import type { BaseMemoryStore, MemoryRecord } from '@lumen/core'

/** A single profile entry. */
export interface ProfileEntry {
  /** Key (e.g. 'name', 'preferred_language', 'os'). */
  readonly key: string
  /** Human-readable value. */
  readonly value: string
  /** Confidence in [0, 1]. */
  readonly trust: number
  /** Source fact ids that contributed to this entry. */
  readonly sources: ReadonlyArray<string>
}

/** The full user profile. */
export interface UserProfile {
  /** Stable profile id (usually the user's id). */
  readonly id: string
  /** Profile entries, keyed by key. */
  readonly entries: Readonly<Record<string, ProfileEntry>>
  /** Last update timestamp. */
  readonly updatedAt: number
}

/**
 * Builds and maintains a long-term user profile from
 * facts stored in the memory store.
 *
 * Strategy:
 *   1. Query all records with `kind: 'preference'` and
 *      `kind: 'fact'` from the store.
 *   2. Group by a derived key (first sentence subject).
 *   3. Pick the highest-trust entry for each key.
 *   4. Persist the aggregated profile as a single
 *      `kind: 'profile'` record.
 */
export class ProfileBuilder {
  private readonly store: BaseMemoryStore

  public constructor(store: BaseMemoryStore) {
    this.store = store
  }

  /**
   * Build or refresh the user profile. Returns the
   * aggregated profile.
   */
  public async build(): Promise<UserProfile> {
    const facts = await this.store.search({
      kind: 'preference',
      limit: 200,
    })
    const generalFacts = await this.store.search({
      kind: 'fact',
      limit: 200,
    })

    const allFacts = [...facts, ...generalFacts]

    // Group by derived key.
    const groups = new Map<string, ProfileEntry>()
    for (const { record } of allFacts) {
      const key = this.deriveKey(record.content)
      const existing = groups.get(key)
      if (!existing || record.trust > existing.trust) {
        groups.set(key, {
          key,
          value: record.content,
          trust: record.trust,
          sources: [record.id],
        })
      } else if (record.trust === existing.trust) {
        // Same trust — append source.
        groups.set(key, {
          ...existing,
          sources: [...existing.sources, record.id],
        })
      }
    }

    const entries: Record<string, ProfileEntry> = {}
    for (const [key, entry] of groups) {
      entries[key] = entry
    }

    const profile: UserProfile = {
      id: 'default',
      entries,
      updatedAt: Date.now(),
    }

    // Persist the profile.
    await this.store.put({
      id: 'profile:default',
      kind: 'profile',
      content: JSON.stringify(profile),
      trust: 0.9,
      tags: ['profile', 'system'],
    })

    return profile
  }

  /**
   * Derive a stable key from a fact's content.
   * Simple heuristic: take the first 2-3 words as the
   * subject, lowercase, strip punctuation.
   */
  private deriveKey(content: string): string {
    return content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .slice(0, 3)
      .join('_')
      .slice(0, 40)
  }

  /**
   * Load the persisted profile from the store.
   * Returns undefined if no profile has been built yet.
   */
  public async load(): Promise<UserProfile | undefined> {
    const record = await this.store.get('profile:default')
    if (!record) return undefined
    try {
      return JSON.parse(record.content) as UserProfile
    } catch {
      return undefined
    }
  }
}
