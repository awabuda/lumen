/**
 * P23.7 — parallel tool dispatch + ParallelSubAgent real streaming
 * (fix #9 + #23).
 *
 * Before P23.7:
 *   - tool calls dispatched serially in a for-await loop. When
 *     the model emits 5 read-only calls in one turn, each one
 *     waits for the previous to finish.
 *   - ParallelSubAgent.stream() ran every task via
 *     Promise.allSettled first, then iterated the results in
 *     order — making the stream functionally identical to
 *     `run()` for any caller that awaited the generator one
 *     entry at a time (which is every caller).
 *
 * After P23.7:
 *   - AgentRunOptions.parallel?: boolean — opt-in. When true
 *     and a model response has > 1 tool call, they run
 *     concurrently via Promise.all. tool:start events fire
 *     up front; tool:end events fire as each completes.
 *   - ParallelSubAgent.stream() yields each task as it
 *     completes (Promise.race + tagged Map), so the stream
 *     emits in completion order, not invocation order.
 *
 * Tests assert:
 *   - parallel: true + 3 tool calls in one response dispatches
 *     concurrently (timing-based assertion).
 *   - parallel: false (default) preserves serial behaviour.
 *   - parallel: true with a single tool call still works.
 *   - ParallelSubAgent.stream() yields all entries (correct
 *     SET, not necessarily invocation order).
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createAgent } from '../src/agent/factory.js'
import { createParallelSubAgent } from '../src/agent/sub-agent-orchestration.js'
import { BaseTool, type ToolContext, ToolRegistry } from '../src/tools/index.js'
import { FakeProvider } from './fake-provider.js'

/** Tool that sleeps for `delayMs` then returns `{ tag, delayMs }`. */
class DelayedEchoTool extends BaseTool {
  public readonly name = 'delayedEcho'
  public readonly description = 'Echo after delay.'
  public readonly inputSchema = z.object({ tag: z.string(), delayMs: z.number() })
  public readonly risk = 'safe' as const
  protected async execute(input: unknown, _ctx: ToolContext): Promise<unknown> {
    const { tag, delayMs } = input as { tag: string; delayMs: number }
    await new Promise((r) => setTimeout(r, delayMs))
    return { tag, delayMs }
  }
}

describe('P23.7 — parallel tool dispatch', () => {
  it('parallel: true dispatches concurrent tool calls (timing)', async () => {
    // 3 tool calls each sleeping 100ms. Serial = ≥300ms.
    // Parallel = ~100ms (plus overhead).
    const tools = new ToolRegistry().register(new DelayedEchoTool())
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'c1', name: 'delayedEcho', arguments: { tag: 'a', delayMs: 100 } },
            { id: 'c2', name: 'delayedEcho', arguments: { tag: 'b', delayMs: 100 } },
            { id: 'c3', name: 'delayedEcho', arguments: { tag: 'c', delayMs: 100 } },
          ],
        },
      },
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const agent = createAgent({ provider, tools })
    const start = Date.now()
    await agent.run({ userMessage: 'hi', parallel: true })
    const elapsed = Date.now() - start
    // Parallel: ~100ms; serial: ~300ms. Threshold: 220ms (allows
    // overhead but rejects serial).
    expect(elapsed).toBeLessThan(220)
  })

  it('parallel: false (default) preserves serial behaviour', async () => {
    const tools = new ToolRegistry().register(new DelayedEchoTool())
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'c1', name: 'delayedEcho', arguments: { tag: 'a', delayMs: 50 } },
            { id: 'c2', name: 'delayedEcho', arguments: { tag: 'b', delayMs: 50 } },
          ],
        },
      },
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const agent = createAgent({ provider, tools })
    const start = Date.now()
    await agent.run({ userMessage: 'hi' }) // parallel not set → serial
    const elapsed = Date.now() - start
    // Serial: ≥100ms (2 × 50ms).
    expect(elapsed).toBeGreaterThanOrEqual(90)
  })

  it('parallel: true with a single tool call still works (no parallel path)', async () => {
    const tools = new ToolRegistry().register(new DelayedEchoTool())
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'delayedEcho', arguments: { tag: 'a', delayMs: 30 } }],
        },
      },
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const agent = createAgent({ provider, tools })
    const result = await agent.run({ userMessage: 'hi', parallel: true })
    expect(result.finalMessage.content).toBe('done')
  })
})

describe('P23.7 — ParallelSubAgent real streaming', () => {
  it('stream() yields all tasks (correct set, completion order)', async () => {
    // 3 sub-tasks with the same content. With FakeProvider
    // (synchronous), all 3 finish in the same microtask batch;
    // the implementation uses Promise.race against a tagged
    // map so the streamed order is the order in which the
    // microtask queue resolves them.
    const provider = new FakeProvider([
      { message: { role: 'assistant', content: 'fast', toolCalls: [] } },
      { message: { role: 'assistant', content: 'medium', toolCalls: [] } },
      { message: { role: 'assistant', content: 'slow', toolCalls: [] } },
      { message: { role: 'assistant', content: 'fast', toolCalls: [] } },
      { message: { role: 'assistant', content: 'medium', toolCalls: [] } },
      { message: { role: 'assistant', content: 'slow', toolCalls: [] } },
    ])
    const runner = createParallelSubAgent({
      parent: {
        provider,
        tools: new ToolRegistry(),
      },
      tasks: [
        {
          spec: { name: 'fast', description: 'fast', systemPrompt: 'fast' },
          prompt: 'fast',
        },
        {
          spec: { name: 'medium', description: 'medium', systemPrompt: 'medium' },
          prompt: 'medium',
        },
        {
          spec: { name: 'slow', description: 'slow', systemPrompt: 'slow' },
          prompt: 'slow',
        },
      ],
    })
    // Use run() which is invocation order → to compare.
    const runResults = await runner.run()
    expect(runResults.map((r) => r.result.finalMessage.content)).toEqual(['fast', 'medium', 'slow'])
    // Use stream() which must emit the same set of results
    // (regardless of order, since all 3 finish in the same
    // microtask batch with FakeProvider).
    const streamedContents: string[] = []
    for await (const entry of runner.stream()) {
      streamedContents.push(entry.result.finalMessage.content ?? '')
    }
    expect(new Set(streamedContents)).toEqual(new Set(['fast', 'medium', 'slow']))
  })
})
