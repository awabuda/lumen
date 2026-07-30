/**
 * `SqliteLoopsStore` — persistent loop registry backed by
 * `better-sqlite3`.
 *
 * Why a dedicated store rather than reusing SqliteStore /
 * SqliteCheckpointStore:
 *   - SqliteStore holds durable `records`/`sessions`/`messages`
 *     shaped for agent memory; loops have completely different
 *     fields and lifecycle. Forcing them into `BaseMemoryStore`'s
 *     contract would pollute `MemoryRecord` with loop-only fields.
 *   - SqliteCheckpointStore is snapshot-shaped (single `messages_json`
 *     column per row). Loops are flat columns + an `id` keyed by
 *     `/loop`-generated random suffix, not by `sessionId-iteration`.
 *     Mixing the two would lock both schemas into a single DDL
 *     migration.
 *   - Loop persistence uses `stopped_at` to gate restart-on-next-launch;
 *     none of the other stores have that axis.
 *
 * Schema:
 *   `loops(id PK, kind CHECK, interval_ms, cron_expr, prompt,
 *     registered_at, last_tick_at, stopped_at)`
 *     - `id` is the natural key (loop-<timestamp>-<rand>) generated
 *       by the CLI /loop command, matching `IntervalCron.id`.
 *     - `stopped_at IS NULL` means "still alive" — the marker
 *       startAll() filters on.
 *
 * Tier isolation: same as `SqliteCheckpointStore` — this file
 * lives in `@lumen/memory` next to the other SQLite machinery;
 * `@lumen/core` stays storage-agnostic. The CLI in `apps/cli`
 * holds the schedule-management helpers
 * (`openCronRegistry`-equivalent) and orchestrates firing each
 * loop on top of the pure storage API exposed here.
 *
 * P32.1.1 mkdirSync invariant — same as the sibling stores: the
 * parent directory must exist before better-sqlite3 opens the
 * handle.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import BetterSqlite3 from 'better-sqlite3'
import type { Database, Statement } from 'better-sqlite3'

const LOOPS_FILE = 'loops.sqlite'

/**
 * Default location for the cron-registry SQLite file. Mirrors
 * the XDG-aware resolution pattern of `chat-paths.ts`. Returns
 * `$LUMEN_LOOPS_PATH` (test override) → `$XDG_STATE_HOME/lumen/`
 * → `~/.local/state/lumen/` for the macOS-default-env case.
 */
const defaultLoopsPath = (): string => {
  const override = process.env.LUMEN_LOOPS_PATH
  if (override !== undefined && override.length > 0) return override
  const xdgState = process.env.XDG_STATE_HOME
  if (xdgState !== undefined && xdgState.length > 0) {
    return path.join(xdgState, 'lumen', LOOPS_FILE)
  }
  return path.join(os.homedir(), '.local', 'state', 'lumen', LOOPS_FILE)
}

/**
 * Yield to the event loop after a sync better-sqlite3 op so callers
 * see a real `await` hop instead of a fully synchronous return.
 * Same rationale as `SqliteCheckpointStore.yieldToLoop` (P23.11).
 */
const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const LOOPS_DDL = `
CREATE TABLE IF NOT EXISTS loops (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('interval','cron')),
  interval_ms   INTEGER,
  cron_expr     TEXT,
  prompt        TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  last_tick_at  INTEGER,
  stopped_at    INTEGER
);
CREATE INDEX IF NOT EXISTS loops_active_idx ON loops(stopped_at, registered_at);
`

export type LoopKind = 'interval' | 'cron'

export interface PersistedLoop {
  readonly id: string
  readonly kind: LoopKind
  readonly intervalMs?: number
  readonly cronExpr?: string
  readonly prompt: string
  readonly registeredAt: number
  readonly lastTickAt?: number
  readonly stoppedAt?: number
  readonly isActive: boolean
}

interface LoopRow {
  readonly id: string
  readonly kind: LoopKind
  readonly interval_ms: number | null
  readonly cron_expr: string | null
  readonly prompt: string
  readonly registered_at: number
  readonly last_tick_at: number | null
  readonly stopped_at: number | null
}

const rowToLoop = (r: LoopRow): PersistedLoop => {
  const base: PersistedLoop = {
    id: r.id,
    kind: r.kind,
    prompt: r.prompt,
    registeredAt: r.registered_at,
    isActive: r.stopped_at === null,
  }
  return {
    ...base,
    ...(r.interval_ms !== null ? { intervalMs: r.interval_ms } : {}),
    ...(r.cron_expr !== null ? { cronExpr: r.cron_expr } : {}),
    ...(r.last_tick_at !== null ? { lastTickAt: r.last_tick_at } : {}),
    ...(r.stopped_at !== null ? { stoppedAt: r.stopped_at } : {}),
  }
}

