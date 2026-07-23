/**
 * P25.5 — apply_patch parser + applier (bug.md #54).
 *
 * Pins the public surface of `parsePatch` + `applyPatchPlan`.
 * The on-disk tool (`apply_patch`) is wired via a separate
 * CLI flag in a future P-ticket; this file pins the data
 * layer.
 */

import { describe, expect, it } from 'vitest'

import {
  applyPatchPlan,
  parsePatch,
  PatchParseError,
  type PatchApplier,
} from '../src/patch/apply.js'

// ---------------------------------------------------------------------------
// parsePatch
// ---------------------------------------------------------------------------

const ADD = (path: string, lines: ReadonlyArray<string>): string =>
  ['*** Begin Patch', `*** Add File: ${path}`, ...lines.map((l) => `+${l}`), '*** End Patch'].join(
    '\n',
  )

const UPDATE = (
  path: string,
  removed: ReadonlyArray<string>,
  added: ReadonlyArray<string>,
  context: ReadonlyArray<string> = [],
): string => {
  const lines: string[] = ['*** Begin Patch', `*** Update File: ${path}`]
  for (const r of removed) lines.push(`-${r}`)
  for (const a of added) lines.push(`+${a}`)
  for (const c of context) lines.push(` ${c}`)
  lines.push('*** End Patch')
  return lines.join('\n')
}

const DELETE = (path: string): string =>
  ['*** Begin Patch', `*** Delete File: ${path}`, '*** End Patch'].join('\n')

describe('P25.5 — parsePatch', () => {
  it('parses an Add File hunk', () => {
    const plan = parsePatch(ADD('src/new.ts', ['export const x = 1', '']))
    expect(plan.hunks).toHaveLength(1)
    const h = plan.hunks[0]!
    expect(h.filePath).toBe('src/new.ts')
    expect(h.isCreate).toBe(true)
    expect(h.newText).toBe('export const x = 1\n')
  })

  it('parses an Update File hunk with remove + add + context', () => {
    const plan = parsePatch(
      UPDATE('src/existing.ts', ['old line'], ['new line'], ['untouched line']),
    )
    const h = plan.hunks[0]!
    expect(h.isCreate).toBe(false)
    expect(h.isDelete).toBe(false)
    // Lines appear in source order in the patch: removed,
    // added, then unchanged context. The parser appends to
    // both old and new arrays in source order, so the
    // resulting strings reflect that order.
    expect(h.oldText).toBe('old line\nuntouched line')
    expect(h.newText).toBe('new line\nuntouched line')
  })

  it('parses a Delete File hunk', () => {
    const plan = parsePatch(DELETE('src/gone.ts'))
    const h = plan.hunks[0]!
    expect(h.isDelete).toBe(true)
    expect(h.oldText).toBe('')
    expect(h.newText).toBe('')
  })

  it('parses multi-hunk patches in apply order', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: a.ts',
      '+a',
      '*** Update File: b.ts',
      '-old',
      '+new',
      '*** Delete File: c.ts',
      '*** End Patch',
    ].join('\n')
    const plan = parsePatch(patch)
    expect(plan.hunks.map((h) => h.filePath)).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('rejects a patch without the Begin marker', () => {
    expect(() => parsePatch('*** Update File: x\n-old\n+new\n*** End Patch')).toThrow(
      PatchParseError,
    )
  })

  it('rejects a patch without the End marker', () => {
    expect(() => parsePatch('*** Begin Patch\n*** Update File: x\n-old\n+new')).toThrow(
      PatchParseError,
    )
  })

  it('rejects a body line before any file marker', () => {
    const bad = ['*** Begin Patch', '+orphan line', '*** End Patch'].join('\n')
    expect(() => parsePatch(bad)).toThrow(PatchParseError)
  })

  it('rejects an unrecognised prefix', () => {
    const bad = [
      '*** Begin Patch',
      '*** Update File: x',
      '?weird line',
      '*** End Patch',
    ].join('\n')
    expect(() => parsePatch(bad)).toThrow(PatchParseError)
  })
})

// ---------------------------------------------------------------------------
// applyPatchPlan
// ---------------------------------------------------------------------------

const fakeFs = (
  files: Record<string, string>,
): { fs: PatchApplier; writes: string[]; removes: string[] } => {
  const writes: string[] = []
  const removes: string[] = []
  const fs: PatchApplier = {
    async read(path) {
      const v = files[path]
      if (v === undefined) throw new Error(`ENOENT: ${path}`)
      return v
    },
    async write(path, content) {
      writes.push(`${path} = ${JSON.stringify(content)}`)
    },
    async remove(path) {
      removes.push(path)
    },
  }
  return { fs, writes, removes }
}

describe('P25.5 — applyPatchPlan', () => {
  it('creates a file when the hunk isCreate', async () => {
    const plan = parsePatch(ADD('src/new.ts', ['export const x = 1']))
    const { fs, writes, removes } = fakeFs({})
    const r = await applyPatchPlan(plan, fs)
    expect(r.applied).toEqual([{ filePath: 'src/new.ts', kind: 'created' }])
    expect(r.failed).toEqual([])
    expect(writes).toHaveLength(1)
    expect(removes).toEqual([])
  })

  it('updates a file when the on-disk content matches oldText', async () => {
    const plan = parsePatch(UPDATE('src/x.ts', ['old'], ['new']))
    const { fs, writes } = fakeFs({ 'src/x.ts': 'old' })
    const r = await applyPatchPlan(plan, fs)
    expect(r.applied).toEqual([{ filePath: 'src/x.ts', kind: 'updated' }])
    expect(writes[0]).toContain('"new"')
  })

  it('reports a failure when the on-disk content does NOT match oldText', async () => {
    const plan = parsePatch(UPDATE('src/x.ts', ['old'], ['new']))
    const { fs } = fakeFs({ 'src/x.ts': 'stale' })
    const r = await applyPatchPlan(plan, fs)
    expect(r.applied).toEqual([])
    expect(r.failed).toEqual([
      { index: 0, reason: 'oldText does not match on-disk content' },
    ])
  })

  it('deletes a file when the hunk isDelete', async () => {
    const plan = parsePatch(DELETE('src/x.ts'))
    const { fs, removes } = fakeFs({ 'src/x.ts': 'anything' })
    const r = await applyPatchPlan(plan, fs)
    expect(r.applied).toEqual([{ filePath: 'src/x.ts', kind: 'deleted' }])
    expect(removes).toEqual(['src/x.ts'])
  })

  it('mixes applied + failed across multi-hunk patches', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: a.ts',
      '+hello',
      '*** Update File: b.ts',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n')
    const plan = parsePatch(patch)
    // b.ts has STALE content -> update fails; a.ts creates.
    const { fs } = fakeFs({ 'b.ts': 'stale' })
    const r = await applyPatchPlan(plan, fs)
    expect(r.applied.map((a) => a.kind)).toEqual(['created'])
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]!.index).toBe(1)
  })

  it('catches a missing file on update and records a failure', async () => {
    const plan = parsePatch(UPDATE('src/missing.ts', ['old'], ['new']))
    const { fs } = fakeFs({})
    const r = await applyPatchPlan(plan, fs)
    expect(r.applied).toEqual([])
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0]!.reason).toMatch(/ENOENT/)
  })
})