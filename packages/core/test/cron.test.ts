/** Tests for the cron scheduler. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CronExpressionCron,
  CronScheduler,
  IntervalCron,
  OnceCron,
  cronMatches,
} from '../src/cron/index.js'

describe('cronMatches', () => {
  it('matches "* * * * *" every minute', () => {
    expect(cronMatches('* * * * *', new Date())).toBe(true)
  })

  it('matches a specific minute', () => {
    const date = new Date(2026, 0, 1, 9, 30, 0)
    expect(cronMatches('30 9 * * *', date)).toBe(true)
  })

  it('rejects a non-matching minute', () => {
    const date = new Date(2026, 0, 1, 9, 30, 0)
    expect(cronMatches('15 9 * * *', date)).toBe(false)
  })

  it('handles comma-separated lists', () => {
    const date = new Date(2026, 0, 1, 9, 0, 0)
    expect(cronMatches('0,15,30,45 9 * * *', date)).toBe(true)
  })

  it('handles ranges', () => {
    const date = new Date(2026, 0, 1, 9, 15, 0)
    expect(cronMatches('0-30 9 * * *', date)).toBe(true)
  })

  it('handles step expressions', () => {
    const date = new Date(2026, 0, 1, 9, 15, 0)
    expect(cronMatches('*/15 9 * * *', date)).toBe(true)
  })

  it('rejects malformed expressions', () => {
    expect(cronMatches('not a cron', new Date())).toBe(false)
    expect(cronMatches('* * *', new Date())).toBe(false)
  })
})

describe('IntervalCron', () => {
  it('does not run before start', async () => {
    const job = vi.fn().mockResolvedValue(undefined)
    const cron = new IntervalCron({ id: 'i1', intervalMs: 10, job })
    expect(cron.isRunning).toBe(false)
    expect(cron.runCount).toBe(0)
  })

  it('runs when start is called', async () => {
    const job = vi.fn().mockResolvedValue(undefined)
    const cron = new IntervalCron({ id: 'i2', intervalMs: 10, job })
    cron.start()
    await new Promise((r) => setTimeout(r, 25))
    cron.stop()
    expect(cron.runCount).toBeGreaterThanOrEqual(1)
  })

  it('stops after stop', async () => {
    const job = vi.fn().mockResolvedValue(undefined)
    const cron = new IntervalCron({ id: 'i3', intervalMs: 10, job })
    cron.start()
    await new Promise((r) => setTimeout(r, 15))
    cron.stop()
    const count = cron.runCount
    await new Promise((r) => setTimeout(r, 30))
    expect(cron.runCount).toBe(count)
    expect(cron.isRunning).toBe(false)
  })

  it('records history', async () => {
    const job = vi.fn().mockResolvedValue(undefined)
    const cron = new IntervalCron({ id: 'i4', intervalMs: 10, job })
    await cron.run()
    await cron.run()
    expect(cron.history).toHaveLength(2)
    expect(cron.history[0]?.success).toBe(true)
  })

  it('rethrows errors (Rule 7) and records failure', async () => {
    const job = vi.fn().mockRejectedValue(new Error('boom'))
    const cron = new IntervalCron({ id: 'i5', intervalMs: 10, job })
    await expect(cron.run()).rejects.toThrow('boom')
    expect(cron.history[0]?.success).toBe(false)
    expect(cron.history[0]?.error).toBe('boom')
  })
})

