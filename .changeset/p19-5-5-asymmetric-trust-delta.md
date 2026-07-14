---
'@lumen/memory': minor
---

P19.5.5 — opt-in asymmetric trust delta (Hermes mirror). Adds
`META_REFLECTOR_POSITIVE_MAX_DELTA = 0.05` and
`META_REFLECTOR_NEGATIVE_MAX_DELTA = 0.10` as named exports, plus a
new helper `applyAsymmetricTrustDelta(cluster, representative, interval?, sign?, positiveMax?, negativeMax?)`.
`createClusteringMetaReflector({ asymmetric: true })` now routes through
the asymmetric helper instead of `applyTrustDelta`. Default behavior
(`applyTrustDelta` symmetric, no `asymmetric` flag) is unchanged —
back-compat preserved. See `docs/P19.5.5-asymmetric-trust-delta-design-basis.md`.