/**
 * Observability — trace context (P20.8).
 *
 * Lightweight W3C-style trace propagation for lumen. Provides:
 *   - `createTrace({ traceId?, spanId?, parentSpanId? })` builds a
 *     `TraceContext`. traceId + spanId default to 16-char random
 *     hex strings (sufficient for an in-process trace tree; not
 *     full W3C 128-bit IDs because the agent runtime does not
 *     interoperate with external tracing systems).
 *   - `runWithTrace(trace, runner)` runs `runner(trace)` and
 *     returns the runner's result; the helper exists to make
 *     the call site self-documenting ("this whole block is
 *     one trace") and to centralise future policy (e.g. abort
 *     propagation).
 *
 * Why an **outer helper**, not a middleware:
 *   - P19+ rule 11 says "extension to the Agent loop = middleware";
 *     observability does not extend the loop, it observes it.
 *   - The trace is the **caller's** decision (a CLI command
 *     that wants per-invocation traces creates one; a TUI that
 *     reuses a single trace for the session reuses the id).
 *   - A helper is forward-compatible with W3C / OpenTelemetry
 *     bridges: a future `toOtelContext(trace)` can map our
 *     `TraceContext` to a `SpanContext` without changing the
 *     public surface.
 *
 * What this module does **not** do:
 *   - It does not instrument Agent.run internally. Callers
 *     that want the trace id attached to every step event
 *     call `createAgent({ middleware: [createTraceHook(trace)] })`
 *     (a future P20.8.x). For now, the trace is opt-in metadata
 *     that callers thread through their own code.
 *   - It does not log, print, or export anything. Output is the
 *     caller's responsibility.
 */

import { randomBytes } from 'node:crypto'

/** Trace + span identifiers. 16 hex chars each (~64 bits). */
export interface TraceContext {
  readonly traceId: string
  readonly spanId: string
  /** Optional parent span (for nested traces). */
  readonly parentSpanId?: string
  /** Optional human-readable name. */
  readonly name?: string
  /** Wall-clock ms when the trace was created. */
  readonly startedAt: number
}

/** Options for {@link createTrace}. */
export interface CreateTraceOptions {
  /** Override the trace id (e.g. propagate from an upstream system). */
  readonly traceId?: string
  /** Override the span id. */
  readonly spanId?: string
  /** Optional parent span id. */
  readonly parentSpanId?: string
  /** Optional human-readable name. */
  readonly name?: string
}

const ID_BYTES = 8 // 8 random bytes = 16 hex chars

const randomHexId = (): string => randomBytes(ID_BYTES).toString('hex')

const isHex = (s: string, expectedLen: number): boolean =>
  s.length === expectedLen && /^[0-9a-f]+$/.test(s)

/**
 * Build a new {@link TraceContext}. Both `traceId` and `spanId`
 * default to 16-char random hex. Override either when
 * propagating from an upstream system (e.g. a parent
 * OpenTelemetry trace).
 */
export const createTrace = (options: CreateTraceOptions = {}): TraceContext => {
  const traceId = options.traceId ?? randomHexId()
  const spanId = options.spanId ?? randomHexId()
  if (!isHex(traceId, 16)) {
    throw new Error('createTrace: traceId must be 16 hex characters')
  }
  if (!isHex(spanId, 16)) {
    throw new Error('createTrace: spanId must be 16 hex characters')
  }
  if (options.parentSpanId !== undefined && !isHex(options.parentSpanId, 16)) {
    throw new Error('createTrace: parentSpanId must be 16 hex characters')
  }
  const base: TraceContext = {
    traceId,
    spanId,
    startedAt: Date.now(),
  }
  let withParent: TraceContext = options.parentSpanId !== undefined
    ? { ...base, parentSpanId: options.parentSpanId }
    : base
  withParent = options.name !== undefined ? { ...withParent, name: options.name } : withParent
  return withParent
}

/**
 * Run `runner(trace)` and return its result. The helper does
 * nothing on its own today; it is the documented entry point
 * for trace-tagged scopes and the place future policy lands
 * (timeout propagation, abort propagation, span close events).
 */
export const runWithTrace = async <T>(
  trace: TraceContext,
  runner: (trace: TraceContext) => Promise<T>,
): Promise<T> => {
  return runner(trace)
}

/** Render a trace as a 1-line summary, suitable for log lines. */
export const formatTrace = (trace: TraceContext): string => {
  const name = trace.name ? ` ${trace.name}` : ''
  const parent = trace.parentSpanId ? ` parent=${trace.parentSpanId}` : ''
  return `[trace ${trace.traceId} span=${trace.spanId}${parent}${name}]`
}
