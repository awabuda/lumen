/**
 * Phase B.1 / P34.1 — markdown-bridge helper tests.
 *
 * Pure-data functions; no fs / sqlite. Round-trip the
 * SerializedFact ↔ Markdown projection and assert the
 * determinism + tolerance properties.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRUST_THRESHOLD,
  type SerializedFact,
  buildMarkdownDocument,
  parseMarkdownFacts,
  serializeFactsToMarkdown,
} from '../src/markdown-bridge.js'

const fact = (overrides: Partial<SerializedFact> = {}): SerializedFact => ({
  id: 'fact-1',
  kind: 'preference',
  content: 'Postgres conn strings go in ~/.pgpass',
  trust: 0.7,
  tags: ['security', 'pg'],
  createdAtIso: '2026-08-04T12:00:00.000Z',
  ...overrides,
})

describe('serializeFactsToMarkdown', () => {
  it('emits the schema-version frontmatter', () => {
    const md = serializeFactsToMarkdown([fact()], { generatedAtIso: '2026-08-04T12:00:00.000Z' })
    expect(md).toContain('<!-- lumen:memory-md v1 -->')
    expect(md).toContain('<!-- generated: 2026-08-04T12:00:00.000Z -->')
  })

  it('groups facts by kind with stable alphabetical section order', () => {
    const md = serializeFactsToMarkdown(
      [
        fact({ id: 'a', kind: 'preference' }),
        fact({ id: 'b', kind: 'agent', content: 'agent fact' }),
        fact({ id: 'c', kind: 'agent', content: 'agent fact 2' }),
      ],
      { generatedAtIso: 'now' },
    )
    const agentIdx = md.indexOf('## agent')
    const prefIdx = md.indexOf('## preference')
    expect(agentIdx).toBeGreaterThan(0)
    expect(prefIdx).toBeGreaterThan(agentIdx)
  })

  it('formats the content + id + trust + tags inline', () => {
    const md = serializeFactsToMarkdown([fact()], { generatedAtIso: 'now' })
    expect(md).toContain(
      '- Postgres conn strings go in ~/.pgpass (id=fact-1, trust=0.70, tags=security,pg)',
    )
  })

  it('omits the tags suffix when no tags are present', () => {
    const md = serializeFactsToMarkdown([fact({ tags: [] })], { generatedAtIso: 'now' })
    expect(md).toContain('trust=0.70)')
    expect(md).not.toContain('tags=')
  })

  it('renders the profile when meta.profile is set', () => {
    const md = serializeFactsToMarkdown([fact()], {
      generatedAtIso: 'now',
      profile: 'assistant',
    })
    expect(md).toContain('<!-- profile: assistant -->')
  })
})

describe('parseMarkdownFacts', () => {
  it('round-trips a single fact', () => {
    const original = fact()
    const md = serializeFactsToMarkdown([original], { generatedAtIso: 'now' })
    const parsed = parseMarkdownFacts(md)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.id).toBe(original.id)
    expect(parsed[0]?.kind).toBe(original.kind)
    expect(parsed[0]?.content).toBe(original.content)
    expect(parsed[0]?.trust).toBe(0.7)
    expect(parsed[0]?.tags).toEqual(['security', 'pg'])
  })

  it('round-trips multiple facts', () => {
    const facts = [
      fact({ id: 'a', kind: 'preference' }),
      fact({ id: 'b', kind: 'agent', content: 'agent note' }),
      fact({ id: 'c', kind: 'user', content: 'user note', trust: 0.9 }),
    ]
    const md = serializeFactsToMarkdown(facts, { generatedAtIso: 'now' })
    const parsed = parseMarkdownFacts(md)
    expect(parsed.map((f) => f.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('tolerates hand-edited prose (no metadata on the line)', () => {
    const md = `## preference
- this is a hand-edited note

## agent
- another prose line
`
    const parsed = parseMarkdownFacts(md)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]?.content).toBe('this is a hand-edited note')
    expect(parsed[1]?.content).toBe('another prose line')
    expect(parsed[0]?.id.startsWith('md-')).toBe(true)
  })

  it('skips lines outside a section', () => {
    const md = `- orphaned fact line
## preference
- kept fact
`
    const parsed = parseMarkdownFacts(md)
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.content).toBe('kept fact')
  })

  it('tolerates broken trust values (treats as prose without metadata)', () => {
    // The metadata comment is parsed by regex. When the
    // trust literal is non-numeric, the regex fails to
    // match — the line falls through to the "synthesize"
    // branch and is kept as a hand-edited prose fact with
    // a deterministic id. We never silently drop a line
    // because the operator's hand-edit looked wrong;
    // round-trip with a fresh id is recoverable on the
    // next sync.
    const md = `## preference
- broken (id=x, trust=abc, tags=t)
- good (id=y, trust=0.50)
`
    const parsed = parseMarkdownFacts(md)
    expect(parsed).toHaveLength(2)
    const good = parsed.find((f) => f.id === 'y')
    expect(good).toBeDefined()
    const synthesized = parsed.find((f) => f.id !== 'y')
    expect(synthesized?.id.startsWith('md-')).toBe(true)
    expect(synthesized?.trust).toBe(0.6)
  })
})

describe('buildMarkdownDocument', () => {
  it('filters below the default trust threshold', () => {
    const md = buildMarkdownDocument({
      facts: [fact({ id: 'hi', trust: 0.7 }), fact({ id: 'lo', trust: 0.3 })],
      meta: { generatedAtIso: 'now' },
    })
    expect(md).toContain('id=hi')
    expect(md).not.toContain('id=lo')
  })

  it('respects a custom trust threshold', () => {
    const md = buildMarkdownDocument({
      facts: [fact({ id: 'mid', trust: 0.5 })],
      meta: { generatedAtIso: 'now' },
      trustThreshold: 0.4,
    })
    expect(md).toContain('id=mid')
  })

  it('default threshold matches the documented constant', () => {
    expect(DEFAULT_TRUST_THRESHOLD).toBe(0.6)
  })
})
