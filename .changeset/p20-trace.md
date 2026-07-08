---
"@lumen/core": minor
---

P20.8 — Observability: trace context.

Adds `createTrace({ traceId?, spanId?, parentSpanId?, name? })`,
`runWithTrace(trace, runner)`, and `formatTrace(trace)` to
`@lumen/core`. 16-hex-char identifiers (8 random bytes each)
suffice for an in-process trace tree; full W3C 128-bit IDs are
not implemented because the agent runtime does not interoperate
with external tracing systems today.

Why an outer helper (not a middleware):
  - P19+ rule 11 ("extension to Agent loop = middleware") does
    not apply — observability observes the loop, it does not
    change loop behaviour.
  - The trace is the caller's decision (CLI: per-invocation;
    TUI: per-session). A helper keeps the call site
    self-documenting.
  - Forward-compatible with W3C / OpenTelemetry bridges: a
    future `toOtelContext(trace)` can map TraceContext to a
    SpanContext without changing the public surface.

14 e2e in `test/trace.test.ts`: default 16-hex ids / override
ids / optional parent + name / omission of optional fields /
rejection of bad length + non-hex / startedAt is construction
time / unique spanId per call / runWithTrace forwards / error
propagation / return value passthrough / formatTrace with
parent + name / formatTrace without parent.

What this module does NOT do:
  - It does not instrument Agent.run internally. A future
    P20.8.x ticket can add `createTraceHook(trace)` to wire
    the trace into Agent hook events without breaking the
    public surface.
  - It does not log, print, or export anything. Output is the
    caller's responsibility (typically `console.log(formatTrace(trace))`
    in a hook callback).
