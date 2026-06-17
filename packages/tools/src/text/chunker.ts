/**
 * Pure chunking primitives used by {@link ChunkTextTool}.
 *
 * Three strategies ship today:
 *   - `char`     — fixed-size windows over the raw character stream.
 *                  Useful for code or prose where paragraph / sentence
 *                  boundaries carry no semantic weight.
 *   - `paragraph` — split on blank lines (`\n\n`), then greedily pack
 *                  paragraphs into a chunk up to `maxChunkSize`. The
 *                  last `overlap` characters of a chunk are repeated
 *                  at the start of the next chunk to preserve
 *                  cross-boundary context.
 *   - `sentence` — split on a curated set of sentence-final
 *                  punctuation (`.!?。！？`), then greedily pack. Same
 *                  overlap semantics as paragraph.
 *
 * Every strategy records absolute `startOffset` / `endOffset` indices
 * into the *original* input string so callers can join chunks back
 * into the source document without re-running the splitter.
 *
 * Pure: no I/O, no Date, no Math.random. Safe to call from worker
 * threads.
 */

export type ChunkStrategy = 'char' | 'paragraph' | 'sentence'

/** Options accepted by {@link chunkText}. */
export interface ChunkOptions {
  /** Strategy to use. Default `'paragraph'`. */
  readonly strategy?: ChunkStrategy
  /**
   * Soft maximum chunk length, in characters. Chunking always tries
   * to stay at or below this; for `paragraph` / `sentence` a single
   * unit longer than `maxChunkSize` will overflow rather than be
   * truncated. Default 1000.
   */
  readonly maxChunkSize?: number
  /**
   * Number of characters from the tail of one chunk to repeat at the
   * head of the next. Default 200. Must be `< maxChunkSize`. The
   * overlap is included in both chunks' `text` and in the
   * `startOffset` / `endOffset` ranges of the *next* chunk; the
   * *previous* chunk's range is unchanged.
   */
  readonly overlap?: number
}

/** A single chunk produced by {@link chunkText}. */
export interface TextChunk {
  /** 0-based chunk index, in the order they were produced. */
  readonly index: number
  /** The chunk text (may contain the overlap region). */
  readonly text: string
  /** Inclusive start offset into the original input. */
  readonly startOffset: number
  /** Exclusive end offset into the original input. */
  readonly endOffset: number
}

/** Default values for {@link ChunkOptions}. */
export const DEFAULT_CHUNK_MAX_SIZE = 1000
export const DEFAULT_CHUNK_OVERLAP = 200
export const MIN_CHUNK_MAX_SIZE = 1

import { ValidationError } from '@lumen/core'

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Split `text` into chunks according to `options`.
 *
 * The returned array is empty when `text` is empty. A single
 * degenerate chunk (a string that cannot be split further) is returned
 * when the input is non-empty but the strategy cannot find a
 * boundary.
 */
export function chunkText(text: string, options: ChunkOptions = {}): TextChunk[] {
  if (text.length === 0) return []
  const strategy = options.strategy ?? 'paragraph'
  const maxChunkSize = options.maxChunkSize ?? DEFAULT_CHUNK_MAX_SIZE
  const overlap = options.overlap ?? DEFAULT_CHUNK_OVERLAP
  if (maxChunkSize < MIN_CHUNK_MAX_SIZE) {
    throw new ValidationError(
      `chunkText: maxChunkSize must be >= ${MIN_CHUNK_MAX_SIZE}, got ${maxChunkSize}`,
      { field: 'maxChunkSize', value: maxChunkSize },
    )
  }
  if (overlap < 0) {
    throw new ValidationError(`chunkText: overlap must be >= 0, got ${overlap}`, {
      field: 'overlap',
      value: overlap,
    })
  }
  if (overlap >= maxChunkSize) {
    throw new ValidationError(
      `chunkText: overlap (${overlap}) must be < maxChunkSize (${maxChunkSize})`,
      { field: 'overlap', value: overlap },
    )
  }
  switch (strategy) {
    case 'char':
      return chunkByChars(text, maxChunkSize, overlap)
    case 'paragraph':
      return chunkByUnits(text, splitParagraphs(text), maxChunkSize, overlap)
    case 'sentence':
      return chunkByUnits(text, splitSentences(text), maxChunkSize, overlap)
    default: {
      const exhaustive: never = strategy
      throw new Error(`chunkText: unknown strategy ${String(exhaustive)}`)
    }
  }
}

// ---------------------------------------------------------------------------
// char strategy
// ---------------------------------------------------------------------------

