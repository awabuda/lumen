/**
 * Phase B.1 / P34.1 — Memory markdown bridge helpers.
 *
 * Pure-data functions that translate between `MemoryRecord[]`
 * (the structured SqliteStore shape) and a deterministic
 * Markdown projection. The Markdown is a *projection* — the
 * SqliteStore is the source of truth; this module never
 * owns state and has no `node:fs` imports (per P19+ tier
 * isolation, `apps/cli` owns the bridge lifecycle).
 *
 * The on-disk shape is a frontmatter-free Markdown list.
 * One section per `kind` (e.g. `## Agent`, `## User`,
 * `## Preference`), each item:
 *
 *   - <content> (id=<id>, trust=<0.X>, tags=<csv>)
 *
 * The id + trust + tags metadata is encoded inline so the
 * file is round-trippable without external state. When the
 * operator hand-edits, the bridge re-ingests via
 * {@link parseMarkdownFacts} and the original SQLite row
 * stays the authoritative copy.
 */

/** Current on-disk schema marker. Bumped on shape breaks. */
export const SERIALIZED_MARKDOWN_SCHEMA_VERSION = 1

/**
 * Minimal fact shape the bridge round-trips. Subset of
 * `MemoryRecord` — fields like `embedding` and `metadata`
 * are intentionally omitted (markdown is human-readable,
 * not a vector / JSON dump).
 */
export interface SerializedFact {
  readonly id: string
  readonly kind: string
  readonly content: string
  readonly trust: number
  readonly tags: ReadonlyArray<string>
  readonly createdAtIso: string
}

export interface MarkdownDocumentMeta {
  readonly generatedAtIso: string
  readonly profile?: string
  readonly schemaVersion?: number
}

/**
 * Default trust threshold below which a record is NOT
 * rendered into markdown. P34.1 §4 — the operator can
 * inspect low-trust rows via `lumen reflect meta` instead.
 */
export const DEFAULT_TRUST_THRESHOLD = 0.6

/**
 * Serialize a list of facts (already filtered by trust
 * threshold + kind) into a deterministic Markdown document.
 *
 * The output is stable byte-for-byte given the same input
 * order + meta: callers that diff markdown against
 * `git diff` will see noise only when the operator
 * hand-edits.
 */
export const serializeFactsToMarkdown = (
  facts: ReadonlyArray<SerializedFact>,
  meta: MarkdownDocumentMeta,
): string => {
  const lines: string[] = []
  lines.push('<!-- lumen:memory-md v1 -->')
  lines.push(`<!-- generated: ${meta.generatedAtIso} -->`)
  if (meta.profile !== undefined) {
    lines.push(`<!-- profile: ${meta.profile} -->`)
  }
  lines.push('')
  // Group by kind so each `## <kind>` section reads as a
  // table of contents. Stable order: alphabetical kind
  // then original input order within each kind.
  const byKind = new Map<string, SerializedFact[]>()
  for (const fact of facts) {
    const bucket = byKind.get(fact.kind)
    if (bucket !== undefined) {
      bucket.push(fact)
    } else {
      byKind.set(fact.kind, [fact])
    }
  }
  const kinds = [...byKind.keys()].sort((a, b) => a.localeCompare(b))
  for (const kind of kinds) {
    lines.push(`## ${kind}`)
    lines.push('')
    const items = byKind.get(kind) ?? []
    for (const fact of items) {
      lines.push(formatFactLine(fact))
    }
    lines.push('')
  }
  return lines.join('\n')
}

const formatFactLine = (fact: SerializedFact): string => {
  const tags = fact.tags.length > 0 ? `, tags=${fact.tags.join(',')}` : ''
  // Trust is rendered to 2 decimal places — `trust=0.70`
  // reads cleanly and matches the SqliteStore column
  // precision (REAL is 8-byte IEEE-754, but the displayed
  // trust is rounded to 0.01 because human edits want
  // that level of fidelity).
  const trust = fact.trust.toFixed(2)
  return `- ${fact.content} (id=${fact.id}, trust=${trust}${tags})`
}

