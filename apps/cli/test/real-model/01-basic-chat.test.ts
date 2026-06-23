/**
 * Scenario 01: Basic chat round-trip.
 *
 * The simplest possible real-model exercise: send a single user
 * message, get a single assistant message back. No tools, no
 * memory, no streaming. This is the canary for "the wiring still
 * works end-to-end" -- if this fails, the agent loop or the
 * provider adapter has regressed in a way the unit tests
 * didn't catch.
 *
 * Runs once per configured provider (see helpers.ts for the
 * LUMEN_E2E_* env-var contract). When no provider is
 * configured, the entire scenario is skipped.
 */

import { Agent, ToolRegistry } from '@lumen/core'
import { describe, expect, it } from 'vitest'
import { e2eEnabled, getEnabledProviders } from './helpers.js'

const shouldRun = e2eEnabled() && getEnabledProviders().length > 0
const providers = getEnabledProviders()

// `describe.skip` is the same export as `describe` with the
// skip flag baked in; the ternary lets us hard-skip the entire
// scenario when LUMEN_E2E is disabled or no provider is set up,
// without relying on a thrown sentinel that vitest would
// misclassify as a failure.
const describeE2E = shouldRun ? describe : describe.skip

describeE2E('scenario 01: basic chat round-trip', () => {
  for (const { id, provider, defaultModel } of providers) {
    it(`[${id}] returns a non-empty assistant message`, async () => {
      const agent = new Agent({
        provider,
        tools: new ToolRegistry(),
        model: defaultModel,
        systemPrompt: 'You are a precise assistant. Answer in one short sentence.',
      })

      const result = await agent.run({
        userMessage: 'What is 2 + 2?',
      })

      expect(result.iterations).toBeGreaterThanOrEqual(1)
      expect(result.finalMessage.role).toBe('assistant')
      // `content` is optional; an empty reply (rare) is still a
      // valid assistant message. We only fail if the loop
      // terminated without ever producing a final message.
      const content = result.finalMessage.content ?? ''
      expect(content.length).toBeGreaterThan(0)
      // The model should mention "4" somewhere in its reply.
      // Case-insensitive substring check tolerates "four" if the
      // model chooses to spell it out.
      const text = content.toLowerCase()
      expect(text).toMatch(/\b4\b|four/)
    }, 30_000)
  }
})
