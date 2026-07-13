/** P20.2 e2e: heartbeat / long-running supervisor. */

import { describe, expect, it, vi } from 'vitest'
import {
  AgentCheckpointSchema,
  HEARTBEAT_DEFAULT_INTERVAL_MS,
  InMemoryCheckpointStore,
  runWithHeartbeat,
  startHeartbeat,
} from '../src/index.js'

describe('startHeartbeat', () => {
  it('exposes a signal and a stop method', () => {
    const h = startHeartbeat({ intervalMs: 1000 })
    expect(h.signal).toBeInstanceOf(AbortSignal)
    expect(h.isAlive()).toBe(true)
    h.stop()
    expect(h.isAlive()).toBe(false)
  })

  it('throws on non-positive intervalMs', () => {
    expect(() => startHeartbeat({ intervalMs: 0 })).toThrow()
    expect(() => startHeartbeat({ intervalMs: -1 })).toThrow()
  })

  it('throws on non-positive timeoutMs when set', () => {
    expect(() => startHeartbeat({ intervalMs: 100, timeoutMs: 0 })).toThrow()
    expect(() => startHeartbeat({ intervalMs: 100, timeoutMs: -5 })).toThrow()
  })

  it('invokes onPing on every tick', async () => {
    vi.useFakeTimers()
    try {
      const onPing = vi.fn()
      const h = startHeartbeat({ intervalMs: 100, onPing })
      h.bump() // does not call onPing (only resets deadline)
      expect(onPing).not.toHaveBeenCalled()
      vi.advanceTimersByTime(100)
      expect(onPing).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(300)
      expect(onPing).toHaveBeenCalledTimes(4)
      h.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('aborts the signal after timeoutMs of no bump() activity', async () => {
    vi.useFakeTimers()
    try {
      const onTimeout = vi.fn()
      const h = startHeartbeat({
        intervalMs: 50,
        timeoutMs: 200,
        onTimeout,
      })
      // Tick a few times — well under the deadline.
      vi.advanceTimersByTime(150)
      expect(h.signal.aborted).toBe(false)
      // Bump to reset the deadline.
      h.bump()
      vi.advanceTimersByTime(150)
      expect(h.signal.aborted).toBe(false)
      // Now let the deadline pass.
      vi.advanceTimersByTime(250)
      expect(h.signal.aborted).toBe(true)
      expect(onTimeout).toHaveBeenCalledTimes(1)
      h.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not auto-abort when timeoutMs is omitted', () => {
    vi.useFakeTimers()
    try {
      const h = startHeartbeat({ intervalMs: 50 })
      vi.advanceTimersByTime(10_000)
      expect(h.signal.aborted).toBe(false)
      h.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  it('stop() makes the handle inert and clears the timer', () => {
    vi.useFakeTimers()
    try {
      const onPing = vi.fn()
      const h = startHeartbeat({ intervalMs: 50, onPing })
      h.stop()
      vi.advanceTimersByTime(500)
      expect(onPing).not.toHaveBeenCalled()
      // Double-stop is a no-op.
      h.stop()
      expect(h.isAlive()).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('runWithHeartbeat', () => {
  it('passes the signal to the runner and stops on settle', async () => {
    vi.useFakeTimers()
    try {
      const onPing = vi.fn()
      const seenSignals: AbortSignal[] = []
      const promise = runWithHeartbeat(
        async (signal) => {
          seenSignals.push(signal)
          return 42
        },
        { intervalMs: 50, onPing },
      )
      vi.advanceTimersByTime(0) // let microtasks run
      const result = await promise
      expect(result).toBe(42)
      expect(seenSignals).toHaveLength(1)
      // After settle, the timer is cleared — no more onPing.
      const beforeCount = onPing.mock.calls.length
      vi.advanceTimersByTime(500)
      expect(onPing.mock.calls.length).toBe(beforeCount)
    } finally {
      vi.useRealTimers()
    }
  })

  it('propagates runner errors without rethrowing as AbortError', async () => {
    const promise = runWithHeartbeat(
      async () => {
        throw new Error('runner failed')
      },
      { intervalMs: 1000 },
    )
    await expect(promise).rejects.toThrow('runner failed')
  })

  it('aborts the run when the heartbeat deadline elapses', async () => {
    vi.useFakeTimers()
    try {
      const promise = runWithHeartbeat(
        async (signal) => {
          // Wait forever (until aborted). The fake timer can
          // resolve the inner await by running the timer.
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve()
            signal.addEventListener('abort', () => resolve())
          })
          throw new Error('aborted')
        },
        { intervalMs: 30, timeoutMs: 100 },
      )
      // Let the deadline pass.
      vi.advanceTimersByTime(150)
      await expect(promise).rejects.toThrow(/aborted/)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('HEARTBEAT_DEFAULT_INTERVAL_MS', () => {
  it('is 30 000 ms (matches the P20.2 spec)', () => {
    expect(HEARTBEAT_DEFAULT_INTERVAL_MS).toBe(30_000)
  })
})

describe('runWithHeartbeat checkpoint poll (P21.2)', () => {
  it('rejects a non-positive checkpointIntervalMs', async () => {
    const store = new InMemoryCheckpointStore()
    await expect(
      runWithHeartbeat(async () => 0, { checkpointStore: store, checkpointIntervalMs: 0 }),
    ).rejects.toThrow(/checkpointIntervalMs must be a positive integer/)
  })

  it('rejects a store that does not implement latestInProgress', async () => {
    const brokenStore = {
      id: 'broken',
      save: () => Promise.resolve(),
      get: () => Promise.resolve(undefined),
      list: () => Promise.resolve([]),
      delete: () => Promise.resolve(false),
    } as unknown as { id: string }
    await expect(
      runWithHeartbeat(async () => 0, {
        checkpointStore: brokenStore as never,
        checkpointIntervalMs: 10,
      }),
    ).rejects.toThrow(/latestInProgress/)
  })

  it('polls the store on a wall-clock interval and forwards snapshots to onCheckpoint', async () => {
    const store = new InMemoryCheckpointStore()
    const observed: number[] = []
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const promise = runWithHeartbeat(
      async () => {
        await pending
      },
      {
        intervalMs: 1_000_000,
        timeoutMs: 1_000_000,
        checkpointStore: store,
        checkpointIntervalMs: 25,
        onCheckpoint: (snapshot) => observed.push(snapshot.iterations),
      },
    )
    await store.save({
      id: 'poll-1',
      sessionId: 'poll-1',
      messages: [{ role: 'user', content: 'go' }],
      iterations: 7,
      createdAt: Date.now(),
      outcome: 'in_progress' as const,
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    await store.save({
      id: 'poll-2',
      sessionId: 'poll-1',
      messages: [{ role: 'user', content: 'go' }],
      iterations: 9,
      createdAt: Date.now(),
      outcome: 'in_progress' as const,
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(observed.length).toBeGreaterThan(0)
    expect(observed[observed.length - 1]).toBe(9)
    release()
    await promise
  })
})
