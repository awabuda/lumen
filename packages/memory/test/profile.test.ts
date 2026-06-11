/** Tests for the profile builder. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryStore } from '../src/in-memory-store.js'
import { ProfileBuilder } from '../src/profile.js'

let store: InMemoryStore

beforeEach(async () => {
  store = new InMemoryStore()
  await store.init()
})

afterEach(async () => {
  await store.dispose()
})

describe('ProfileBuilder', () => {
  it('builds a profile from preference facts', async () => {
    await store.put({
      id: 'p1',
      kind: 'preference',
      content: 'User prefers concise responses',
      trust: 0.7,
      tags: [],
    })
    await store.put({
      id: 'p2',
      kind: 'preference',
      content: 'User prefers TypeScript',
      trust: 0.8,
      tags: [],
    })

    const builder = new ProfileBuilder(store)
    const profile = await builder.build()

    expect(profile.entries).toBeDefined()
    const keys = Object.keys(profile.entries)
    expect(keys.length).toBeGreaterThan(0)
  })

  it('picks the highest-trust entry for each key', async () => {
    await store.put({
      id: 'p1',
      kind: 'preference',
      content: 'User prefers concise responses',
      trust: 0.5,
      tags: [],
    })
    await store.put({
      id: 'p2',
      kind: 'preference',
      content: 'User prefers concise responses',
      trust: 0.9,
      tags: [],
    })

    const builder = new ProfileBuilder(store)
    const profile = await builder.build()

    const key = 'user_prefers_concise'
    expect(profile.entries[key]?.trust).toBe(0.9)
  })

  it('persists the profile to the store', async () => {
    await store.put({
      id: 'p1',
      kind: 'preference',
      content: 'User prefers concise responses',
      trust: 0.7,
      tags: [],
    })

    const builder = new ProfileBuilder(store)
    await builder.build()

    const loaded = await builder.load()
    expect(loaded).toBeDefined()
    expect(loaded?.id).toBe('default')
  })

  it('returns undefined when no profile exists', async () => {
    const builder = new ProfileBuilder(store)
    const profile = await builder.load()
    expect(profile).toBeUndefined()
  })
})
