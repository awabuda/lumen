---
'@lumen/core': minor
---

P23.4: Middleware can now read the full conversation history at any hook point (bug #5). `MiddlewareContext.history: ReadonlyArray<Message>` is attached on `beforeModel`, `wrapModelCall`, `afterModel`, and `afterRun` (with the just-produced message included on `afterModel`). `ReflectionMiddleware.afterModel` and `afterRun` now read `ctx.history` instead of `[message]` — pre-P23.4 the heuristic collapsed every run to "1 message, 0 tools, 0 errors" regardless of length. The new seam is back-compat-friendly: pre-existing middleware that doesn't touch `ctx.history` keeps working unchanged.