/**
 * Scenario 02: Tool calling end-to-end.
 *
 * The model is told about a single deterministic tool and
 * asked to use it. The test asserts the agent loop:
 *   - emits a tool call (not just a textual answer),
 *   - dispatches the call to the tool,
 *   - feeds the result back into the conversation,
 *   - terminates with a final assistant message that uses
 *     the tool's output.
 *
 * This exercises the most important path in the runtime:
 * the model <-> tool <-> model round-trip. If this breaks
 * on a real provider but the unit tests still pass, the
 * break is in adapter-level mapping (tool-call shape,
 * tool-result shape, message ordering) -- exactly the bugs
 * that fakes are most likely to mask.
 */

import { Agent, BaseTool, ToolRegistry } from '@lumen/core'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { e2eEnabled, getEnabledProviders } from './helpers.js'

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

const shouldRun = e2eEnabled() && getEnabledProviders().length > 0
const providers = getEnabledProviders()
const describeE2E = shouldRun ? describe : describe.skip

describeE2E('scenario 02: tool calling round-trip', () => {
  for (const { id, provider, defaultModel } of providers) {
    it(`[${id}] model calls add(a=2, b=3) and uses the result`, async () => {
      const tools = new ToolRegistry()
      tools.register(new AddTool())

      const agent = new Agent({
        provider,
        tools,
        model: defaultModel,
        systemPrompt:
          'You MUST use the `add` tool whenever the user asks for arithmetic. ' +
          'Do not answer from memory; call the tool and use the result.',
      })

      const result = await agent.run({
        userMessage: 'What is 2 + 3? Use the add tool to compute it.',
      })

      // The model must have called the tool at least once.
      // (We allow more than one call in case the model
      // self-corrects.)
      const toolCalls = result.messages.flatMap((m) => (m.role === 'assistant' ? m.toolCalls : []))
      expect(toolCalls.length).toBeGreaterThanOrEqual(1)
      expect(toolCalls.some((c) => c.name === 'add')).toBe(true)

      // The final message must reference the result (5).
      const content = result.finalMessage.content ?? ''
      expect(content).toMatch(/\b5\b/)

      // And the loop must have produced tool result messages
      // back to the model, proving the dispatch path worked.
      const toolResults = result.messages.filter((m) => m.role === 'tool')
      expect(toolResults.length).toBeGreaterThanOrEqual(1)
    }, 60_000)
  }
})
