/**
 * Checkpoint / Resume (P20.4) — agent run-state snapshots.
 *
 * P19.7 follow-up: the agent loop already supports `AbortSignal`
 * for clean cancellation, but a cancelled run loses all
 * progress — the next `agent.run()` call starts from scratch.
 * Checkpoint adds a layer on top: when the loop is aborted (or
 * exceeds `maxIterations`, or hits a budget), the agent can
 * save a snapshot of the message history and `iterations`
 * count, and a subsequent call can resume from that snapshot
 * instead of re-running from the original user message.
 *
 * Design choices:
 *   - `BaseCheckpointStore` is an interface, not an abstract
 *     class (P19 rule 15: helper > abstract class). The
 *     in-process `InMemoryCheckpointStore` is one
 *     implementation; a future SqliteCheckpointStore in
 *     `@lumen/memory` (or in a downstream package) is another.
 *   - Core ships the interface + the in-memory implementation.
 *     The SQLite-backed version is a downstream concern so the
 *     core package can stay storage-agnostic.
 *   - `AgentCheckpoint` is a plain JSON-serialisable value.
 *     The base contract does **not** include the agent
 *     instance or tool registry — only the inputs and
 *     outputs that are stable across processes.
 *
 * Not a middleware: checkpoint is orthogonal to the agent
 * loop's hook points. P19+ rule 11 says "any extension to the
 * Agent loop = middleware"; checkpoint is a save/load helper,
 * not a per-step hook, so it stays out of the middleware
 * pipeline.
 */

import { z } from 'zod'

import type { Message } from '../message/index.js'
import type { AgentRunResult } from './index.js'

/**
 * A serialisable snapshot of an agent run's progress.
 *
 * `messages` is the full conversation history up to and
 * including the last assistant message. `iterations` is the
 * iteration counter at the moment of the snapshot (so resume
 * can re-enter the loop with a clean `iterations` reset and
 * the same message prefix).
 */
export interface AgentCheckpoint {
  /** Stable checkpoint id, derived from sessionId + iterations. */
  readonly id: string
  /** Session id the checkpoint belongs to. */
  readonly sessionId: string
  /** Full message history at the moment of the snapshot. */
  readonly messages: ReadonlyArray<Message>
  /** Iteration counter at the moment of the snapshot. */
  readonly iterations: number
  /** When the checkpoint was saved (epoch ms). */
  readonly createdAt: number
  /** Optional human-readable label. */
  readonly label?: string
  /**
   * P21 outcome marker. Legacy P20.4 checkpoints omit this field and are
   * treated as `in_progress` by resume discovery.
   */
  readonly outcome?: 'in_progress' | 'success' | 'error'
}

export const AgentCheckpointSchema = z
  .object({
    id: z.string().min(1),
    sessionId: z.string().min(1),
    messages: z.array(z.unknown()),
    iterations: z.number().int().nonnegative(),
    createdAt: z.number().int().nonnegative(),
    label: z.string().min(1).optional(),
    outcome: z.enum(['in_progress', 'success', 'error']).optional(),
  })
  .strict()

/** Build a checkpoint from an agent run result. */
export const checkpointFromRun = (result: AgentRunResult, label?: string): AgentCheckpoint => {
  const base: AgentCheckpoint = {
    id: `${result.sessionId}-${result.iterations}`,
    sessionId: result.sessionId,
    messages: [...result.messages],
    iterations: result.iterations,
    createdAt: Date.now(),
  }
  return label !== undefined ? { ...base, label } : base
}

/**
 * The contract every checkpoint store fulfils. Implementations
 * must be safe to call from multiple async contexts.
 */
export interface BaseCheckpointStore {
  readonly id: string
  /** Persist a checkpoint. Overwrites if the same id is saved twice. */
  save(checkpoint: AgentCheckpoint): Promise<AgentCheckpoint>
  /** Get a checkpoint by id. */
  get(id: string): Promise<AgentCheckpoint | undefined>
  /** List all checkpoints for a session, newest first. */
  list(sessionId: string): Promise<ReadonlyArray<AgentCheckpoint>>
  /** Return the newest resumable checkpoint, optionally scoped to one session. */
  latestInProgress(options?: {
    readonly sessionId?: string
    readonly minCreatedAt?: number
  }): Promise<AgentCheckpoint | undefined>
  /** Delete a checkpoint by id. Returns true if a checkpoint was removed. */
  delete(id: string): Promise<boolean>
}

/**
 * In-memory checkpoint store. Suitable for tests and short-lived
 * CLI invocations; for cross-process persistence, use a SQLite
 * implementation (downstream package).
 */
export class InMemoryCheckpointStore implements BaseCheckpointStore {
  public readonly id = 'memory'
  private readonly byId = new Map<string, AgentCheckpoint>()

  public async save(checkpoint: AgentCheckpoint): Promise<AgentCheckpoint> {
    AgentCheckpointSchema.parse(checkpoint)
    this.byId.set(checkpoint.id, checkpoint)
    return checkpoint
  }

  public async get(id: string): Promise<AgentCheckpoint | undefined> {
    return this.byId.get(id)
  }

  public async list(sessionId: string): Promise<ReadonlyArray<AgentCheckpoint>> {
    return [...this.byId.values()]
      .filter((c) => c.sessionId === sessionId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  public async latestInProgress(
    options: {
      readonly sessionId?: string
      readonly minCreatedAt?: number
    } = {},
  ): Promise<AgentCheckpoint | undefined> {
    return [...this.byId.values()]
      .filter(
        (checkpoint) =>
          (options.sessionId === undefined || checkpoint.sessionId === options.sessionId) &&
          checkpoint.outcome !== 'success' &&
          checkpoint.outcome !== 'error' &&
          (options.minCreatedAt === undefined || checkpoint.createdAt >= options.minCreatedAt),
      )
      .sort((a, b) => b.createdAt - a.createdAt)[0]
  }

  public async delete(id: string): Promise<boolean> {
    return this.byId.delete(id)
  }
}
