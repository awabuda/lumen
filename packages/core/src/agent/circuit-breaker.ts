/**
 * `ProviderCircuitBreaker` — per-provider failure-rate tracker.
 *
 * Wraps a single provider id; tracks consecutive failures and
 * transitions between three states:
 *
 *   - `closed`   — normal operation. Failures are recorded.
 *   - `open`     — calls fail-fast with `CircuitOpenError`. After
 *                  `cooldownMs` the breaker becomes `half-open`.
 *   - `half-open` — exactly one trial call is allowed. A success
 *                  closes the breaker; a failure re-opens it.
 *
 * The breaker is **idempotent and cheap**. It holds one timestamp
 * (`openedAt`) and one counter (`consecutiveFailures`) per id.
 * Use one breaker instance per logical failure domain (e.g. one
 * per provider pool) and pass the `providerId` on each call.
 *
 * This is intentionally **not** a sliding-window rate breaker —
 * that requires per-call timestamps and is overkill for the
 * "LLM provider is down" case, where 5 consecutive 5xx errors is
 * already a clear signal. Sliding-window can layer on top later.
 */
import { z } from 'zod'
import { AgentError } from '../errors/index.js'

/** State of a single circuit. */
export type CircuitState = 'closed' | 'open' | 'half-open'

/** Options for {@link CircuitBreaker}. */
export interface CircuitBreakerOptions {
  /**
   * Consecutive failures before the breaker opens. Default 5.
   * Lower this for tighter protection (e.g. tier-1 routing),
   * raise it for chatty providers that occasionally drop a request.
   */
  readonly failureThreshold?: number
  /**
   * How long the breaker stays open before transitioning to
   * half-open, in milliseconds. Default 30_000.
   */
  readonly cooldownMs?: number
  /**
   * Time source. Defaults to `Date.now`. Tests can inject a
   * deterministic clock to drive the state machine.
   */
  readonly now?: () => number
}

/** Zod schema for {@link CircuitBreakerOptions}. */
export const CircuitBreakerOptionsSchema = z.object({
  failureThreshold: z.number().int().positive().max(1_000).optional(),
  cooldownMs: z.number().int().positive().max(600_000).optional(),
  now: z.function().optional(),
})

/**
 * Thrown by {@link CircuitBreaker.allow} when the breaker is
 * `open` and has not yet cooled down.
 */
export class CircuitOpenError extends AgentError {
  public readonly providerId: string
  public readonly retryAfterMs: number
  public constructor(providerId: string, retryAfterMs: number) {
    super(`Circuit for provider '${providerId}' is open; retry after ${retryAfterMs}ms`)
    this.name = 'CircuitOpenError'
    this.providerId = providerId
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * Per-id circuit breaker. One instance can track many provider
 * ids in parallel.
 */
export class CircuitBreaker {
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly now: () => number
  /**
   * Per-id state. We keep this in a map so one breaker instance
   * can be shared across many providers without losing
   * independence. We use a state machine rather than "openedAt
   * is 0" tricks, because 0 is a valid timestamp on some clocks.
   */
  private readonly state = new Map<
    string,
    { state: CircuitState; consecutiveFailures: number; openedAt: number }
  >()

  public constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5
    this.cooldownMs = options.cooldownMs ?? 30_000
    this.now = options.now ?? Date.now
  }

  /**
   * Check whether the breaker allows a call to `providerId`
   * right now. Returns `true` (or rather, returns void on
   * success) if the call may proceed. If the breaker is `open`
   * and has cooled down, this also transitions it to
   * `half-open` (exactly one trial).
   *
   * Throws `CircuitOpenError` if the breaker is `open` and
   * still within the cooldown window.
   */
  public allow(providerId: string): void {
    const entry = this.state.get(providerId)
    if (!entry) return // never failed — closed by default
    if (entry.state === 'closed') return
    if (entry.state === 'open') {
      const elapsed = this.now() - entry.openedAt
      if (elapsed < this.cooldownMs) {
        throw new CircuitOpenError(providerId, this.cooldownMs - elapsed)
      }
      // Cooldown elapsed — transition to half-open so the next
      // call is the trial. We don't reset the failure counter;
      // a half-open failure re-opens at the same count.
      entry.state = 'half-open'
    }
    // half-open: caller is the trial; let it through.
  }

  /** Record a successful call. Closes the breaker if it was open. */
  public recordSuccess(providerId: string): void {
    this.state.delete(providerId)
  }

  /** Record a failed call. Opens the breaker if the threshold is reached. */
  public recordFailure(providerId: string): void {
    const entry = this.state.get(providerId) ?? {
      state: 'closed' as CircuitState,
      consecutiveFailures: 0,
      openedAt: 0,
    }
    entry.consecutiveFailures += 1
    if (entry.consecutiveFailures >= this.failureThreshold) {
      entry.state = 'open'
      entry.openedAt = this.now()
    }
    this.state.set(providerId, entry)
  }

  /** Read-only view of the current state for one id. */
  public stateOf(providerId: string): CircuitState {
    const entry = this.state.get(providerId)
    if (!entry) return 'closed'
    if (entry.state === 'closed') return 'closed'
    if (entry.state === 'open') {
      if (this.now() - entry.openedAt >= this.cooldownMs) return 'half-open'
      return 'open'
    }
    return 'half-open'
  }
}
