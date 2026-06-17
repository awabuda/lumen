/**
 * End-to-end RAG (retrieval-augmented generation) pipeline.
 *
 * Composes three primitives already shipped in this package:
 *   - {@link TextEmbedder} (see `./embedder.ts`, P5.1) — turns text
 *     into Float32-packed embedding arrays.
 *   - {@link BaseVectorBackend} (see `./vector-backend.ts`) — stores
 *     the embeddings and answers top-K queries.
 *   - A caller-supplied chunker — splits a document into
 *     {text, startOffset, endOffset, index} pieces. The memory
 *     package is intentionally agnostic about chunking strategy:
 *     {@link ChunkerFunction} is a structural type that accepts
 *     `chunkText` from `@lumen/tools` without importing it.
 *
 * The pipeline is two operations:
 *
 *   {@link BaseRagPipeline.ingest} — chunk → embed → upsert into the
 *   vector backend. Each chunk gets a stable id derived from the
 *   document id and the chunk index, so re-ingesting the same document
 *   overwrites the old chunks in place.
 *
 *   {@link BaseRagPipeline.retrieve} — embed the query → topK on the
 *   vector backend → return {@link RagHit}[] with the original chunk
 *   text. The caller is responsible for re-ranking (BM25, cross-
 *   encoder, etc.) — this layer only does cosine similarity, but
 *   the {@link RagHit} shape exposes the source offsets so a richer
 *   pipeline can build its own ranking on top.
 *
 * Why a base class instead of a free function:
 *   Inheritable — a subclass can override `embed` to add caching, a
 *   `ingest` to add deduplication, or `retrieve` to fuse with a
 *   keyword signal. The base is the seam; pluggability is the rule.
 *
 * Threading / concurrency: the pipeline is stateless apart from the
 * injected collaborators. Safe to share across concurrent ingests
 * of distinct documents; the vector backend owns the locking.
 */

import { ConfigError, ToolError } from '@lumen/core'
import { type TextEmbedder, float32ToBytes } from './embedder.js'
import {
  IngestInputSchema,
  RagPipelineOptionsSchema,
  RetrieveInputSchema,
  parseOrThrow,
} from './schemas.js'
import type { BaseVectorBackend, VectorHit } from './vector-backend.js'

/** Structural chunker type — accepts `chunkText` from @lumen/tools. */
export type ChunkerFunction = (text: string) => ReadonlyArray<{
  readonly text: string
  readonly startOffset: number
  readonly endOffset: number
  readonly index: number
}>

/** A single chunk as the pipeline ingests it. */
export interface RagChunk {
  readonly text: string
  readonly startOffset: number
  readonly endOffset: number
  readonly index: number
}

/** A single retrieval hit. */
export interface RagHit {
  readonly id: string
  readonly score: number
  readonly text: string
  readonly startOffset: number
  readonly endOffset: number
  readonly index: number
}

/** Input to {@link BaseRagPipeline.ingest}. */
export interface IngestInput {
  /** Stable id for the document being ingested. */
  readonly documentId: string
  /** The full document text. */
  readonly text: string
  /**
   * Optional pre-chunked pieces. If supplied, the pipeline skips
   * its own `chunker` call. Use this when the caller wants to
   * customise the chunker per document.
   */
  readonly chunks?: ReadonlyArray<RagChunk>
  /**
   * Optional metadata hook. The pipeline itself does not store
   * metadata — it only owns the vector path — but it does emit
   * per-chunk lifecycle events so a subclass can record metadata
   * elsewhere.
   */
  readonly onChunk?: (chunk: { readonly id: string; readonly chunk: RagChunk }) => void
}

/** Result of an ingest call. */
export interface IngestResult {
  readonly documentId: string
  readonly chunkCount: number
  readonly ids: ReadonlyArray<string>
}

/** Input to {@link BaseRagPipeline.retrieve}. */
export interface RetrieveInput {
  readonly query: string
  /** Number of neighbours to return. Default 5. */
  readonly limit?: number
}
export interface RetrieveResult {
  readonly hits: ReadonlyArray<RagHit>
}

/** Options accepted by the pipeline constructor. */
export interface RagPipelineOptions {
  readonly embedder: TextEmbedder
  readonly backend: BaseVectorBackend
  readonly chunker: ChunkerFunction
}

const deriveChunkId = (documentId: string, chunkIndex: number): string =>
  `${documentId}#${chunkIndex.toString(36)}`

/** Narrow a structural chunker output to a validated {@link RagChunk}[]. */
const validateChunks = (
  raw: ReadonlyArray<{
    readonly text: string
    readonly startOffset: number
    readonly endOffset: number
    readonly index: number
  }>,
): ReadonlyArray<RagChunk> => {
  const out: RagChunk[] = []
  for (const c of raw) {
    if (typeof c.text !== 'string' || c.text.length === 0) {
      throw new ToolError('chunker produced a chunk with empty text', { toolName: 'chunker' })
    }
    if (!Number.isInteger(c.startOffset) || c.startOffset < 0) {
      throw new ToolError(`chunker produced a chunk with invalid startOffset: ${c.startOffset}`, {
        toolName: 'chunker',
      })
    }
    if (!Number.isInteger(c.endOffset) || c.endOffset < c.startOffset) {
      throw new ToolError(`chunker produced a chunk with invalid endOffset: ${c.endOffset}`, {
        toolName: 'chunker',
      })
    }
    if (!Number.isInteger(c.index) || c.index < 0) {
      throw new ToolError(`chunker produced a chunk with invalid index: ${c.index}`, {
        toolName: 'chunker',
      })
    }
    out.push({ text: c.text, startOffset: c.startOffset, endOffset: c.endOffset, index: c.index })
  }
  return out
}

