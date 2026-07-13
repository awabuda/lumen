/**
 * Heartbeat / long-running supervisor (P20.2) — outer wrapper
 * around `Agent.run` that aborts the run if the agent has been
 * idle for too long.
 *
 * Why an **outer wrapper** (not a middleware):
 *   - The supervisor's job is to watch the run **between**
 *     agent loop iterations, not to influence any single
 *     iteration. P19+ rule 11 ("extension to the Agent loop =
 *     middleware") does not apply because the supervisor does
 *     not change loop behaviour — it terminates the run from
 *     the outside.
 *   - An outer wrapper is also the **only** place that can
 *     reliably call `signal.abort()` on a stable signal. The
 *     agent loop reads `signal.aborted` at the top of every
 *     iteration; the supervisor sets the abort flag from a
 *     setInterval callback. A middleware-based design would
 *     need a side channel to the controller.
 *   - The pattern matches the existing `runWithFailover` and
 *     `withTimeout` patterns in `@lumen/core` — utility
 *     functions, not middleware.
 *
 * Algorithm:
 *   1. `startHeartbeat({ intervalMs, onTimeout, onPing })`
 *      returns a `HeartbeatHandle` that owns a private
 *      `AbortController` and a `setInterval`.
 *   2. The caller passes `handle.signal` to `agent.run()`.
 *   3. Every `intervalMs`, the supervisor's tick fires. If
 *      the run is still alive (`handle.isAlive()`), the
 *      `onPing` callback runs (default: no-op). The caller
 *      updates `lastActivity` whenever it wants the timer to
 *      reset; we do **not** auto-detect activity because the
 *      agent loop has no "last activity" hook.
 *   4. When the caller wants the supervisor to **enforce** a
 *      deadline, they use the higher-level `runWithHeartbeat`
 *      helper which builds the supervisor, drives the agent,
 *      and triggers `signal.abort()` on timeout.
 *
 * Two layers (handle + runWithHeartbeat) because the call
 * sites are different: a CLI tool that runs an agent and
 * pipes events wants `runWithHeartbeat`; a TUI that wants
 * a "still alive" indicator wants the raw handle + onPing.
 */

import { AbortError } from './errors/index.js'

/** Default heartbeat interval. 30 s matches the P20.2 spec. */
export const HEARTBEAT_DEFAULT_INTERVAL_MS = 30_000

/**
 * Options for {@link startHeartbeat}.
 *
 * `onTimeout` is optional. When omitted, the supervisor never
 * auto-aborts; the handle is purely a "still alive" signal
 * for the caller. When present, `signal.abort()` is invoked
 * after `timeoutMs` of inactivity and the handle stops.
 */
export interface HeartbeatOptions {
  /** Wall-clock interval between ticks. Defaults to 30 000 ms. */
  readonly intervalMs?: number
  /**
   * Optional auto-abort deadline. When set, the supervisor
   * calls `signal.abort()` after `timeoutMs` of no
   * `bump()` activity. The default is **no** auto-abort
   * (pure ping mode).
   */
  readonly timeoutMs?: number
  /**
   * Optional per-tick observer. The supervisor invokes this
   * on every tick. The handle's `bump()` call does **not**
   * invoke onPing; bump only resets the deadline.
   */
  readonly onPing?: (now: number) => void
  /**
   * Optional timeout observer. Fires once when the deadline
   * elapses (right before the signal is aborted). Use this
   * to log, increment a metric, or surface a UI message.
   */
  readonly onTimeout?: (now: number) => void
  /**
   * P21.2: optional second timer that periodically reads the
   * newest fresh checkpoint from a store that implements
   * `latestInProgress`. The reader is fed to `onCheckpoint`
   * so the operator (or a CLI) can mirror the latest
   * snapshot — e.g. copy the SQLite file, log a JSON
   * progress line, or push a `wal checkpoint` call. Mutually
   * independent of the heartbeat (the heartbeat enforces
   * `timeoutMs`; this reader is just a periodic poll). The
   * store must implement `BaseCheckpointStore.latestInProgress`.
   */
  readonly checkpointStore?: import('./agent/checkpoint.js').BaseCheckpointStore
  /** Wall-clock interval for the checkpoint poll (ms). Required when `checkpointStore` is set. */
  readonly checkpointIntervalMs?: number
  /** Optional session scope for the checkpoint poll. */
  readonly checkpointSessionId?: string
  /** Per-tick observer fired with the latest fresh checkpoint. */
  readonly onCheckpoint?: (checkpoint: import('./agent/checkpoint.js').AgentCheckpoint) => void
}

/**
 * Handle returned by {@link startHeartbeat}.
 *
 * Lifecycle:
 *   - `signal` — the AbortSignal to pass to `agent.run()`.
 *   - `bump()` — reset the deadline. Call whenever the run
 *     produces activity you want to count as "still alive".
 *   - `isAlive()` — true if the supervisor is still ticking.
 *   - `stop()` — tear down the interval. Always call this
 *     when the run finishes (success or failure).
 */
export interface HeartbeatHandle {
  readonly signal: AbortSignal
  bump(): void
  isAlive(): boolean
  stop(): void
}

