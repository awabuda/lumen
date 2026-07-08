---
"@lumen/core": minor
---

P20.4 — Checkpoint / Resume (interface + InMemoryCheckpointStore).

Adds `AgentCheckpoint` interface, `BaseCheckpointStore` interface,
`AgentCheckpointSchema` (Zod), `checkpointFromRun` helper, and
`InMemoryCheckpointStore` implementation to `@lumen/core`. A
SQLite-backed implementation is intentionally **not** in core
(tier isolation: core cannot import `@lumen/memory`); it will
live in a downstream package (P20.4.2) so the core package
stays storage-agnostic.

10 new unit tests in `test/checkpoint.test.ts` covering
checkpoint construction (with / without label), schema
validation, save/get/list/delete roundtrips, session filtering,
and rejection of malformed checkpoints.

P19+ rule 15: helper + interface, not abstract class.
