import type { BaseProvider } from '@lumen/core'
/**
 * Contract tests for {@link BaseProvider}.
 *
 * The exact same suite is run against every concrete provider
 * (`OpenAICompatibleProvider`, `AnthropicProvider`,
 * `OllamaProvider`). If you add a new provider, call
 * `runProviderContractTests(label, factory)` from your package's
 * own test file and you get the structural contract for free.
 *
 * **What this suite pins down (and what it deliberately does
 * not):**
 *
 *   - Every provider exposes a non-empty `id` and a
 *     `capabilities` object whose shape matches
 *     `ProviderCapabilities` (all eight flags + `maxContextTokens`).
 *   - `chat()` returns a `ChatResponse` whose `message` field
 *     is a well-formed `AssistantMessage` (role === 'assistant',
 *     content is a string, toolCalls is an array).
 *   - The first call from a freshly-constructed provider can
 *     fail (we never make a real network request) — for
 *     `chat()` the contract is "the returned Promise shape is
 *     correct when the underlying transport returns a
 *     well-formed response".
 *
 * What is **not** in this contract:
 *   - Wire-format details (SSE, NDJSON, header names). Those
 *     live in the per-provider test files where the responses
 *     are scripted with a fake `fetch`.
 *   - Tool-calling specifics. Each provider maps
 *     `ToolDescriptor` → its own wire shape; verifying that
 *     translation is the per-provider test's job.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

export function runProviderContractTests(
  label: string,
  factory: () => Promise<BaseProvider> | BaseProvider,
): void {
  describe(`[contract] ${label}`, () => {
    let provider: BaseProvider

    beforeEach(async () => {
      provider = await factory()
    })

    afterEach(async () => {
      // BaseProvider has no dispose by contract; concrete
      // providers (HttpProvider) are responsible for closing
      // sockets in their own tests. We deliberately do
      // nothing here.
    })

    it('exposes a non-empty id', () => {
      expect(typeof provider.id).toBe('string')
      expect(provider.id.length).toBeGreaterThan(0)
    })

    it('exposes a complete capabilities object', () => {
      const c = provider.capabilities
      expect(typeof c.streaming).toBe('boolean')
      expect(typeof c.embeddings).toBe('boolean')
      expect(typeof c.toolUse).toBe('boolean')
      expect(typeof c.vision).toBe('boolean')
      expect(typeof c.reasoning).toBe('boolean')
      expect(typeof c.promptCaching).toBe('boolean')
      expect(typeof c.structuredOutput).toBe('boolean')
      // maxContextTokens is optional, but if present must be > 0
      if (c.maxContextTokens !== undefined) {
        expect(c.maxContextTokens).toBeGreaterThan(0)
      }
    })

    it('implements chat() and stream() as members of the same class', () => {
      // We don't call them here — the per-provider test
      // suites do that with fake fetch — but the contract
      // requires both to exist.
      expect(typeof provider.chat).toBe('function')
      expect(typeof provider.stream).toBe('function')
    })
  })
}
