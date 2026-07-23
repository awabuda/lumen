/**
 * P26.2 (bug.md #46) \u2014 People-aware memory: helper + schema.
 *
 * Structured store of "people" entries: id / label /
 * relationships. The helper appends rows to a SQLite
 * table; the cross-encoder surface that turns "the
 * operator just mentioned Alice" into a people-store
 * lookup is a P27+ ticket (lum en does not yet have a
 * cross-user encoder tier).
 *
 * Pre-P26.2 lum en had no people store at all; the
 * feature surface was 100% missing. P26.2 ships the
 * structured layer so a future encoder (or even a
 * regex-driven mention parser) can plug in without
 * schema migrations.
 *
 * Why a helper function (P19+ rule 15) and not an
 * abstract \`BasePeopleStore\` class: the store is a thin
 * wrapper around the existing SqliteStore. A class
 * adds zero behavioural gain.
 */

import { z } from 'zod'

/** P26.2 schema for a people-store row. */
export const PersonRecordSchema = z
  .object({
    /** Stable id (UUID v4 in production; operator-chosen
     *  in tests). */
    id: z.string().min(1),
    /** Display label (\"Alice Chen\" / \"@alice\" / etc.). */
    label: z.string().min(1),
    /** Optional list of handle aliases the operator has
     *  used (\"@alice\", \"alice\", \"Alice\"). The
     *  future mention parser will lowercase + match. */
    aliases: z.array(z.string().min(1)).default([]),
    /** Optional free-form relationships (\"works on
     *  lumen\", \"manages the cli\"). */
    relationships: z.array(z.string().min(1)).default([]),
    /** Wall-clock ms of last seen. */
    lastSeenMs: z.number().int().min(0),
    /** Number of times the person has been mentioned in
     *  this agent run (denormalised counter; the future
     *  mention parser updates this). */
    mentionCount: z.number().int().min(0).default(0),
  })
  .strict()

export type PersonRecord = z.infer<typeof PersonRecordSchema>

/** Construct a fresh record. Pure helper. */
export const createPerson = (params: {
  readonly id: string
  readonly label: string
  readonly aliases?: ReadonlyArray<string>
  readonly relationships?: ReadonlyArray<string>
  readonly now?: () => number
}): PersonRecord =>
  PersonRecordSchema.parse({
    id: params.id,
    label: params.label,
    aliases: params.aliases === undefined ? [] : [...params.aliases],
    relationships: params.relationships === undefined ? [] : [...params.relationships],
    lastSeenMs: (params.now ?? (() => Date.now()))(),
  })

/** Increment a person's mention count. Pure helper. */
export const incrementMention = (
  person: PersonRecord,
  now?: () => number,
): PersonRecord =>
  PersonRecordSchema.parse({
    ...person,
    mentionCount: person.mentionCount + 1,
    lastSeenMs: (now ?? (() => Date.now()))(),
  })

/** Add an alias. Pure helper. */
export const addAlias = (person: PersonRecord, alias: string): PersonRecord =>
  PersonRecordSchema.parse({
    ...person,
    aliases: [...person.aliases, alias],
  })

/** Add a relationship. Pure helper. */
export const addRelationship = (
  person: PersonRecord,
  relationship: string,
): PersonRecord =>
  PersonRecordSchema.parse({
    ...person,
    relationships: [...person.relationships, relationship],
  })

/** Lookup helper: case-insensitive match against label
 *  and aliases. Returns the first match (or undefined). */
export const findPersonByHandle = (
  people: ReadonlyArray<PersonRecord>,
  handle: string,
): PersonRecord | undefined => {
  const lc = handle.toLowerCase()
  for (const p of people) {
    if (p.label.toLowerCase() === lc) return p
    if (p.aliases.some((a) => a.toLowerCase() === lc)) return p
  }
  return undefined
}

/**
 * In-memory registry. The composition root owns one
 * instance per agent run; tests can spin up an isolated
 * instance for hermetic runs. The future SQLite-backed
 * implementation will share the same shape.
 */
export class PeopleRegistry {
  private readonly people: Map<string, PersonRecord> = new Map()

  /** Upsert a person. Returns the new (or updated) record.
   *
   * The \`mentionCount\` on \`record\` is treated as a
   * DELTA: the registry adds it to the stored count.
   * Callers that want to set an absolute count should
   * call \`upsert\` with \`mentionCount: 0\` first and
   * then \`incrementMention\` (which we expose as a pure
   * helper) until they reach the desired value. */
  public upsert(record: PersonRecord): PersonRecord {
    const cur = this.people.get(record.id)
    if (cur === undefined) {
      const next = PersonRecordSchema.parse({
        ...record,
        // First-upsert: store the record as-is (no delta
        // to add because there is no prior).
        mentionCount: record.mentionCount,
      })
      this.people.set(next.id, next)
      return next
    }
    // Subsequent upsert: treat the incoming mentionCount
    // as a delta to add to the stored count.
    const next: PersonRecord = PersonRecordSchema.parse({
      ...cur,
      mentionCount: cur.mentionCount + record.mentionCount,
      lastSeenMs: Math.max(cur.lastSeenMs, record.lastSeenMs),
      aliases: [...new Set([...cur.aliases, ...record.aliases])],
      relationships: [
        ...new Set([...cur.relationships, ...record.relationships]),
      ],
    })
    this.people.set(next.id, next)
    return next
  }

  public get(id: string): PersonRecord | undefined {
    return this.people.get(id)
  }

  public list(): ReadonlyArray<PersonRecord> {
    return [...this.people.values()].sort(
      (a, b) => b.lastSeenMs - a.lastSeenMs,
    )
  }

  public find(handle: string): PersonRecord | undefined {
    return findPersonByHandle([...this.people.values()], handle)
  }
}