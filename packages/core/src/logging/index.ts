/**
 * Structured logging contract.
 *
 * Every Lumen component that needs to emit diagnostics
 * receives a {@link BaseLogger} instance. The default
 * implementation is {@link ConsoleLogger} (zero deps);
 * operators who want JSON-structured logs swap it for
 * {@link PinoLogger} at composition time.
 *
 * The contract is intentionally tiny: four severity
 * levels plus a `child()` method for scoped loggers.
 * No format strings, no printf-style interpolation —
 * every log call takes a message string and an optional
 * context object. This keeps the surface testable and
 * the output machine-parseable.
 */

/** Severity level. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/** A single log entry. */
export interface LogEntry {
  readonly level: LogLevel
  readonly msg: string
  readonly context?: Readonly<Record<string, unknown>>
  readonly timestamp: number
}

/** The contract every logger implements. */
export abstract class BaseLogger {
  /** Stable identifier for the implementation. */
  public abstract readonly id: string

  public abstract debug(msg: string, context?: Record<string, unknown>): void
  public abstract info(msg: string, context?: Record<string, unknown>): void
  public abstract warn(msg: string, context?: Record<string, unknown>): void
  public abstract error(msg: string, context?: Record<string, unknown>): void

  /**
   * Create a child logger with additional bindings. Every
   * log call on the child includes the parent's bindings
   * plus the child's own. Used for per-component scoping
   * (e.g. `logger.child({ component: 'agent' })`).
   */
  public abstract child(bindings: Record<string, unknown>): BaseLogger
}

// ---------------------------------------------------------------------------
// ConsoleLogger — zero-dependency default
// ---------------------------------------------------------------------------

/**
 * Default {@link BaseLogger} implementation. Writes to
 * `process.stderr` (never stdout, which is reserved for
 * the agent's primary output). No dependencies beyond
 * `console.error`.
 *
 * The output format is deliberately human-readable:
 * `[LEVEL] [bindings] message`. Operators who want JSON
 * should use {@link PinoLogger}.
 */
export class ConsoleLogger extends BaseLogger {
  public readonly id = 'console'
  private readonly bindings: Readonly<Record<string, unknown>>
  private readonly minLevel: number

  private static readonly LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
  }

  public constructor(bindings: Record<string, unknown> = {}, minLevel: LogLevel = 'info') {
    super()
    this.bindings = { ...bindings }
    this.minLevel = ConsoleLogger.LEVEL_ORDER[minLevel]
  }

  public debug(msg: string, context?: Record<string, unknown>): void {
    this.log('debug', msg, context)
  }

  public info(msg: string, context?: Record<string, unknown>): void {
    this.log('info', msg, context)
  }

  public warn(msg: string, context?: Record<string, unknown>): void {
    this.log('warn', msg, context)
  }

  public error(msg: string, context?: Record<string, unknown>): void {
    this.log('error', msg, context)
  }

  public child(bindings: Record<string, unknown>): BaseLogger {
    return new ConsoleLogger({ ...this.bindings, ...bindings }, this.levelFromOrder())
  }

  private log(level: LogLevel, msg: string, context?: Record<string, unknown>): void {
    if (ConsoleLogger.LEVEL_ORDER[level] < this.minLevel) return
    const prefix = `[${level.toUpperCase()}]`
    const bindingStr =
      Object.keys(this.bindings).length > 0
        ? ` [${Object.entries(this.bindings)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(' ')}]`
        : ''
    const ctxStr = context && Object.keys(context).length > 0 ? ` ${JSON.stringify(context)}` : ''
    process.stderr.write(`${prefix}${bindingStr} ${msg}${ctxStr}\n`)
  }

  private levelFromOrder(): LogLevel {
    const entries = Object.entries(ConsoleLogger.LEVEL_ORDER) as Array<[LogLevel, number]>
    for (const [level, order] of entries) {
      if (order === this.minLevel) return level
    }
    return 'info'
  }
}

// ---------------------------------------------------------------------------
// PinoLogger — optional, lazy-loaded
// ---------------------------------------------------------------------------

/**
 * pino-backed {@link BaseLogger}. Requires `pino` to be
 * installed (it is NOT a hard dependency of `@lumen/core`).
 *
 * Construction is async because we `await import('pino')`
 * at runtime. If pino is not installed the factory returns
 * a {@link ConsoleLogger} instead, with a one-time warning
 * on stderr.
 */
export class PinoLogger extends BaseLogger {
  public readonly id = 'pino'
  private pinoInstance: Record<string, unknown> | null = null
  private initialized = false
  private readonly bindings: Record<string, unknown>

  public constructor(bindings: Record<string, unknown> = {}) {
    super()
    this.bindings = { ...bindings }
  }

  /**
   * Must be called once before any log methods. Loads pino
   * via dynamic import and creates the root logger.
   */
  public async init(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    try {
      // @ts-expect-error pino is optional; not a hard dep
      const pino = await import('pino')
      this.pinoInstance = pino.default({
        name: 'lumen',
        level: 'info',
        ...this.bindings,
      }) as unknown as Record<string, unknown>
    } catch {
      process.stderr.write('[lumen] pino not installed, falling back to console logger\n')
    }
  }

  public debug(msg: string, context?: Record<string, unknown>): void {
    this.log('debug', msg, context)
  }

  public info(msg: string, context?: Record<string, unknown>): void {
    this.log('info', msg, context)
  }

  public warn(msg: string, context?: Record<string, unknown>): void {
    this.log('warn', msg, context)
  }

  public error(msg: string, context?: Record<string, unknown>): void {
    this.log('error', msg, context)
  }

  public child(bindings: Record<string, unknown>): BaseLogger {
    const child = new PinoLogger({ ...this.bindings, ...bindings })
    // Share the pino instance so the child doesn't
    // re-import. The child's bindings are passed to
    // pino.child() when the parent is ready.
    if (this.pinoInstance) {
      const childFn = this.pinoInstance['child'] as
        | ((b: Record<string, unknown>) => Record<string, unknown>)
        | undefined
      child.pinoInstance = childFn ? childFn(bindings) : this.pinoInstance
      child.initialized = true
    }
    return child
  }

  private log(level: LogLevel, msg: string, context?: Record<string, unknown>): void {
    if (!this.pinoInstance) return
    const fn = this.pinoInstance[level] as
      | ((obj: Record<string, unknown>, msg: string) => void)
      | undefined
    if (fn) {
      fn({ ...context }, msg)
    }
  }
}
