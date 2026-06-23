/**
 * Scenario: chat latency.
 *
 * Measures the wall-clock cost of a single `agent.run` call
 * (one user turn, no tool calls, no streaming, no memory
 * lookup beyond a fresh in-memory store) across the
 * configured providers. This is the "headline" number for
 * the agent loop: most user-visible latency on a non-tool
 * exchange ends up here.
 *
 * Methodology:
 *   - `benchWarmup()` warmup runs are issued but discarded
 *     (amortises cold start -- first request is almost
 *     always 100-300ms slower due to TLS / connection
 *     pool / JIT).
 *   - `benchRuns()` measured runs are recorded; we report
 *     p50, p95, max, mean.
 *
 * The output is a single markdown table printed to stdout;
 * `pnpm test:bench > REPORT.md` captures it to disk.
 *
 * Opt in: LUMEN_BENCH=1 + at least one LUMEN_BENCH_*_API_KEY
 * (or local server URL). Otherwise the entire scenario is
 * skipped via describe.skipIf.
 */

import { Agent, ToolRegistry } from '@lumen/core'
import { describe, expect, it } from 'vitest'
import {
  BENCH_TABLE_HEADER,
  benchEnabled,
  benchRuns,
  benchTableRow,
  benchWarmup,
  getBenchProviders,
  summariseLatency,
  timeAsync,
} from './helpers.js'

const shouldRun = benchEnabled() && getBenchProviders().length > 0
const providers = getBenchProviders()
const describeBench = shouldRun ? describe : describe.skip

describeBench('bench 01: chat latency (agent.run round-trip)', () => {
  for (const { id, provider, defaultModel } of providers) {
    it(`[${id}] reports p50/p95/max over ${benchRuns()} runs`, async () => {
      const agent = new Agent({
        provider,
        tools: new ToolRegistry(),
        model: defaultModel,
        systemPrompt: 'You are a precise assistant. Answer in one short sentence.',
      })

      // Warmup phase: discarded. Issues the first chat to
      // prime connection pools and JIT, so the measured
      // samples reflect steady-state behaviour.
      for (let i = 0; i < benchWarmup(); i++) {
        await agent.run({ userMessage: 'warmup' })
      }

      // Measured phase.
      const samples: number[] = []
      for (let i = 0; i < benchRuns(); i++) {
        const { durationMs } = await timeAsync(() =>
          agent.run({ userMessage: 'What is 2 + 2? Reply with just the number.' }),
        )
        samples.push(durationMs)
      }

      const stats = summariseLatency(samples)
      // Print a row the regression tracker can grep. Always
      // emitted, even on success, so the bench output is the
      // source of truth.
      console.log(BENCH_TABLE_HEADER)
      console.log(benchTableRow(id, 'chat', stats))

      // Soft assertion: at least one run must complete
      // under 60 seconds. This catches "provider completely
      // broken" without flaking on genuinely slow networks.
      // We do not assert on p50 / p95 -- absolute latency
      // regressions are a human-read-the-table problem, not
      // a test-failure problem.
      expect(stats.count).toBe(benchRuns())
      expect(stats.maxMs).toBeLessThan(60_000)
    }, 120_000)
  }
})
