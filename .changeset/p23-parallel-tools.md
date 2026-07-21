---
'@lumen/core': minor
---

P23.7: Parallel tool dispatch + ParallelSubAgent real streaming (bug #9 + #23). `AgentRunOptions.parallel?: boolean` opts into concurrent tool-call dispatch via `Promise.all` when a model response has > 1 tool call. tool:start events fire up front in invocation order; tool:end events fire as each completes. Default false preserves serial behaviour. `ParallelSubAgent.stream()` now yields each task as it settles (Promise.race against a tagged Map) instead of waiting for `Promise.allSettled` and iterating in invocation order. Pre-P23.7 `stream()` was functionally identical to `run()` for any caller that awaited one entry at a time.