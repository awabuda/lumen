---
"@lumen/core": minor
---

P20.10 — Dataset + scoring (structured benchmark harness).

Adds `BenchmarkCase<TInput, TExpected>`, `BenchmarkScore`,
`BenchmarkScoreSchema` (Zod, strict), `BenchmarkReport`,
`runDatasetBench({ name, cases, runner })`, and
`reportTableRow(report)` to `@lumen/core`. The helper is
**additive** on top of the existing per-scenario bench
files in `apps/cli/test/perf/` — a future P20.10.2 can
rewrite those benches in terms of `runDatasetBench` without
changing the existing bench output format.

Design choices:
  - Tiny: 200-line module, no new framework. The existing
    bench harness in `apps/cli/test/perf/helpers.ts` is
    intentionally small; a structured sibling at the same
    scale is the right size.
  - `runDatasetBench` **never throws**: a per-case error is
    caught and recorded as a `passed: false` row so one
    failure does not abort the whole dataset.
  - `runner` is async and returns a `BenchmarkScore`; the
    runner owns its own scoring logic (no LLM-as-judge).
  - `reportTableRow` produces a markdown row matching the
    `apps/cli/test/perf/benchTableRow` shape so future
    rewrites can diff the report against the legacy output.

What this module does NOT do:
  - No LLM-as-judge. Score = whatever the runner returns.
  - No parallel cases. Callers compose with Promise.all if
    they want concurrency.
  - No remote dataset store. Datasets are plain TypeScript
    values.

11 e2e in `test/benchmark.test.ts`: every case gets a score /
per-case errors are caught / wall-clock recorded / empty
dataset throws / runner-supplied caseId is preserved / case
fallback id / report table row all-pass + mixed / Zod rejects
negative duration + empty caseId + accepts minimal valid.
