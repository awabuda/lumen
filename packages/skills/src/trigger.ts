/**
 * Skill trigger — decides which skills are relevant for a
 * given user message.
 *
 * Two strategies ship here:
 *   - {@link KeywordTrigger} — fast, deterministic, zero
 *     dependencies. Matches a skill's `triggerWords` against
 *     the user message with case-insensitive substring
 *     matching.
 *   - {@link EmbeddingTrigger} — uses a vector similarity
 *     score between the user message embedding and each
 *     skill's description. Requires an embedding model
 *     (not shipped in this package; the caller provides
 *     an `embed` function).
 *
 * The contract is intentionally tiny. The agent loop calls
 * `trigger(message)` once per turn, then loads the top-K
 * matching skills into the system prompt.
 */

import type { BaseSkill } from './base.js'

/** A triggered skill with a relevance score. */
export interface SkillTriggerResult {
  readonly skill: BaseSkill
  /** Relevance score in [0, 1]. Higher = more relevant. */
  readonly score: number
}

/** The contract every trigger implements. */
export abstract class BaseSkillTrigger {
  /** Stable identifier for the implementation. */
  public abstract readonly id: string

  /**
   * Return up to `topK` skills relevant to the message,
   * ordered by descending relevance.
   */
  public abstract trigger(
    message: string,
    skills: ReadonlyArray<BaseSkill>,
    topK?: number,
  ): Promise<ReadonlyArray<SkillTriggerResult>>
}

// ---------------------------------------------------------------------------
// KeywordTrigger — fast, deterministic
// ---------------------------------------------------------------------------

/**
 * Matches a skill's `triggerWords` against the user message
 * with case-insensitive substring matching. Each matching
 * word contributes 1/n to the score, where n is the total
 * number of trigger words for that skill.
 *
 * Example: a skill with `triggerWords: ['git', 'commit']`
 * gets score 0.5 if the message contains 'git' but not
 * 'commit', and score 1.0 if it contains both.
 */
export class KeywordTrigger extends BaseSkillTrigger {
  public readonly id = 'keyword'

  public async trigger(
    message: string,
    skills: ReadonlyArray<BaseSkill>,
    topK = 5,
  ): Promise<ReadonlyArray<SkillTriggerResult>> {
    const lower = message.toLowerCase()
    const scored: SkillTriggerResult[] = []

    for (const skill of skills) {
      const words = skill.triggerWords
      if (!words || words.length === 0) continue
      let matches = 0
      for (const word of words) {
        if (lower.includes(word.toLowerCase())) matches += 1
      }
      if (matches > 0) {
        scored.push({ skill, score: matches / words.length })
      }
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }
}

// ---------------------------------------------------------------------------
// EmbeddingTrigger — vector similarity
// ---------------------------------------------------------------------------

/**
 * Uses an embedding function to compute the cosine similarity
 * between the user message and each skill's description. The
 * caller provides `embed` — typically a call to an OpenAI or
 * Ollama embedding endpoint.
 *
 * If `embed` throws or returns an empty array, the trigger
 * returns an empty result set (no crash).
 */
export class EmbeddingTrigger extends BaseSkillTrigger {
  public readonly id = 'embedding'
  private readonly embed: (text: string) => Promise<ReadonlyArray<number>>

  public constructor(embed: (text: string) => Promise<ReadonlyArray<number>>) {
    super()
    this.embed = embed
  }

  public async trigger(
    message: string,
    skills: ReadonlyArray<BaseSkill>,
    topK = 5,
  ): Promise<ReadonlyArray<SkillTriggerResult>> {
    try {
      const msgEmb = await this.embed(message)
      if (msgEmb.length === 0) return []

      const scored: SkillTriggerResult[] = []
      for (const skill of skills) {
        const descEmb = await this.embed(skill.description)
        if (descEmb.length === 0) continue
        const score = cosineSimilarity(msgEmb, descEmb)
        scored.push({ skill, score })
      }

      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, topK)
    } catch {
      return []
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Cosine similarity between two equal-length number arrays. */
const cosineSimilarity = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): number => {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}
