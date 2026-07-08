---
"@lumen/core": minor
---

P20.1 — HITL (Human-in-the-Loop) interrupt middleware.

Adds `createInterruptMiddleware({ toolNames?, maxIterations?, onError? })`
to `@lumen/core`. The middleware throws an `AbortError` when one
of the configured rules fires:

  - `toolNames`: throws as soon as a tool with one of these
    names is about to dispatch
  - `maxIterations`: throws when the iteration counter reaches
    the cap (checked in `beforeModel`, before the provider
    call)
  - `onError: true`: throws when a tool dispatch throws

The AbortError propagates to the P20.4.2 catch path in
`Agent.run`, which auto-saves a checkpoint and re-throws.
The caller can then `resumeFrom` after handling the interrupt
(operator approval, fix the bad input, etc.).

6 new e2e in `test/middleware-interrupt.test.ts`: rule-less
config throws / tool-name triggers abort + checkpoint / not-in-
list tool passes through / maxIterations triggers abort +
checkpoint / middleware name 'interrupt' / maxIterations
rejects non-positive values.

P19+ rule 11: middleware, not a boolean flag on AgentConfig.
P19+ rule 15: helper function + interface, not abstract class.
