/**
 * Retry utility — exponential backoff with optional jitter, abort
 * awareness, and a pluggable `shouldRetry` predicate.
 *
 * Why this lives in `@lumen/core`:
 *   The whole point is to consume the `retryable: boolean` field on
 *   {@link ProviderError}. Since {@link ProviderError} is defined in
 *   `@lumen/core/src/errors`, and `@lumen/llm` already depends on
 *   `@lumen/core`, the retry helper has to live here so providers can
 *   import it without inverting the dependency graph.
 *
 * Conventions:
 *   - Default behaviour: 0 retries (no behaviour change for callers
 *     that opt out by leaving `maxRetries` at the default).
 *   - Default `shouldRetry`: retry when the thrown value is an
 *     {@link AgentError} subclass with `retryable === true`. This
 *     matches the marker the 4 shipped providers already set on
 *     5xx / 408 / 429 responses.
 *   - `AbortSignal` short-circuit: the first `signal.aborted` check
 *     fires `RetryAbortedError` (a typed {@link AbortError}) so callers
 *     can `instanceof` distinguish "I gave up" from "the user pressed
 *     Ctrl+C".
 *   - Jitter is on by default (full-jitter strategy from the AWS
 *     architecture blog) so a thundering herd of agents retrying
 *     against the same backend don't synchronise.
 *
 * NOT a general-purpose circuit breaker — that's the ProviderPool's
 * job. This module retries the SAME call N times; the pool swaps
 * providers. They're complementary.
 */
import { AbortError, AgentError, ProviderError } from './errors/index.js'

/** Configuration for {@link withRetry}. */
export interface RetryConfig {
  /**
   * Total number of attempts (including the first). `1` means "try
   * once, never retry". Default `1` (no retry) for backwards
   * compatibility.
   */
  readonly maxAttempts?: number
  /**
   * Delay before the first retry, in milliseconds. Subsequent retries
   * multiply by {@link backoffFactor}. Default `100`.
   */
  readonly initialDelayMs?: number
  /**
   * Hard cap on the per-retry delay, in milliseconds. Default `5_000`.
   */
  readonly maxDelayMs?: number
  /**
   * Multiplier applied to the delay after each attempt. Default `2`.
   */
  readonly backoffFactor?: number
  /**
   * Random jitter fraction in `[0, 1)`. With `jitter: 0.5` the
   * computed delay is multiplied by a random value in `[0.5, 1)`.
   * Default `0.5` (full-jitter range, conservative half).
   */
  readonly jitter?: number
  /**
   * Predicate deciding whether to retry a given error. Default
   * retries when the error is a {@link ProviderError} with
   * `retryable === true`.
   */
  readonly shouldRetry?: (err: unknown, attempt: number) => boolean
  /**
   * Optional abort signal. If the signal aborts mid-retry, the loop
   * throws {@link RetryAbortedError} and the original error is
   * attached as `cause`.
   */
  readonly signal?: AbortSignal
  /**
   * Optional observer fired BEFORE sleeping before the next attempt.
   * Useful for logging / metrics. Not awaited — fire-and-forget.
   */
  readonly onRetry?: (err: unknown, attempt: number, delayMs: number) => void
  /**
   * Optional sleep override (for tests). Receives the computed delay
   * and resolves when the retry should proceed. Default uses
   * `setTimeout`.
   */
  readonly sleep?: (ms: number) => Promise<void>
}

const DEFAULTS = {
  maxAttempts: 1,
  initialDelayMs: 100,
  maxDelayMs: 5_000,
  backoffFactor: 2,
  jitter: 0.5,
} as const

/**
 * Thrown when a retry loop exhausts {@link RetryConfig.maxAttempts}
 * without success. Carries the final attempt's error as `cause` and
 * the attempt count for diagnostics.
 */
export class RetryExhaustedError extends AgentError {
  public readonly attempts: number
  public override readonly cause: unknown

  constructor(attempts: number, cause: unknown) {
    super(`Retry exhausted after ${attempts} attempt(s)`, { cause })
    this.name = 'RetryExhaustedError'
    this.attempts = attempts
    this.cause = cause
  }
}

