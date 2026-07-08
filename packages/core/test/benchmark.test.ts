/** P20.10 e2e: dataset + scoring benchmark harness. */

import { describe, expect, it } from 'vitest'
import {
  BenchmarkScoreSchema,
  type BenchmarkCase,
  type BenchmarkReport,
  type BenchmarkScore,
  reportTableRow,
  runDatasetBench,
} from '../src/benchmark.js'

describe('runDatasetBench', () => {
  it('runs every case and records a BenchmarkScore per case', async () => {
    const cases: BenchmarkCase<number, number>[] = [
      { id: 'double-2', input: 2, expected: 4 },
      { id: 'double-3', input: 3, expected: 6 },
      { id: 'double-4', input: 4, expected: 8 },
    ]
    const report = await runDatasetBench({
      name: 'double',
      cases,
      runner: async (input) => ({
        caseId: '',
        passed: input > 0,
        durationMs: 0,
        score: input * 2 === input * 2 ? 1 : 0,
      }),
    })
    expect(report.totalCases).toBe(3)
    expect(report.passedCases).toBe(3)
    expect(report.failedCases).toBe(0)
    expect(report.scores).toHaveLength(3)
    expect(report.scores[0]?.caseId).toBe('double-2')
  })

  it('catches per-case errors and records passed: false', async () => {
    const cases: BenchmarkCase<number, number>[] = [
      { id: 'ok', input: 1, expected: 1 },
      { id: 'fail', input: 0, expected: 0 },
    ]
    const report = await runDatasetBench({
      name: 'mixed',
      cases,
      runner: async (input) => {
        if (input === 0) throw new Error('zero is not allowed')
        return {
          caseId: '',
          passed: true,
          durationMs: 0,
        }
      },
    })
    expect(report.passedCases).toBe(1)
    expect(report.failedCases).toBe(1)
    const failed = report.scores.find((s) => s.caseId === 'fail')
    expect(failed?.passed).toBe(false)
    expect(failed?.error).toContain('zero is not allowed')
  })

  it('records the wall-clock duration of the dataset run', async () => {
    const cases: BenchmarkCase<string, string>[] = [
      { id: 'a', input: 'a' },
      { id: 'b', input: 'b' },
    ]
    const t0 = Date.now()
    const report = await runDatasetBench({
      name: 'quick',
      cases,
      runner: async () => {
        await new Promise((r) => setTimeout(r, 5))
        return { caseId: '', passed: true, durationMs: 5 }
      },
    })
    expect(report.finishedAt - report.startedAt).toBeGreaterThanOrEqual(10)
    expect(report.startedAt).toBeGreaterThanOrEqual(t0)
  })

  it('throws when the dataset is empty', async () => {
    await expect(
      runDatasetBench({
        name: 'empty',
        cases: [],
        runner: async () => ({
          caseId: '',
          passed: true,
          durationMs: 0,
        }),
      }),
    ).rejects.toThrow(/empty/)
  })

  it('preserves the caseId from the runner when supplied', async () => {
    const cases: BenchmarkCase<number, number>[] = [{ id: 'origin', input: 1 }]
    const report = await runDatasetBench({
      name: 'rename',
      cases,
      runner: async () => ({
        caseId: 'overridden',
        passed: true,
        durationMs: 1,
      }),
    })
    expect(report.scores[0]?.caseId).toBe('overridden')
  })

  it('falls back to the case id when the runner does not supply one', async () => {
    const cases: BenchmarkCase<number, number>[] = [{ id: 'fallback', input: 1 }]
    const report = await runDatasetBench({
      name: 'fallback',
      cases,
      runner: async () => ({ caseId: '', passed: true, durationMs: 0 }),
    })
    expect(report.scores[0]?.caseId).toBe('fallback')
  })
})

describe('reportTableRow', () => {
  it('renders a markdown row with the dataset summary', () => {
    const report: BenchmarkReport = {
      name: 'demo',
      startedAt: 0,
      finishedAt: 100,
      totalCases: 3,
      passedCases: 2,
      failedCases: 1,
      scores: [],
    }
    const row = reportTableRow(report)
    expect(row).toContain('| demo |')
    expect(row).toContain('dataset')
    expect(row).toContain('2/3 passed')
    expect(row).toContain('100')
  })

  it('renders an all-pass row with the right passed count', () => {
    const report: BenchmarkReport = {
      name: 'all-pass',
      startedAt: 0,
      finishedAt: 50,
      totalCases: 4,
      passedCases: 4,
      failedCases: 0,
      scores: [],
    }
    const row = reportTableRow(report)
    expect(row).toContain('4/4 passed')
  })
})

describe('BenchmarkScore shape (Zod contract)', () => {
  it('rejects a score with a negative duration', () => {
    const result = BenchmarkScoreSchema.safeParse({
      caseId: 'a',
      passed: true,
      durationMs: -1,
    })
    expect(result.success).toBe(false)
  })

  it('rejects a score with an empty caseId', () => {
    const result = BenchmarkScoreSchema.safeParse({
      caseId: '',
      passed: true,
      durationMs: 0,
    })
    expect(result.success).toBe(false)
  })

  it('accepts a minimal valid score', () => {
    const result: { success: boolean; data?: BenchmarkScore } =
      BenchmarkScoreSchema.safeParse({
        caseId: 'a',
        passed: true,
        durationMs: 0,
      })
    expect(result.success).toBe(true)
    expect(result.data?.caseId).toBe('a')
  })
})
