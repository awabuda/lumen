/**
 * P25.4 \u2014 Agent View (bug.md #50).
 *
 * Read-only observer surface that exposes the agent's
 * task list + currently-active sub-agents. \`lumen view\`
 * (CLI, future ticket) consumes this view.
 *
 * The view is a *pure function* over the agent's current
 * state. We do NOT mutate anything; we do NOT depend on
 * any private class internals.
 */

import type { BackgroundTaskRecord } from './background-tasks.js'

export interface AgentViewSnapshot {
  /** The agent's session id. */
  readonly sessionId: string
  /** The model id in use. */
  readonly model: string
  /** Wall-clock ms since the run started. */
  readonly elapsedMs: number
  /** Number of iterations the loop has taken so far. */
  readonly iterations: number
  /** All background tasks (resolved + pending + rejected +
   *  cancelled). Same shape as BackgroundTaskRecord. */
  readonly backgroundTasks: ReadonlyArray<BackgroundTaskRecord<unknown>>
  /** Active sub-agent ids. */
  readonly activeSubAgentIds: ReadonlyArray<string>
}

/** Pure factory: snapshot the agent's state at call time. */
export const snapshotAgentView = (params: {
  readonly sessionId: string
  readonly model: string
  readonly startedAtMs: number
  readonly iterations: number
  readonly backgroundTasks: ReadonlyArray<BackgroundTaskRecord<unknown>>
  readonly activeSubAgentIds: ReadonlyArray<string>
  readonly now?: () => number
}): AgentViewSnapshot => {
  const now = params.now ?? (() => Date.now())
  return {
    sessionId: params.sessionId,
    model: params.model,
    elapsedMs: Math.max(0, now() - params.startedAtMs),
    iterations: params.iterations,
    backgroundTasks: [...params.backgroundTasks],
    activeSubAgentIds: [...params.activeSubAgentIds],
  }
}

/**
 * Format the snapshot as a one-line-per-row Markdown
 * table. Operators can pipe it into \`lumen view\`'s TUI
 * or to a log file.
 */
export const formatAgentView = (snap: AgentViewSnapshot): string => {
  const rows = [
    `session: ${snap.sessionId}`,
    `model: ${snap.model}`,
    `elapsed: ${snap.elapsedMs}ms`,
    `iterations: ${snap.iterations}`,
    `background tasks: ${snap.backgroundTasks.length}`,
    `active sub-agents: ${snap.activeSubAgentIds.length}`,
  ]
  return rows.join('\n')
}