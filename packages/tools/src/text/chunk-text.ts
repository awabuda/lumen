/**
 * `chunk_text` — split a long text into smaller, overlapping chunks
 * suitable for embedding and RAG pipelines.
 *
 * The actual splitting is done by the pure {@link chunkText} helper in
 * `./chunker.js`; this file is a thin {@link BaseTool} wrapper that
 * exposes the helper to the agent loop.
 *
 * Three strategies are exposed via the `strategy` field:
 *   - `paragraph` (default) — split on blank lines, pack into windows
 *     of `maxChunkSize` characters, tail-overlap `overlap` chars.
 *   - `sentence` — same packing rules, split on sentence-final
 *     punctuation (`.!?。！？`).
 *   - `char` — fixed-size character windows with `overlap` chars of
 *     tail-overlap. Useful for code or unstructured text.
 *
 * Output records absolute `startOffset` / `endOffset` indices into
 * the original `text` so callers can join chunks back into the source.
 */

import { z } from 'zod'
import { BaseTool, type ToolContext, type ToolRisk } from '@lumen/core'
import {
  chunkText,
  DEFAULT_CHUNK_MAX_SIZE,
  DEFAULT_CHUNK_OVERLAP,
  type TextChunk,
} from './chunker.js'

export const ChunkTextInputSchema = z.object({
  /** The text to split. */
  text: z.string(),
  /**
   * Splitting strategy. `'paragraph'` is the default and respects
   * `\n\n` boundaries; `'sentence'` is the most semantically aware
   * for prose; `'char'` is the most aggressive and is the right
   * choice for code or fixed-window embedding models.
   */
  strategy: z.enum(['char', 'paragraph', 'sentence']).optional(),
  /**
   * Soft maximum chunk length in characters. Default 1000. Must be
   * >= 1. A single paragraph / sentence longer than this will
   * overflow rather than be split.
   */
  maxChunkSize: z.number().int().min(1).optional(),
  /**
   * Tail-overlap in characters. Default 200. Must be 0 <= overlap
   * < maxChunkSize. The overlap region is included in both the
   * trailing and the leading chunk to preserve cross-boundary
   * context for embeddings.
   */
  overlap: z.number().int().min(0).optional(),
})
export type ChunkTextInput = z.infer<typeof ChunkTextInputSchema>

const ChunkSchema = z.object({
  index: z.number().int().min(0),
  text: z.string(),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(0),
})

export const ChunkTextOutputSchema = z.object({
  chunks: z.array(ChunkSchema),
  totalChunks: z.number().int().min(0),
  strategy: z.enum(['char', 'paragraph', 'sentence']),
  maxChunkSize: z.number().int().min(1),
  overlap: z.number().int().min(0),
})
export type ChunkTextOutput = z.infer<typeof ChunkTextOutputSchema>

/**
 * Tool: split text into chunks.
 *
 * Pure / deterministic / safe: no I/O, no network, no filesystem
 * access. Risk level `'safe'`.
 */
export class ChunkTextTool extends BaseTool {
  public readonly name = 'chunk_text'
  public readonly description =
    'Split a long text into smaller overlapping chunks for embedding / RAG pipelines. ' +
    'Three strategies: paragraph (split on blank lines, default), sentence (split on ' +
    '.!?。！？), or char (fixed-size windows). Each chunk records absolute offsets ' +
    'into the source so chunks can be rejoined to the original text.'
  public readonly inputSchema: z.ZodType<unknown> = ChunkTextInputSchema
  public readonly risk: ToolRisk = 'safe'
  public override readonly version = '0.1.0'

  protected execute(input: unknown, _ctx: ToolContext): Promise<ChunkTextOutput> {
    const { text, strategy, maxChunkSize, overlap } = input as ChunkTextInput
    const effectiveStrategy = strategy ?? 'paragraph'
    const effectiveMax = maxChunkSize ?? DEFAULT_CHUNK_MAX_SIZE
    const effectiveOverlap = overlap ?? DEFAULT_CHUNK_OVERLAP
    const chunks: TextChunk[] = chunkText(text, {
      strategy: effectiveStrategy,
      maxChunkSize: effectiveMax,
      overlap: effectiveOverlap,
    })
    const out: ChunkTextOutput = {
      chunks: chunks.map((c) => ({
        index: c.index,
        text: c.text,
        startOffset: c.startOffset,
        endOffset: c.endOffset,
      })),
      totalChunks: chunks.length,
      strategy: effectiveStrategy,
      maxChunkSize: effectiveMax,
      overlap: effectiveOverlap,
    }
    return Promise.resolve(out)
  }
}
