/**
 * Reflection — post-run fact extraction from the agent's
 * conversation history.
 *
 * After every agent run, the reflection pipeline:
 *   1. Takes the last N assistant messages.
 *   2. Extracts structured facts (id, kind, content, trust).
 *   3. Persists them into the {@link BaseMemoryStore}.
 *
 * Two strategies ship here:
 *   - {@link RuleBasedReflector} — regex-based extraction
 *     of "I learned that …" and "The user prefers …"
 *     patterns. Zero dependencies, fast, deterministic.
 *   - {@link LLMReflector} — asks the LLM to extract facts
 *     from the conversation. Requires a provider.
 *
 * The contract is intentionally tiny. The agent loop calls
 * `reflect(messages)` after every run and persists the
 * results.
 */

import type { BaseMemoryStore, MemoryRecord } from '@lumen/core'

/** Minimal message type — mirrors @lumen/core's message types. */
interface ChatMessage {
  readonly role: string
  readonly content: string
  readonly toolName?: string
}

/** Minimal provider type — mirrors @lumen/core's BaseProvider. */
interface MinimalProvider {
  chat(opts: { model: string; messages: ChatMessage[]; temperature?: number }): Promise<{
    content: string
  }>
}

/** A single extracted fact. */
export interface ExtractedFact {
  /** Stable id, derived from content hash. */
  readonly id: string
  /** Fact kind (e.g. 'fact', 'preference', 'learning'). */
  readonly kind: string
  /** Human-readable fact content. */
  readonly content: string
  /** Confidence in [0, 1]. */
  readonly trust: number
  /** Free-form tags. */
  readonly tags: ReadonlyArray<string>
}

/** The contract every reflector implements. */
export abstract class BaseReflector {
  /** Stable identifier for the implementation. */
  public abstract readonly id: string

  /**
   * Extract facts from the last N messages and persist
   * them into the store. Returns the number of facts
   * that were newly persisted (deduplicated by id).
   */
  public abstract reflect(
    messages: ReadonlyArray<ChatMessage>,
    store: BaseMemoryStore,
  ): Promise<number>
}

// ---------------------------------------------------------------------------
// RuleBasedReflector — regex patterns
// ---------------------------------------------------------------------------

/**
 * Extracts facts from assistant messages using simple
 * regex patterns. Designed for deterministic, offline
 * operation — no LLM call needed.
 *
 * Recognised patterns:
 *   - "I learned that …" → kind='learning', trust=0.6
 *   - "The user prefers …" → kind='preference', trust=0.7
 *   - "Remember: …" → kind='fact', trust=0.8
 *   - "Key insight: …" → kind='insight', trust=0.5
 */
export class RuleBasedReflector extends BaseReflector {
  public readonly id = 'rule-based'

  private static readonly PATTERNS: ReadonlyArray<{
    readonly regex: RegExp
    readonly kind: string
    readonly trust: number
  }> = [
    { regex: /\bI learned that\s+(.+?)[.!]\s*$/gim, kind: 'learning', trust: 0.6 },
    { regex: /\bThe user prefers\s+(.+?)[.!]\s*$/gim, kind: 'preference', trust: 0.7 },
    { regex: /\bRemember:\s*(.+?)[.!]\s*$/gim, kind: 'fact', trust: 0.8 },
    { regex: /\bKey insight:\s*(.+?)[.!]\s*$/gim, kind: 'insight', trust: 0.5 },
  ]

  public async reflect(
    messages: ReadonlyArray<ChatMessage>,
    store: BaseMemoryStore,
  ): Promise<number> {
    let count = 0
    for (const msg of messages) {
      if (msg.role !== 'assistant') continue
      const content = typeof msg.content === 'string' ? msg.content : ''
      for (const pattern of RuleBasedReflector.PATTERNS) {
        const matches = content.matchAll(pattern.regex)
        for (const match of matches) {
          const fact = match[1]?.trim()
          if (!fact || fact.length < 3) continue
          const id = hashId(fact)
          const existing = await store.get(id)
          if (existing) continue
          await store.put({
            id,
            kind: pattern.kind,
            content: fact,
            trust: pattern.trust,
            tags: [pattern.kind],
          })
          count += 1
        }
      }
    }
    return count
  }
}

// ---------------------------------------------------------------------------
// LLMReflector — ask the model
// ---------------------------------------------------------------------------

/**
 * Asks the LLM to extract facts from the conversation.
 * Sends a short system prompt instructing the model to
 * output a JSON array of facts. Parses the response and
 * persists each fact.
 *
 * If the LLM call fails or returns unparseable output,
 * the reflector returns 0 (no crash).
 */
export class LLMReflector extends BaseReflector {
  public readonly id = 'llm'
  private readonly provider: MinimalProvider
  private readonly model: string

  public constructor(provider: MinimalProvider, model = 'gpt-4o-mini') {
    super()
    this.provider = provider
    this.model = model
  }

  public async reflect(
    messages: ReadonlyArray<ChatMessage>,
    store: BaseMemoryStore,
  ): Promise<number> {
    const prompt = this.buildPrompt(messages)
    try {
      const response = await this.provider.chat({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
      })
      const text = response.content
      if (!text) return 0
      const facts = this.parseFacts(text)
      let count = 0
      for (const fact of facts) {
        const id = hashId(fact.content)
        const existing = await store.get(id)
        if (existing) continue
        await store.put({
          id,
          kind: fact.kind,
          content: fact.content,
          trust: fact.trust,
          tags: fact.tags,
        })
        count += 1
      }
      return count
    } catch {
      return 0
    }
  }

  private buildPrompt(messages: ReadonlyArray<ChatMessage>): string {
    const transcript = messages
      .filter((m) => m.role === 'assistant' || m.role === 'user')
      .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`)
      .join('\n')
    return `Extract key facts from this conversation. Output a JSON array of objects with fields: kind, content, trust (0-1), tags (string array).\n\n${transcript}\n\nJSON:`
  }

  private parseFacts(text: string): ExtractedFact[] {
    try {
      // Find the first JSON array in the response.
      const match = text.match(/\[[\s\S]*\]/)
      if (!match) return []
      const parsed = JSON.parse(match[0]) as unknown[]
      if (!Array.isArray(parsed)) return []
      return parsed
        .filter(
          (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
        )
        .map((item) => ({
          id: hashId(String(item.content ?? '')),
          kind: String(item.kind ?? 'fact'),
          content: String(item.content ?? ''),
          trust: Math.min(1, Math.max(0, Number(item.trust ?? 0.5))),
          tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        }))
        .filter((f) => f.content.length > 0)
    } catch {
      return []
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simple FNV-1a hash for deduplication. */
const hashId = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `fact-${(h >>> 0).toString(16)}`
}
