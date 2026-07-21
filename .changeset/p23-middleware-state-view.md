---
'@lumen/core': minor
---

P23.3: Middleware state mutation now goes through the typed `MiddlewareStateView.set()` writer (bug #4 + #15 in the bug.md audit). `ctx.stateView` exposes one `MiddlewareStateView` entry per middleware; `set(next)` re-parses against the owning middleware's `stateSchema` (throwing `MiddlewareError` on violation) and persists into the merged state dictionary so changes survive across iterations. `plan.ts` and `reflection.ts` migrated from the cast-and-mutate footgun (`state.plan = X`, `state.stepCount += 1`) to `stateView.<name>.set(next)`. Writes from one middleware into another's slice fail closed at runtime because each `set` callback is closed over the owning schema.