---
'@lumen/core': minor
---

P23.6: Cost and time budget limits are now wired end-to-end (bug #8). Pre-P23.6 the `Budget` constructor accepted `costUsd` and `timeMs` but `Agent.run` never read either from `AgentRunOptions` — the Budget was constructed with only `tokens`. `Budget.addCost()` existed but no caller invoked it, and `usage.costUsd` had no schema field. This commit adds `costLimitUsd` and `timeLimitMs` to `AgentRunOptions`, threads them into the Budget constructor, extends `AssistantMessage.usage` with optional `costUsd`, and wires `budget.addCost(usage.costUsd)` after each model call on both the sync and stream paths. Pre-existing token-limit behaviour and the "no limit" default are preserved.