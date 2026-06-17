/**
 * Zod schemas for the public input surface of `@lumen/memory`.
 *
 * Scope: **input validation only**. Output types (MemoryRecord, RagHit,
 * VectorHit, …) are constructed internally and returned to the caller;
 * TypeScript types are enough. Schemas are reserved for the
 * constructor and method-entry points that take user-supplied data.
 *
 * Why Zod:
 *   - The 9 sibling packages in this monorepo all use Zod for input
 *     validation. `@lumen/memory` was the odd one out.
 *   - Zod gives us a single source of truth for both runtime checks
 *     and inferred static types via `z.infer`.
 *   - Errors surface as `ZodError`; we re-shape them into the typed
 *     `ValidationError` from `@lumen/core` so callers can use a
 *     single `instanceof ValidationError` discriminator.
 *
 * Conventions:
 *   - `parseOrThrow(...)` is the public helper; every constructor
 *     and entry method calls it once at the boundary.
 *   - Schemas use the smallest constraint set that catches real
 *     bugs (e.g. `min(1)` on `documentId` to reject empty strings)
 *     but do not over-constrain. Length caps, regex constraints,
 *     and the like are deliberately omitted — TS types handle
 *     the structural side; the schema handles the value side.
 *   - Function collaborators (`embedder`, `backend`, `chunker`,
 *     `onChunk`) are typed as `z.function()` for shape only; we
 *     do not validate return values or call them during parse.
 */

import { ValidationError } from '@lumen/core'
import { type ZodTypeAny, z } from 'zod'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Zod parse result into a typed object or a `ValidationError`.
 *
 * @param schema The schema to validate against.
 * @param input  The value supplied by the caller.
 * @param field  Field name to embed in the error message (e.g. the
 *               parameter name, like `"config"` or `"query"`).
 */
export function parseOrThrow<T extends ZodTypeAny>(
  schema: T,
  input: unknown,
  field: string,
): z.infer<T> {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const issue = result.error.issues[0]
  // Pick the first issue as the headline; the full ZodError is
  // attached as `cause` so a logger can still dump it. The message
  // is shaped to be readable in `lumen doctor` and on the CLI:
  //   "schema for <field>: <path>: <message>"
  const path = issue?.path.length ? issue.path.join('.') : '(root)'
  const message = issue
    ? `schema for ${field}: ${path}: ${issue.message}`
    : `schema for ${field}: invalid input`
  throw new ValidationError(message, {
    field,
    cause: result.error,
  })
}

// ---------------------------------------------------------------------------
// SqliteStoreConfig
// ---------------------------------------------------------------------------

/** Schema for {@link SqliteStoreConfig}. */
export const SqliteStoreConfigSchema = z
  .object({
    /** `:memory:` for tests, a file path for production. */
    path: z.string().min(1, 'path must not be empty'),
    /** Open in read-only mode. */
    readonly: z.boolean().optional(),
    /** Pipe SQL to a logger. */
    verbose: z.function().args(z.string()).returns(z.void()).optional(),
  })
  .strict()

// ---------------------------------------------------------------------------
// RagPipelineOptions
// ---------------------------------------------------------------------------

/**
 * Schema for {@link RagPipelineOptions}.
 *
 * The three collaborators (`embedder`, `backend`, `chunker`) are
 * duck-typed. We use `z.unknown()` for each so Zod does NOT clone
 * them: cloning would lose the class prototype and methods like
 * `backend.upsert` would silently disappear. The TypeScript types
 * in the constructor signature are the real contract guard; the
 * schema only confirms the keys are present.
 */
export const RagPipelineOptionsSchema = z
  .object({
    embedder: z.unknown(),
    backend: z.unknown(),
    chunker: z.unknown(),
  })
  .strict()

// ---------------------------------------------------------------------------
// ProviderEmbedderOptions
// ---------------------------------------------------------------------------

/** Schema for {@link ProviderEmbedderOptions}. */
export const ProviderEmbedderOptionsSchema = z
  .object({
    /** Default model name. Required. */
    model: z.string().min(1, 'model must not be empty'),
    /** Optional explicit dimensionality. */
    dimensions: z.number().int().positive().optional(),
    /** Optional AbortSignal. */
    signal: z.instanceof(AbortSignal).optional(),
  })
  .strict()

// ---------------------------------------------------------------------------
// MemoryQuery
// ---------------------------------------------------------------------------

/** Schema for {@link MemoryQuery}. */
export const MemoryQuerySchema = z
  .object({
    kind: z.string().optional(),
    tags: z.array(z.string()).optional(),
    text: z.string().optional(),
    embedding: z.array(z.number()).optional(),
    limit: z.number().int().positive().optional(),
    minTrust: z.number().min(0, 'minTrust must be >= 0').max(1, 'minTrust must be <= 1').optional(),
  })
  .strict()

// ---------------------------------------------------------------------------
// IngestInput
// ---------------------------------------------------------------------------

/** Schema for the chunk shape used in {@link IngestInput.chunks}. */
const RagChunkSchema = z
  .object({
    text: z.string().min(1, 'chunk text must not be empty'),
    startOffset: z.number().int().min(0),
    endOffset: z.number().int().min(0),
    index: z.number().int().min(0),
  })
  .strict()
  .refine((c) => c.endOffset >= c.startOffset, {
    message: 'endOffset must be >= startOffset',
    path: ['endOffset'],
  })

/** Schema for {@link IngestInput}. */
export const IngestInputSchema = z
  .object({
    /** Stable id for the document being ingested. */
    documentId: z.string().min(1, 'documentId must not be empty'),
    /** The full document text. */
    text: z.string(),
    /** Optional pre-chunked pieces. */
    chunks: z.array(RagChunkSchema).optional(),
    /** Optional per-chunk lifecycle callback. */
    onChunk: z.function().optional(),
  })
  .strict()

// ---------------------------------------------------------------------------
// RetrieveInput
// ---------------------------------------------------------------------------

/** Schema for {@link RetrieveInput}. */
export const RetrieveInputSchema = z
  .object({
    /** Query text. */
    query: z.string().min(1, 'query must not be empty'),
    /** Number of neighbours to return. */
    limit: z.number().int().positive().optional(),
  })
  .strict()
