/** Tests for the reflector. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryStore } from '../src/in-memory-store.js'
import {
  createRuleBasedReflector,
  hashFactId,
  persistExtractedFacts,
  ruleBasedReflect,
} from '../src/reflector.js'

let store: InMemoryStore

beforeEach(async () => {
  store = new InMemoryStore()
  await store.init()
})

afterEach(async () => {
  await store.dispose()
})

describe('RuleBasedReflector', () => {
  it('extracts "I learned that" facts', async () => {
    const reflector = createRuleBasedReflector()
    const count = await reflector.reflect(
      [{ role: 'assistant', content: 'I learned that Paris is the capital of France.' }],
      store,
    )
    expect(count).toBe(1)
    const records = await store.search({ kind: 'learning' })
    expect(records[0]?.record.content).toContain('Paris')
  })

  it('extracts "The user prefers" facts', async () => {
    const reflector = createRuleBasedReflector()
    await reflector.reflect(
      [{ role: 'assistant', content: 'The user prefers concise responses.' }],
      store,
    )
    const records = await store.search({ kind: 'preference' })
    expect(records[0]?.record.content).toContain('concise')
  })

  it('extracts "Remember:" facts', async () => {
    const reflector = createRuleBasedReflector()
    await reflector.reflect(
      [{ role: 'assistant', content: 'Remember: the project uses pnpm workspaces.' }],
      store,
    )
    const records = await store.search({ kind: 'fact' })
    expect(records[0]?.record.content).toContain('pnpm')
  })

  it('skips user messages', async () => {
    const reflector = createRuleBasedReflector()
    const count = await reflector.reflect(
      [{ role: 'user', content: 'I learned that this is a test.' }],
      store,
    )
    expect(count).toBe(0)
  })

  it('deduplicates by content hash', async () => {
    const reflector = createRuleBasedReflector()
    await reflector.reflect([{ role: 'assistant', content: 'Remember: the sky is blue.' }], store)
    const count2 = await reflector.reflect(
      [{ role: 'assistant', content: 'Remember: the sky is blue.' }],
      store,
    )
    expect(count2).toBe(0)
  })

  it('skips facts shorter than 3 characters', async () => {
    const reflector = createRuleBasedReflector()
    const count = await reflector.reflect([{ role: 'assistant', content: 'Remember: ab.' }], store)
    expect(count).toBe(0)
  })
})

describe('reflector helper functions', () => {
  it('ruleBasedReflect returns facts without requiring a store', () => {
    const facts = ruleBasedReflect([
      { role: 'assistant', content: 'Key insight: middleware should be composable.' },
    ])
    expect(facts).toHaveLength(1)
    expect(facts[0]?.kind).toBe('insight')
    expect(facts[0]?.content).toContain('middleware')
  })

  it('persistExtractedFacts deduplicates by id', async () => {
    const fact = {
      id: hashFactId('the same fact'),
      kind: 'fact',
      content: 'the same fact',
      trust: 0.8,
      tags: ['fact'],
    }
    const first = await persistExtractedFacts([fact], store)
    const second = await persistExtractedFacts([fact], store)
    expect(first).toBe(1)
    expect(second).toBe(0)
  })
})
