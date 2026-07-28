/**
 * P30.A4 — `AgentRunOptions.toolRetry` wire-up to the dispatch path.
 *
 * Pre-P30.A4 `callToolWithRetry` was a helper function with a
 * P23.11 unit-test surface, but the main `Agent.dispatchToolCall`
 * path always ran the tool exactly once. The `AgentRunOptions.toolRetry`
 * field added in P30.A4 threads the caller's `RetryConfig` through
 * `executeLoop` → `callToolWithMiddleware` → `dispatchToolCall` so
 * the helper is now the default for callers that opt in.
 *
 * These tests cover:
 *   - `toolRetry: undefined` (default) — the tool runs exactly once,
 *     matching the pre-P30.A4 behaviour.
 *   - `toolRetry: { maxAttempts: 3 }` — a transient tool failure is
 *     retried, eventually succeeds, and the dispatch returns the
 *     success result.
 *   - `toolRetry: { maxAttempts: 3, shouldRetry: () => false }` —
 *     a custom predicate that declines to retry; the tool fails
 *     immediately on the first attempt.
 *   - `toolRetry: { maxAttempts: 3, shouldRetry: includes ToolError }` —
 *     non-default error class is retried; exhaustion after N calls.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { Agent } from '../src/agent/index.js'
import { ProviderError, ToolError } from '../src/errors/index.js'
import { BaseTool, type ToolContext, ToolRegistry } from '../src/tools/index.js'

import { FakeProvider } from './fake-provider.js'

const noSleep = (): Promise<void> => Promise.resolve()
const emptySchema = (): z.ZodType<unknown> => z.object({})

/** Tool that fails the first N times with a retryable ProviderError, then succeeds. */
const makeFlakyTool = (
  failuresBeforeSuccess: number,
  name: string,
): { readonly tool: BaseTool; readonly callCount: () => number } => {
  let calls = 0
  const tool = new (class extends BaseTool {
    public readonly name = name
    public readonly description = `${name} for P30.A4`
    public readonly inputSchema = emptySchema()
    public readonly risk = 'safe' as const
    protected async execute(_input: unknown, _ctx: ToolContext): Promise<unknown> {
      calls += 1
      if (calls <= failuresBeforeSuccess) {
        throw new ProviderError(`${name}: transient ${calls}`, {
          providerId: 'test',
          retryable: true,
        })
      }
      return `${name}: ok`
    }
  })()
  return { tool, callCount: () => calls }
}

/** Tool that always fails with a retryable ProviderError. */
const makeAlwaysFailTool = (
  name: string,
): { readonly tool: BaseTool; readonly callCount: () => number } => {
  let calls = 0
  const tool = new (class extends BaseTool {
    public readonly name = name
    public readonly description = `${name} for P30.A4`
    public readonly inputSchema = emptySchema()
    public readonly risk = 'safe' as const
    protected async execute(_input: unknown, _ctx: ToolContext): Promise<unknown> {
      calls += 1
      throw new ProviderError(`${name}: transient ${calls}`, {
        providerId: 'test',
        retryable: true,
      })
    }
  })()
  return { tool, callCount: () => calls }
}

/** Tool that always fails with a non-ProviderError (ToolError). */
const makeCountedToolErrorTool = (
  name: string,
): { readonly tool: BaseTool; readonly callCount: () => number } => {
  let calls = 0
  const tool = new (class extends BaseTool {
    public readonly name = name
    public readonly description = `${name} for P30.A4`
    public readonly inputSchema = emptySchema()
    public readonly risk = 'safe' as const
    protected async execute(_input: unknown, _ctx: ToolContext): Promise<unknown> {
      calls += 1
      throw new ToolError(`counted: transient ${calls}`)
    }
  })()
  return { tool, callCount: () => calls }
}

describe('P30.A4 — AgentRunOptions.toolRetry threads through to dispatchToolCall', () => {
  it('default (no toolRetry): tool runs exactly once even when the tool throws retryably', async () => {
    const flaky = makeAlwaysFailTool('once-fail')
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'once-fail', arguments: {} }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: 'finished',
          toolCalls: [],
        },
      },
    ])
    const registry = new ToolRegistry()
    registry.register(flaky.tool)
    const agent = new Agent({ provider, tools: registry })
    const result = await agent.run({ userMessage: 'go' })
    expect(flaky.callCount()).toBe(1)
    expect(result.finalMessage.content).toBe('finished')
  })

  it('toolRetry with maxAttempts: 3: flaky tool succeeds after 2 retries', async () => {
    const flaky = makeFlakyTool(2, 'flaky-2')
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'flaky-2', arguments: {} }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: 'done',
          toolCalls: [],
        },
      },
    ])
    const registry = new ToolRegistry()
    registry.register(flaky.tool)
    const agent = new Agent({ provider, tools: registry })
    const result = await agent.run({
      userMessage: 'go',
      toolRetry: {
        maxAttempts: 3,
        sleep: noSleep,
        // BaseTool.call() wraps non-ToolError throws in
        // ToolError (see `src/tools/index.ts:108-110`), so
        // by the time callToolWithRetry sees the throw, it
        // is a ToolError, not the original ProviderError.
        // Include both in the predicate.
        shouldRetry: (err) =>
          err instanceof ToolError || (err instanceof ProviderError && err.retryable === true),
      },
    })
    // 1 initial + 2 retries = 3 calls; the 3rd succeeds.
    expect(flaky.callCount()).toBe(3)
    expect(result.finalMessage.content).toBe('done')
  })

  it('toolRetry with shouldRetry: false skips the retry and reports the error after 1 call', async () => {
    const flaky = makeFlakyTool(2, 'flaky-no-retry')
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'flaky-no-retry', arguments: {} }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: 'finished',
          toolCalls: [],
        },
      },
    ])
    const registry = new ToolRegistry()
    registry.register(flaky.tool)
    const agent = new Agent({ provider, tools: registry })
    await agent.run({
      userMessage: 'go',
      toolRetry: {
        maxAttempts: 3,
        sleep: noSleep,
        shouldRetry: () => false,
      },
    })
    expect(flaky.callCount()).toBe(1)
  })

  it('toolRetry with custom predicate (ToolError included): 3 attempts on a non-ProviderError tool', async () => {
    const flaky = makeCountedToolErrorTool('counted-tool-error')
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-1', name: 'counted-tool-error', arguments: {} }],
        },
      },
      {
        message: {
          role: 'assistant',
          content: 'after-fail',
          toolCalls: [],
        },
      },
    ])
    const registry = new ToolRegistry()
    registry.register(flaky.tool)
    const agent = new Agent({ provider, tools: registry })
    await agent.run({
      userMessage: 'go',
      toolRetry: {
        maxAttempts: 3,
        sleep: noSleep,
        // Default RetryConfig.shouldRetry only retries on
        // ProviderError; we override to also retry on
        // ToolError so the 3 attempts actually happen.
        shouldRetry: (err) =>
          err instanceof ToolError || (err instanceof ProviderError && err.retryable === true),
      },
    })
    expect(flaky.callCount()).toBe(3)
  })
})