/**
 * The contract every RAG pipeline fulfills.
 *
 * Implementations extend this base and optionally override the
 * `ingest` / `retrieve` defaults. The default implementation here
 * is a pure vector-cosine pipeline.
 */
export abstract class BaseRagPipeline {
  public abstract readonly id: string

  /** Ingest a document: chunk → embed → upsert. */
  public abstract ingest(input: IngestInput): Promise<IngestResult>

  /** Retrieve top-K chunks most similar to the query. */
  public abstract retrieve(input: RetrieveInput): Promise<RetrieveResult>

  /** Remove every chunk belonging to a document. No-op if absent. */
  public abstract forget(documentId: string): Promise<void>
}

/**
 * Default {@link BaseRagPipeline}: straight embed + topK.
 *
 * Production note: for corpora beyond a few thousand chunks,
 * subclass this and override `retrieve` to fuse with a BM25
 * signal — see `HybridRetriever` for the pattern. For a single-
 * machine Lumen install the default is enough.
 */
export class RagPipeline extends BaseRagPipeline {
  public readonly id = 'vector-cosine'
  private readonly embedder: TextEmbedder
  private readonly backend: BaseVectorBackend
  private readonly chunker: ChunkerFunction
  /** ids -> (chunk text, offsets) — kept in memory for cite lookups. */
  private readonly chunkMeta = new Map<
    string,
    { text: string; startOffset: number; endOffset: number; index: number }
  >()

  public constructor(options: RagPipelineOptions) {
    super()
    // Validate at the boundary. The schema is intentionally
    // permissive about the three collaborators (embedder /
    // backend / chunker) because their contracts are duck-typed
    // and TypeScript already guards the call sites.
    const validated = parseOrThrow(RagPipelineOptionsSchema, options, 'options')
    this.embedder = validated.embedder as TextEmbedder
    this.backend = validated.backend as unknown as BaseVectorBackend
    this.chunker = validated.chunker as ChunkerFunction
  }

  public async ingest(input: IngestInput): Promise<IngestResult> {
    // Validate at the boundary. A missing `documentId` or an
    // empty `query` should surface here, not deeper in the
    // pipeline where the failure mode is less obvious.
    const validated = parseOrThrow(IngestInputSchema, input, 'input')
    // First forget any chunks from a previous ingest of the same
    // document id. Re-ingestion is supposed to be idempotent.
    await this.forget(validated.documentId)

    const chunks: ReadonlyArray<RagChunk> = validateChunks(
      validated.chunks ?? this.chunker(validated.text),
    )
    if (chunks.length === 0) {
      return { documentId: validated.documentId, chunkCount: 0, ids: [] }
    }

    const vectors = await this.embedder(chunks.map((c) => c.text))
    if (vectors.length !== chunks.length) {
      throw new ConfigError(
        `embedder returned ${vectors.length} vectors for ${chunks.length} chunks`,
      )
    }
    const ids: string[] = []
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i]!
      const vec = vectors[i]!
      const id = deriveChunkId(validated.documentId, chunk.index)
      await this.backend.upsert({ id, embedding: float32ToBytes(vec) })
      this.chunkMeta.set(id, {
        text: chunk.text,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        index: chunk.index,
      })
      ids.push(id)
      if (validated.onChunk) validated.onChunk({ id, chunk })
    }
    return { documentId: validated.documentId, chunkCount: chunks.length, ids }
  }

  public async retrieve(input: RetrieveInput): Promise<RetrieveResult> {
    // Validate at the boundary. An empty `query` would otherwise
    // produce a meaningless zero-vector lookup and a silent miss.
    const validated = parseOrThrow(RetrieveInputSchema, input, 'input')
    const limit = validated.limit ?? 5
    if (this.chunkMeta.size === 0) return { hits: [] }
    const vectors = await this.embedder([validated.query])
    const queryVec = vectors[0]
    if (!queryVec) return { hits: [] }
    const hits = await this.backend.topK(float32ToBytes(queryVec), limit)
    return { hits: hits.map((h) => this.toRagHit(h)).filter((h): h is RagHit => h !== null) }
  }

  public async forget(documentId: string): Promise<void> {
    const prefix = `${documentId}#`
    const removed: string[] = []
    for (const id of this.chunkMeta.keys()) {
      if (id.startsWith(prefix)) removed.push(id)
    }
    for (const id of removed) {
      await this.backend.remove(id)
      this.chunkMeta.delete(id)
    }
  }

  private toRagHit(hit: VectorHit): RagHit | null {
    const meta = this.chunkMeta.get(hit.id)
    if (!meta) return null
    return {
      id: hit.id,
      score: hit.score,
      text: meta.text,
      startOffset: meta.startOffset,
      endOffset: meta.endOffset,
      index: meta.index,
    }
  }
}

/**
 * Re-export `float32ToBytes` here so the RAG module is self-contained
 * for callers that want to project embeddings to other backends.
 */
export { float32ToBytes }
