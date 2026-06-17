/**
 * `patch` — find-and-replace in a file, with fuzzy whitespace tolerance.
 *
 * The match is performed in two passes:
 *   1. Exact substring match. If it appears exactly once (or the caller
 *      set `replaceAll: true`), use it directly.
 *   2. Whitespace-normalized match: collapse runs of whitespace
 *      (including newlines) to a single space, then search. This
 *      tolerates trivial indentation differences.
 *
 * Patches always use the atomic writer from {@link WriteFileTool}, so
 * a half-applied patch is never observed.
 */

import * as fs from 'node:fs/promises'
import path from 'node:path'
import {
  BaseTool,
  type ToolContext,
  type ToolDescriptor,
  ToolError,
  ValidationError,
} from '@lumen/core'
import { z } from 'zod'
import { atomicWriteFile } from './write-file.js'

/** Zod schema for the tool's input. */
export const PatchInputSchema = z.object({
  /** File path, resolved against `ctx.cwd` if relative. */
  path: z.string().min(1),
  /** The exact substring to find. Must be at least 1 character. */
  oldString: z.string().min(1),
  /** The replacement. May be empty (deletion). */
  newString: z.string(),
  /** When true, replace every occurrence. Defaults to false (unique match). */
  replaceAll: z.boolean().optional(),
})
export type PatchInput = z.infer<typeof PatchInputSchema>

/** Zod schema for the tool's output. */
export const PatchOutputSchema = z.object({
  /** Number of replacements actually performed. */
  replacements: z.number().int().min(0),
  /** Absolute path of the patched file. */
  path: z.string(),
})
export type PatchOutput = z.infer<typeof PatchOutputSchema>

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 *
 * Avoids `String.prototype.matchAll` so the count is allocation-free
 * beyond a single index walk.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let idx = 0
  while (true) {
    const found = haystack.indexOf(needle, idx)
    if (found === -1) return count
    count++
    idx = found + needle.length
  }
}

/**
 * Normalize whitespace by collapsing any run of whitespace (including
 * newlines) to a single space. Used for the fuzzy match pass.
 */
function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ')
}

/**
 * Replace exactly one occurrence of `needle` in `haystack` starting at
 * normalized index `normIdx`. The needle is taken from the normalized
 * form, but the replacement is performed on the original characters
 * that produced the normalized span.
 *
 * Returns the patched string and the length (in original characters)
 * of the slice that was replaced. Throws if the slice can't be
 * determined.
 */
function replaceOneNormalized(
  original: string,
  needle: string,
  normIdx: number,
  replacement: string,
): { result: string; replacedLength: number } {
  // Walk the original string, tracking the parallel index in the
  // normalized form. The normalized form compresses each whitespace
  // run to one character, so we advance the normalized cursor only
  // when we transition into a new run (or hit a non-whitespace char).
  let nIdx = 0
  let origStart = -1
  // Find the start of the matching span in `original`.
  for (let i = 0; i <= original.length; i++) {
    if (nIdx === normIdx) {
      origStart = i
      break
    }
    if (i === original.length) break
    const ch = original[i] as string
    if (/\s/.test(ch)) {
      const prev = i > 0 ? (original[i - 1] as string) : ''
      if (!/\s/.test(prev)) nIdx++ // opening of a new whitespace run
    } else {
      nIdx++
    }
  }
  if (origStart < 0) {
    throw new ToolError('patch: normalized index out of range', { toolName: 'patch' })
  }

  // The end of the match in the original is the point where the
  // normalized cursor has advanced by `needle.length` characters.
  let end = origStart
  let advanced = 0
  for (; end < original.length && advanced < needle.length; end++) {
    const ch = original[end] as string
    if (/\s/.test(ch)) {
      const prev = end > 0 ? (original[end - 1] as string) : ''
      if (!/\s/.test(prev)) advanced++
    } else {
      advanced++
    }
  }
  const replacedLength = end - origStart
  return {
    result: original.slice(0, origStart) + replacement + original.slice(origStart + replacedLength),
    replacedLength,
  }
}

/** Tool: find-and-replace in a file with fuzzy whitespace matching. */
export class PatchTool extends BaseTool {
  public readonly name = 'patch'
  public readonly description =
    'Find-and-replace text inside a file. oldString must match exactly once unless replaceAll is set. ' +
    'If exact matching fails, retries with whitespace-normalized fuzzy matching. ' +
    'Writes are atomic — readers see either the old file or the patched file, never a half-applied patch.'
  public readonly inputSchema: z.ZodType<unknown> = PatchInputSchema
  public readonly risk = 'approval-required' as const
  public override readonly version = '0.1.0'

  protected async execute(input: unknown, ctx: ToolContext): Promise<PatchOutput> {
    const { path: userPath, oldString, newString, replaceAll } = input as PatchInput
    const absPath = path.resolve(ctx.cwd, userPath)
    const original = await fs.readFile(absPath, 'utf8')

    // First pass: exact substring match.
    const exactCount = countOccurrences(original, oldString)
    if (exactCount > 0) {
      if (exactCount > 1 && !replaceAll) {
        throw new ValidationError(
          `patch: oldString matched ${exactCount} times in ${absPath} but replaceAll=false. Refine oldString with more surrounding context, or pass replaceAll=true.`,
          { field: 'oldString' },
        )
      }
      const next = replaceAll
        ? original.split(oldString).join(newString)
        : original.replace(oldString, newString)
      await atomicWriteFile(absPath, next, ctx.signal)
      return { replacements: replaceAll ? exactCount : 1, path: absPath }
    }

    // Second pass: whitespace-normalized fuzzy match.
    const normOriginal = normalizeWhitespace(original)
    const normNeedle = normalizeWhitespace(oldString)
    const normCount = countOccurrences(normOriginal, normNeedle)
    if (normCount === 0) {
      throw new ValidationError(`patch: oldString not found in ${absPath}`, { field: 'oldString' })
    }
    if (normCount > 1 && !replaceAll) {
      throw new ValidationError(
        `patch: oldString matched ${normCount} times under fuzzy whitespace normalization in ${absPath} but replaceAll=false. Refine oldString or pass replaceAll=true.`,
        { field: 'oldString' },
      )
    }
    const normIdx = normOriginal.indexOf(normNeedle)
    const { result } = replaceOneNormalized(original, normNeedle, normIdx, newString)
    await atomicWriteFile(absPath, result, ctx.signal)
    return { replacements: replaceAll ? normCount : 1, path: absPath }
  }

  public override describe(): ToolDescriptor {
    return { ...super.describe(), version: this.version }
  }
}
