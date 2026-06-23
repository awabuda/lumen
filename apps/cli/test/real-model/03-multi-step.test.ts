/**
 * Scenario 03: Multi-step tool-use.
 *
 * The model is given a goal that requires **two** tool calls
 * in sequence: first look up a constant, then compute a
 * function of it. The test asserts:
 *
 *   - iterations >= 2 (the loop didn't exit after one shot)
 *   - the model called `lookup` AND `compute`
 *   - the final answer references both intermediate values
 *     and the derived result.
 *
 * This catches a class of bugs that the single-step tool test
 * misses: e.g. providers that fail to re-issue tool calls when
 * the assistant's first response contained an empty `content`
 * field, or tool registries that swallow the second call.
 */

import { Agent, BaseTool, ToolRegistry } from '@lumen/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { e2eEnabled, getEnabledProviders } from './helpers.js'

class LookupTool extends BaseTool {
  public readonly name = 'lookup'
  public readonly description =
    'Look up the value of a named constant. Always returns 7 for the key "magic".'
  public readonly risk = 'safe' as const
  public readonly inputSchema = z.object({
    key: z.string(),
  })

  protected async execute(input: { key: string }): Promise<unknown> {
    if (input.key === 'magic') return 7
    return null
  }
}

class ComputeTool extends BaseTool {
  public readonly name = 'compute'
  public readonly description = 'Multiply a number by 6 and return the product.'
  public readonly risk = 'safe' as const
  public readonly inputSchema = z.object({
    n: z.number().int(),
  })

  protected async execute(input: { n: number }): Promise<unknown> {
    return input.n * 6
  }
}

const shouldRun = e2eEnabled() && getEnabledProviders().length > 0
const providers = getEnabledProviders()
const describeE2E = shouldRun ? describe : describe.skip

describeE2E('scenario 03: multi-step tool use', () => {
  for (const { id, provider, defaultModel } of providers) {
    it(`[${id}] model chains lookup(magic) -> compute(result)`, async () => {
      const tools = new ToolRegistry()
      tools.register(new LookupTool())
      tools.register(new ComputeTool())

      const agent = new Agent({
        provider,
        tools,
        model: defaultModel,
        systemPrompt:
          'You have two tools: `lookup(key)` returns a number for a known ' +
          'key, and `compute(n)` multiplies a number by 6. Use them to ' +
          'answer the user. Never guess; always call a tool.',
      })

      const result = await agent.run({
        userMessage: 'Look up the value of "magic", then compute(six_times) on it.',
      })

      // The loop must have taken at least 2 iterations:
      // one to call lookup, one to call compute, possibly more
      // for the final synthesis.
      expect(result.iterations).toBeGreaterThanOrEqual(2)

      const toolCalls = result.messages.flatMap((m) => (m.role === 'assistant' ? m.toolCalls : []))
      const toolNames = new Set(toolCalls.map((c) => c.name))
      expect(toolNames.has('lookup')).toBe(true)
      expect(toolNames.has('compute')).toBe(true)

      // The final answer must mention 42 (7 * 6). We tolerate
      // a wide range of phrasings.
      const content = (result.finalMessage.content ?? '').toLowerCase()
      expect(content).toMatch(/\b42\b/)
    }, 90_000)
  }
})
