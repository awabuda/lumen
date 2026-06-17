/** Tests for the conflict detector. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { KeywordConflictDetector } from '../src/conflict-detector.js'
import { InMemoryStore } from '../src/in-memory-store.js'

let store: InMemoryStore

beforeEach(async () => {
  store = new InMemoryStore()
  await store.init()
})

afterEach(async () => {
  await store.dispose()
})

describe('KeywordConflictDetector', () => {
  it('detects negation conflict between two facts', async () => {
    await store.put({
      id: 'a',
      kind: 'fact',
      content: 'The sky is blue',
      trust: 0.8,
      tags: [],
    })
    const detector = new KeywordConflictDetector()
    const conflicts = await detector.detect(
      {
        id: 'b',
        kind: 'fact',
        content: 'The sky is not blue',
        trust: 0.5,
        tags: [],
        createdAt: 0,
        updatedAt: 0,
      },
      store,
    )
    expect(conflicts.length).toBeGreaterThan(0)
    expect(conflicts[0]?.existing.id).toBe('a')
  })

  it('returns empty when no conflict exists', async () => {
    await store.put({
      id: 'a',
      kind: 'fact',
      content: 'The sky is blue',
      trust: 0.8,
      tags: [],
    })
    const detector = new KeywordConflictDetector()
    const conflicts = await detector.detect(
      {
        id: 'b',
        kind: 'fact',
        content: 'The ocean is blue',
        trust: 0.5,
        tags: [],
        createdAt: 0,
        updatedAt: 0,
      },
      store,
    )
    expect(conflicts).toEqual([])
  })

  it('skips records of different kinds', async () => {
    await store.put({
      id: 'a',
      kind: 'preference',
      content: 'The sky is not blue',
      trust: 0.8,
      tags: [],
    })
    const detector = new KeywordConflictDetector()
    const conflicts = await detector.detect(
      {
        id: 'b',
        kind: 'fact',
        content: 'The sky is blue',
        trust: 0.5,
        tags: [],
        createdAt: 0,
        updatedAt: 0,
      },
      store,
    )
    expect(conflicts).toEqual([])
  })

  it('skips the same record', async () => {
    await store.put({
      id: 'a',
      kind: 'fact',
      content: 'The sky is not blue',
      trust: 0.8,
      tags: [],
    })
    const detector = new KeywordConflictDetector()
    const conflicts = await detector.detect(
      {
        id: 'a',
        kind: 'fact',
        content: 'The sky is not blue',
        trust: 0.8,
        tags: [],
        createdAt: 0,
        updatedAt: 0,
      },
      store,
    )
    expect(conflicts).toEqual([])
  })
})
