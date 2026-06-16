/**
 * Tests for {@link withRetry} and its accompanying error types.
 *
 * Coverage focus:
 *   - maxAttempts semantics (1 = no retry, N = N tries)
 *   - shouldRetry predicate (default ProviderError.retryable, custom)
 *   - backoff computation (no jitter == deterministic)
 *   - abort signal short-circuit
 *   - observer (onRetry) error isolation
 *   - final-attempt wrapping in RetryExhaustedError
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AbortError, ProviderError } from './errors/index.js'
import { RetryAbortedError, RetryExhaustedError, withRetry } from './retry.js'

describe('withRetry', () => {
  let sleeps: number[]

  beforeEach(() => {
    sleeps = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** Inject deterministic sleeps so we can assert on the delay sequence. */
  function captureSleeps() {
    return async (ms: number) => {
      sleeps.push(ms)
    }
  }

  function retryableError(message: string): ProviderError {
    return new ProviderError(message, { providerId: 'test', retryable: true })
  }

  function fatalError(message: string): ProviderError {
    return new ProviderError(message, { providerId: 'test', retryable: false })
  }

  it('returns the result on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withRetry(fn, { maxAttempts: 3, sleep: captureSleeps() })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
    expect(sleeps).toEqual([])
  })

  it('does not retry when maxAttempts is 1 (default)', async () => {
    const fn = vi.fn().mockRejectedValue(retryableError('boom'))
    await expect(withRetry(fn)).rejects.toBeInstanceOf(ProviderError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries up to maxAttempts and then throws RetryExhaustedError', async () => {
    const fn = vi.fn().mockRejectedValue(retryableError('always fails'))
    const onRetry = vi.fn()
    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        sleep: captureSleeps(),
        initialDelayMs: 10,
        backoffFactor: 2,
        jitter: 0,
        onRetry,
      }),
    ).rejects.toBeInstanceOf(RetryExhaustedError)
    expect(fn).toHaveBeenCalledTimes(3)
    expect(sleeps).toEqual([10, 20])
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  it('RetryExhaustedError.cause is the final underlying error', async () => {
    const cause = retryableError('final')
    const fn = vi.fn().mockRejectedValue(cause)
    try {
      await withRetry(fn, { maxAttempts: 2, sleep: captureSleeps() })
      throw new Error('should not reach here')
    } catch (err) {
      expect(err).toBeInstanceOf(RetryExhaustedError)
      expect((err as RetryExhaustedError).attempts).toBe(2)
      expect((err as RetryExhaustedError).cause).toBe(cause)
    }
  })

  it('stops on first non-retryable error without retrying', async () => {
    const err = fatalError('4xx')
    const fn = vi.fn().mockRejectedValue(err)
    await expect(withRetry(fn, { maxAttempts: 5, sleep: captureSleeps() })).rejects.toBe(err)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('uses the custom shouldRetry predicate when provided', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('first')).mockResolvedValueOnce('ok')
    const shouldRetry = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false)
    const result = await withRetry(fn, {
      maxAttempts: 5,
      sleep: captureSleeps(),
      shouldRetry,
    })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
    expect(shouldRetry).toHaveBeenCalledTimes(1)
  })

  it('throws RetryAbortedError when signal is pre-aborted', async () => {
    const controller = new AbortController()
    controller.abort(new Error('user cancel'))
    const fn = vi.fn().mockResolvedValue('never')
    await expect(
      withRetry(fn, { maxAttempts: 3, signal: controller.signal, sleep: captureSleeps() }),
    ).rejects.toBeInstanceOf(RetryAbortedError)
    expect(fn).toHaveBeenCalledTimes(0)
  })

  it('throws RetryAbortedError when signal aborts between attempts', async () => {
    const controller = new AbortController()
    const fn = vi.fn().mockRejectedValueOnce(retryableError('transient'))
    setTimeout(() => controller.abort(new Error('late cancel')), 0)
    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        signal: controller.signal,
        sleep: async (ms) => {
          await new Promise((r) => setTimeout(r, ms))
        },
      }),
    ).rejects.toBeInstanceOf(RetryAbortedError)
  })

  it('RetryAbortedError extends AbortError so caller can instanceof-check', () => {
    const err = new RetryAbortedError('x')
    expect(err).toBeInstanceOf(AbortError)
    expect(err.name).toBe('RetryAbortedError')
  })

  it('observer errors do not break the retry loop', async () => {
    const onRetry = vi.fn().mockImplementation(() => {
      throw new Error('observer bug')
    })
    const fn = vi
      .fn()
      .mockRejectedValueOnce(retryableError('transient'))
      .mockResolvedValueOnce('ok')
    const result = await withRetry(fn, {
      maxAttempts: 3,
      sleep: captureSleeps(),
      onRetry,
    })
    expect(result).toBe('ok')
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('computes exponential backoff with cap (no jitter)', async () => {
    const fn = vi.fn().mockRejectedValue(retryableError('always'))
    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 500,
        backoffFactor: 2,
        jitter: 0,
        sleep: captureSleeps(),
      }),
    ).rejects.toBeInstanceOf(RetryExhaustedError)
    // delays before retry 2, 3, 4, 5: 100, 200, 400 (5th attempt is the last, no sleep)
    // We sleep 4 times (after attempts 1, 2, 3, 4) before the final 5th attempt fails.
    expect(sleeps).toEqual([100, 200, 400, 500])
  })

  it('caps delay at maxDelayMs', async () => {
    const fn = vi.fn().mockRejectedValue(retryableError('always'))
    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        initialDelayMs: 1000,
        maxDelayMs: 2000,
        backoffFactor: 10,
        jitter: 0,
        sleep: captureSleeps(),
      }),
    ).rejects.toBeInstanceOf(RetryExhaustedError)
    // base = 1000, 10000, 100000, 1000000 — all but first exceed the 2000 cap
    expect(sleeps).toEqual([1000, 2000, 2000, 2000])
  })

  it('treats maxAttempts < 1 as 1 (no retry), unwrapped', async () => {
    const cause = retryableError('once')
    const fn = vi.fn().mockRejectedValue(cause)
    await expect(withRetry(fn, { maxAttempts: 0, sleep: captureSleeps() })).rejects.toBe(cause)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('propagates non-Error rejections (unknown) without retrying by default', async () => {
    const fn = vi.fn().mockRejectedValue('string error')
    await expect(withRetry(fn, { maxAttempts: 3, sleep: captureSleeps() })).rejects.toBe(
      'string error',
    )
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