const loopToRow = (e: PersistedLoop): LoopRow => ({
  id: e.id,
  kind: e.kind,
  interval_ms: e.intervalMs ?? null,
  cron_expr: e.cronExpr ?? null,
  prompt: e.prompt,
  registered_at: e.registeredAt,
  last_tick_at: e.lastTickAt ?? null,
  stopped_at: e.stoppedAt ?? null,
})

interface PreparedLoopStatements {
  upsert: Statement
  stop: Statement
  listAll: Statement
  listActive: Statement
  tick: Statement
}

const prepareStatements = (db: Database): PreparedLoopStatements => ({
  upsert: db.prepare(
    `INSERT INTO loops (id, kind, interval_ms, cron_expr, prompt, registered_at, last_tick_at, stopped_at)
     VALUES (@id, @kind, @interval_ms, @cron_expr, @prompt, @registered_at, @last_tick_at, @stopped_at)
     ON CONFLICT(id) DO UPDATE SET
       kind = excluded.kind,
       interval_ms = excluded.interval_ms,
       cron_expr = excluded.cron_expr,
       prompt = excluded.prompt,
       stopped_at = excluded.stopped_at,
       last_tick_at = excluded.last_tick_at`,
  ),
  stop: db.prepare('UPDATE loops SET stopped_at = ? WHERE id = ?'),
  listAll: db.prepare('SELECT * FROM loops ORDER BY registered_at DESC'),
  listActive: db.prepare(
    'SELECT * FROM loops WHERE stopped_at IS NULL ORDER BY registered_at DESC',
  ),
  tick: db.prepare('UPDATE loops SET last_tick_at = ? WHERE id = ?'),
})

export interface SqliteLoopsStoreOptions {
  /**
   * Path to the SQLite file. When omitted (the default), the
   * constructor uses `$XDG_STATE_HOME/lumen/loops.sqlite` with a
   * fallback to `~/.local/state/lumen/loops.sqlite` for the
   * macOS-default-env case. Use `':memory:'` for in-process
   * tests that need to keep the database alive without a file.
   */
  readonly path?: string
}

/**
 * Persistent loop registry. Lifecycle mirrors `SqliteCheckpointStore`:
 * constructor opens the handle, DDL runs immediately, and the
 * optional `dispose()` closes the connection.
 */
export class SqliteLoopsStore {
  public readonly id = 'loops-sqlite'
  private readonly db: Database
  private readonly stmts: PreparedLoopStatements

  public constructor(options: SqliteLoopsStoreOptions = {}) {
    const rawPath = options.path ?? defaultLoopsPath()
    const resolved = rawPath === ':memory:' ? ':memory:' : path.resolve(rawPath)
    if (resolved !== ':memory:') {
      // P32.1.1 mkdirSync invariant.
      fs.mkdirSync(path.dirname(resolved), { recursive: true })
    }
    this.db = new BetterSqlite3(resolved)
    if (!this.db.name.endsWith(':memory:')) {
      this.db.pragma('journal_mode = WAL')
    }
    this.db.pragma('synchronous = NORMAL')
    this.db.exec(LOOPS_DDL)
    this.stmts = prepareStatements(this.db)
  }

  /** Insert or update one loop row. */
  public async save(entry: PersistedLoop): Promise<PersistedLoop> {
    this.stmts.upsert.run(loopToRow(entry))
    await yieldToLoop()
    return entry
  }

  /**
   * Mark a loop as stopped at the current wall-clock. Returns
   * `true` if a row was updated (i.e. the id existed).
   */
  public async stop(id: string): Promise<boolean> {
    const result = this.stmts.stop.run(Date.now(), id)
    await yieldToLoop()
    return result.changes > 0
  }

  /** Update `last_tick_at` for one loop. Called after a successful tick. */
  public async recordTick(id: string, when: number = Date.now()): Promise<void> {
    this.stmts.tick.run(when, id)
    await yieldToLoop()
  }

  /** Return every loop row, newest first, including stopped rows. */
  public async listAll(): Promise<ReadonlyArray<PersistedLoop>> {
    const rows = this.stmts.listAll.all() as LoopRow[]
    await yieldToLoop()
    return rows.map(rowToLoop)
  }

  /**
   * Return the rows that should be re-started on the next
   * `lumen chat` launch — i.e. those without `stopped_at` set.
   * The CLI's `/loop` reload on mount iterates over this list.
   */
  public async listActive(): Promise<ReadonlyArray<PersistedLoop>> {
    const rows = this.stmts.listActive.all() as LoopRow[]
    await yieldToLoop()
    return rows.map(rowToLoop)
  }

  /** Close the underlying database. Tests should call this. */
  public async dispose(): Promise<void> {
    this.db.close()
    await yieldToLoop()
  }
}
