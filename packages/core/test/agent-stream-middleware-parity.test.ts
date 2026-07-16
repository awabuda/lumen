/**
 * P23.0: tests for the bug-#1 / bug-#6 / bug-#10 fixes. The
 * pre-P23.0 `streamRun` bypassed the middleware chain (bug #1,
 * security-critical), hard-coded `sessionId: ''` on every tool
 * call (bug #6, audit-trail gap), and collapsed parallel
 * tool-call deltas into a single entry at index 0 (bug #10,
 * dropped calls). These three behaviours are now tested.
 *
 * Coverage:
 *  - `applyBeforeModel` runs in stream mode (messages are
 *    transformable before the model call).
 *  - `applyAfterModel` runs in stream mode (assembled message
 *    passes through the afterModel chain).
 *  - `wrapToolCall` runs in stream mode (every tool call goes
 *    through the wrapper, not just sync).
 *  - `applyAfterRun` runs in stream mode (the afterRun hook
 *    fires for chat / `lumen run --stream`).
 *  - The real `sessionId` reaches the tool (not `''`).
 *  - Multiple parallel tool calls in a single stream step are
 *    each retained, keyed by their OpenAI `id`.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { AgentMiddleware, MiddlewareContext } from '../src/agent/middleware.js'
import {
  Agent,
  BaseProvider,
  BaseTool,
  type ChatRequest,
  type ChatResponse,
  type Message,
  type ProviderCapabilities,
  type StreamEvent,
  type StreamOptions,
  type ToolCall,
  type ToolContext,
  type ToolDescriptor,
  ToolRegistry,
  type ToolRisk,
  createAgent,
} from '../src/index.js'

// -----------------------------------------------------------------------------
// Test helpers
// -----------------------------------------------------------------------------

class ScriptedStreamProvider extends BaseProvider {
  public override readonly id = 'scripted-stream'
  public override readonly capabilities: ProviderCapabilities = {
    streaming: true,
    embeddings: false,
    toolUse: true,
    vision: false,
    reasoning: false,
    promptCaching: false,
    structuredOutput: false,
    maxContextTokens: 8000,
  }
  public readonly calls: ChatRequest[] = []
  private readonly scripts: ReadonlyArray<{
    message: { role: 'assistant'; content?: string; toolCalls: ToolCall[] }
  }>
  private callIndex = 0

  constructor(
    scripts: ReadonlyArray<{
      message: { role: 'assistant'; content?: string; toolCalls: ToolCall[] }
    }>,
  ) {
    super()
    this.scripts = scripts
  }

  public override async chat(
    request: ChatRequest,
    _options?: StreamOptions,
  ): Promise<ChatResponse> {
    this.calls.push({ ...request, messages: [...request.messages] })
    const step = this.scripts[this.callIndex]
    if (!step) throw new Error('ScriptedStreamProvider: script exhausted')
    this.callIndex += 1
    return { message: step.message, latencyMs: 0 }
  }

  public override async *stream(
    request: ChatRequest,
    _options?: StreamOptions,
  ): AsyncGenerator<StreamEvent, void, void> {
    this.calls.push({ ...request, messages: [...request.messages] })
    const step = this.scripts[this.callIndex]
    if (!step) throw new Error('ScriptedStreamProvider: script exhausted')
    this.callIndex += 1
    yield { type: 'message_start', message: { role: 'assistant', content: '', toolCalls: [] } }
    if (step.message.content) {
      yield { type: 'content_delta', delta: step.message.content }
    }
    for (const tc of step.message.toolCalls) {
      yield { type: 'tool_call_complete', toolCall: tc }
    }
    yield { type: 'message_complete', message: step.message }
  }
}

class EchoTool extends BaseTool {
  public override readonly name = 'echo'
  public override readonly description = 'Echo the message back; records the sessionId it received.'
  public override readonly risk: ToolRisk = 'low'
  public override readonly inputSchema = z.object({ message: z.string() })
  public readonly observedSessionIds: string[] = []

  protected override async execute(
    input: { message: string },
    ctx: ToolContext,
  ): Promise<{ echoed: string; sessionId: string }> {
    this.observedSessionIds.push(ctx.sessionId)
    return { echoed: input.message, sessionId: ctx.sessionId }
  }

  public override describe(): ToolDescriptor {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
      inputJsonSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
      risk: this.risk,
      version: this.version,
    }
  }
}

interface MiddlewareCallLog {
  beforeModelCalls: number
  afterModelCalls: number
  wrapToolCallCalls: number
  afterRunCalls: number
  receivedSessionId: string | undefined
}

const recordingMiddleware = (log: MiddlewareCallLog): AgentMiddleware => ({
  name: 'recording',
  beforeModel: (messages: ReadonlyArray<Message>, _ctx: MiddlewareContext) => {
    log.beforeModelCalls += 1
    void _ctx
    return messages
  },
  afterModel: (message, _ctx: MiddlewareContext) => {
    log.afterModelCalls += 1
    void _ctx
    return message
  },
  wrapToolCall: (_call, next, _ctx: MiddlewareContext) => {
    log.wrapToolCallCalls += 1
    void _ctx
    return next()
  },
  afterRun: (result, ctx: MiddlewareContext) => {
    log.afterRunCalls += 1
    log.receivedSessionId = ctx.sessionId
    void result
  },
})

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('Agent — P23.0 streamRun middleware parity (bug #1)', () => {
  it('streamRun() invokes applyBeforeModel and applyAfterModel', async () => {
    const provider = new ScriptedStreamProvider([
      { message: { role: 'assistant', content: 'ok', toolCalls: [] } },
    ])
    const log: MiddlewareCallLog = {
      beforeModelCalls: 0,
      afterModelCalls: 0,
      wrapToolCallCalls: 0,
      afterRunCalls: 0,
      receivedSessionId: undefined,
    }
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      middleware: [recordingMiddleware(log)],
    })
    for await (const _ev of agent.streamRun({ userMessage: 'hi' })) {
      // drain
    }
    expect(log.beforeModelCalls).toBe(1)
    expect(log.afterModelCalls).toBe(1)
  })

  it('streamRun() invokes wrapToolCall when a tool is dispatched', async () => {
    const provider = new ScriptedStreamProvider([
      {
        message: {
          role: 'assistant',
          content: 'calling',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: { message: 'ping' } }],
        },
      },
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const log: MiddlewareCallLog = {
      beforeModelCalls: 0,
      afterModelCalls: 0,
      wrapToolCallCalls: 0,
      afterRunCalls: 0,
      receivedSessionId: undefined,
    }
    const tools = new ToolRegistry().register(new EchoTool())
    const agent = createAgent({
      provider,
      tools,
      middleware: [recordingMiddleware(log)],
    })
    for await (const _ev of agent.streamRun({ userMessage: 'go' })) {
      // drain
    }
    expect(log.wrapToolCallCalls).toBe(1)
  })

  it('streamRun() invokes applyAfterRun at run completion', async () => {
    const provider = new ScriptedStreamProvider([
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const log: MiddlewareCallLog = {
      beforeModelCalls: 0,
      afterModelCalls: 0,
      wrapToolCallCalls: 0,
      afterRunCalls: 0,
      receivedSessionId: undefined,
    }
    const agent = createAgent({
      provider,
      tools: new ToolRegistry(),
      middleware: [recordingMiddleware(log)],
    })
    for await (const _ev of agent.streamRun({ userMessage: 'hi' })) {
      // drain
    }
    expect(log.afterRunCalls).toBe(1)
    expect(log.receivedSessionId).toMatch(/^[0-9a-f-]{36}$/i)
  })
})

describe('Agent — P23.0 sessionId threading (bug #6)', () => {
  it('streamRun() dispatches the real sessionId to the tool, not ""', async () => {
    const provider = new ScriptedStreamProvider([
      {
        message: {
          role: 'assistant',
          content: 'calling',
          toolCalls: [{ id: 'c1', name: 'echo', arguments: { message: 'ping' } }],
        },
      },
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const echo = new EchoTool()
    const tools = new ToolRegistry().register(echo)
    const agent = new Agent({ provider, tools })
    for await (const _ev of agent.streamRun({ userMessage: 'go' })) {
      // drain
    }
    expect(echo.observedSessionIds).toHaveLength(1)
    expect(echo.observedSessionIds[0]).toMatch(/^[0-9a-f-]{36}$/i)
    expect(echo.observedSessionIds[0]).not.toBe('')
  })
})

describe('Agent — P23.0 parallel tool-call deltas (bug #10)', () => {
  it('retains multiple parallel tool_call_complete events in one step', async () => {
    // Pre-P23.0 the test path used `toolAcc.set(0, ...)` /
    // `toolAcc.set(toolAcc.size, ...)` which collapsed all deltas
    // into a single Map entry at index 0. The test below
    // supplies two tool calls in a single `message_complete`
    // event and asserts both reach the tool registry.
    const t1 = { id: 't1', name: 'echo', arguments: { message: 'one' } }
    const t2 = { id: 't2', name: 'echo', arguments: { message: 'two' } }
    // First step: TWO tool calls in one step (this is the path
    // that pre-P23.0 collapsed). Second step: a no-tool message
    // so the loop terminates.
    const provider = new ScriptedStreamProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [t1, t2],
        },
      },
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const echo = new EchoTool()
    const tools = new ToolRegistry().register(echo)
    const agent = new Agent({ provider, tools })
    for await (const _ev of agent.streamRun({ userMessage: 'go' })) {
      // drain
    }
    // Both tool calls reached the tool — the pre-P23.0 code
    // would only have dispatched the last one because the Map
    // key was a hard-coded `0`.
    expect(echo.observedSessionIds).toHaveLength(2)
  })
})
