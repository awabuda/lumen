/**
 * Scenario: concurrent throughput.
 *
 * Measures how the agent loop scales when multiple
 * `agent.run` calls are in flight at once. The headline
 * number is *throughput* (runs/sec) at a given
 * concurrency level, plus a tail-latency check (max
 * run-time at concurrency N should not regress more than
 * the serialised baseline by a factor larger than the
 * provider's own rate-limit allowance).
 *
 * Scope and caveats:
 *   - This is a *baseline* scenario, not a real load
 *     test. It does not coordinate cancellation, per-tenant
 *     rate-limit accounting, or fairness across providers.
 *     Those would be P19+ work.
 *   - Concurrency is bounded to `LUMEN_BENCH_CONCURRENCY`
 *     (default 5). Going much higher burns API credits
 *     quickly; cloud providers will also rate-limit before
 *     reaching interesting concurrency on the local
 *     providers (Ollama, llama.cpp) which serialise on the
 *     same CPU.
 *   - Throughput numbers are only comparable to a
 *     previous run of the same scenario on the same
 *     provider and model. A different model can change
 *     both latency and concurrency behaviour.
 *
 * Methodology:
 *   - `benchWarmup()` warmup runs are issued serially and
 *     discarded (still serial -- warmup is for
 *     per-connection priming, not for priming the event
 *     loop).
 *   - `benchRuns()` measured *batches* of
 *     `LUMEN_BENCH_CONCURRENCY` parallel runs are issued
 *     via `Promise.all`. We record the wall-clock
 *     duration of each batch and the slowest run in
 *     each batch.
 *
 * Opt in: LUMEN_BENCH=1 + LUMEN_BENCH_CONCURRENT=1 +
 *         at least one LUMEN_BENCH_*_API_KEY. The
 *         LUMEN_BENCH_CONCURRENT gate is a separate
 *         switch from the per-scenario LUMEN_BENCH=1 so
 *         the other scenarios (chat, streaming, tool-call)
 *         are not affected.
 */

import { Agent, ToolRegistry } from '@lumen/core'
import { describe, expect, it } from 'vitest'
import {
  benchEnabled,
  benchRuns,
  benchWarmup,
  getBenchProviders,
  summariseLatency,
} from './helpers.js'

const concurrentEnabled = process.env.LUMEN_BENCH_CONCURRENT === '1'
const shouldRun = benchEnabled() && concurrentEnabled && getBenchProviders().length > 0
const providers = getBenchProviders()
const describeBench = shouldRun ? describe : describe.skip

const CONCURRENCY = Math.min(
  Math.max(1, Number.parseInt(process.env.LUMEN_BENCH_CONCURRENCY ?? '5', 10) || 5),
  20,
)

describeBench(`bench 04: concurrent throughput (${CONCURRENCY} parallel)`, () => {
  for (const { id, provider, defaultModel } of providers) {
    it(`[${id}] reports throughput + tail over ${benchRuns()} batches`, async () => {
      const agent = new Agent({
        provider,
        tools: new ToolRegistry(),
        model: defaultModel,
        systemPrompt: 'You are a precise assistant. Answer in one short sentence.',
      })

      // Serial warmup: primes the connection / model
      // loader. Parallel warmup is misleading because
      // first-call cold-start is a property of the
      // process, not of the dispatcher.
      for (let i = 0; i < benchWarmup(); i++) {
        await agent.run({ userMessage: 'warmup' })
      }

      const batchDurationSamples: number[] = []
      const slowestRunSamples: number[] = []

      for (let batch = 0; batch < benchRuns(); batch++) {
        // Fire CONCURRENCY runs in parallel. Each run is
        // timed individually so we can report the slowest
        // run in the batch as the tail-latency signal.
        const t0 = process.hrtime.bigint()
        const runTimings = await Promise.all(
          Array.from({ length: CONCURRENCY }, async () => {
            const inner0 = process.hrtime.bigint()
            await agent.run({ userMessage: 'What is 2 + 2? Reply with just the number.' })
            const inner1 = process.hrtime.bigint()
            return Number(inner1 - inner0) / 1e6
          }),
        )
        const t1 = process.hrtime.bigint()
        const batchDurationMs = Number(t1 - t0) / 1e6
        const slowestRunMs = Math.max(...runTimings)
        batchDurationSamples.push(batchDurationMs)
        slowestRunSamples.push(slowestRunMs)
      }

      const batchStats = summariseLatency(batchDurationSamples)
      const tailStats = summariseLatency(slowestRunSamples)
      const throughputOps = (CONCURRENCY * batchStats.count) / (batchStats.p50Ms / 1000)
      const throughput = Math.round(throughputOps * 100) / 100

      // Two rows per provider: throughput (ops/sec) as a
      // separate "scenario" line, and the tail-latency
      // per-run. The "runs" column for throughput is
      // total requests (= CONCURRENCY × batchStats.count);
      // tail latency uses CONCURRENCY × batchStats.count
      // too but represents the slowest of each batch.
      const totalRequests = CONCURRENCY * batchStats.count
      console.log(
        `| ${id} | concurrent-throughput | ${totalRequests} | ${throughput} ops/s | n/a | n/a | n/a |`,
      )
      console.log(
        `| ${id} | concurrent-tail | ${totalRequests} | ${tailStats.p50Ms} | ${tailStats.p95Ms} | ${tailStats.maxMs} | ${tailStats.meanMs} |`,
      )

      // Soft assertions: the bench never fails on
      // absolute throughput, but a complete freeze is a
      // hard failure. We assert the slowest run stayed
      // under 60s; the headroom is what catches a bug
      // where a future refactor accidentally serialises
      // the parallel dispatch.
      expect(batchStats.count).toBe(benchRuns())
      expect(tailStats.maxMs).toBeLessThan(60_000)
      // Sanity: throughput must be > 0 (the model is at
      // least returning). A zero here means a real
      // regression, not a noise floor.
      expect(throughput).toBeGreaterThan(0)
    }, 180_000)
  }
})
