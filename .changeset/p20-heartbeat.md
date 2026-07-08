---
"@lumen/core": minor
---

P20.2 — Heartbeat / long-running supervisor.

Adds `startHeartbeat({ intervalMs, timeoutMs?, onPing?, onTimeout? })`
and `runWithHeartbeat(runner, options)` to `@lumen/core`. The
supervisor is an **outer wrapper** (not a middleware) because:

  - It runs between agent iterations and the agent loop has no
    "last activity" hook to wire to.
  - P19+ rule 11 ("extension to Agent loop = middleware") does
    not apply: the supervisor does not change loop behaviour, it
    terminates the run from the outside via `signal.abort()`.

Two-layer API:
  - `startHeartbeat` returns a `HeartbeatHandle` with `signal`,
    `bump()`, `isAlive()`, `stop()`. The handle is alive until
    `stop()` is called; the underlying `setInterval` is `unref()`-ed
    so a never-stopped heartbeat does not keep Node alive past
    `lumen run` exit.
  - `runWithHeartbeat` is a convenience: builds a heartbeat, runs
    the caller's `runner(signal)`, and stops the heartbeat on
    settle. The runner's signal is `signal.aborted` when the
    deadline elapses.

Defaults: `HEARTBEAT_DEFAULT_INTERVAL_MS = 30 000` (matches the
P20.2 spec). `timeoutMs` is optional — when omitted, the
supervisor is in pure ping mode (no auto-abort).

11 e2e in `test/heartbeat.test.ts`: handle lifecycle / intervalMs
/ timeoutMs / onPing per tick / abort on deadline / no auto-abort
when timeoutMs omitted / stop is idempotent / runWithHeartbeat
forwards signal / runWithHeartbeat propagates runner errors /
runWithHeartbeat aborts on deadline / default constant is 30 000.

The bump() method is intentionally **not** auto-called by the
agent loop (no "last activity" hook in core). Callers that want
auto-bumping wire it via their own hooks (e.g. `afterModel`,
`afterRun`).
