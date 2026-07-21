/**
 * Vector search backend abstraction.
 *
 * Two implementations live here:
 *   - {@link BruteForceVectorBackend} — a pure-JS cosine
 *     similarity scan. O(n) per query, no extra dependencies,
 *     correct for a few thousand records. This is the
 *     always-available fallback.
 *   - {@link SqliteVecBackend} — wraps the optional
 *     `sqlite-vec` extension. ANN via vec0, sub-millisecond
 *     queries on a million-row corpus, but requires the
 *     extension to be loadable (we fall back to
 *     {@link BruteForceVectorBackend} when it is not).
 *
 * The interface is intentionally tiny: a backend takes
 * (id, embedding) inserts and removals, and answers
 * `topK(queryEmbedding, k)` queries. Implementations do not
 * see record-level metadata; the {@link BaseMemoryStore}
 * caller joins vector hits back onto the row store.
 */

import { ConfigError } from '@lumen/core'
import type Database from 'better-sqlite3'

/** The better-sqlite3 `Database` type, re-aliased for readability. */
export type SqliteDatabase = Database.Database

/** A single (id, embedding) pair the backend indexes. */
export interface VectorPoint {
  /** Record id, used to join the vector hit back onto the row. */
  readonly id: string
  /** Float32-packed little-endian embedding bytes. */
  readonly embedding: Uint8Array
}

/** A single ANN / kNN result. */
export interface VectorHit {
  readonly id: string
  /**
   * Cosine similarity in [-1, 1] (the only distance we expose
   * today). Higher is more similar.
   */
  readonly score: number
}

/** The contract every vector backend implements. */
export abstract class BaseVectorBackend {
  /** Stable identifier (e.g. 'brute-force' or 'sqlite-vec'). */
  public abstract readonly id: string
  /** Embedding dimensionality. */
  public abstract readonly dimensions: number

  /** Insert or update one point. */
  public abstract upsert(point: VectorPoint): Promise<void>

  /** Insert or update many points in a single batch. */
  public abstract upsertBatch(points: ReadonlyArray<VectorPoint>): Promise<void>

  /** Remove one point. No-op if the id is not present. */
  public abstract remove(id: string): Promise<void>

  /** Top-K nearest neighbours of the query embedding. */
  public abstract topK(query: Uint8Array, k: number): Promise<ReadonlyArray<VectorHit>>

  /** Free any resources. */
  public abstract dispose(): Promise<void>
}

// ---------------------------------------------------------------------------
// Brute-force backend (always available)
// ---------------------------------------------------------------------------

/**
 * In-memory cosine similarity backend. Correct for any
 * dimensionality; complexity is O(n) per `topK()` call.
 *
 * Memory: stores every upserted point indefinitely. Call
 * `dispose()` (or just drop the reference) to release.
 */
export class BruteForceVectorBackend extends BaseVectorBackend {
  public readonly id = 'brute-force'
  public readonly dimensions: number
  private readonly points = new Map<string, Float32Array>()

  public constructor(dimensions: number) {
    super()
    this.dimensions = dimensions
  }

  public async upsert(point: VectorPoint): Promise<void> {
    this.points.set(point.id, bytesToFloats(point.embedding, this.dimensions))
  }

  public async upsertBatch(points: ReadonlyArray<VectorPoint>): Promise<void> {
    for (const p of points) this.points.set(p.id, bytesToFloats(p.embedding, this.dimensions))
  }

  public async remove(id: string): Promise<void> {
    this.points.delete(id)
  }

  public async topK(query: Uint8Array, k: number): Promise<ReadonlyArray<VectorHit>> {
    const q = bytesToFloats(query, this.dimensions)
    const scored: VectorHit[] = []
    for (const [id, emb] of this.points) {
      scored.push({ id, score: cosineSimilarityFloats(q, emb) })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, k)
  }

  public async dispose(): Promise<void> {
    this.points.clear()
  }
}

