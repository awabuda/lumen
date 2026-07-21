/**
 * Reflection — post-run fact extraction from the agent's conversation history.
 *
 * P19.2.5 refactor note:
 *   The original module exported an abstract `BaseReflector` class plus
 *   `RuleBasedReflector` / `LLMReflector` classes. P19+ rule 15 replaces
 *   that inheritance pattern with an interface + helper functions.
 *   Concrete implementations are plain objects returned by factories.
 */

import type { BaseMemoryStore } from '@lumen/core'

/** Minimal message type — mirrors @lumen/core's message types. */
export interface ChatMessage {
  readonly role: string
  readonly content: string
  readonly toolName?: string
}

/** Minimal provider type — mirrors @lumen/core's BaseProvider. */
export interface MinimalReflectionProvider {
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
export interface BaseReflector {
  /** Stable identifier for the implementation. */
  readonly id: string

  /**
   * Extract facts from the last N messages and persist them into the store.
   * Returns the number of facts that were newly persisted (deduplicated by id).
   */
  reflect(messages: ReadonlyArray<ChatMessage>, store: BaseMemoryStore): Promise<number>
}

const RULE_PATTERNS: ReadonlyArray<{
  readonly regex: RegExp
  readonly kind: string
  readonly trust: number
}> = [
  { regex: /\bI learned that\s+(.+?)[.!]\s*$/gim, kind: 'learning', trust: 0.6 },
  { regex: /\bThe user prefers\s+(.+?)[.!]\s*$/gim, kind: 'preference', trust: 0.7 },
  { regex: /\bRemember:\s*(.+?)[.!]\s*$/gim, kind: 'fact', trust: 0.8 },
  { regex: /\bKey insight:\s*(.+?)[.!]\s*$/gim, kind: 'insight', trust: 0.5 },
]

/** Simple FNV-1a hash for deduplication. */
export const hashFactId = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `fact-${(h >>> 0).toString(16)}`
}

/** Extract facts from assistant messages using deterministic regex rules. */
export const ruleBasedReflect = (
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyArray<ExtractedFact> => {
  const facts: ExtractedFact[] = []
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue
    const content = typeof msg.content === 'string' ? msg.content : ''
    for (const pattern of RULE_PATTERNS) {
      const matches = content.matchAll(pattern.regex)
      for (const match of matches) {
        const fact = match[1]?.trim()
        if (!fact || fact.length < 3) continue
        facts.push({
          id: hashFactId(fact),
          kind: pattern.kind,
          content: fact,
          trust: pattern.trust,
          tags: [pattern.kind],
        })
      }
    }
  }
  return facts
}

/** Persist extracted facts, deduplicating by id.
 *
 * P23.9 (fix #26) — parallelize the dedup + put path with
 * `Promise.all`. Pre-P23.9 a 50-fact batch did 100 sequential
 * round-trips (one get per fact + one put per non-dup); the
 * dedup step is read-only and parallel-safe, and the put
 * step is idempotent on duplicate ids (which we've already
 * filtered). The race-condition window is bounded by the
 * dedup pass — two facts with the same id both see
 * "existing" and both skip; the race is benign.
 */
export const persistExtractedFacts = async (
  facts: ReadonlyArray<ExtractedFact>,
  store: BaseMemoryStore,
): Promise<number> => {
  // Dedup pass: gather the set of ids that are NOT already
  // in the store, in parallel.
  const existing = await Promise.all(facts.map((f) => store.get(f.id)))
  const novel: ExtractedFact[] = []
  for (let i = 0; i < facts.length; i += 1) {
    const fact = facts[i]
    const dup = existing[i]
    if (!fact || dup) continue
    novel.push(fact)
  }
  if (novel.length === 0) return 0
  // Write pass: parallel put, idempotent on the deduped ids.
  await Promise.all(
    novel.map((fact) =>
      store.put({
        id: fact.id,
        kind: fact.kind,
        content: fact.content,
        trust: fact.trust,
        tags: fact.tags,
      }),
    ),
  )
  return novel.length
}

/** Create a deterministic, regex-based reflector. */
export const createRuleBasedReflector = (): BaseReflector => ({
  id: 'rule-based',
  async reflect(messages, store): Promise<number> {
    return persistExtractedFacts(ruleBasedReflect(messages), store)
  },
})

/** Backwards-compatible function alias for the old class export name. */
export const RuleBasedReflector = createRuleBasedReflector

/** Build the prompt used by the LLM reflector helper. */
export const buildReflectionPrompt = (messages: ReadonlyArray<ChatMessage>): string => {
  const transcript = messages
    .filter((m) => m.role === 'assistant' || m.role === 'user')
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : ''}`)
    .join('\n')
  return `Extract key facts from this conversation. Output a JSON array of objects with fields: kind, content, trust (0-1), tags (string array).\n\n${transcript}\n\nJSON:`
}

/** Parse a JSON-array LLM reflector response into facts. */
export const parseReflectionFacts = (text: string): ReadonlyArray<ExtractedFact> => {
  try {
    const match = text.match(/\[[\s\S]*\]/)
    if (!match) return []
    const parsed = JSON.parse(match[0]) as unknown[]
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((item) => {
        const content = String(item.content ?? '')
        return {
          id: hashFactId(content),
          kind: String(item.kind ?? 'fact'),
          content,
          trust: Math.min(1, Math.max(0, Number(item.trust ?? 0.5))),
          tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
        }
      })
      .filter((f) => f.content.length > 0)
  } catch {
    return []
  }
}

/** Ask an LLM provider to extract facts from messages. */
export const llmReflect = async (
  messages: ReadonlyArray<ChatMessage>,
  provider: MinimalReflectionProvider,
  model = 'gpt-4o-mini',
): Promise<ReadonlyArray<ExtractedFact>> => {
  try {
    const response = await provider.chat({
      model,
      messages: [{ role: 'user', content: buildReflectionPrompt(messages) }],
      temperature: 0,
    })
    if (!response.content) return []
    return parseReflectionFacts(response.content)
  } catch {
    return []
  }
}

/** Create an LLM-backed reflector. */
export const createLLMReflector = (
  provider: MinimalReflectionProvider,
  model = 'gpt-4o-mini',
): BaseReflector => ({
  id: 'llm',
  async reflect(messages, store): Promise<number> {
    return persistExtractedFacts(await llmReflect(messages, provider, model), store)
  },
})

/** Backwards-compatible function alias for the old class export name. */
export const LLMReflector = createLLMReflector
