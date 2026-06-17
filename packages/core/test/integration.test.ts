/**
 * End-to-end integration test for the agent loop.
 *
 * This test stitches the real pieces of the Lumen runtime together —
 * a scripted fake provider, the real `Agent` class, a real
 * `ToolRegistry` with a few `BaseTool` subclasses, a real
 * `InMemoryStore` (via the `FakeMemoryStore` test helper), and the
 * real `HookRegistry` — and runs `agent.run()` end-to-end.
 *
 * The goal is to assert cross-component behavior: tools get
 * dispatched, results feed back into the conversation, messages
 * persist, hooks fire in order, and the loop terminates correctly.
 *
 * If this test fails, something the unit tests didn't catch broke
 * the wire-up between layers. It's the single canary for "the MVP
 * still works".
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  Agent,
  type AssistantMessage,
  BaseTool,
  type HookEvent,
  HookRegistry,
  type RunEvent,
  type ToolContext,
  type ToolDescriptor,
  ToolRegistry,
  type ToolRisk,
} from '../src/index.js'
import { FakeMemoryStore } from './fake-memory.js'
import { FakeProvider, type ScriptedStep } from './fake-provider.js'
import { EchoTool } from './fake-tools.js'

// ---------------------------------------------------------------------------
// Test fixture tools
// ---------------------------------------------------------------------------

/**
 * A tool that adds two numbers. The agent should call it once with
 * `{a: 2, b: 3}` and get back `5` — exercising the full Zod input
 * validation path.
 */
class AddTool extends BaseTool {
  public readonly name = 'add'
  public readonly description = 'Add two numbers and return the result.'
  public readonly risk: ToolRisk = 'low'
  public readonly inputSchema = z.object({
    a: z.number(),
    b: z.number(),
  })

  protected async execute(input: { a: number; b: number }, _ctx: ToolContext): Promise<unknown> {
    return input.a + input.b
  }

  public describe(): ToolDescriptor {
    // Override the default JSON-Schema conversion with the
    // hand-rolled shape this test expects, so we can assert against
    // it in `forwards tool descriptors to the provider`.
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
      inputJsonSchema: {
        type: 'object',
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
      risk: this.risk,
      version: this.version,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a scripted provider that walks through a sequence of steps. */
const scriptedProvider = (steps: ScriptedStep[]): FakeProvider => new FakeProvider(steps)

const runOnce = async (steps: ScriptedStep[]) => {
  const provider = scriptedProvider(steps)
  const memory = new FakeMemoryStore()
  await memory.init()
  const hooks = new HookRegistry()
  const tools = new ToolRegistry()
  tools.register(new AddTool())
  tools.register(new EchoTool())
  const agent = new Agent({ provider, tools, memory, hooks, model: 'fake-model' })
  const events: HookEvent[] = []
  hooks.register((e) => {
    events.push(e)
  })
  const result = await agent.run({ userMessage: 'hi' })
  return { provider, memory, hooks, tools, agent, events, result }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Agent integration', () => {
  it('runs a single-turn text-only response end-to-end', async () => {
    const final: AssistantMessage = {
      role: 'assistant',
      content: 'hello back',
      toolCalls: [],
      model: 'fake-model',
    }
    const { provider, memory, result, events } = await runOnce([{ message: final }])

    expect(result.finalMessage.content).toBe('hello back')
    expect(result.iterations).toBe(1)
    expect(result.messages.length).toBe(3) // system + user + assistant
    // Provider was called exactly once with the right model.
    expect(provider.calls.length).toBe(1)
    expect(provider.calls[0]?.model).toBe('fake-model')
    // System prompt was injected, user message appended.
    expect(provider.calls[0]?.messages[0]?.role).toBe('system')
    expect(provider.calls[0]?.messages[1]?.role).toBe('user')
    // Tools were forwarded to the provider via descriptors.
    const toolNames = (provider.calls[0]?.tools ?? []).map((t) => t.name)
    expect(toolNames).toEqual(expect.arrayContaining(['add', 'echo']))
    // Memory persisted every message, oldest-first.
    const persisted = await memory.getSessionMessages(result.sessionId)
    expect(persisted.length).toBe(3)
    expect(persisted[0]?.role).toBe('system')
    expect(persisted[1]?.role).toBe('user')
    expect(persisted[2]?.role).toBe('assistant')
    // Hooks fired in the expected order: run:start, step:start, message:append, step:end, run:end.
    const kinds = events.map((e) => e.kind)
    expect(kinds).toEqual(['run:start', 'step:start', 'message:append', 'step:end', 'run:end'])
  })

  it('dispatches a tool call, feeds the result back, and terminates when the model says done', async () => {
    const toolCall: AssistantMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'add', arguments: { a: 2, b: 3 } }],
      model: 'fake-model',
    }
    const final: AssistantMessage = {
      role: 'assistant',
      content: '5',
      toolCalls: [],
      model: 'fake-model',
    }
    const { provider, memory, tools, result, events } = await runOnce([
      { message: toolCall },
      { message: final },
    ])

    // Two iterations: one tool call, one final text response.
    expect(result.iterations).toBe(2)
    expect(result.finalMessage.content).toBe('5')

    // The second call to the provider carried the tool result back.
    expect(provider.calls.length).toBe(2)
    const secondCall = provider.calls[1]!
    // After iteration 1 the assistant(tool_call) is already appended
    // to `messages`, so the second call sees:
    //   system + user + assistant(tool_call) + tool(results) = 4.
    // (The final assistant(text) is appended AFTER the call returns.)
    expect(secondCall.messages.length).toBe(4)
    expect(secondCall.messages[2]?.role).toBe('assistant')
    expect(secondCall.messages[3]?.role).toBe('tool')

    // Memory persisted all 5 messages: system, user, assistant(tool_call), tool(results), assistant(text)
    const persisted = await memory.getSessionMessages(result.sessionId)
    expect(persisted.length).toBe(5)
    expect(persisted[3]?.role).toBe('tool')
    expect(persisted[4]?.role).toBe('assistant')
    expect(persisted[4]?.content).toBe('5')

    // Hooks fired tool:call and tool:result once each.
    const toolCalls = events.filter((e) => e.kind === 'tool:call')
    const toolResults = events.filter((e) => e.kind === 'tool:result')
    expect(toolCalls.length).toBe(1)
    expect(toolResults.length).toBe(1)
    const toolResult = toolResults[0]
    if (toolResult?.kind === 'tool:result') {
      expect(toolResult.toolCall.id).toBe('c1')
      expect(toolResult.toolCall.name).toBe('add')
    }

    // Tool's `describe()` was consulted to populate the descriptor.
    const descriptor = tools.get('add')?.describe()
    expect(descriptor?.inputJsonSchema).toEqual({
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    })
  })