describe('OnceCron', () => {
  it('does not run before start', () => {
    const job = vi.fn().mockResolvedValue(undefined)
    const cron = new OnceCron({
      id: 'o1',
      at: Date.now() + 1000,
      job,
    })
    expect(cron.runCount).toBe(0)
  })

  it('runs once when start is called', async () => {
    const job = vi.fn().mockResolvedValue(undefined)
    const cron = new OnceCron({ id: 'o2', at: Date.now() + 10, job })
    cron.start()
    await new Promise((r) => setTimeout(r, 50))
    expect(cron.runCount).toBe(1)
  })

  it('stops before firing if stop is called early', async () => {
    const job = vi.fn().mockResolvedValue(undefined)
    const cron = new OnceCron({ id: 'o3', at: Date.now() + 1000, job })
    cron.start()
    cron.stop()
    await new Promise((r) => setTimeout(r, 30))
    expect(cron.runCount).toBe(0)
  })

  it('rethrows errors (Rule 7)', async () => {
    const job = vi.fn().mockRejectedValue(new Error('once-fail'))
    const cron = new OnceCron({ id: 'o4', at: Date.now() + 10000, job })
    await expect(cron.run()).rejects.toThrow('once-fail')
  })
})

describe('CronExpressionCron', () => {
  it('does not fire when expression does not match', async () => {
    const job = vi.fn().mockResolvedValue(undefined)
    const cron = new CronExpressionCron({
      id: 'ce1',
      expression: '0 0 31 12 *', // Dec 31 midnight
      job,
    })
    await cron.tick()
    expect(cron.runCount).toBe(0)
  })

  it('fires when expression matches', async () => {
    const job = vi.fn().mockResolvedValue(undefined)
    const cron = new CronExpressionCron({
      id: 'ce2',
      expression: '* * * * *',
      job,
    })
    await cron.tick()
    expect(cron.runCount).toBe(1)
  })

  it('deduplicates fires within the same minute', async () => {
    const job = vi.fn().mockResolvedValue(undefined)
    const cron = new CronExpressionCron({
      id: 'ce3',
      expression: '* * * * *',
      job,
    })
    await cron.tick()
    await cron.tick()
    await cron.tick()
    expect(cron.runCount).toBe(1)
  })

  it('rejects malformed expressions via schema', () => {
    expect(() => {
      new CronExpressionCron({ id: 'ce4', expression: 'bad', job: vi.fn() })
    }).toThrow()
  })
})

describe('CronScheduler', () => {
  it('registers and looks up crons', () => {
    const sched = new CronScheduler()
    const cron = new IntervalCron({ id: 's1', intervalMs: 1000, job: vi.fn() })
    sched.register(cron)
    expect(sched.get('s1')).toBe(cron)
    expect(sched.size).toBe(1)
  })

  it('rejects duplicate ids', () => {
    const sched = new CronScheduler()
    sched.register(new IntervalCron({ id: 'dup', intervalMs: 1000, job: vi.fn() }))
    expect(() => {
      sched.register(new IntervalCron({ id: 'dup', intervalMs: 1000, job: vi.fn() }))
    }).toThrow(/already registered/)
  })

  it('unregisters and stops', () => {
    const sched = new CronScheduler()
    const cron = new IntervalCron({ id: 's2', intervalMs: 1000, job: vi.fn() })
    sched.register(cron)
    cron.start()
    expect(sched.unregister('s2')).toBe(true)
    expect(cron.isRunning).toBe(false)
    expect(sched.size).toBe(0)
  })

  it('startAll and stopAll', () => {
    const sched = new CronScheduler()
    const a = new IntervalCron({ id: 'a', intervalMs: 1000, job: vi.fn() })
    const b = new OnceCron({ id: 'b', at: Date.now() + 10000, job: vi.fn() })
    sched.register(a)
    sched.register(b)
    sched.startAll()
    expect(a.isRunning).toBe(true)
    sched.stopAll()
    expect(a.isRunning).toBe(false)
  })

  it('aggregates history across all crons', async () => {
    const sched = new CronScheduler()
    const a = new IntervalCron({ id: 'h1', intervalMs: 1000, job: vi.fn() })
    const b = new OnceCron({ id: 'h2', at: Date.now() + 10000, job: vi.fn() })
    sched.register(a)
    sched.register(b)
    await a.run()
    await b.run()
    expect(sched.history).toHaveLength(2)
  })
})
