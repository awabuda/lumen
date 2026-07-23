/**
 * P25.3 \u2014 Background Task registry (bug.md #49).
 *
 * Verifies the registry's spawn / await / cancel / list
 * lifecycle. We use a tiny microtask deferrer so the
 * pending->resolved transition is observable without
 * real network I/O.
 */

import { describe, expect, it } from 'vitest'

import { BackgroundTaskRegistry } from '../src/agent/background-tasks.js'

const defer = <T>(value: T, ms = 5): Promise<T> =>
  new Promise((resolve) => {
    setTimeout(() => resolve(value), ms)
  })

const failAfter = (ms = 5): Promise<never> =>
  new Promise((_resolve, reject) => {
    setTimeout(() => reject(new Error('task failed')), ms)
  })

describe('P25.3 \u2014 BackgroundTaskRegistry', () => {
  it('spawn returns a record in "pending" status', () => {
    const reg = new BackgroundTaskRegistry()
    const rec = reg.spawn({ id: 't1', label: 'first', run: () => defer('done') })
    expect(rec.id).toBe('t1')
    expect(rec.label).toBe('first')
    expect(rec.status).toBe('pending')
    expect(typeof rec.startedAtMs).toBe('number')
  })

  it('records transition to "resolved" with the value', async () => {
    const reg = new BackgroundTaskRegistry()
    reg.spawn({ id: 't1', label: 'first', run: () => defer('done', 10) })
    await reg.await('t1')
    const rec = reg.get('t1')
    expect(rec?.status).toBe('resolved')
    expect(rec?.value).toBe('done')
    expect(typeof rec?.finishedAtMs).toBe('number')
  })

  it('records transition to "rejected" with the error', async () => {
    const reg = new BackgroundTaskRegistry()
    reg.spawn({ id: 't1', label: 'first', run: () => failAfter() })
    await expect(reg.await('t1')).rejects.toThrow('task failed')
    const rec = reg.get('t1')
    expect(rec?.status).toBe('rejected')
    expect(rec?.error?.message).toBe('task failed')
  })

  it('cancel marks a pending task as cancelled', () => {
    const reg = new BackgroundTaskRegistry()
    reg.spawn({ id: 't1', label: 'first', run: () => defer('done', 50) })
    reg.cancel('t1')
    const rec = reg.get('t1')
    expect(rec?.status).toBe('cancelled')
  })

  it('cancel is a no-op on a resolved task', async () => {
    const reg = new BackgroundTaskRegistry()
    reg.spawn({ id: 't1', label: 'first', run: () => defer('done', 5) })
    await reg.await('t1')
    reg.cancel('t1')
    expect(reg.get('t1')?.status).toBe('resolved')
  })

  it('list returns tasks sorted by startedAtMs', () => {
    const reg = new BackgroundTaskRegistry()
    reg.spawn({ id: 'a', label: 'a', run: () => defer(1) })
    reg.spawn({ id: 'b', label: 'b', run: () => defer(2) })
    reg.spawn({ id: 'c', label: 'c', run: () => defer(3) })
    const ids = reg.list().map((t) => t.id)
    expect(ids).toEqual(['a', 'b', 'c'])
  })

  it('await throws on unknown id', async () => {
    const reg = new BackgroundTaskRegistry()
    await expect(reg.await('nope')).rejects.toThrow(/unknown task id/)
  })

  it('cancel on unknown id is a no-op', () => {
    const reg = new BackgroundTaskRegistry()
    expect(() => reg.cancel('nope')).not.toThrow()
  })
})