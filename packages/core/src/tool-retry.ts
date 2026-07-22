/**
 * Tool-call retry wrapper — opt-in retry semantics for {@link BaseTool}
 * invocations.
 *
 * P23.11 (fix #72) — Pre-P23.11 the retry surface was Provider-only
 * (`withRetry` in `src/retry.ts`). Tool-call failures (transient I/O
 * errors, sandbox timeouts, rate limits surfaced through tool errors)
 * did not retry; the agent loop had to recognise the failure mode
 * and re-invoke the tool itself. `callToolWithRetry` adds the same
 * exponential-backoff-with-jitter semantics to tool calls, with the
 * operator deciding per-call whether to enable it.
 *
 * Conventions mirror {@link withRetry}:
 *   - Default `maxAttempts: 1` (no retry; preserves pre-P23.11
 *     behaviour for every existing call site that did not opt in).
 *   - `shouldRetry`: defaults to retry on `AgentError` with
 *     `retryable === true`. Provider-level 5xx / 408 / 429 markers
 *     already propagate through tool errors when the tool wraps a
 *     provider call; sandbox failures and `ToolError` carry the same
 *     flag when the operator sets it.
 *   - `signal.aborted` short-circuits with `RetryAbortedError`.
 *
 * This is a helper function, not a base-class method, so existing
 * `tool.call(input, ctx)` call sites do not need to change. The
 * composition root is free to thread retry config through
 * `Agent.run` in a follow-up.
 */

import { ProviderError } from './errors/index.js'
import { RetryAbortedError, type RetryConfig, withRetry } from './retry.js'
import type { BaseTool, ToolContext } from './tools/index.js'

/**
 * `callToolWithRetry` options. Extends {@link RetryConfig} with the
 * tool's own runtime config knobs (`timeoutMs` and `signal` are
 * taken from the {@link ToolContext} the caller already has).
 */
export interface CallToolWithRetryConfig extends RetryConfig {
  /**
   * Override the `shouldRetry` predicate from `RetryConfig`. The
   * default retries when the thrown value is an `AgentError`
   * subclass carrying `retryable === true`.
   */
  readonly shouldRetry?: (err: unknown) => boolean
}

/**
 * Call `tool.call(input, ctx)` with optional retry semantics.
 * Returns the tool's resolved value (the same shape `tool.call`
 * returns); rejects with the last attempt's error after
 * exhaustion.
 */
export const callToolWithRetry = async <T = unknown>(
  tool: BaseTool,
  input: unknown,
  ctx: ToolContext,
  config: CallToolWithRetryConfig = {},
): Promise<T> => {
  const shouldRetry =
    config.shouldRetry ??
    ((err: unknown): boolean => err instanceof ProviderError && err.retryable === true)
  const merged: RetryConfig = {
    maxAttempts: config.maxAttempts,
    initialDelayMs: config.initialDelayMs,
    maxDelayMs: config.maxDelayMs,
    backoffFactor: config.backoffFactor,
    jitter: config.jitter,
    sleep: config.sleep,
    signal: ctx.signal,
    shouldRetry,
  }
  return (await withRetry(() => tool.call(input, ctx) as Promise<T>, merged)) as T
}

/**
 * Predicate helper: `true` for `RetryAbortedError` (typed
 * `AbortError` subclass). Tool callers can `instanceof` check
 * against this re-export to distinguish "user cancelled" from
 * "retries exhausted".
 */
export const isRetryAborted = (err: unknown): err is RetryAbortedError =>
  err instanceof RetryAbortedError