/**
 * Thrown when an active {@link RetryConfig.signal} aborts the retry
 * loop. Distinct from {@link AbortError} so callers can tell the
 * user's cancel apart from an "I really did mean to throw this"
 * agent-level abort.
 */
export class RetryAbortedError extends AbortError {
  public override readonly cause: unknown

  constructor(cause: unknown) {
    super('retry aborted by signal')
    this.name = 'RetryAbortedError'
    this.cause = cause
  }
}

/** Default `shouldRetry` — consults the typed `retryable` flag. */
function defaultShouldRetry(err: unknown, _attempt: number): boolean {
  return err instanceof ProviderError && err.retryable
}

/** Default `sleep` — wraps `setTimeout`. */
function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** Compute the delay (ms) for the Nth retry (1-indexed). */
function computeDelay(
  attempt: number,
  config: Required<Pick<RetryConfig, 'initialDelayMs' | 'maxDelayMs' | 'backoffFactor' | 'jitter'>>,
): number {
  // attempt=1 is the delay BEFORE the first retry (after attempt 0 failed)
  const base = config.initialDelayMs * config.backoffFactor ** (attempt - 1)
  const capped = Math.min(base, config.maxDelayMs)
  if (config.jitter <= 0) return capped
  // Full-jitter: pick uniformly in [(1 - jitter) * capped, capped]
  const lo = capped * (1 - config.jitter)
  return Math.max(0, lo + Math.random() * (capped - lo))
}

/**
 * Run `fn` and retry it according to `config` if it throws a
 * retryable error.
 *
 * Behaviour:
 *   - `maxAttempts: 1` (the default) means "no retry" — the function
 *     runs once and any error propagates verbatim.
 *   - `maxAttempts: 3` means "try up to three times". On attempt 1
 *     and 2 the error is evaluated by `shouldRetry`; if it returns
 *     true the loop sleeps for `computeDelay(attempt)` then retries.
 *   - The first non-retryable error is thrown verbatim, wrapped in
 *     nothing — original stack preserved.
 *   - When the loop exhausts attempts, the final error is wrapped in
 *     {@link RetryExhaustedError} with `cause` set to the original.
 */
export async function withRetry<T>(fn: () => Promise<T>, config: RetryConfig = {}): Promise<T> {
  const maxAttempts = Math.max(1, config.maxAttempts ?? DEFAULTS.maxAttempts)
  const resolved: Required<
    Pick<RetryConfig, 'initialDelayMs' | 'maxDelayMs' | 'backoffFactor' | 'jitter'>
  > = {
    initialDelayMs: config.initialDelayMs ?? DEFAULTS.initialDelayMs,
    maxDelayMs: config.maxDelayMs ?? DEFAULTS.maxDelayMs,
    backoffFactor: config.backoffFactor ?? DEFAULTS.backoffFactor,
    jitter: config.jitter ?? DEFAULTS.jitter,
  }
  const shouldRetry = config.shouldRetry ?? defaultShouldRetry
  const sleep = config.sleep ?? defaultSleep
  const signal = config.signal

  let lastError: unknown
  let madeAttempts = 0
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new RetryAbortedError(lastError ?? signal.reason)
    }
    madeAttempts = attempt
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt >= maxAttempts) break
      if (!shouldRetry(err, attempt)) throw err
      const delay = computeDelay(attempt, resolved)
      if (config.onRetry) {
        try {
          config.onRetry(err, attempt, delay)
        } catch {
          // observer errors must not break the retry loop
        }
      }
      if (signal?.aborted) {
        throw new RetryAbortedError(err)
      }
      await sleep(delay)
    }
  }
  // Only wrap when we actually exercised the retry loop. A single
  // attempt that failed is a normal error — wrapping it would force
  // every caller to unwrap, defeating the "no retry = no change in
  // behaviour" promise.
  if (madeAttempts <= 1) throw lastError
  throw new RetryExhaustedError(madeAttempts, lastError)
}
