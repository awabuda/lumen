---
'@lumen/core': minor
---

P23.2: Sub-agents now inherit the parent's middleware list (bug #2 + #14 in the bug.md audit). `createSubAgent` and `createSubAgentFromSpec` route through `createAgent` when a non-empty `parentMiddleware` list is supplied; the handoff and supervisor sub-agent paths forward `parent.middleware` through the same channel. The behaviour is strictly additive: omitting the new arg preserves the pre-P23.2 path exactly.