/**
 * Parse a Markdown document produced by
 * {@link serializeFactsToMarkdown} back into structured
 * facts. The parser is *tolerant* — operator hand-edits
 * that drop the metadata comment, add blank lines, or
 * rewrap paragraphs all parse cleanly. Lines that do not
 * match the `- <content> (id=..., trust=..., tags=...)`
 * shape are skipped (they were probably prose edits).
 *
 * Returns an empty array when the document has no
 * recognisable section headers.
 */
export const parseMarkdownFacts = (markdown: string): ReadonlyArray<SerializedFact> => {
  const facts: SerializedFact[] = []
  let currentKind: string | undefined
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    if (line.startsWith('<!--')) continue
    if (line.startsWith('## ')) {
      currentKind = line.slice(3).trim()
      continue
    }
    if (currentKind === undefined) continue
    if (!line.startsWith('- ')) continue
    const fact = parseFactLine(line.slice(2), currentKind)
    if (fact !== undefined) facts.push(fact)
  }
  return facts
}

const parseFactLine = (
  content: string,
  kind: string,
): SerializedFact | undefined => {
  // The trailing `(id=..., trust=..., tags=...)` is
  // optional — operators can hand-edit the content and
  // lose the metadata. When present, parse it; when
  // absent, synthesise a fresh id and default trust so
  // the row still round-trips.
  const metaMatch = content.match(/\(id=([^,]+), trust=([0-9.]+)(?:, tags=([^)]+))?\)$/)
  if (metaMatch === null) {
    return {
      id: synthesizeId(content, kind),
      kind,
      content,
      trust: DEFAULT_TRUST_THRESHOLD,
      tags: [],
      createdAtIso: new Date().toISOString(),
    }
  }
  const id = metaMatch[1]?.trim()
  const trustStr = metaMatch[2]?.trim()
  const tagsStr = metaMatch[3]?.trim()
  if (id === undefined || trustStr === undefined) return undefined
  const trust = Number(trustStr)
  if (!Number.isFinite(trust)) return undefined
  const tags = tagsStr !== undefined && tagsStr.length > 0 ? tagsStr.split(',') : []
  const text = content.slice(0, metaMatch.index).trimEnd()
  return {
    id,
    kind,
    content: text,
    trust,
    tags,
    createdAtIso: new Date().toISOString(),
  }
}

/**
 * Deterministic-ish id synthesis for hand-edited facts
 * whose metadata comment was removed. The id is the first
 * 16 hex chars of a sha-1 of `<kind>:<content>` so two
 * edits of the same line collapse to one record on the
 * next ingest. We use node:crypto (already pulled in via
 * better-sqlite3 transitive deps) so this is the only
 * place in `@lumen/memory` that imports `node:crypto`.
 */
const synthesizeId = (content: string, kind: string): string => {
  // Lazy import so the pure-data path stays free of node:
  // crypto until it is actually used. parseMarkdownFacts
  // is only invoked from the cli bridge, so the cost is
  // paid exactly once per bridge lifecycle.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('node:crypto') as typeof import('node:crypto')
  const hex = createHash('sha1').update(`${kind}:${content}`).digest('hex')
  return `md-${hex.slice(0, 16)}`
}

/**
 * Convenience wrapper used by the CLI bridge: filter a
 * record list by trust threshold + sort by kind then
 * createdAtIso before serializing. The threshold default
 * is {@link DEFAULT_TRUST_THRESHOLD}.
 */
export const buildMarkdownDocument = (input: {
  readonly facts: ReadonlyArray<SerializedFact>
  readonly meta: MarkdownDocumentMeta
  readonly trustThreshold?: number
}): string => {
  const threshold = input.trustThreshold ?? DEFAULT_TRUST_THRESHOLD
  const filtered = input.facts
    .filter((f) => f.trust >= threshold)
    .slice()
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind.localeCompare(b.kind)
      return a.createdAtIso.localeCompare(b.createdAtIso)
    })
  return serializeFactsToMarkdown(filtered, input.meta)
}