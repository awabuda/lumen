---
"@lumen/core": minor
---

P19.4 — Handoff + Supervisor sub-agent orchestration.

Adds `createHandoffSubAgent` and `createSupervisorSubAgent` as independent
implementations (no middleware composition), following the deepagents
sub-agent-is-an-agent philosophy from P19.3. The handoff stub tool is
auto-registered into the sub-agent's tool registry, and `extractHandoff`
walks the run's full message history (not just `finalMessage`) so a
handoff emitted mid-loop is still discoverable. The supervisor judge is
a plain helper function — not an abstract class — keeping with the
P19+ rule 15 (helper > abstract). 9 new tests in
`test/sub-agent-handoff.test.ts`.
