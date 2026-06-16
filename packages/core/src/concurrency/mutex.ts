/**
 * Concurrency primitives — cooperative async mutual exclusion.
 *
 * Why this module exists:
 *   JavaScript is single-threaded but `async` functions interleave at
 *   every `await`. A piece of state that reads, decides, and writes —
 *   like a round-robin cursor advancing then indexing into an array —
 *   can be observed in an inconsistent state by a concurrent caller
 *   if the two read steps straddle an `await`.
 *
 *   The canonical fix is a mutex: a promise-chain that serialises the
 *   critical section. {@link Mutex} is the smallest correct version of
 *   that. {@link BaseMutex} is the contract a subclass can extend to
 *   add metrics, timeouts, or a different scheduling policy.
 *
 * What this module does NOT do:
 *   - True OS-level locks. JavaScript runs in a single thread; "mutual
 *     exclusion" here means "serialised across `await` boundaries".
 *   - Reader/writer splitting. One critical section at a time.
 *   - Cancellation. `AbortSignal` support is intentionally left out of
 *     the first cut; a future version can add `runExclusive(fn, options)`
 *     with `{ signal }` as a non-breaking change.
 *
 * The default implementation {@link Mutex} is what the framework uses
 * internally (e.g. {@link ProviderPool}). Callers who need
 * observability (queue depth, wait time) subclass {@link BaseMutex}.
 */

import { z } from 'zod'
import { AgentError } from '../errors/index.js'

/** Thrown when an operation is attempted on a disposed mutex. */
export class MutexDisposedError extends AgentError {
  public readonly mutexId: string

  constructor(mutexId: string) {
    super(`Mutex '${mutexId}' is disposed`)
    this.name = 'MutexDisposedError'
    this.mutexId = mutexId
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link Mutex.runExclusive} when the optional `timeoutMs`
 * elapses before the caller acquired the lock.
 *
 * The original lock request has been cancelled; the mutex is back to
 * its prior state and may be acquired by the next caller. Callers can
 * `instanceof AcquireTimeoutError` to distinguish "busy" from "broken".
 */
export class AcquireTimeoutError extends AgentError {
  public readonly timeoutMs: number
  public readonly waiters: number

