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

import { type AgentCheckpoint, InMemoryCheckpointStore } from '@lumen/core'

export interface CheckpointListOptions {
  readonly sessionId: string
  /** Override the in-process checkpoint store. */
  readonly store?: InMemoryCheckpointStore
}

export const checkpointListCommand = async (
  opts: CheckpointListOptions,
): Promise<number> => {
  const store = opts.store ?? new InMemoryCheckpointStore()
  const list = await store.list(opts.sessionId)
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
}

export interface CheckpointShowOptions {
  readonly id: string
  readonly store?: InMemoryCheckpointStore
}

export const checkpointShowCommand = async (
  opts: CheckpointShowOptions,
): Promise<number> => {
  const store = opts.store ?? new InMemoryCheckpointStore()
  const cp = await store.get(opts.id)
  if (!cp) {
    process.stderr.write(`lumen checkpoint show: no checkpoint with id "${opts.id}"\n`)
    return 1
  }
  printCheckpoint(cp)
  return 0
}

export interface CheckpointDeleteOptions {
  readonly id: string
  readonly store?: InMemoryCheckpointStore
}

export const checkpointDeleteCommand = async (
  opts: CheckpointDeleteOptions,
): Promise<number> => {
  const store = opts.store ?? new InMemoryCheckpointStore()
  const removed = await store.delete(opts.id)
  if (!removed) {
    process.stderr.write(`lumen checkpoint delete: no checkpoint with id "${opts.id}"\n`)
    return 1
  }
  process.stdout.write(`deleted ${opts.id}\n`)
  return 0
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