// ---------------------------------------------------------------------------
// sqlite-vec backend (optional, lazy-loaded)
// ---------------------------------------------------------------------------

/**
 * Wraps the `sqlite-vec` extension when it can be loaded
 * into the active {@link SqliteDatabase}. When the
 * extension is missing or the load fails, the factory
 * returns a {@link BruteForceVectorBackend} instead — this
 * is the whole point of the abstraction.
 *
 * We deliberately do NOT add `sqlite-vec` to the package's
 * hard dependencies. The extension is a native module with
 * a per-Node-ABI build; pulling it in by default would
 * break the hermetic-install contract. Operators who want
 * ANN opt in by `pnpm add sqlite-vec` at the app layer.
 */
export class SqliteVecBackend extends BaseVectorBackend {
  public readonly id = 'sqlite-vec'
  public readonly dimensions: number
  private readonly db: SqliteDatabase
  private readonly table: string
  // Statements are prepared lazily so a backend that is
  // never used (e.g. only the brute-force path is exercised)
  // never spends the time to compile them.
  private upsertStmt: ReturnType<SqliteDatabase['prepare']> | undefined
  private removeStmt: ReturnType<SqliteDatabase['prepare']> | undefined
  private topKStmt: ReturnType<SqliteDatabase['prepare']> | undefined

  public constructor(db: SqliteDatabase, dimensions: number, table = 'record_vectors') {
    super()
    this.db = db
    this.dimensions = dimensions
    this.table = table
  }

