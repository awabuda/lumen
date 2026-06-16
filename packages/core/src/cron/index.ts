/**
 * Cron scheduler — runs async jobs on a schedule.
 *
 * A {@link BaseCron} schedules and executes jobs. Jobs are
 * user-supplied async functions. The scheduler tracks every
 * run, exposes a history, and supports cancellation.
 *
 * Three schedule types ship here:
 *   - {@link IntervalCron} — fires every N ms.
 *   - {@link OnceCron} — fires once at a wall-clock instant.
 *   - {@link CronExpressionCron} — fires when a 5-field
 *     cron expression matches.
 *
 * Why a separate module: cron logic is orthogonal to the
 * agent loop. It uses BaseProvider only when a job needs
 * to invoke the agent; pure cron jobs (cleanup, health
 * checks) need no LLM.
 */

import { z } from 'zod'
import { ConfigError } from '../errors/index.js'

/** A cron job — an async function with metadata. */
export type CronJob = () => Promise<void>

/** A recorded run of a cron job. */
export interface CronRun {
  /** Identifier of the cron that ran. */
  readonly cronId: string
  /** When the job started (epoch ms). */
  readonly startedAt: number
  /** How long the job took. */
  readonly durationMs: number
  /** Whether the job succeeded. */
  readonly success: boolean
  /** Error message, if any. */
  readonly error?: string
}

/** Zod schema for {@link BaseCronOptions}. */
export const BaseCronOptionsSchema = z.object({
  /** Stable identifier. Required for history correlation. */
  id: z.string().min(1),
  /** The job function. */
  job: z.custom<CronJob>((v) => typeof v === 'function'),
})

/** Constructor options for every cron implementation. */
export type BaseCronOptions = z.input<typeof BaseCronOptionsSchema>

/** The contract every cron implementation fulfills. */
export abstract class BaseCron {
  /** Stable identifier. */
  public abstract readonly id: string
  /** Number of completed runs. */
  public abstract get runCount(): number
  /** Read-only history of runs (most recent first). */
  public abstract get history(): ReadonlyArray<CronRun>

  /** Start the cron. After start, jobs fire on their schedule. */
  public abstract start(): void
  /** Stop the cron. Pending timers are cancelled. */
  public abstract stop(): void
  /** Whether the cron is currently running. */
  public abstract get isRunning(): boolean
}

// ---------------------------------------------------------------------------
// IntervalCron
// ---------------------------------------------------------------------------

/** Zod schema for {@link IntervalCronOptions}. */
export const IntervalCronOptionsSchema = BaseCronOptionsSchema.extend({
  /** Interval in ms. Must be > 0. */
  intervalMs: z.number().int().positive(),
})

/** Options for {@link IntervalCron}. */
export type IntervalCronOptions = z.input<typeof IntervalCronOptionsSchema>

/** Fires the job every `intervalMs` milliseconds. */
export class IntervalCron extends BaseCron {
  public readonly id: string
  private readonly job: CronJob
  private readonly intervalMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private _runCount = 0
  private _history: CronRun[] = []

  public constructor(options: IntervalCronOptions) {
    super()
    IntervalCronOptionsSchema.parse(options)
    this.id = options.id
    this.job = options.job
    this.intervalMs = options.intervalMs
  }

