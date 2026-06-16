/**
 * Tests for {@link Agent.streamRun} — the streaming version of the
 * agent loop. Verifies event ordering, partial text accumulation, and
 * the multi-step text → tool → text flow.
 */
import { describe, expect, it, vi } from 'vitest'
import { Agent } from '../src/agent/index.js'
import { ToolRegistry } from '../src/tools/index.js'
import { BaseProvider } from '../src/message/provider.js'
import type {
  AssistantMessage,
  ChatRequest,
  ProviderCapabilities,
  StreamEvent,
  StreamOptions,
} from '../src/message/index.js'
import { EchoTool } from './fake-tools.js'

/**
 * A scripted streaming provider. Yields the configured sequence of
 * StreamEvents for the Nth call, then returns.
 */
class ScriptedStreamProvider extends BaseProvider {
  public readonly id = 'scripted-stream'
  public readonly capabilities: ProviderCapabilities = {
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
  private readonly eventsByCall: StreamEvent[][]
  private callIndex = 0

  constructor(eventsByCall: StreamEvent[][]) {
    super()
    this.eventsByCall = eventsByCall
  }

  public override async chat(
    _request: ChatRequest,
  ): Promise<{ message: AssistantMessage; latencyMs: number }> {
    throw new Error('ScriptedStreamProvider does not implement chat() — only stream()')
  }

  public override async *stream(
    request: ChatRequest,
    _options?: StreamOptions,
  ): AsyncGenerator<StreamEvent, void, void> {
    this.calls.push(request)
    const events =
      this.eventsByCall[this.callIndex] ?? this.eventsByCall[this.eventsByCall.length - 1] ?? []
    this.callIndex += 1
    for (const ev of events) {
      yield ev
    }
  }
}

const textOnly = (content: string): StreamEvent[] => [
  { type: 'message_start', message: { role: 'assistant', content: '', toolCalls: [] } },
  { type: 'content_delta', delta: content },
  { type: 'message_complete', message: { role: 'assistant', content, toolCalls: [] } },
]

const textChunked = (chunks: string[]): StreamEvent[] => {
  const full = chunks.join('')
  const events: StreamEvent[] = [
    { type: 'message_start', message: { role: 'assistant', content: '', toolCalls: [] } },
  ]
  for (const c of chunks) events.push({ type: 'content_delta', delta: c })
  events.push({
    type: 'message_complete',
    message: { role: 'assistant', content: full, toolCalls: [] },
  })
  return events
}

const textThenTool = (
  text: string,
  toolCall: { id: string; name: string; arguments: Record<string, unknown> },
): StreamEvent[] => {
  const tc: AssistantMessage['toolCalls'][number] = {
    id: toolCall.id,
    name: toolCall.name,
    arguments: toolCall.arguments,
  }
  return [
    { type: 'message_start', message: { role: 'assistant', content: '', toolCalls: [] } },
    { type: 'content_delta', delta: text },
    { type: 'tool_call_complete', toolCall: tc },
    {
      type: 'message_complete',
      message: { role: 'assistant', content: text, toolCalls: [tc], finishReason: 'tool_calls' },
    },
  ]
}

describe('Agent.streamRun', () => {
  it('emits the canonical event sequence for a single text-only step', async () => {
    const provider = new ScriptedStreamProvider([textOnly('hello back')])
    const agent = new Agent({ provider, tools: new ToolRegistry() })
    const events: string[] = []
    let result
    for await (const ev of agent.streamRun({ userMessage: 'hi' })) {
      events.push(ev.type)
      if (ev.type === 'run:end') result = ev
    }
    expect(events).toEqual([
      'run:start',
      'text:start',
      'text:delta',
      'text:end',
      'step:end',
      'run:end',
    ])
    expect(result).toBeDefined()
  })

  it('accumulates multiple text deltas into one text:end payload', async () => {
    const provider = new ScriptedStreamProvider([textChunked(['Hel', 'lo, ', 'world'])])
    const agent = new Agent({ provider, tools: new ToolRegistry() })
    const collected: string[] = []
    let textEnd = ''
    for await (const ev of agent.streamRun({ userMessage: 'hi' })) {
      if (ev.type === 'text:delta') collected.push(ev.delta)
      if (ev.type === 'text:end') textEnd = ev.content
    }
    expect(collected).toEqual(['Hel', 'lo, ', 'world'])
    expect(textEnd).toBe('Hello, world')
  })

  it('dispatches a tool call between text:start and step:end, then continues', async () => {
    // Step 1: model emits text + tool call
    // Step 2: model emits final text
    const provider = new ScriptedStreamProvider([
      textThenTool('let me check', { id: 'c1', name: 'echo', arguments: { message: 'ping' } }),
      textOnly('all done'),
    ])
    const tools = new ToolRegistry().register(new EchoTool())
    const agent = new Agent({ provider, tools })

    const events: string[] = []
    let finalMessage: AssistantMessage | undefined
    for await (const ev of agent.streamRun({ userMessage: 'go' })) {
      events.push(ev.type)
      if (ev.type === 'run:end') finalMessage = ev.finalMessage
    }

    // The first step must include tool:start and tool:end.
    const firstStepEnd = events.indexOf('step:end')
    expect(events.slice(0, firstStepEnd + 1)).toEqual([
      'run:start',
      'text:start',
      'text:delta',
      'text:end',
      'tool:start',
      'tool:end',
      'step:end',
    ])
    // Then a second step runs.
    expect(events).toContain('run:end')
    expect(finalMessage?.content).toBe('all done')
    // The provider was called twice.
    expect(provider.calls.length).toBe(2)
    // The second call includes a tool result for c1.
    const secondCall = provider.calls[1]!
    const toolMessage = secondCall.messages.find((m) => m.role === 'tool')
    expect(toolMessage).toBeDefined()
    if (toolMessage && toolMessage.role === 'tool') {
      const result = toolMessage.results[0]
      expect(result).toBeDefined()
      expect(result?.isError).toBe(false)
    }
  })

  it('yields an error event when the provider throws, then terminates', async () => {
    const provider = new ScriptedStreamProvider([[]])
    // Override stream to throw on first call.
    const throwing = {
      id: 'throwing',
      capabilities: provider.capabilities,
      calls: [] as ChatRequest[],
      chat: vi.fn(),
      stream: vi.fn(async function* () {
        throw new Error('boom')
      }),
      embed: vi.fn(),
    } as unknown as BaseProvider
    const agent = new Agent({ provider: throwing, tools: new ToolRegistry() })
    const events: string[] = []
    await expect(async () => {
      for await (const ev of agent.streamRun({ userMessage: 'x' })) {
        events.push(ev.type)
      }
    }).rejects.toThrow('boom')
    expect(events).toContain('error')
  })

  it('persists messages to memory when provided', async () => {
    const provider = new ScriptedStreamProvider([textOnly('saved')])
    const memory = {
      id: 'fake',
      init: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      put: vi.fn(),
      get: vi.fn(),
      delete: vi.fn(),
      search: vi.fn(),
      createSession: vi.fn().mockResolvedValue({ id: 's', createdAt: 0, updatedAt: 0 }),
      getSession: vi.fn(),
      listSessions: vi.fn(),
      appendMessage: vi
        .fn()
        .mockResolvedValue({
          id: 1,
          sessionId: 's',
          role: 'assistant',
          content: 'saved',
          createdAt: 0,
        }),
      getSessionMessages: vi.fn(),
      prune: vi.fn(),
    }
    const agent = new Agent({ provider, tools: new ToolRegistry(), memory })
    for await (const _ev of agent.streamRun({ userMessage: 'remember' })) {
      // drain
    }
    expect(memory.createSession).toHaveBeenCalled()
    expect(memory.appendMessage).toHaveBeenCalled()
  })
})
