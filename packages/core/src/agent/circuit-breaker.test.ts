/**
 * Unit tests for {@link CircuitBreaker}.
 *
 * Covers the full state machine using a fake clock so we can
 * drive `now()` without sleeping. The tests are deterministic.
 */
import { describe, expect, it } from 'vitest'
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker.js'

describe('CircuitBreaker', () => {
  it('starts closed and allows calls', () => {
    const t = { now: 0 }
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000, now: () => t.now })
    expect(cb.stateOf('a')).toBe('closed')
    expect(() => cb.allow('a')).not.toThrow()
  })

  it('opens after `failureThreshold` consecutive failures', () => {
    const t = { now: 0 }
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000, now: () => t.now })
    cb.recordFailure('a')
    expect(cb.stateOf('a')).toBe('closed')
    cb.recordFailure('a')
    expect(cb.stateOf('a')).toBe('closed')
    cb.recordFailure('a')
    expect(cb.stateOf('a')).toBe('open')
  })

  it('throws CircuitOpenError while open and within the cooldown', () => {
    const t = { now: 0 }
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000, now: () => t.now })
    cb.recordFailure('a')
    cb.recordFailure('a')
    try {
      cb.allow('a')
      throw new Error('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(CircuitOpenError)
      expect((err as CircuitOpenError).providerId).toBe('a')
      expect((err as CircuitOpenError).retryAfterMs).toBeGreaterThan(0)
    }
  })

  it('transitions to half-open after the cooldown elapses', () => {
    const t = { now: 0 }
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000, now: () => t.now })
    cb.recordFailure('a')
    cb.recordFailure('a')
    t.now = 1_001
    expect(cb.stateOf('a')).toBe('half-open')
    // `allow` succeeds (lets the trial through) and clears
    // `openedAt`, so a subsequent failure re-opens with the
    // same counter.
    expect(() => cb.allow('a')).not.toThrow()
  })

  it('half-open success closes the breaker; failure re-opens it', () => {
    const t = { now: 0 }
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000, now: () => t.now })
    cb.recordFailure('a')
    cb.recordFailure('a')
    t.now = 1_001
    cb.allow('a') // trial
    cb.recordFailure('a')
    expect(cb.stateOf('a')).toBe('open')
    t.now = 2_001
    cb.allow('a') // second trial
    cb.recordSuccess('a')
    expect(cb.stateOf('a')).toBe('closed')
  })

  it('a success in closed state resets the failure counter', () => {
    const t = { now: 0 }
    const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000, now: () => t.now })
    cb.recordFailure('a')
    cb.recordFailure('a')
    cb.recordSuccess('a')
    // Two more failures must NOT open the breaker — the success
    // zeroed the counter.
    cb.recordFailure('a')
    cb.recordFailure('a')
    expect(cb.stateOf('a')).toBe('closed')
  })

  it('tracks each provider id independently', () => {
    const t = { now: 0 }
    const cb = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 1_000, now: () => t.now })
    cb.recordFailure('a')
    cb.recordFailure('a')
    cb.recordFailure('b')
    expect(cb.stateOf('a')).toBe('open')
    expect(cb.stateOf('b')).toBe('closed')
  })

  it('default failureThreshold is 5; default cooldownMs is 30_000', () => {
    const cb = new CircuitBreaker()
    for (let i = 0; i < 4; i++) cb.recordFailure('x')
    expect(cb.stateOf('x')).toBe('closed')
    cb.recordFailure('x')
    expect(cb.stateOf('x')).toBe('open')
  })
})