interface InternalHeartbeatState {
  lastActivity: number
  alive: boolean
  timer: ReturnType<typeof setInterval> | null
  controller: AbortController
  timedOut: boolean
}

const createInternalState = (now: number): InternalHeartbeatState => ({
  lastActivity: now,
  alive: true,
  timer: null,
  controller: new AbortController(),
  timedOut: false,
})

/**
 * Start a heartbeat supervisor. The returned handle is alive
 * until `stop()` is called.
 */
export const startHeartbeat = (options: HeartbeatOptions = {}): HeartbeatHandle => {
  const intervalMs = options.intervalMs ?? HEARTBEAT_DEFAULT_INTERVAL_MS
  if (intervalMs <= 0) {
    throw new Error('startHeartbeat: intervalMs must be positive')
  }
  if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
    throw new Error('startHeartbeat: timeoutMs must be positive when set')
  }
  const timeoutMs = options.timeoutMs
  const state = createInternalState(Date.now())

  const tick = (): void => {
    if (!state.alive) return
    const now = Date.now()
    if (timeoutMs !== undefined && now - state.lastActivity >= timeoutMs) {
      if (!state.timedOut) {
        state.timedOut = true
        options.onTimeout?.(now)
        state.controller.abort(new AbortError('heartbeat timeout'))
      }
      return
    }
    options.onPing?.(now)
  }

  state.timer = setInterval(tick, intervalMs)
  // Allow the process to exit even if the timer is still
  // running. Without this, a never-stopped heartbeat would
  // keep Node alive past `lumen run` exit.
  if (typeof state.timer === 'object' && state.timer !== null && 'unref' in state.timer) {
    ;(state.timer as { unref?: () => void }).unref?.()
  }

  return {
    signal: state.controller.signal,
    bump: () => {
      state.lastActivity = Date.now()
    },
    isAlive: () => state.alive,
    stop: () => {
      if (!state.alive) return
      state.alive = false
      if (state.timer !== null) {
        clearInterval(state.timer)
        state.timer = null
      }
    },
  }
}

/**
 * Drive an `Agent.run` with a heartbeat supervisor attached.
 *
 *   - Builds a heartbeat with `intervalMs` (default 30 000).
 *   - Calls `runner()` with the supervisor's signal attached.
 *   - If the supervisor fires, the underlying run throws
 *     `AbortError` (same shape as a user-driven abort) and
 *     this helper propagates it.
 *   - When the run settles (success or failure), the
 *     supervisor is stopped so the timer doesn't keep the
 *     process alive.
 *   - When `checkpointStore` + `checkpointIntervalMs` are
 *     provided, the helper also bridges the two timers: the
 *     heartbeat continues to enforce `timeoutMs`, while a
 *     separate wall-clock interval calls
 *     `checkpointStore.latestInProgress({ sessionId, minCreatedAt })`
 *     and forwards the snapshot to a caller-supplied
 *     `onCheckpoint` observer. The agent loop's own step-level
 *     `saveCheckpointBestEffort` continues to run on every
 *     completed step inside the loop; the heartbeat hook is
 *     the **second** timer, useful for surfaces that want a
 *     deterministic wall-clock cadence independent of how
 *     many model turns fit in a window.
 *
 * The runner is the only thing that should call `bump()`.
 * Inside the runner, `bump()` is a no-op unless the caller
 * is using the higher-level handle directly; this helper
 * does **not** auto-bump on tool calls or model responses
 * (the agent loop has no such hook in core).
 */
export const runWithHeartbeat = async <T>(
  runner: (signal: AbortSignal) => Promise<T>,
  options: HeartbeatOptions = {},
): Promise<T> => {
  const handle = startHeartbeat(options)
  let checkpointTimer: ReturnType<typeof setInterval> | null = null
  let checkpointMinCreatedAt = 0
  if (options.checkpointStore && options.checkpointIntervalMs !== undefined) {
    const interval = options.checkpointIntervalMs
    if (!Number.isInteger(interval) || interval < 1) {
      handle.stop()
      throw new Error('runWithHeartbeat: checkpointIntervalMs must be a positive integer')
    }
    if (typeof options.checkpointStore.latestInProgress !== 'function') {
      handle.stop()
      throw new Error('runWithHeartbeat: checkpointStore must implement latestInProgress')
    }
    const store = options.checkpointStore
    const sessionId = options.checkpointSessionId
    const onCheckpoint = options.onCheckpoint
    const checkpointTick = (): void => {
      if (!handle.isAlive()) return
      void store
        .latestInProgress({
          ...(sessionId ? { sessionId } : {}),
          minCreatedAt: checkpointMinCreatedAt,
        })
        .then((snapshot) => {
          if (snapshot) onCheckpoint?.(snapshot)
        })
        .catch(() => {
          // best-effort: never replace the runner result
        })
    }
    checkpointTimer = setInterval(checkpointTick, interval)
    if (
      typeof checkpointTimer === 'object' &&
      checkpointTimer !== null &&
      'unref' in checkpointTimer
    ) {
      ;(checkpointTimer as { unref?: () => void }).unref?.()
    }
    checkpointMinCreatedAt = Date.now() - interval
  }
  try {
    return await runner(handle.signal)
  } finally {
    handle.stop()
    if (checkpointTimer !== null) clearInterval(checkpointTimer)
  }
}
