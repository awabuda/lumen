/**
 * `lumen checkpoint` — list / show / delete saved agent run checkpoints.
 *
 * Sub-commands:
 *   - `list <session-id>`: print every checkpoint for the given
 *     session, newest first, with id, iterations, createdAt, label.
 *   - `show <checkpoint-id>`: print the full checkpoint (id,
 *     sessionId, iterations, createdAt, label, messages).
 *   - `delete <checkpoint-id>`: remove a checkpoint.
 *   - `save <session-id>`: reserved for the future — currently
 *     checkpoints are only produced automatically by `Agent.run`
 *     when it throws; there is no manual "save the in-flight
 *     run" path. (See P20.4.2.)
 *
 * Why a CLI surface for checkpoints:
 *   - The agent loop auto-saves on every throw (when a
 *     `checkpointStore` is configured). The CLI escape hatch
 *     is useful for inspecting what was saved and for pruning
 *     stale snapshots.
 *   - This is a power-user command. The normal path is the
 *     agent loop's own save-on-throw behaviour.
 *
 * Storage: the in-memory store is per-process, so this CLI
 * command is best-effort (it reports (no checkpoints) on a
 * fresh process). The P20.4.4 SQLite-backed store will be
 * persistent across processes; that commit is the one that
 * makes this CLI genuinely useful for production use.
 */

import {
  type AgentCheckpoint,
  type BaseCheckpointStore,
  InMemoryCheckpointStore,
} from '@lumen/core'

/**
 * Resolve the checkpoint store to operate on.
 *
 * Resolution order:
 *   1. The `store` option (used by the unit tests for an
 *      InMemoryCheckpointStore injected with pre-seeded data).
 *   2. The `file` option pointing at a SQLite database —
 *      instantiates a SqliteCheckpointStore and **opens it
 *      lazily** so the CLI does not have to be told about
 *      SQLite upfront.
 *   3. The in-memory store (per-process). The CLI reports
 *      "(no checkpoints ...)" on a fresh process because the
 *      in-memory store is per-process.
 */
const resolveStore = async (opts: {
  readonly store?: BaseCheckpointStore
  readonly file?: string
}): Promise<BaseCheckpointStore & { dispose?: () => Promise<void> }> => {
  if (opts.store) return opts.store
  if (opts.file) {
    const { SqliteCheckpointStore } = await import('@lumen/memory')
    return new SqliteCheckpointStore({ path: opts.file })
  }
  return new InMemoryCheckpointStore()
}

export interface CheckpointListOptions {
  readonly sessionId: string
  /** Override the in-process checkpoint store. */
  readonly store?: BaseCheckpointStore
  /** Path to a SQLite-backed store. Overrides the in-memory default. */
  readonly file?: string
  /**
   * P38.d — output format. 'human' (default) is the
   * pre-P38.d one-line-per-checkpoint text layout;
   * 'json' emits a JSON array (CI-friendly). Brings
   * `list` to parity with `show --format json` (P37.b).
   */
  readonly format?: 'human' | 'json'
}

export const checkpointListCommand = async (opts: CheckpointListOptions): Promise<number> => {
  const store = await resolveStore(opts)
  try {
    const list = await store.list(opts.sessionId)
    if (opts.format === 'json') {
      const rows = list.map((cp) => ({
        id: cp.id,
        iterations: cp.iterations,
        createdAt: cp.createdAt,
        ...(cp.label !== undefined ? { label: cp.label } : {}),
      }))
      process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
      return 0
    }
    if (list.length === 0) {
      process.stdout.write(`(no checkpoints for session ${opts.sessionId})\n`)
      return 0
    }
    process.stdout.write(`Checkpoints for session ${opts.sessionId} (${list.length}):\n`)
    for (const cp of list) {
      const label = cp.label ? `  label=${JSON.stringify(cp.label)}` : ''
      process.stdout.write(
        `  - ${cp.id}  iter=${cp.iterations}  createdAt=${cp.createdAt}${label}\n`,
      )
    }
    return 0
  } finally {
    await store.dispose?.()
  }
}

export interface CheckpointShowOptions {
  readonly id: string
  readonly store?: BaseCheckpointStore
  readonly file?: string
  /**
   * P37.b — output format. 'human' (default) is the
   * pre-P37.b one-line-per-field text layout; 'json'
   * emits the full AgentCheckpoint as JSON for CI
   * pipelines and scripted consumers.
   */
  readonly format?: 'human' | 'json'
}

