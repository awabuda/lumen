import { describe, expect, it } from 'vitest'
import { createAgent } from '../src/agent/factory.js'
import {
  SUB_AGENT_TOOL_NAME,
  SubAgentTaskTool,
  createSubAgentMiddleware,
} from '../src/agent/middleware/sub-agent.js'
import { ToolRegistry } from '../src/tools/index.js'
import { FakeProvider } from './fake-provider.js'

describe('SubAgentMiddleware', () => {
  it('intercepts task tool calls and returns the sub-agent output as the tool result', async () => {
    const tools = new ToolRegistry().register(new SubAgentTaskTool())
    // The parent has 2 scripted steps: task call then a final response.
    const parentProvider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'c1',
              name: SUB_AGENT_TOOL_NAME,
              arguments: { subagent: 'researcher', prompt: 'find info' },
            },
          ],
        },
      },
      { message: { role: 'assistant', content: 'parent done', toolCalls: [] } },
    ])
    // The sub-agent has its own scripted response.
    const subProvider = new FakeProvider([
      { message: { role: 'assistant', content: 'sub result', toolCalls: [] } },
    ])
    const parentTools = new ToolRegistry()
    const subTools = new ToolRegistry()
    const agent = createAgent({
      provider: parentProvider,
      tools,
      middleware: [
        createSubAgentMiddleware({
          parent: {
            provider: subProvider,
            tools: subTools,
          },
          specs: [
            {
              name: 'researcher',
              description: 'Researches a topic',
              systemPrompt: 'You research.',
            },
          ],
        }),
      ],
    })

    const result = await agent.run({ userMessage: 'do it' })

    expect(result.finalMessage.content).toBe('parent done')
    expect(parentProvider.calls[1]?.messages.some((m) => m.role === 'tool')).toBe(true)
    const toolMessage = parentProvider.calls[1]?.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.results[0]?.isError).toBe(false)
    expect(toolMessage?.results[0]?.content).toBe('sub result')
  })

  it('returns an error result when the subagent name is unknown', async () => {
    const tools = new ToolRegistry().register(new SubAgentTaskTool())
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'c1',
              name: SUB_AGENT_TOOL_NAME,
              arguments: { subagent: 'unknown', prompt: 'x' },
            },
          ],
        },
      },
      { message: { role: 'assistant', content: 'fallback', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools,
      middleware: [
        createSubAgentMiddleware({
          parent: { provider, tools },
          specs: [
            {
              name: 'researcher',
              description: 'Researches a topic',
              systemPrompt: 'You research.',
            },
          ],
        }),
      ],
    })

    const result = await agent.run({ userMessage: 'go' })

    expect(result.finalMessage.content).toBe('fallback')
    const toolMessage = provider.calls[1]?.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.results[0]?.isError).toBe(true)
    expect(toolMessage?.results[0]?.content).toContain('unknown subagent')
  })

  it('passes through other tool calls without interception', async () => {
    const tools = new ToolRegistry().register(new SubAgentTaskTool())
    const provider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'unknown_tool', arguments: {} }],
        },
      },
      { message: { role: 'assistant', content: 'done', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider,
      tools,
      middleware: [
        createSubAgentMiddleware({
          parent: { provider, tools },
          specs: [],
        }),
      ],
    })

    const result = await agent.run({ userMessage: 'go' })

    expect(result.finalMessage.content).toBe('done')
  })

  // P19.4.3: SubAgentMiddleware with enableHandoff=true should route
  // the sub-agent through createHandoffSubAgent and surface a handoff
  // tool call as part of the tool result.
  it('forwards a handoff tool call from a sub-agent to the parent (enableHandoff=true)', async () => {
    const tools = new ToolRegistry().register(new SubAgentTaskTool())
    // Parent: emit task, then a final response.
    const parentProvider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'c1',
              name: SUB_AGENT_TOOL_NAME,
              arguments: { subagent: 'worker', prompt: 'do work' },
            },
          ],
        },
      },
      { message: { role: 'assistant', content: 'parent got handoff', toolCalls: [] } },
    ])
    // Sub-agent: emit handoff, then stop.
    const subProvider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: 'passing control',
          toolCalls: [
            {
              id: 'h1',
              name: 'handoff',
              arguments: { to: 'parent', reason: 'task done' },
            },
          ],
        },
      },
      { message: { role: 'assistant', content: 'finished', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider: parentProvider,
      tools,
      middleware: [
        createSubAgentMiddleware({
          parent: { provider: subProvider, tools: new ToolRegistry() },
          enableHandoff: true,
          specs: [
            {
              name: 'worker',
              description: 'A worker sub-agent',
              systemPrompt: 'You do work.',
            },
          ],
        }),
      ],
    })

    const result = await agent.run({ userMessage: 'go' })

    const toolMessage = parentProvider.calls[1]?.messages.find((m) => m.role === 'tool')
    const toolResult = toolMessage?.results[0]
    expect(toolResult?.isError).toBe(false)
    // The sub-agent's finalMessage.content comes from step 2 (the
    // post-handoff stop turn); the handoff suffix carries the
    // { to, reason } that the parent should act on.
    expect(toolResult?.content).toContain('finished')
    expect(toolResult?.content).toContain('[handoff:')
    expect(toolResult?.content).toContain('to=parent')
    expect(toolResult?.content).toContain('task done')
    expect(result.finalMessage.content).toBe('parent got handoff')
  })

  it('does not surface a handoff suffix when enableHandoff=false and no handoff is emitted', async () => {
    const tools = new ToolRegistry().register(new SubAgentTaskTool())
    const parentProvider = new FakeProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          toolCalls: [
            {
              id: 'c1',
              name: SUB_AGENT_TOOL_NAME,
              arguments: { subagent: 'worker', prompt: 'do work' },
            },
          ],
        },
      },
      { message: { role: 'assistant', content: 'parent done', toolCalls: [] } },
    ])
    const subProvider = new FakeProvider([
      { message: { role: 'assistant', content: 'plain sub result', toolCalls: [] } },
    ])
    const agent = createAgent({
      provider: parentProvider,
      tools,
      middleware: [
        createSubAgentMiddleware({
          parent: { provider: subProvider, tools: new ToolRegistry() },
          // enableHandoff defaults to false
          specs: [
            {
              name: 'worker',
              description: 'A worker sub-agent',
              systemPrompt: 'You do work.',
            },
          ],
        }),
      ],
    })

    await agent.run({ userMessage: 'go' })

    const toolMessage = parentProvider.calls[1]?.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.results[0]?.content).toBe('plain sub result')
    expect(toolMessage?.results[0]?.content).not.toContain('[handoff:')
  })
})
