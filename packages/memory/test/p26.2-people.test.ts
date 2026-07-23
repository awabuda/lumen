/**
 * P26.2 (bug.md #46) \u2014 People-aware memory: helper + schema.
 *
 * Pins the data-layer surface so a future cross-encoder
 * (P27+) can plug in without schema migrations. The
 * helper is a structured store today, not a People-aware
 * surface \u2014 the mention-parser is a future ticket.
 */

import { describe, expect, it } from 'vitest'

import {
  addAlias,
  addRelationship,
  createPerson,
  findPersonByHandle,
  incrementMention,
  PeopleRegistry,
  PersonRecordSchema,
} from '../src/people.js'

const alice = createPerson({ id: 'p1', label: 'Alice Chen' })
const bob = createPerson({
  id: 'p2',
  label: 'Bob Liu',
  aliases: ['@bob', 'bob'],
})

describe('P26.2 \u2014 PersonRecordSchema', () => {
  it('accepts a minimal valid record', () => {
    expect(PersonRecordSchema.safeParse(alice).success).toBe(true)
  })

  it('rejects an empty id', () => {
    expect(
      PersonRecordSchema.safeParse({ ...alice, id: '' }).success,
    ).toBe(false)
  })

  it('rejects unknown fields (strict)', () => {
    expect(
      PersonRecordSchema.safeParse({ ...alice, rogue: 'x' }).success,
    ).toBe(false)
  })

  it('rejects negative mentionCount', () => {
    expect(
      PersonRecordSchema.safeParse({ ...alice, mentionCount: -1 }).success,
    ).toBe(false)
  })
})

describe('P26.2 \u2014 helpers', () => {
  it('createPerson seeds defaults for aliases / relationships / lastSeenMs', () => {
    expect(alice.aliases).toEqual([])
    expect(alice.relationships).toEqual([])
    expect(alice.mentionCount).toBe(0)
    expect(typeof alice.lastSeenMs).toBe('number')
  })

  it('incrementMention bumps count + lastSeenMs', () => {
    const after = incrementMention(alice, () => 200)
    expect(after.mentionCount).toBe(1)
    expect(after.lastSeenMs).toBe(200)
  })

  it('addAlias appends (no dedup)', () => {
    const after = addAlias(alice, '@alice')
    expect(after.aliases).toEqual(['@alice'])
  })

  it('addRelationship appends (no dedup)', () => {
    const after = addRelationship(alice, 'works on lumen')
    expect(after.relationships).toEqual(['works on lumen'])
  })

  it('findPersonByHandle does case-insensitive match against label', () => {
    expect(findPersonByHandle([alice, bob], 'ALICE CHEN')).toBe(alice)
  })

  it('findPersonByHandle does case-insensitive match against alias', () => {
    expect(findPersonByHandle([alice, bob], '@BOB')).toBe(bob)
  })

  it('findPersonByHandle returns undefined on no match', () => {
    expect(findPersonByHandle([alice, bob], 'carol')).toBeUndefined()
  })
})

describe('P26.2 \u2014 PeopleRegistry', () => {
  it('upsert creates a new person on first call', () => {
    const r = new PeopleRegistry()
    const out = r.upsert(alice)
    expect(out.id).toBe('p1')
    expect(r.list()).toHaveLength(1)
  })

  it('upsert adds the incoming mentionCount as a delta on the second call', () => {
    const r = new PeopleRegistry()
    r.upsert(createPerson({ id: 'p1', label: 'Alice Chen', now: () => 100 }))
    // Second upsert brings a +1 mention + a new alias +
    // a later lastSeenMs.
    r.upsert(
      incrementMention(
        addAlias(createPerson({ id: 'p1', label: 'Alice Chen', now: () => 100 }), '@alice'),
        () => 999,
      ),
    )
    const merged = r.get('p1')
    // 0 (stored) + 1 (delta) = 1
    expect(merged?.mentionCount).toBe(1)
    // lastSeenMs is the max of the two lastSeenMs; both
    // share createPerson's seed (100), the increment
    // updates to 999.
    expect(merged?.lastSeenMs).toBe(999)
    expect(merged?.aliases).toEqual(['@alice'])
  })

  it('upsert chains cleanly across three calls (delta accumulates)', () => {
    const r = new PeopleRegistry()
    r.upsert(createPerson({ id: 'p1', label: 'Alice Chen', now: () => 50 }))
    r.upsert(
      incrementMention(
        createPerson({ id: 'p1', label: 'Alice Chen', now: () => 50 }),
        () => 100,
      ),
    ) // +1 -> 1
    r.upsert(
      incrementMention(
        createPerson({ id: 'p1', label: 'Alice Chen', now: () => 50 }),
        () => 200,
      ),
    ) // +1 -> 2
    expect(r.get('p1')?.mentionCount).toBe(2)
  })

  it('upsert de-dups aliases and relationships', () => {
    const r = new PeopleRegistry()
    r.upsert(alice)
    r.upsert(addAlias(addAlias(alice, '@alice'), 'alice-2'))
    const merged = r.get('p1')
    expect(new Set(merged?.aliases ?? [])).toEqual(
      new Set(['@alice', 'alice-2']),
    )
  })

  it('list sorts by lastSeenMs descending', () => {
    const r = new PeopleRegistry()
    r.upsert(createPerson({ id: 'old', label: 'Old', now: () => 100 }))
    r.upsert(createPerson({ id: 'new', label: 'New', now: () => 200 }))
    expect(r.list().map((p) => p.id)).toEqual(['new', 'old'])
  })

  it('find() reuses findPersonByHandle against the registry contents', () => {
    const r = new PeopleRegistry()
    r.upsert(
      createPerson({ id: 'p1', label: 'Alice Chen', now: () => 100 }),
    )
    r.upsert(
      createPerson({ id: 'p2', label: 'Bob Liu', aliases: ['@bob', 'bob'], now: () => 100 }),
    )
    expect(r.find('@alice')).toBeUndefined()
    // Alice has no '@alice' alias by default; lookup by
    // the label.
    expect(r.find('Alice Chen')?.id).toBe('p1')
    // Bob has '@bob' as an alias.
    expect(r.find('@bob')?.id).toBe('p2')
  })

  it('get() returns undefined on unknown id', () => {
    expect(new PeopleRegistry().get('nope')).toBeUndefined()
  })
})