export const checkpointShowCommand = async (opts: CheckpointShowOptions): Promise<number> => {
  const store = await resolveStore(opts)
  try {
    const cp = await store.get(opts.id)
    if (!cp) {
      process.stderr.write(`lumen checkpoint show: no checkpoint with id "${opts.id}"\n`)
      return 1
    }
    if (opts.format === 'json') {
      process.stdout.write(`${JSON.stringify(cp, null, 2)}\n`)
      return 0
    }
    printCheckpoint(cp)
    return 0
  } finally {
    await store.dispose?.()
  }
}

export interface CheckpointDeleteOptions {
  readonly id: string
  readonly store?: BaseCheckpointStore
  readonly file?: string
}

export const checkpointDeleteCommand = async (opts: CheckpointDeleteOptions): Promise<number> => {
  const store = await resolveStore(opts)
  try {
    const removed = await store.delete(opts.id)
    if (!removed) {
      process.stderr.write(`lumen checkpoint delete: no checkpoint with id "${opts.id}"\n`)
      return 1
    }
    process.stdout.write(`deleted ${opts.id}\n`)
    return 0
  } finally {
    await store.dispose?.()
  }
}

export interface CheckpointRestoreOptions {
  /**
   * Restore by explicit checkpoint id. Mutually
   * exclusive with `sessionId` and `latest`. When
   * neither is set, restores the most-recent
   * in-progress checkpoint across every session.
   */
  readonly id?: string
  /**
   * Restore the most-recent in-progress checkpoint
   * for the given session.
   */
  readonly sessionId?: string
  /**
   * Restore the latest in-progress checkpoint across
   * every session (no session filter).
   */
  readonly latest?: boolean
  /** When set, print the resolved checkpoint as JSON. */
  readonly json?: boolean
  readonly store?: BaseCheckpointStore
  readonly file?: string
}

/**
 * `lumen checkpoint restore` — P34.5 (Phase B.5)
 * resolves a saved checkpoint and prints it for use
 * with `lumen run --resume-from <path>:<id>` (or the
 * TUI's auto-resume path). The restore path does NOT
 * itself run the agent — it returns the resolved
 * checkpoint id so the caller can decide which
 * `lumen run` invocation to attach it to.
 */
export const checkpointRestoreCommand = async (opts: CheckpointRestoreOptions): Promise<number> => {
  const store = await resolveStore(opts)
  try {
    let cp: AgentCheckpoint | undefined
    if (opts.id !== undefined) {
      cp = await store.get(opts.id)
      if (cp === undefined) {
        process.stderr.write(`lumen checkpoint restore: no checkpoint with id "${opts.id}"\n`)
        return 1
      }
    } else {
      // latest / sessionId / both-unset all map to
      // `latestInProgress` with the optional session
      // filter. `latest: true` is a flag for "ignore
      // session filter" — we just don't pass it.
      cp = await store.latestInProgress(
        opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {},
      )
      if (cp === undefined) {
        const where = opts.sessionId !== undefined ? ` for session "${opts.sessionId}"` : ''
        process.stderr.write(`lumen checkpoint restore: no in-progress checkpoint${where}\n`)
        return 1
      }
    }
    if (opts.json === true) {
      process.stdout.write(`${JSON.stringify(cp, null, 2)}\n`)
    } else {
      process.stdout.write(
        `lumen checkpoint restore: ${cp.id} (session=${cp.sessionId} iter=${cp.iterations})\n`,
      )
      process.stdout.write('  use: lumen run --resume-from <path>:<id>\n')
    }
    return 0
  } finally {
    await store.dispose?.()
  }
}

const printCheckpoint = (cp: AgentCheckpoint): void => {
  process.stdout.write(`id:        ${cp.id}\n`)
  process.stdout.write(`sessionId: ${cp.sessionId}\n`)
  process.stdout.write(`iterations: ${cp.iterations}\n`)
  process.stdout.write(`createdAt: ${cp.createdAt}\n`)
  if (cp.label) {
    process.stdout.write(`label:     ${JSON.stringify(cp.label)}\n`)
  }
  process.stdout.write(`messages:  ${cp.messages.length}\n`)
  for (const m of cp.messages) {
    const role = m.role
    const content = 'content' in m ? String(m.content) : ''
    process.stdout.write(`  [${role}] ${content.slice(0, 120)}\n`)
  }
}
