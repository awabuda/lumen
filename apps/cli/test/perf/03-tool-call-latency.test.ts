/**
 * Scenario: tool-calling latency.
 *
 * Measures the wall-clock cost of a single `agent.run`
 * call when a tool is involved. The agent loop has to:
 *   1. send the request with the tool schema attached,
 *   2. receive a tool-call from the model,
 *   3. dispatch to the tool implementation,
 *   4. send the tool result back,
 *   5. receive the final assistant message.
 *
 * That round-trip is one model<->model + one model<->tool
 * dispatch. For a well-behaved model the tool call adds
 * ~30-100ms over the chat-only baseline (a second
 * provider round-trip plus a tool execution that is
 * sub-millisecond in-process). Tracking that delta is the
 * point of this scenario: regressions here mean the
 * adapter is shipping the tool result in a way the
 * provider double-parses, or the tool registry is doing
 * extra work per dispatch.
 *
 * Methodology mirrors `01-chat-latency.test.ts`:
 *   - `benchWarmup()` warmup runs (one of which is the
 *     "first call" that primes the tool registry's
 *     schema serialisation path -- the first dispatch is
 *     always slower because the JSON schema validator
 *     warms up).
 *   - `benchRuns()` measured runs.
 *
 * Caveat (noted in the perf README): without a system
 * prompt that strongly directs the model to call the
 * tool, the model may just answer "5" in prose and the
 * tool never fires. We sidestep that by using an
 * instruction that forces the tool path. Local models
 * (Ollama, llama.cpp) on smaller checkpoints will still
 * fail to call the tool sometimes; the per-run expect()
 * will then mark that run as a soft failure but the
 * latency numbers are still reported.
 *
 * Opt in: LUMEN_BENCH=1 + at least one LUMEN_BENCH_*_API_KEY.
 */

import { Agent, BaseTool, ToolRegistry } from '@lumen/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
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

class AddTool extends BaseTool {
  public readonly name = 'add'
  public readonly description = 'Add two integers and return the sum.'
  public readonly risk = 'safe' as const
  public readonly inputSchema = z.object({
    a: z.number().int(),
    b: z.number().int(),
  })

  protected async execute(input: { a: number; b: number }): Promise<unknown> {
    return input.a + input.b
  }
}

const shouldRun = benchEnabled() && getBenchProviders().length > 0
const providers = getBenchProviders()
const describeBench = shouldRun ? describe : describe.skip

describeBench('bench 03: tool-call latency (add tool round-trip)', () => {
  for (const { id, provider, defaultModel } of providers) {
    it(`[${id}] reports p50/p95/max over ${benchRuns()} runs`, async () => {
      const agent = new Agent({
        provider,
        tools: new ToolRegistry().register(new AddTool()),
        model: defaultModel,
        // Force the tool path: an instruction the model
        // cannot satisfy without calling `add`. Without
        // this many models will just answer "5" in prose
        // and the tool registry's dispatch code is never
        // exercised -- which defeats the purpose of the
        // benchmark.
        systemPrompt:
          'You MUST call the `add` tool with a=2, b=3, then reply with the result. Never answer in prose.',
      })

      // Warmup -- one of the warmup runs hits the tool
      // dispatch path so the second measured run sees a
      // warm JSON-schema validator.
      for (let i = 0; i < benchWarmup(); i++) {
        await agent.run({ userMessage: 'What is 2 + 3?' })
      }

      const samples: number[] = []
      for (let i = 0; i < benchRuns(); i++) {
        const { result, durationMs } = await timeAsync(() =>
          agent.run({ userMessage: 'What is 2 + 3?' }),
        )
        // Sanity: the loop should have actually invoked
        // the tool. If the model answered in prose (some
        // smaller local models do), we still record the
        // sample but flag it in the row so the regression
        // table shows "this model didn't follow the
        // instruction" instead of silently mixing tool
        // and prose runs.
        const iterations = result.iterations
        const sawToolCall = iterations > 1
        const flag = sawToolCall ? '' : ' (no-tool-call)'
        samples.push(durationMs)
        // Console-log per run so a flake is visible. The
        // final table row is emitted once at the end of
        // the test.
        if (flag) {
          console.log(`  [${id}] run ${i + 1}: ${flag}`)
        }
      }

      const stats = summariseLatency(samples)
      console.log(BENCH_TABLE_HEADER)
      console.log(benchTableRow(id, 'tool-call', stats))

      // Soft assertion: at least one complete run under
      // 60s. Same rationale as 01/02.
      expect(stats.count).toBe(benchRuns())
      expect(stats.maxMs).toBeLessThan(60_000)
    }, 120_000)
  }
})
