/**
 * Dataset + scoring (P20.10) — structured benchmark harness.
 *
 * Builds on the existing per-scenario bench files in
 * `apps/cli/test/perf/`. Adds a thin layer that:
 *   - Defines `BenchmarkCase<Input, Expected>` and
 *     `BenchmarkScore` types (one file, one place to look).
 *   - Provides `runDatasetBench({ name, cases, runner })` that
 *     iterates over a dataset, calls the runner per case, and
 *     collects `BenchmarkScore[]` ready for markdown table
 *     output.
 *
 * Why a small helper instead of a heavy framework:
 *   - Lumen's bench harness is intentionally tiny
 *     (apps/cli/test/perf/helpers.ts). A 200-line runner that
 *     wraps every case in a try/catch and emits a stable
 *     score row is the right size.
 *   - The existing per-scenario bench files (P19.7.1-4) still
 *     work as they are. P20.10 is **additive**: a future
 *     P20.10.2 ticket can rewrite them in terms of
 *     `runDatasetBench` without changing the bench output
 *     format.
 *
 * What this module does NOT do:
 *   - It does not score against a reference implementation
 *     (no LLM-as-judge). The score is whatever the runner
 *     returns. Callers compose their own scoring logic.
 *   - It does not parallelise cases. Callers who want
 *     concurrency can `Promise.all(cases.map(runner))` and
 *     feed the results into `runDatasetBench` themselves.
 *   - It does not depend on a remote dataset store. Datasets
 *     are plain TypeScript values.
 */

import { z } from 'zod'

/** A single benchmark case: a typed input and an expected outcome. */
export interface BenchmarkCase<TInput, TExpected> {
  /** Stable case id (used in score output). */
  readonly id: string
  /** Free-form description. */
  readonly description?: string
  /** Input fed to the runner. */
  readonly input: TInput
  /**
   * Optional expected value. The runner is not required to
   * use it; some benches score by side effect (e.g. wall
   * clock) rather than equality.
   */
  readonly expected?: TExpected
}

/** A single score row emitted by the runner. */
export interface BenchmarkScore {
  readonly caseId: string
  /** Whether the run completed without throwing. */
  readonly passed: boolean
  /** Wall-clock duration in ms (or 0 if instant). */
  readonly durationMs: number
  /** Optional numeric score in [0, 1] or any caller-defined range. */
  readonly score?: number
  /** Free-form error message (when passed is false). */
  readonly error?: string
}

export const BenchmarkScoreSchema = z
  .object({
    caseId: z.string().min(1),
    passed: z.boolean(),
    durationMs: z.number().nonnegative(),
    score: z.number().optional(),
    error: z.string().optional(),
  })
  .strict()

/** Options for {@link runDatasetBench}. */
export interface RunDatasetBenchOptions<TInput, TExpected> {
  /** Dataset name (used in logs and table headers). */
  readonly name: string
  /** The cases to run. */
  readonly cases: ReadonlyArray<BenchmarkCase<TInput, TExpected>>
  /**
   * Per-case runner. Must return a `BenchmarkScore`. Throws
   * are caught and turned into `passed: false` rows so a
   * single failure does not abort the whole dataset.
   */
  readonly runner: (input: TInput, expected: TExpected | undefined) => Promise<BenchmarkScore>
}

/** A complete dataset run, including timing and per-case scores. */
export interface BenchmarkReport {
  readonly name: string
  readonly startedAt: number
  readonly finishedAt: number
  readonly totalCases: number
  readonly passedCases: number
  readonly failedCases: number
  readonly scores: ReadonlyArray<BenchmarkScore>
}

/**
 * Run a dataset end-to-end and collect a {@link BenchmarkReport}.
 *
 * The function never throws: a runner that throws is caught
 * and recorded as a failed score row. The total wall-clock
 * covers the entire dataset; per-case timing is recorded in
 * each `BenchmarkScore`.
 */
export const runDatasetBench = async <TInput, TExpected>(
  options: RunDatasetBenchOptions<TInput, TExpected>,
): Promise<BenchmarkReport> => {
  if (options.cases.length === 0) {
    throw new Error('runDatasetBench: cases must not be empty')
  }
  const startedAt = Date.now()
  const scores: BenchmarkScore[] = []
  for (const c of options.cases) {
    const caseStart = Date.now()
    try {
      const score = await options.runner(c.input, c.expected)
      const validated = BenchmarkScoreSchema.parse({
        ...score,
        caseId: score.caseId || c.id,
        durationMs: score.durationMs ?? Date.now() - caseStart,
      })
      scores.push(validated)
    } catch (err) {
      scores.push({
        caseId: c.id,
        passed: false,
        durationMs: Date.now() - caseStart,
        error: (err as Error).message ?? String(err),
      })
    }
  }
  const finishedAt = Date.now()
  return {
    name: options.name,
    startedAt,
    finishedAt,
    totalCases: options.cases.length,
    passedCases: scores.filter((s) => s.passed).length,
    failedCases: scores.filter((s) => !s.passed).length,
    scores,
  }
}

/**
 * Render a {@link BenchmarkReport} as a single markdown table
 * row. Stays consistent with the existing `benchTableRow` in
 * apps/cli/test/perf/helpers.ts so the report and the
 * per-scenario bench output can be diffed.
 */
export const reportTableRow = (report: BenchmarkReport): string => {
  const totals = `${report.passedCases}/${report.totalCases} passed`
  const durationMs = report.finishedAt - report.startedAt
  return `| ${report.name} | dataset | ${report.totalCases} | ${totals} | ${durationMs} | - | - | - |`
}