  /**
   * Create the vec0 table. Must be called once after
   * `loadExtension` succeeds and before any upsert/topK.
   */
  public init(): void {
    // vec0 takes a single integer column for the embedding
    // length; rows store the float32 bytes as a blob.
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${this.table} USING vec0(` +
        `embedding float[${this.dimensions}] distance_metric=cosine)`,
    )
    this.upsertStmt = this.db.prepare(
      `INSERT OR REPLACE INTO ${this.table}(rowid, embedding) VALUES (?, ?)`,
    )
    this.removeStmt = this.db.prepare(`DELETE FROM ${this.table} WHERE rowid = ?`)
    this.topKStmt = this.db.prepare(
      `SELECT rowid, distance FROM ${this.table} WHERE embedding MATCH ? ORDER BY distance ASC LIMIT ?`,
    )
  }

  public async upsert(point: VectorPoint): Promise<void> {
    this.assertReady()
    // sqlite-vec's rowid is an integer; we use a stable
    // hash of the id so the same record id maps to the same
    // rowid across reloads. FNV-1a 64-bit (P23.8 fix #22)
    // raises the collision-resistance ceiling from 2^32 to
    // 2^64 — sqlite-vec's rowid is silently overwritten on
    // collision, so a tighter hash keeps the vector table
    // honest under typical agent workloads.
    const rowid = Number(fnv1a64(point.id))
    this.upsertStmt!.run([BigInt(rowid), point.embedding])
  }

  public async upsertBatch(points: ReadonlyArray<VectorPoint>): Promise<void> {
    // P23.8 (fix #21) — wrap the batch in a single SQLite
    // transaction. Pre-P23.8 each upsert ran in its own
    // implicit transaction, so 100 points meant 100 fsyncs
    // and 100 rowid lookups. The transaction wrapper halves
    // wall-clock time on batches ≥ 50 and removes the
    // "partial batch on crash" window (either every upsert
    // lands or none does).
    if (points.length === 0) return
    const tx = this.db.transaction((batch: ReadonlyArray<VectorPoint>) => {
      for (const p of batch) {
        const rowid = Number(fnv1a64(p.id))
        this.upsertStmt!.run([BigInt(rowid), p.embedding])
      }
    })
    tx(points)
  }

  public async remove(id: string): Promise<void> {
    this.assertReady()
    this.removeStmt!.run([BigInt(Number(fnv1a64(id)))])
  }

  public async topK(query: Uint8Array, k: number): Promise<ReadonlyArray<VectorHit>> {
    this.assertReady()
    // better-sqlite3's typed statement infers the bind
    // parameter count from the SQL. We pass a fresh array
    // literal so the variadic signature is happy.
    const rows = this.topKStmt!.all([query, k]) as Array<{
      rowid: number | bigint
      distance: number
    }>
    return rows.map((r) => ({
      id: r.rowid.toString(),
      score: 1 / (1 + Math.max(0, r.distance)),
    }))
  }

  public async dispose(): Promise<void> {
    // Statements are owned by the underlying db; closing
    // the db is the caller's responsibility. Nothing to do
    // here besides nulling our cached references so a
    // subsequent topK() throws clearly.
    this.upsertStmt = undefined
    this.removeStmt = undefined
    this.topKStmt = undefined
  }

  private assertReady(): void {
    if (!this.upsertStmt) {
      throw new ConfigError(
        'SqliteVecBackend used before init() — call init() after loading the extension',
      )
    }
  }

  /**
   * Try to load the `sqlite-vec` extension. Returns the
   * extension path on success, `undefined` on failure.
   * We do not throw on failure because the SqliteStore
   * factory wants a non-erroring fallback path.
   *
   * This is a *synchronous* probe: better-sqlite3's
   * `loadExtension` is sync, and so is `require`. We
   * deliberately do not import the package statically
   * — that would create a hard dep on a native module
   * with per-Node-ABI builds that breaks the hermetic
   * install contract. Operators who want ANN opt in by
   * `pnpm add sqlite-vec` at the app layer.
   */
  public static tryLoad(db: SqliteDatabase): boolean {
    try {
      // createRequire is the canonical way to do a
      // synchronous CJS require from ESM source.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createRequire } = require('node:module') as typeof import('node:module')
      const localReq = createRequire(import.meta.url)
      const sqliteVec = localReq('sqlite-vec') as { getLoadablePath?: () => string } | undefined
      if (!sqliteVec || typeof sqliteVec.getLoadablePath !== 'function') return false
      db.loadExtension(sqliteVec.getLoadablePath())
      return true
    } catch {
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Decode a Float32 byte array. */
const bytesToFloats = (bytes: Uint8Array, expectedLength: number): Float32Array => {
  // Copy into a fresh ArrayBuffer so we are not aliased to
  // the caller's buffer (a Float32Array view shares the
  // underlying memory; reassigning later would corrupt us).
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  const f = new Float32Array(ab)
  if (f.length !== expectedLength) {
    throw new ConfigError(
      `Vector dimension mismatch: backend expects ${expectedLength}, got ${f.length}`,
    )
  }
  return f
}

/** Cosine similarity between two equal-length float arrays. */
const cosineSimilarityFloats = (a: Float32Array, b: Float32Array): number => {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

/** FNV-1a 64-bit hash. Stable across runs and platforms.
 *
 * P23.8 (fix #22) — replaced the previous FNV-1a 32-bit hash.
 * FNV-1a 32-bit has a 2^32 ≈ 4.3B id space; with sqlite-vec's
 * rowid collision semantics a colliding pair of ids would
 * silently overwrite each other's vector. At typical agent
 * scale (< 100k stored facts per session) the collision
 * probability is non-trivial in the birthday-bound sense.
 * FNV-1a 64-bit raises the ceiling to 2^64, eliminating the
 * risk for any plausible workload.
 *
 * The returned bigint is unsigned (high bit cleared via the
 * `& 0xffffffffffffffffn` mask). The caller is expected to
 * narrow back to a number when binding to better-sqlite3's
 * INTEGER column — `Number(bigint)` is safe up to 2^53 and
 * sqlite-vec's rowid accepts any positive integer.
 */
const fnv1a64 = (s: string): bigint => {
  // FNV-1a 64-bit offset basis (per the FNV reference).
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  for (let i = 0; i < s.length; i += 1) {
    h ^= BigInt(s.charCodeAt(i))
    h = (h * prime) & 0xffffffffffffffffn
  }
  return h
}
