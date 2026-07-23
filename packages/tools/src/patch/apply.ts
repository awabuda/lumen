/**
 * P25.5 \u2014 apply_patch tool (bug.md #54).
 *
 * Multi-file V4A patch parser + applier. The tool consumes
 * the Claude Code V4A patch format (line-based hunks with
 * `*** Begin Patch` / `*** End Patch` delimiters) and
 * applies each hunk to disk. Pre-P25.5 the agent had no
 * equivalent; P25.5 ships the tool so operators can
 * bundle multi-file edits into a single tool call.
 *
 * Why a helper function (P19+ rule 15) and not an
 * abstract \`BasePatchApplier\` class: the patch parser
 * is a pure function from text to a `PatchPlan` data
 * structure; the applier is a state-machine that walks
 * the plan. No inheritance behaviour to share.
 */

/** A single file hunk within a multi-file patch. */
export interface PatchHunk {
  readonly filePath: string
  readonly oldText: string
  readonly newText: string
  /** \`true\` if the hunk creates a new file (oldText === ''). */
  readonly isCreate: boolean
  /** \`true\` if the hunk deletes a file (newText === ''). */
  readonly isDelete: boolean
}

/** A parsed patch (zero or more hunks in apply order). */
export interface PatchPlan {
  readonly hunks: ReadonlyArray<PatchHunk>
}

/** Custom error type so callers can `instanceof` discriminate. */
export class PatchParseError extends Error {
  public override readonly name = 'PatchParseError'
  public constructor(message: string, public readonly line?: number) {
    super(`apply_patch: ${message}${line !== undefined ? ` (line ${line})` : ''}`)
  }
}

/**
 * Parse a V4A patch string into a {@link PatchPlan}.
 *
 * Format:
 *
 *     *** Begin Patch
 *     *** Add File: path/to/new
 *     +line one
 *     +line two
 *     *** Update File: path/to/existing
 *     @@ optional marker
 *     -old line
 *     +new line
 *      unchanged line (leading space)
 *     *** Delete File: path/to/gone
 *     *** End Patch
 *
 * Each line is one of:
 *   - `*** Begin Patch` / `*** End Patch` — delimiters
 *   - `*** Add File: <path>` — create
 *   - `*** Update File: <path>` — modify
 *   - `*** Delete File: <path>` — delete
 *   - `@@` — optional section marker (ignored)
 *   - `+<line>` — added text
 *   - `-<line>` — removed text
 *   - ` <line>` — unchanged context
 */
export const parsePatch = (input: string): PatchPlan => {
  const lines = input.replace(/\r\n/g, '\n').split('\n')
  if (lines.length === 0 || lines[0]?.trim() !== '*** Begin Patch') {
    throw new PatchParseError('patch must start with `*** Begin Patch`', 1)
  }
  if (lines[lines.length - 1]?.trim() !== '*** End Patch') {
    throw new PatchParseError('patch must end with `*** End Patch`', lines.length)
  }
  const body = lines.slice(1, -1)

  const hunks: PatchHunk[] = []
  let current: { filePath: string; oldLines: string[]; newLines: string[] } | undefined

  for (let i = 0; i < body.length; i += 1) {
    const raw = body[i] ?? ''
    const line = i + 2 // 1-based, +1 for the Begin Patch header
    if (raw.startsWith('*** Add File:')) {
      if (current !== undefined) hunks.push(toHunk(current))
      current = { filePath: raw.slice('*** Add File:'.length).trim(), oldLines: [], newLines: [] }
      continue
    }
    if (raw.startsWith('*** Update File:')) {
      if (current !== undefined) hunks.push(toHunk(current))
      current = { filePath: raw.slice('*** Update File:'.length).trim(), oldLines: [], newLines: [] }
      continue
    }
    if (raw.startsWith('*** Delete File:')) {
      if (current !== undefined) hunks.push(toHunk(current))
      const filePath = raw.slice('*** Delete File:'.length).trim()
      hunks.push({ filePath, oldText: '', newText: '', isCreate: false, isDelete: true })
      current = undefined
      continue
    }
    if (raw === '@@' || raw.startsWith('@@ ')) {
      continue
    }
    if (current === undefined) {
      throw new PatchParseError('hunk body line before any file marker', line)
    }
    if (raw.startsWith('+')) {
      current.newLines.push(raw.slice(1))
    } else if (raw.startsWith('-')) {
      current.oldLines.push(raw.slice(1))
    } else if (raw.startsWith(' ')) {
      // Unchanged context: must match both old and new.
      current.oldLines.push(raw.slice(1))
      current.newLines.push(raw.slice(1))
    } else if (raw === '') {
      // Blank line: ignored (we don't preserve blank-only
      // context lines through the patch round-trip).
      continue
    } else {
      throw new PatchParseError(`unrecognised line "${raw}"`, line)
    }
  }
  if (current !== undefined) hunks.push(toHunk(current))
  return { hunks }
}

const toHunk = (h: {
  filePath: string
  oldLines: string[]
  newLines: string[]
}): PatchHunk => {
  const oldText = h.oldLines.join('\n')
  const newText = h.newLines.join('\n')
  const isCreate = oldText === '' && newText !== ''
  const isDelete = newText === '' && oldText === ''
  return { filePath: h.filePath, oldText, newText, isCreate, isDelete }
}

/**
 * Apply a parsed plan to disk. Pure helper; the caller is
 * responsible for the actual `writeFile` / `unlink` calls
 * (this module does not depend on `node:fs` directly so
 * tests can run in any environment).
 */
export interface PatchApplier {
  read: (path: string) => Promise<string>
  write: (path: string, content: string) => Promise<void>
  remove: (path: string) => Promise<void>
}

export interface PatchApplyResult {
  readonly applied: ReadonlyArray<{ filePath: string; kind: 'created' | 'updated' | 'deleted' }>
  /** Hunk indexes (into the original plan) that failed. */
  readonly failed: ReadonlyArray<{ index: number; reason: string }>
}

/** Apply a {@link PatchPlan} via the supplied applier.
 *  Updates / deletes that don't match the on-disk file
 *  surface are recorded as failures (the patch is NOT
 *  idempotent; the operator retries with a fresh patch).
 */
export const applyPatchPlan = async (
  plan: PatchPlan,
  applier: PatchApplier,
): Promise<PatchApplyResult> => {
  const applied: { filePath: string; kind: 'created' | 'updated' | 'deleted' }[] = []
  const failed: { index: number; reason: string }[] = []
  for (let i = 0; i < plan.hunks.length; i += 1) {
    const hunk = plan.hunks[i]
    if (hunk === undefined) continue
    try {
      if (hunk.isCreate) {
        await applier.write(hunk.filePath, hunk.newText)
        applied.push({ filePath: hunk.filePath, kind: 'created' })
        continue
      }
      if (hunk.isDelete) {
        await applier.remove(hunk.filePath)
        applied.push({ filePath: hunk.filePath, kind: 'deleted' })
        continue
      }
      const onDisk = await applier.read(hunk.filePath)
      // V4A's contract: the oldText must match the on-disk
      // file *exactly* (whitespace included). Operators
      // re-read the file before patching if they suspect
      // drift; we do NOT do fuzzy matching here.
      if (onDisk !== hunk.oldText) {
        failed.push({ index: i, reason: 'oldText does not match on-disk content' })
        continue
      }
      await applier.write(hunk.filePath, hunk.newText)
      applied.push({ filePath: hunk.filePath, kind: 'updated' })
    } catch (err) {
      failed.push({ index: i, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return { applied, failed }
}