  public start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.run()
    }, this.intervalMs)
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  public get isRunning(): boolean {
    return this.timer !== undefined
  }

  public get runCount(): number {
    return this._runCount
  }

  public get history(): ReadonlyArray<CronRun> {
    return this._history
  }

  /** Execute the job once (useful for tests and manual triggers). */
  public async run(): Promise<void> {
    const startedAt = Date.now()
    try {
      await this.job()
      this._history.unshift({
        cronId: this.id,
        startedAt,
        durationMs: Date.now() - startedAt,
        success: true,
      })
    } catch (err) {
      // Re-throw AND record — Rule 7: do not swallow.
      this._history.unshift({
        cronId: this.id,
        startedAt,
        durationMs: Date.now() - startedAt,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      this._runCount += 1
    }
  }
}

// ---------------------------------------------------------------------------
// OnceCron
// ---------------------------------------------------------------------------

/** Zod schema for {@link OnceCronOptions}. */
export const OnceCronOptionsSchema = BaseCronOptionsSchema.extend({
  /** When to fire (epoch ms). Must be > now. */
  at: z.number().int().positive(),
})

/** Options for {@link OnceCron}. */
export type OnceCronOptions = z.input<typeof OnceCronOptionsSchema>

/** Fires the job once at a wall-clock instant. */
export class OnceCron extends BaseCron {
  public readonly id: string
  private readonly job: CronJob
  private readonly at: number
  private timer: ReturnType<typeof setTimeout> | undefined
  private _runCount = 0
  private _history: CronRun[] = []
  private _running = false

  public constructor(options: OnceCronOptions) {
    super()
    OnceCronOptionsSchema.parse(options)
    this.id = options.id
    this.job = options.job
    this.at = options.at
  }

  public start(): void {
    if (this.timer || this._running) return
    const delay = Math.max(0, this.at - Date.now())
    this.timer = setTimeout(() => {
      this.timer = undefined
      this._running = true
      void this.run().finally(() => {
        this._running = false
      })
    }, delay)
  }

  public stop(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  public get isRunning(): boolean {
    return this._running
  }

  public get runCount(): number {
    return this._runCount
  }

  public get history(): ReadonlyArray<CronRun> {
    return this._history
  }

  public async run(): Promise<void> {
    const startedAt = Date.now()
    try {
      await this.job()
      this._history.unshift({
        cronId: this.id,
        startedAt,
        durationMs: Date.now() - startedAt,
        success: true,
      })
    } catch (err) {
      this._history.unshift({
        cronId: this.id,
        startedAt,
        durationMs: Date.now() - startedAt,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      this._runCount += 1
    }
  }
}

// ---------------------------------------------------------------------------
// CronExpressionCron
// ---------------------------------------------------------------------------

/**
 * A 5-field cron expression:
 *   minute (0-59) hour (0-23) day-of-month (1-31) month (1-12) day-of-week (0-6)
 *
 * Supports `*`, `,`, `-`, `/`. This is a minimal implementation
 * suitable for agent scheduling. It does NOT support year, seconds,
 * or `?` / `L` / `W` shortcuts.
 */
const matchField = (value: number, spec: string, min: number, max: number): boolean => {
  if (spec === '*') return value >= min && value <= max
  for (const part of spec.split(',')) {
    if (part.includes('/')) {
      const [range, step] = part.split('/')
      const stepNum = Number(step)
      if (Number.isNaN(stepNum) || stepNum <= 0) continue
      const start = range === '*' || range === undefined ? min : Number(range.split('-')[0])
      if (Number.isNaN(start)) continue
      if (value >= start && (value - start) % stepNum === 0) return true
    } else if (part.includes('-')) {
      const [loStr, hiStr] = part.split('-')
      if (loStr === undefined || hiStr === undefined) continue
      const lo = Number(loStr)
      const hi = Number(hiStr)
      if (Number.isNaN(lo) || Number.isNaN(hi)) continue
      if (value >= lo && value <= hi) return true
    } else {
      const n = Number(part)
      if (!Number.isNaN(n) && n === value) return true
    }
  }
  return false
}

/** Test whether a 5-field cron expression matches a Date. */
export const cronMatches = (expression: string, date: Date): boolean => {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return false
  const [minute, hour, day, month, dow] = parts as [string, string, string, string, string]
  return (
    matchField(date.getMinutes(), minute, 0, 59) &&
    matchField(date.getHours(), hour, 0, 23) &&
    matchField(date.getDate(), day, 1, 31) &&
    matchField(date.getMonth() + 1, month, 1, 12) &&
    matchField(date.getDay(), dow, 0, 6)
  )
}

/** Zod schema for {@link CronExpressionCronOptions}. */
export const CronExpressionCronOptionsSchema = BaseCronOptionsSchema.extend({
  /** 5-field cron expression. */
  expression: z.string().regex(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/, 'must be a 5-field expression'),
})

/** Options for {@link CronExpressionCron}. */
export type CronExpressionCronOptions = z.input<typeof CronExpressionCronOptionsSchema>

/** Fires the job whenever a 5-field cron expression matches the current minute. */
export class CronExpressionCron extends BaseCron {
  public readonly id: string
  private readonly job: CronJob
  private readonly expression: string
  private timer: ReturnType<typeof setInterval> | undefined
  private _runCount = 0
  private _history: CronRun[] = []
  private lastFiredMinute = ''

  public constructor(options: CronExpressionCronOptions) {
    super()
    CronExpressionCronOptionsSchema.parse(options)
    this.id = options.id
    this.job = options.job
    this.expression = options.expression
  }

  public start(): void {
    if (this.timer) return
    // Tick every 30s so we don't miss a minute boundary.
    this.timer = setInterval(() => void this.tick(), 30_000)
    // Also tick once immediately on start.
    void this.tick()
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  public get isRunning(): boolean {
    return this.timer !== undefined
  }

  public get runCount(): number {
    return this._runCount
  }

  public get history(): ReadonlyArray<CronRun> {
    return this._history
  }

  /** Check if the expression matches and fire if so (deduplicated per minute). */
  public async tick(): Promise<void> {
    const now = new Date()
    const minuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`
    if (minuteKey === this.lastFiredMinute) return
    if (!cronMatches(this.expression, now)) return
    this.lastFiredMinute = minuteKey
    await this.run()
  }

  public async run(): Promise<void> {
    const startedAt = Date.now()
    try {
      await this.job()
      this._history.unshift({
        cronId: this.id,
        startedAt,
        durationMs: Date.now() - startedAt,
        success: true,
      })
    } catch (err) {
      this._history.unshift({
        cronId: this.id,
        startedAt,
        durationMs: Date.now() - startedAt,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    } finally {
      this._runCount += 1
    }
  }
}

// ---------------------------------------------------------------------------
// CronScheduler — manages a collection of crons
// ---------------------------------------------------------------------------

/** Lifecycle state of the scheduler. */
export class CronScheduler {
  private readonly crons: Map<string, BaseCron> = new Map()

  /** Register a cron. Returns the registered cron. */
  public register(cron: BaseCron): BaseCron {
    if (this.crons.has(cron.id)) {
      throw new ConfigError(`Cron with id "${cron.id}" is already registered`, { field: 'id' })
    }
    this.crons.set(cron.id, cron)
    return cron
  }

  /** Unregister and stop a cron. */
  public unregister(id: string): boolean {
    const cron = this.crons.get(id)
    if (!cron) return false
    cron.stop()
    this.crons.delete(id)
    return true
  }

  /** Start all registered crons. */
  public startAll(): void {
    for (const cron of this.crons.values()) cron.start()
  }

  /** Stop all registered crons. */
  public stopAll(): void {
    for (const cron of this.crons.values()) cron.stop()
  }

  /** Get a cron by id. */
  public get(id: string): BaseCron | undefined {
    return this.crons.get(id)
  }

  /** Number of registered crons. */
  public get size(): number {
    return this.crons.size
  }

  /** Get all history across all crons (most recent first). */
  public get history(): ReadonlyArray<CronRun> {
    const all: CronRun[] = []
    for (const cron of this.crons.values()) all.push(...cron.history)
    all.sort((a, b) => b.startedAt - a.startedAt)
    return all
  }
}
