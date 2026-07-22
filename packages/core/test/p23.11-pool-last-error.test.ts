/**
 * P23.11 — ProviderPool.stream lastError never undefined (fix #24).
 *
 * Pre-P23.11 `lastError` was declared `let lastError: unknown` and
 * was only assigned inside the candidate loop. If a future refactor
 * ever produced a `candidates.length > 0` path where every candidate
 * short-circuited before the `head.done === true` check AND before
 * the `catch (err)` block, `lastError` would reach the throw on
 * line ~431 as `undefined`, and `PoolExhaustedError.attempts[*].error`
 * would carry `undefined`. The fix initialises `lastError` with a
 * synthetic `ProviderError(...)` so the attribution chain never
 * drops the cause.
 *
 * This test asserts the *observable* contract: every entry in
 * `PoolExhaustedError.attempts[*].error` is a real `Error`-shaped
 * value, never `undefined`.
 */

import { describe, expect, it } from 'vitest'

import { PoolExhaustedError, ProviderPool } from '../src/agent/pool.js'
import {
  BaseProvider,
  type ChatRequest,
  type ChatResponse,
  type EmbedRequest,
  type EmbedResponse,
  type ProviderCapabilities,
  ProviderError,
  type StreamEvent,
} from '../src/index.js'

const makeClosedStreamProvider = (id: string): BaseProvider =>
  new (class extends BaseProvider {
    public readonly id = id
    public readonly capabilities: ProviderCapabilities = {
      streaming: true,
      embeddings: false,
      toolUse: false,
      vision: false,
      reasoning: false,
      promptCaching: false,
      structuredOutput: false,
      maxContextTokens: 4096,
    }
    public async chat(_req: ChatRequest): Promise<ChatResponse> {
      throw new Error('chat not used')
    }
    public async embed(_req: EmbedRequest): Promise<EmbedResponse> {
      throw new Error('embed not used')
    }
    // biome-ignore lint/correctness/useYield: closed-stream sentinel
    public async *stream(_req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
      // Closed iterator — no events ever yielded. The pool's
      // `head.done === true` path lands here, which sets
      // `lastError = new ProviderError(...empty stream...)` for
      // each candidate and then continues the loop.
      return
    }
  })()

describe('P23.11 — fix #24: ProviderPool.stream lastError never undefined', () => {
  it('PoolExhaustedError.attempts[*].error is always defined (never undefined)', async () => {
    const pool = new ProviderPool({
      strategy: 'capability',
      capability: 'streaming',
      providers: [
        { provider: makeClosedStreamProvider('a'), weight: 1 },
        { provider: makeClosedStreamProvider('b'), weight: 1 },
      ],
    })
    let caught: unknown
    try {
      const iter = pool.stream({ messages: [], model: 'm' })
      for await (const _ev of iter) {
        // Drain so the pool actually exercises the failover loop.
        void _ev
      }
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(PoolExhaustedError)
    // biome-ignore lint/suspicious/noExplicitAny: structural shape assertion
    const attempts = (caught as any).attempts as ReadonlyArray<{
      providerId: string
      error: unknown
    }>
    expect(attempts.length).toBe(2)
    for (const a of attempts) {
      expect(a.error).not.toBeUndefined()
      expect(a.error).not.toBeNull()
      // Pre-P23.11 the entries could be the literal `undefined`;
      // P23.11 sets a default ProviderError on the variable so
      // even if a future path forgets to assign, this assertion
      // still passes.
      expect(a.error).toBeInstanceOf(ProviderError)
    }
  })
})
