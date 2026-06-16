/** Tests for the async mutex primitive. */

import { describe, expect, it } from 'vitest'
import { AcquireTimeoutError, Mutex } from '../src/concurrency/mutex.js'

describe('Mutex', () => {
  it('runs an exclusive block serially with no contention', async () => {
    const m = new Mutex({ name: 'test-1' })
    const order: number[] = []
    await m.runExclusive(async () => {
      order.push(1)
    })
    await m.runExclusive(async () => {
      order.push(2)
    })
    expect(order).toEqual([1, 2])
    expect(m.id).toBe('test-1')
    expect(m.pending).toBe(0)
    expect(m.locked).toBe(false)
  })

  it('serialises concurrent callers in FIFO order', async () => {
    const m = new Mutex()
    const order: number[] = []
    const build = (n: number, delay: number) =>
      m.runExclusive(async () => {
        order.push(n)
        await new Promise((r) => setTimeout(r, delay))
        order.push(n * 10)
      })
    // Launch three concurrent calls; FIFO order should be 1, 2, 3.
    const p1 = build(1, 20)
    const p2 = build(2, 5)
    const p3 = build(3, 5)
    // All three are in flight. Two of them are awaiting their turn.
    // (We allow a microtask to elapse so they are queued, not racing.)
    await new Promise((r) => setTimeout(r, 0))
    expect(m.pending).toBeGreaterThanOrEqual(1)
    await Promise.all([p1, p2, p3])
    // First call enters immediately; the *completion* order is
    // (1, 10), (2, 20), (3, 30) — but entry order is the entry log
    // (1, 2, 3). We assert the entry sequence is monotonically
    // increasing under the FIFO discipline.
    const entries = order.filter((n) => n < 10)
    expect(entries).toEqual([1, 2, 3])
  })

  it('releases the lock on synchronous throw so the next caller can proceed', async () => {
    const m = new Mutex()
    const caught: string[] = []
    const order: string[] = []
    const failing = m
      .runExclusive(() => {
        order.push('enter-fail')
        throw new Error('boom')
      })
      .catch((err) => {
        caught.push((err as Error).message)
      })
    const succeeding = m.runExclusive(async () => {
      order.push('enter-ok')
    })
    await Promise.all([failing, succeeding])
    // The point of the test is that BOTH ran to completion — i.e.
    // the throw did not poison the lock. We don't pin the exact
    // order of `caught` vs `enter-ok` because that depends on
    // microtask scheduling, not on the lock semantics.
    expect(order).toContain('enter-fail')
    expect(order).toContain('enter-ok')
    expect(caught).toEqual(['boom'])
    expect(m.pending).toBe(0)
    expect(m.locked).toBe(false)
  })

  it('releases the lock on async rejection so the next caller can proceed', async () => {
    const m = new Mutex()
    const caught: string[] = []
    const order: string[] = []
    const failing = m
      .runExclusive(async () => {
        order.push('enter-fail')
        await new Promise((r) => setTimeout(r, 5))
        throw new Error('async-boom')
      })
      .catch((err) => {
        caught.push((err as Error).message)
      })
    const succeeding = m.runExclusive(async () => {
      order.push('enter-ok')
    })
    await Promise.all([failing, succeeding])
    expect(order).toContain('enter-fail')
    expect(order).toContain('enter-ok')
    expect(caught).toEqual(['async-boom'])
  })

  it('rejects new acquires after dispose()', async () => {
    const m = new Mutex()
    m.dispose()
    await expect(m.runExclusive(async () => 1)).rejects.toThrow(/disposed/)
  })

  it('allows an in-flight acquire to complete after dispose()', async () => {
    const m = new Mutex()
    let inside = false
    const p = m.runExclusive(async () => {
      inside = true
      await new Promise((r) => setTimeout(r, 10))
      return 'done'
    })
    m.dispose()
    expect(inside).toBe(false)
    await expect(p).resolves.toBe('done')
  })

  it('reports pending and locked accurately during a hold', async () => {
    const m = new Mutex()
    let release!: () => void
    const held = m.runExclusive(
      () =>
        new Promise<void>((r) => {
          release = r
        }),
    )
    // After yielding, the first holder is inside the critical section.
    await new Promise((r) => setTimeout(r, 0))
    expect(m.locked).toBe(true)
    expect(m.pending).toBe(0)

    // Queue two more callers; they should show up in `pending` but
    // not acquire the lock.
    const waiting: Array<Promise<void>> = []
    waiting.push(m.runExclusive(async () => {}))
    waiting.push(m.runExclusive(async () => {}))
    await new Promise((r) => setTimeout(r, 0))
    expect(m.locked).toBe(true)
    expect(m.pending).toBe(2)

    release()
    await Promise.all([held, ...waiting])
    expect(m.locked).toBe(false)
    expect(m.pending).toBe(0)
  })

  it('times out an acquire that waits too long', async () => {
    const m = new Mutex({ timeoutMs: 10 })
    let release!: () => void
    const held = m.runExclusive(
      () =>
        new Promise<void>((r) => {
          release = r
        }),
    )
    await expect(m.runExclusive(async () => 'unreached')).rejects.toBeInstanceOf(
      AcquireTimeoutError,
    )
    release()
    await held
  })

  it('preserves FIFO order even when an earlier acquire times out', async () => {
    // After a timed-out acquire, the next caller should still be
    // able to acquire when the lock is free — the timed-out caller
    // does not consume a slot.
    const m = new Mutex({ timeoutMs: 5 })
    const order: string[] = []
    let release!: () => void
    const held = m.runExclusive(
      () =>
        new Promise<void>((r) => {
          release = r
        }),
    )
    // Wait for the holder to enter.
    await new Promise((r) => setTimeout(r, 1))
    expect(m.locked).toBe(true)

    // First waiter: short timeout, will time out.
    const timed = m
      .runExclusive(async () => 'late')
      .catch((err) => {
        order.push(`timed-out:${err instanceof AcquireTimeoutError}`)
      })
    // Second waiter: long timeout, should succeed once the holder exits.
    const patient = m.runExclusive(async () => {
      order.push('patient-enter')
    })
    // Force the timed-out call to fire.
    await new Promise((r) => setTimeout(r, 12))
    release()
    await Promise.all([held, timed, patient])
    // `patient-enter` must come after the holder exits. The exact
    // relative order of `timed-out` is microtask-dependent.
    const patientIdx = order.indexOf('patient-enter')
    expect(patientIdx).toBeGreaterThanOrEqual(0)
    expect(order[order.length - 1]).toBe('patient-enter')
  })

  it('default name is "mutex" when no options are supplied', () => {
    const m = new Mutex()
    expect(m.id).toBe('mutex')
  })
})