  it('loops until the model stops calling tools (multiple rounds)', async () => {
    const call1: AssistantMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'add', arguments: { a: 1, b: 1 } }],
      model: 'fake-model',
    }
    const call2: AssistantMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c2', name: 'add', arguments: { a: 2, b: 2 } }],
      model: 'fake-model',
    }
    const call3: AssistantMessage = {
      role: 'assistant',
      content: 'sum:6',
      toolCalls: [],
      model: 'fake-model',
    }
    const { provider, result } = await runOnce([
      { message: call1 },
      { message: call2 },
      { message: call3 },
    ])

    expect(result.iterations).toBe(3)
    expect(result.finalMessage.content).toBe('sum:6')
    expect(provider.calls.length).toBe(3)
    // Each subsequent call carried the new tool result in messages.
    expect(provider.calls[1]?.messages.length).toBe(4)
    expect(provider.calls[2]?.messages.length).toBe(6)
  })

  it('handles a tool error by passing isError=true back to the model', async () => {
    const { FailingTool } = await import('./fake-tools.js')
    const provider = scriptedProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'failing', arguments: { input: 'x' } }],
          model: 'fake-model',
        },
      },
      {
        message: {
          role: 'assistant',
          content: 'tool failed gracefully',
          toolCalls: [],
          model: 'fake-model',
        },
      },
    ])
    const memory = new FakeMemoryStore()
    await memory.init()
    const tools = new ToolRegistry()
    tools.register(new FailingTool())
    const agent = new Agent({
      provider,
      tools,
      memory,
      hooks: new HookRegistry(),
      model: 'fake-model',
    })
    const result = await agent.run({ userMessage: 'go' })

    // Two iterations: the tool error didn't crash the loop; the model
    // was given a chance to recover.
    expect(result.iterations).toBe(2)
    // The second provider call included the tool's error result.
    const secondCall = provider.calls[1]!
    const toolMsg = secondCall.messages[3]
    expect(toolMsg?.role).toBe('tool')
    if (toolMsg?.role === 'tool') {
      expect(toolMsg.results[0]?.isError).toBe(true)
    }
  })

  it('throws MaxIterationsExceededError when the model never stops calling tools', async () => {
    const alwaysCallTool: AssistantMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'add', arguments: { a: 1, b: 1 } }],
      model: 'fake-model',
    }
    // 50 steps of tool calls + 1 grace round = 51 iterations. Pass
    // maxIterations=3 to force a quick exit.
    const provider = scriptedProvider(Array(10).fill({ message: alwaysCallTool }))
    const memory = new FakeMemoryStore()
    await memory.init()
    const tools = new ToolRegistry()
    tools.register(new AddTool())
    const agent = new Agent({
      provider,
      tools,
      memory,
      hooks: new HookRegistry(),
      model: 'fake-model',
    })
    await expect(agent.run({ userMessage: 'go', maxIterations: 3 })).rejects.toThrow(
      /maximum iterations/,
    )
  })

  it('streamRun() yields run:end with the final message on the last event', async () => {
    const final: AssistantMessage = {
      role: 'assistant',
      content: 'streamed',
      toolCalls: [],
      model: 'fake-model',
    }
    const provider = scriptedProvider([{ message: final }])
    const memory = new FakeMemoryStore()
    await memory.init()
    const tools = new ToolRegistry()
    tools.register(new AddTool())
    const agent = new Agent({
      provider,
      tools,
      memory,
      hooks: new HookRegistry(),
      model: 'fake-model',
    })
    const events: RunEvent[] = []
    let lastRunEnd: RunEvent | undefined
    for await (const ev of agent.streamRun({ userMessage: 'hi' })) {
      events.push(ev)
      if (ev.type === 'run:end') {
        lastRunEnd = ev
      }
    }
    const kinds = events.map((e) => e.type)
    expect(kinds).toContain('step:end')
    expect(kinds).toContain('run:end')
    if (lastRunEnd && lastRunEnd.type === 'run:end') {
      expect(lastRunEnd.finalMessage.content).toBe('streamed')
    } else {
      throw new Error('expected run:end event')
    }
  })
})