const chunkByChars = (text: string, max: number, overlap: number): TextChunk[] => {
  const chunks: TextChunk[] = []
  if (text.length <= max) {
    chunks.push({ index: 0, text, startOffset: 0, endOffset: text.length })
    return chunks
  }
  let i = 0
  let idx = 0
  while (i < text.length) {
    const end = Math.min(i + max, text.length)
    const slice = text.slice(i, end)
    chunks.push({ index: idx, text: slice, startOffset: i, endOffset: end })
    if (end === text.length) break
    i = end - overlap
    idx += 1
  }
  return chunks
}

// ---------------------------------------------------------------------------
// paragraph / sentence strategies
// ---------------------------------------------------------------------------

/**
 * A *unit* is a contiguous slice of the source text bounded by
 * splitter markers (blank lines for `paragraph`, sentence-final
 * punctuation for `sentence`). Each unit is annotated with the
 * absolute start / end offsets so the chunker can stitch the final
 * chunks back to source positions.
 */
interface Unit {
  readonly text: string
  readonly start: number
  readonly end: number
}

const chunkByUnits = (
  source: string,
  units: ReadonlyArray<Unit>,
  max: number,
  overlap: number,
): TextChunk[] => {
  if (units.length === 0) {
    return [{ index: 0, text: source, startOffset: 0, endOffset: source.length }]
  }
  const chunks: TextChunk[] = []
  let bufferUnits: Unit[] = []
  let bufferLen = 0
  let chunkIndex = 0

  const flush = (): void => {
    if (bufferUnits.length === 0) return
    const first = bufferUnits[0]!
    const last = bufferUnits[bufferUnits.length - 1]!
    const text = bufferUnits.map((u) => u.text).join('')
    chunks.push({
      index: chunkIndex,
      text,
      startOffset: first.start,
      endOffset: last.end,
    })
    chunkIndex += 1
    // Build the overlap window: keep the tail of the buffer up to
    // `overlap` characters, but always at a unit boundary so we never
    // split a paragraph / sentence across the overlap.
    let overlapLen = 0
    const keep: Unit[] = []
    for (let i = bufferUnits.length - 1; i >= 0; i -= 1) {
      const u = bufferUnits[i]!
      if (overlapLen + u.text.length > overlap) {
        // If the very last unit would push us over, we just drop it
        // from the overlap window — the alternative is splitting the
        // unit, which would put a partial sentence at the head of the
        // next chunk.
        if (overlapLen === 0) break
        break
      }
      keep.unshift(u)
      overlapLen += u.text.length
      if (overlapLen >= overlap) break
    }
    bufferUnits = keep
    bufferLen = overlapLen
  }

  for (const unit of units) {
    const unitLen = unit.text.length
    // If the unit alone exceeds `max`, we still flush a buffer first
    // (to keep small units grouped with the previous chunk), then emit
    // the oversized unit on its own.
    if (bufferLen + unitLen > max && bufferUnits.length > 0) {
      flush()
    }
    bufferUnits.push(unit)
    bufferLen += unitLen
    if (bufferLen >= max) {
      flush()
    }
  }
  flush()
  return chunks
}

// ---------------------------------------------------------------------------
// Splitters
// ---------------------------------------------------------------------------

/**
 * Split the source on blank-line boundaries. The unit *text* always
 * includes the trailing blank line(s) so consecutive units join
 * back into the original string when concatenated.
 */
const splitParagraphs = (text: string): Unit[] => {
  const units: Unit[] = []
  const re = /\n\s*\n/g
  let last = 0
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard RegExp.exec() iteration idiom
  while ((m = re.exec(text)) !== null) {
    const end = re.lastIndex
    units.push({ text: text.slice(last, end), start: last, end })
    last = end
  }
  if (last < text.length) {
    units.push({ text: text.slice(last), start: last, end: text.length })
  }
  return units
}

/**
 * Split the source on sentence-final punctuation. We treat any of
 * `. ! ? 。 ！ ？` as a terminator and include the terminator in the
 * previous unit so units concatenate back into the original string.
 *
 * The look-ahead `(?=[^.!?。！？]|$)` says "the character after the
 * punctuation is *not* another terminator (or there is no next
 * character)". This deliberately tolerates CJK punctuation that is
 * not followed by whitespace — Chinese text usually has no space
 * after `。` — and also tolerates Latin punctuation followed by a
 * space. We consume the terminator only; the look-ahead is zero-width.
 */
const splitSentences = (text: string): Unit[] => {
  const units: Unit[] = []
  const re = /([.!?。！？]+)(?=[^.!?。！？]|$)/g
  let last = 0
  let m: RegExpExecArray | null
  // biome-ignore lint/suspicious/noAssignInExpressions: standard RegExp.exec() iteration idiom
  while ((m = re.exec(text)) !== null) {
    const end = re.lastIndex
    units.push({ text: text.slice(last, end), start: last, end })
    last = end
  }
  if (last < text.length) {
    units.push({ text: text.slice(last), start: last, end: text.length })
  }
  return units
}
