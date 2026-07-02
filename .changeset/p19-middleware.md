---
"@lumen/core": minor
---

P19.0 introduces the middleware extension surface and the `createAgent` factory.

- Adds `AgentMiddleware`, hook types (`beforeModel`, `afterModel`, `wrapModelCall`, `wrapToolCall`), `MiddlewareContext`, `MiddlewareError`, and `parseMiddleware`.
- Adds `createAgent(config)` with an optional `middleware` list, eager duplicate-name validation, and symbol-keyed middleware attachment.
- Wires `Agent.run` to dispatch `beforeModel`, `wrapModelCall`, `afterModel`, and `wrapToolCall` in registration order while preserving bare `new Agent(...)` behavior.
- Re-exports the middleware surface and `createAgent` from `@lumen/core`.

`streamRun` remains on the old path for now; P19.0.2 only wires the non-streaming `Agent.run` loop.
