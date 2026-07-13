/** Durable checkpoint auto-resume helpers (P21.1). */
import type { AgentCheckpoint, BaseCheckpointStore } from '@lumen/core'

/** Default maximum age for an automatically resumed checkpoint. */
export const DEFAULT_RESUME_TTL_MS = 10 * 60_000

export interface FindResumeCheckpointOptions {
  readonly store: BaseCheckpointStore
  readonly enabled?: boolean
  readonly ttlMs?: number
  readonly sessionId?: string
  readonly now?: number
}

/** Return the newest fresh in-progress checkpoint, or undefined. */
export const findResumeCheckpoint = async (
  options: FindResumeCheckpointOptions,
): Promise<AgentCheckpoint | undefined> => {
  if (options.enabled === false) return undefined
  const ttlMs = options.ttlMs ?? DEFAULT_RESUME_TTL_MS
  if (!Number.isInteger(ttlMs) || ttlMs < 1) {
    throw new RangeError('resumeTtlMs must be a positive integer')
  }
  const now = options.now ?? Date.now()
  return options.store.latestInProgress({
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    minCreatedAt: now - ttlMs,
  })
}
