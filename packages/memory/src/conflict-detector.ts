/**
 * Conflict detection — find contradictory facts in the
 * memory store.
 *
 * When the agent learns a new fact, the conflict detector
 * scans existing records for contradictions. Two records
 * conflict when they share the same kind and tags but
 * have semantically opposite content.
 *
 * Two strategies ship here:
 *   - {@link KeywordConflictDetector} — fast, deterministic.
 *     Flags records whose content contains negations of
 *     the new fact's keywords.
 *   - {@link LLMConflictDetector} — asks the LLM to judge
 *     whether two facts contradict each other.
 */

import type { BaseMemoryStore, MemoryRecord } from '@lumen/core'

/** Minimal provider type — mirrors @lumen/core's BaseProvider. */
interface MinimalProvider {
  chat(opts: {
    model: string
    messages: Array<{ role: string; content: string }>
    temperature?: number
  }): Promise<{ content: string }>
}

/** A detected conflict between two records. */
export interface Conflict {
  /** The existing record that conflicts. */
  readonly existing: MemoryRecord
  /** The new record that triggered the conflict. */
  readonly incoming: MemoryRecord
  /** Human-readable explanation. */
  readonly reason: string
  /** Confidence in [0, 1]. */
  readonly confidence: number
}

/** The contract every conflict detector implements. */
export abstract class BaseConflictDetector {
  /** Stable identifier for the implementation. */
  public abstract readonly id: string

  /**
   * Check whether `incoming` conflicts with any existing
   * record in the store. Returns up to `limit` conflicts,
   * sorted by descending confidence.
   */
  public abstract detect(
    incoming: MemoryRecord,
    store: BaseMemoryStore,
    limit?: number,
  ): Promise<ReadonlyArray<Conflict>>
}

// ---------------------------------------------------------------------------
// KeywordConflictDetector
// ---------------------------------------------------------------------------

/**
 * Detects conflicts by keyword negation. If the incoming
 * fact says "X is Y" and an existing record says "X is not Y"
 * (or vice versa), a conflict is flagged.
 *
 * Negation patterns:
 *   - "is not", "isn't", "does not", "doesn't"
 *   - "no longer", "never", "not"
 */
export class KeywordConflictDetector extends BaseConflictDetector {
  public readonly id = 'keyword'

  private static readonly NEGATION_RE = /\b(is not|isn'?t|does not|doesn'?t|no longer|never|not)\b/i

  public async detect(
    incoming: MemoryRecord,
    store: BaseMemoryStore,
    limit = 5,
  ): Promise<ReadonlyArray<Conflict>> {
    // Only check records of the same kind.
    const candidates = await store.search({
      kind: incoming.kind,
      limit: 50,
    })

    const conflicts: Conflict[] = []

    for (const { record: existing } of candidates) {
      if (existing.id === incoming.id) continue

      // Check if one contains a negation of the other's
      // key terms.
      const incomingWords = this.extractKeywords(incoming.content)
      const existingWords = this.extractKeywords(existing.content)

      const incomingNegated = KeywordConflictDetector.NEGATION_RE.test(incoming.content)
      const existingNegated = KeywordConflictDetector.NEGATION_RE.test(existing.content)

      // Conflict: one is negated and they share keywords.
      if (
        (incomingNegated || existingNegated) &&
        this.shareKeywords(incomingWords, existingWords)
      ) {
        conflicts.push({
          existing,
          incoming,
          reason: incomingNegated
            ? `Incoming fact negates existing record "${existing.id}"`
            : `Existing record "${existing.id}" negates incoming fact`,
          confidence: 0.7,
        })
      }
    }

    return conflicts.slice(0, limit)
  }

  private extractKeywords(content: string): string[] {
    return content
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2)
  }

  private shareKeywords(a: string[], b: string[]): boolean {
    return a.some((w) => b.includes(w))
  }
}

// ---------------------------------------------------------------------------
// LLMConflictDetector
// ---------------------------------------------------------------------------

/**
 * Asks the LLM to judge whether two facts contradict each
 * other. Sends both facts and expects a JSON response with
 * `conflict: boolean` and `reason: string`.
 */
export class LLMConflictDetector extends BaseConflictDetector {
  public readonly id = 'llm'
  private readonly provider: MinimalProvider
  private readonly model: string

  public constructor(provider: MinimalProvider, model = 'gpt-4o-mini') {
    super()
    this.provider = provider
    this.model = model
  }

  public async detect(
    incoming: MemoryRecord,
    store: BaseMemoryStore,
    limit = 5,
  ): Promise<ReadonlyArray<Conflict>> {
    const candidates = await store.search({
      kind: incoming.kind,
      limit: 20,
    })

    const conflicts: Conflict[] = []

    for (const { record: existing } of candidates) {
      if (existing.id === incoming.id) continue

      try {
        const response = await this.provider.chat({
          model: this.model,
          messages: [
            {
              role: 'user',
              content: [
                'Do these two facts contradict each other?',
                `Fact A: "${existing.content}"`,
                `Fact B: "${incoming.content}"`,
                'Respond with JSON: {"conflict": true/false, "reason": "..."}',
              ].join('\n'),
            },
          ],
          temperature: 0,
        })

        const text = response.content
        if (!text) continue

        const json = this.parseJson(text)
        if (json?.conflict === true) {
          conflicts.push({
            existing,
            incoming,
            reason: json.reason ?? 'LLM detected contradiction',
            confidence: 0.85,
          })
        }
      } catch {
        // Skip on error.
      }
    }

    return conflicts.slice(0, limit)
  }

  private parseJson(text: string): { conflict?: boolean; reason?: string } | null {
    try {
      const match = text.match(/\{[\s\S]*\}/)
      if (!match) return null
      return JSON.parse(match[0]) as { conflict?: boolean; reason?: string }
    } catch {
      return null
    }
  }
}
