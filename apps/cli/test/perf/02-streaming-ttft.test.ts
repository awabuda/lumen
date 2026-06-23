/**
 * Scenario: streaming time-to-first-token (TTFT).
 *
 * For streaming providers the user-perceived latency is the
 * time between sending the request and seeing the first
 * character, not the time to the final message. The total
 * round-trip is the cost of generating every token; the
 * TTFT is the cost of getting the model to start talking.
 *
 * Methodology:
 *   - One `agent.streamRun` per measurement, accumulated.
 *   - We record the wall-clock from `streamRun` invocation
 *     to the first `text:delta` event (TTFT) and to the
 *     terminal event (total).
 *   - Warmup runs prime the streaming connection, which on
 *     cloud providers is a separate connection from the
 *     one-shot endpoint and has its own cold-start cost.
 *
 * Caveats:
 *   - Some local providers (llama.cpp in particular) buffer
 *     the full response and ship it in one shot. The TTFT
 *     for those will be ~equal to the total time. That is
 *     a real signal, not a test failure.
 *   - The terminal event name depends on the provider --
 *     we listen for `message` (Anthropic), `final` (MCP
 *     alias) and `end` (OpenAI). Anything else is a no-op
 *     and the total-time is the time until the stream
 *     function returns.
 *
 * Opt in: LUMEN_BENCH=1 + at least one LUMEN_BENCH_*_API_KEY.
 */

import { Agent, ToolRegistry } from '@lumen/core'
import { describe, expect, it } from 'vitest'
import {
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

interface StreamTimings {
  readonly ttftMs: number
  readonly totalMs: number
  readonly hadStreaming: boolean
}

async function measureStream(agent: Agent, prompt: string): Promise<StreamTimings> {
  const t0 = process.hrtime.bigint()
  let firstDeltaAt: bigint | null = null
  let terminalAt: bigint | null = null

  // `agent.streamRun` returns an async iterable of agent
  // events. Each event has a `type` discriminator; we care
  // about the first `text:delta` and the terminal `run:end`.
  // (Other event types -- `run:start`, `tool:start`,
  // `step:end` -- are observed but not used for timing.)
  for await (const event of agent.streamRun({ userMessage: prompt })) {
    if (firstDeltaAt === null && event.type === 'text:delta') {
      firstDeltaAt = process.hrtime.bigint()
    }
    if (event.type === 'run:end') {
      terminalAt = process.hrtime.bigint()
    }
  }

  const end = process.hrtime.bigint()
  const totalMs = Number(end - t0) / 1e6
  if (firstDeltaAt === null) {
    // No streaming observed -- treat the whole thing as a
    // one-shot response. TTFT == total.
    return { ttftMs: totalMs, totalMs, hadStreaming: false }
  }
  const ttftMs = Number(firstDeltaAt - t0) / 1e6
  return {
    ttftMs,
    totalMs: terminalAt ? Number(terminalAt - t0) / 1e6 : totalMs,
    hadStreaming: true,
  }
}

describeBench('bench 02: streaming time-to-first-token', () => {
  for (const { id, provider, defaultModel } of providers) {
    it(`[${id}] reports TTFT p50/p95 over ${benchRuns()} runs`, async () => {
      const agent = new Agent({
        provider,
        tools: new ToolRegistry(),
        model: defaultModel,
        systemPrompt: 'You are a precise assistant. Answer in one short sentence.',
      })

      // Warmup: streaming has its own connection cold-start.
      for (let i = 0; i < benchWarmup(); i++) {
        await measureStream(agent, 'warmup')
      }

      const ttftSamples: number[] = []
      const totalSamples: number[] = []
      for (let i = 0; i < benchRuns(); i++) {
        const timings = await measureStream(agent, 'What is 2 + 2? Reply with just the number.')
        ttftSamples.push(timings.ttftMs)
        totalSamples.push(timings.totalMs)
      }

      const ttftStats = summariseLatency(ttftSamples)
      const totalStats = summariseLatency(totalSamples)

      // Two rows per provider: TTFT and total. Format is
      // stable so a regression diff is greppable.
      console.log(benchTableRow(id, 'stream-ttft', ttftStats))
      console.log(benchTableRow(id, 'stream-total', totalStats))

      // Soft assertion: at least one complete stream under
      // 60s. (Same rationale as scenario 01.)
      expect(ttftStats.count).toBe(benchRuns())
      expect(totalStats.maxMs).toBeLessThan(60_000)
      // TTFT should be <= total on every run, by
      // construction. Guard against the timer code getting
      // inverted in a future refactor.
      for (let i = 0; i < ttftSamples.length; i++) {
        expect(ttftSamples[i]).toBeLessThanOrEqual(totalSamples[i] ?? Number.POSITIVE_INFINITY)
      }
    }, 120_000)
  }
})
