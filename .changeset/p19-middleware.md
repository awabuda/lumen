---
"@lumen/core": minor
---

P19.0 introduces the middleware extension surface and the `createAgent` factory.

- Adds `AgentMiddleware`, hook types (`beforeModel`, `afterModel`, `wrapModelCall`, `wrapToolCall`), `MiddlewareContext`, `MiddlewareError`, and `parseMiddleware`.
- Adds `createAgent(config)` with an optional `middleware` list, eager duplicate-name validation, and symbol-keyed middleware attachment.
- Wires `Agent.run` to dispatch `beforeModel`, `wrapModelCall`, `afterModel`, and `wrapToolCall` in registration order while preserving bare `new Agent(...)` behavior.
- Re-exports the middleware surface and `createAgent` from `@lumen/core`.
- Refactors the planner surface to the P19 helper-function pattern: `BasePlanner` is now an interface, `createStaticPlanner` / `createLLMPlanner` are the concrete helpers, `StaticPlanner` / `LLMPlanner` remain exported function aliases, `revisePlan` provides the old default revise behavior, and `ModeSchema` now accepts `auto`.
- Adds `createPlanMiddleware({ mode, planner?, planStore? })` and `PlanMiddleware` for `plan` / `act` / `auto` orchestration. `plan` mode suppresses tool calls, `act` mode is a no-op, and `auto` mode uses `MiddlewareControl.continueAfterModel` to continue from planning into acting.
- Adds `createReflectionMiddleware({ inline?, stepInterval?, runEnd?, memory? })` and `ReflectionMiddleware` for inline confidence tokens, step-level rule reflection state, and run-end rule reflection persistence. Adds `MiddlewareControl` and `afterRun` middleware support used by reflection.

`streamRun` remains on the old path for now; P19.0.2 only wires the non-streaming `Agent.run` loop.
