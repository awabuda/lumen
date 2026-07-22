---
'@lumen/core': minor
'@lumen/skills': minor
---

P23.10: tools / security / skill-quality fixes from the bug.md audit (fix #12, #13, #19, #33, #35, #36, #45, #46). Highlights:

- #12 `buildRestrictedRegistry` now warns (via the optional logger) when an `allowedTools` entry has no match in the source registry; previously the entry was silently dropped and the sub-agent ran with fewer tools than the caller intended. The logger param is forwarded from `createSubAgent` → `buildAgent` → `buildRestrictedRegistry`.
- #13 `ProviderPoolOptionsSchema` now exposes the `circuit` field that the interface already accepted. Pre-P23.10 a caller who wired `circuit` through `Schema.parse(cfg)` had it silently stripped — the pool ran without a breaker.
- #19 `ToolRegistry.materializeToolset` logs at `console.debug` when a tool name already exists, naming the duplicate toolset so an operator can resolve the conflict without grepping. The first-wins policy is preserved.
- #33 `IntervalCron.run` and `OnceCron.run` add a `_running` re-entry guard. The doc-flagged `isRunning` getter reflects the scheduler's timer state, not the in-progress job; the new flag is local to `run()` and cleared in `finally`.
- #35 `SkillRegistry.activate()` and `applyActive()` run in parallel via `Promise.all` — `shouldActivate()` and `apply()` are read-only against `ctx`, so the parallelism is safe.
- #36 `globLikeMatch` skips the `^` / `$` anchors when the pattern contains `*` so `'foo*'` matches `'foobar/baz'` and `'*foo*'` matches `'myfoobar'`. Literal (no-`*`) patterns still anchor.
- #45 `createTrace` throws `ValidationError` (was a generic `Error`) so callers can `instanceof`-discriminate validation failures from other runtime errors.
- #46 `HookRegistry` accepts an optional `BaseLogger`; hook exceptions are routed through `logger.error` instead of `console.error` when one is provided. The default behaviour is preserved.