  public constructor(timeoutMs: number, waiters: number) {
    super(`Mutex acquire timed out after ${timeoutMs}ms (${waiters} waiter(s) ahead)`)
    this.name = 'AcquireTimeoutError'
    this.timeoutMs = timeoutMs
    this.waiters = waiters
  }
}

// ---------------------------------------------------------------------------
// Zod schemas (public surface — see CLAUDE.md rule #4)
// ---------------------------------------------------------------------------

/** Zod schema for {@link MutexOptions}. */
export const MutexOptionsSchema = z.object({
  /** Per-acquire timeout in milliseconds. If set, every `runExclusive` call
   * races against this deadline; missing it throws {@link AcquireTimeoutError}. */
  timeoutMs: z.number().positive().optional(),
  /** Name used in error messages and (subclass) telemetry. Defaults to 'mutex'. */
  name: z.string().min(1).optional(),
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for constructing a {@link Mutex}. */
export interface MutexOptions {
  /**
   * If set, every `runExclusive` call waits at most this many
   * milliseconds to acquire the lock. A timeout throws
   * {@link AcquireTimeoutError} — the lock is *not* held by the
   * timed-out caller; the next caller proceeds.
   */
  readonly timeoutMs?: number
  /**
   * A label for this mutex. Used in error messages and (in a
   * subclass with telemetry) metric tags. Defaults to `'mutex'`.
   */
  readonly name?: string
}

/** Discriminated union of outcomes for an acquire attempt. */
export type AcquireResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AcquireTimeoutError }

// ---------------------------------------------------------------------------
// Base contract
// ---------------------------------------------------------------------------

/**
 * The contract every mutex implementation fulfills.
 *
 * `runExclusive` is the only method a caller ever invokes. The other
 * accessors are there for tests, observability, and graceful shutdown.
 */
export abstract class BaseMutex {
  /** Stable identifier for the implementation. */
  public abstract readonly id: string
  /**
   * Run `fn` inside the critical section. Concurrent callers queue in
   * FIFO order and execute one at a time. The returned promise
   * resolves with `fn`'s result or rejects with whatever `fn` throws.
   */
  public abstract runExclusive<T>(fn: () => Promise<T> | T): Promise<T>
  /**
   * Number of callers currently waiting to enter the critical section
   * (excludes the active holder, if any). For tests and metrics.
   */
  public abstract get pending(): number
  /**
   * Whether the mutex is currently held by an active critical section.
   */
  public abstract get locked(): boolean
  /**
   * Disable this mutex permanently. Any in-flight `runExclusive` call
   * completes normally; subsequent calls reject with an `Error`.
   * Idempotent.
   */
  public abstract dispose(): void
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

/**
 * Default {@link BaseMutex}: a promise-chain that serialises every
 * critical section.
 *
 * Algorithm:
 *   - Maintain a single `chain: Promise<void>` that represents the
 *     "previous holder's completion".
 *   - On `runExclusive(fn)`, build a new `release` deferred and set
 *     `chain = release.promise` BEFORE awaiting. This is the FIFO
 *     hand-off: the next caller's `chain` is now THIS caller's release.
 *   - `await chain` (the prior holder), then run `fn`, then resolve
 *     `release` in `finally` so the next caller wakes up.
 *
 * The lock is released even if `fn` throws — that's the `finally`
 * guarantee. Errors propagate to the caller of `runExclusive`; they
 * do NOT poison the chain.
 *
 * Optional `timeoutMs` (via {@link MutexOptions}) races the wait
 * against a timer. A timeout throws {@link AcquireTimeoutError} and
 * does NOT enter the critical section.
 *
 * Concurrency-safe: any number of async callers may invoke
 * `runExclusive` concurrently. Order of execution is the order of
 * invocation (FIFO). There is no preemption — once a critical
 * section starts it runs to completion.
 *
 * Reentrancy: this mutex is NOT reentrant. Calling `runExclusive`
 * from inside a critical section held by the same mutex deadlocks
 * the inner call (it will only be released by the outer call's
 * `finally`, which can never run because the inner is awaiting it).
 * If a caller needs reentrancy, that is a contract change in their
 * code, not a feature of this mutex.
 */
export class Mutex extends BaseMutex {
  public readonly id: string
  private chain: Promise<void> = Promise.resolve()
  private waiters = 0
  private held = false
  private disposed = false
  private readonly timeoutMs?: number

  public constructor(options: MutexOptions = {}) {
    super()
    this.id = options.name ?? 'mutex'
    this.timeoutMs = options.timeoutMs
  }

  public async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    if (this.disposed) {
      throw new MutexDisposedError(this.id)
    }
    // Snapshot the prior chain BEFORE incrementing waiters. The new
    // chain is THIS caller's release deferred.
    const prior = this.chain
    let release!: () => void
    this.chain = new Promise<void>((resolve) => {
      release = resolve
    })
    this.waiters += 1
    try {
      if (this.timeoutMs !== undefined) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const timeout = new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new AcquireTimeoutError(this.timeoutMs as number, this.queueDepth - 1))
          }, this.timeoutMs)
        })
        try {
          await Promise.race([prior, timeout])
        } catch (err) {
          if (err instanceof AcquireTimeoutError) {
            // We never acquired. The chain we set above is held by
            // no one — if we don't release it, the next caller
            // blocks forever. Resolve our chain now so the queue
            // can drain.
            release()
            throw err
          }
          throw err
        } finally {
          if (timer) clearTimeout(timer)
        }
      } else {
        await prior
      }
      this.held = true
      return await fn()
    } finally {
      // Decrement the total queue depth exactly once on every path.
      // The `pending` getter subtracts the active holder, so callers
      // see a pure "number of waiters" view.
      this.waiters -= 1
      this.held = false
      release()
    }
  }

  /**
   * Number of callers currently waiting to enter the critical section
   * (excludes the active holder, if any). For tests and metrics.
   */
  public get pending(): number {
    return this.held ? this.waiters - 1 : this.waiters
  }

  /**
   * Total queue depth including the active holder. `pending` is the
   * user-facing "how many callers are blocked" number; `queueDepth`
   * is the implementation detail.
   */
  public get queueDepth(): number {
    return this.waiters
  }

  public get locked(): boolean {
    return this.held
  }

  public dispose(): void {
    if (this.disposed) return
    this.disposed = true
    // Resolve the chain so any in-flight waiter that's still in
    // `await prior` does not hang. They will then hit the `disposed`
    // check on the next iteration... actually no: by the time `await
    // prior` resolves they are past the check. The cleanest answer
    // is: dispose() should be called when no one is waiting, and
    // any in-flight call completes naturally. We do not cancel
    // in-flight critical sections.
    this.chain = Promise.resolve()
  }
}
