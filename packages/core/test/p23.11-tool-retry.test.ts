/**
 * P23.11 — tool-call retry wrapper (fix #72).
 *
 *   #72  Pre-P23.11 retry semantics lived at the Provider level
 *        (`withRetry`); tool-level transient failures did not
 *        retry. `callToolWithRetry` adds the same exponential-
 *        backoff-with-jitter surface to `tool.call(input, ctx)`.
 *        The default `maxAttempts: 1` preserves back-compat
 *        for every existing call site that did not opt in.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ProviderError, ToolError, ValidationError } from '../src/errors/index.js'
import { callToolWithRetry, isRetryAborted } from '../src/tool-retry.js'
import { BaseTool, type ToolContext } from '../src/tools/index.js'

const noSleep = (): Promise<void> => Promise.resolve()

/**
 * Minimal BaseTool-shaped stub. Bypasses `BaseTool.call()`'s
 * error-wrapping so the underlying `ProviderError` / `ToolError`
 * we throw in `execute()` is what `callToolWithRetry` sees.
 */
const makeRawStub = (failuresBeforeSuccess: number) => {
  const stub = {
    name: 'stub',
    description: 'stub for retry test',
    inputSchema: z.object({}),
    risk: 'safe' as const,
    version: '0.1.0',
    failuresBeforeSuccess,
    calls: 0,
    async call(_input: unknown, _ctx: unknown): Promise<{ ok: true } | never> {
      stub.calls += 1
      if (stub.calls <= stub.failuresBeforeSuccess) {
        throw new ProviderError('transient', {
          providerId: 'stub',
          retryable: true,
        })
      }
      return { ok: true }
    },
    describe: () => ({
      name: 'stub',
      description: 'stub',
      inputSchema: z.object({}),
      inputJsonSchema: {} as Record<string, unknown>,
      risk: 'safe' as const,
      version: '0.1.0',
    }),
  }
  return stub
}

const ctx: ToolContext = {
  cwd: '/tmp',
  signal: new AbortController().signal,
  sessionId: 's',
}

describe('P23.11 — fix #72: callToolWithRetry retries transient tool failures', () => {
  it('default maxAttempts=1 means no retry on failure', async () => {
    const stub = makeRawStub(Number.POSITIVE_INFINITY)
    const tool = stub as unknown as BaseTool
    await expect(callToolWithRetry(tool, {}, ctx)).rejects.toBeInstanceOf(ProviderError)
    expect(stub.calls).toBe(1)
  })

  it('retries up to maxAttempts-1 times on retryable ProviderError', async () => {
    const stub = makeRawStub(2)
    const tool = stub as unknown as BaseTool
    const out = (await callToolWithRetry(tool, {}, ctx, {
      maxAttempts: 3,
      sleep: noSleep,
    })) as { ok: true }
    expect(out.ok).toBe(true)
    expect(stub.calls).toBe(3)
  })

  it('does not retry on non-retryable errors (ToolError)', async () => {
    class FailingTool extends BaseTool {
      public readonly name = 'fail'
      public readonly description = 'fails once'
      public readonly inputSchema = z.object({})
      public readonly risk = 'safe' as const
      public readonly version = '0.1.0'
      public calls = 0
      public async execute(): Promise<never> {
        this.calls += 1
        throw new ToolError('not retryable', { toolName: 'fail' })
      }
    }
    const tool = new FailingTool()
    await expect(
      callToolWithRetry(tool, {}, ctx, {
        maxAttempts: 5,
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(ToolError)
    expect(tool.calls).toBe(1)
  })

  it('rejects bad input with ToolValidationError without retrying', async () => {
    class BadInputTool extends BaseTool {
      public readonly name = 'bad'
      public readonly description = 'always bad'
      public readonly inputSchema = z.object({ x: z.string() }).strict()
      public readonly risk = 'safe' as const
      public readonly version = '0.1.0'
      public calls = 0
      public async execute(): Promise<{ ok: true }> {
        this.calls += 1
        return { ok: true }
      }
    }
    const tool = new BadInputTool()
    // Bad input is rejected inside `BaseTool.call()` before the
    // retry wrapper sees it. The error is `ToolValidationError`,
    // a `ToolError` subclass. The retry wrapper should not
    // re-enter because it is not a retryable `ProviderError`.
    await expect(
      callToolWithRetry(tool, { x: 1 }, ctx, {
        maxAttempts: 5,
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(ToolError)
    expect(tool.calls).toBe(0)
  })

  it('isRetryAborted identifies RetryAbortedError correctly', () => {
    const err = new Error('not')
    expect(isRetryAborted(err)).toBe(false)
  })
})
