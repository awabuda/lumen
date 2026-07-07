---
"@lumen/memory": minor
---

P19.5 — MetaReflector (cross-run fact consolidation + trust delta).

Adds `BaseMetaReflector` interface + `createClusteringMetaReflector` helper
to `@lumen/memory`. The clustering pass groups `MemoryRecord`s of the same
`kind` and identical tag-set whose content shares a Jaccard token overlap
above a configurable threshold. Each cluster yields a `TrustDeltaPatch`
that proposes a bounded ±0.1 trust adjustment on the oldest (representative)
record. The patch is a pure value — the meta-reflector does not own the
write back to the store, so callers can apply or reject it as they see
fit. 10 new unit tests in `test/meta-reflector.test.ts`. P19+ rule 15:
helper functions + interface, not abstract class.
