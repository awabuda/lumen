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
})
