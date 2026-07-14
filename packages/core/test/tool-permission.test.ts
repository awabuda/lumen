/** P22 permission policy + middleware tests. */

import { describe, expect, it } from 'vitest'
import {
  InMemoryCheckpointStore,
  TOOL_PERMISSION_MAX_RULES,
  type ToolCall,
  ToolPermissionMiddlewareOptionsSchema,
  ToolPermissionPolicySchema,
  ToolRegistry,
  createAgent,
  createInterruptMiddleware,
  createStaticToolPermissionPolicy,
  createToolPermissionMiddleware,
} from '../src/index.js'
import { FakeProvider } from './fake-provider.js'
import { EchoTool } from './fake-tools.js'

const tools = (): ToolRegistry => {
  const registry = new ToolRegistry()
  registry.register(new EchoTool())
  return registry
}

const toolCall = (name: string, args: Record<string, unknown> = {}): ToolCall => ({
  id: 't1',
  name,
  arguments: args,
})

const basePolicy = (rules: ReadonlyArray<unknown> = []) =>
  ({
    version: 1,
    default: 'ask',
    rules,
  }) as const

describe('ToolPermissionPolicySchema', () => {
  it('rejects an unknown top-level key (strict)', () => {
    const result = ToolPermissionPolicySchema.safeParse({
      version: 1,
      default: 'ask',
      rules: [],
      nope: 1,
    })
    expect(result.success).toBe(false)
  })

  it('rejects a non-enum decision', () => {
    const result = ToolPermissionPolicySchema.safeParse({
      version: 1,
      default: 'maybe',
      rules: [],
    })
    expect(result.success).toBe(false)
  })
})

describe('createStaticToolPermissionPolicy', () => {
  it('returns the default when no rule matches', () => {
    const policy = createStaticToolPermissionPolicy({
      version: 1,
      default: 'ask',
      rules: [{ name: 'allow-read', tools: ['read_file'], decision: 'allow' }],
    })
    expect(policy.id).toBe('static')
    expect(policy.evaluate(toolCall('write_file'))).toBe('ask')
  })

  it('matches by exact tool name and respects the rule decision', () => {
    const policy = createStaticToolPermissionPolicy({
      version: 1,
      default: 'ask',
      rules: [
        { name: 'allow-read', tools: ['read_file'], decision: 'allow' },
        { name: 'deny-write', tools: ['write_file'], decision: 'deny' },
      ],
    })
    expect(policy.evaluate(toolCall('read_file'))).toBe('allow')
    expect(policy.evaluate(toolCall('write_file'))).toBe('deny')
  })

  it('fires argMatches when every entry matches', () => {
    const policy = createStaticToolPermissionPolicy({
      version: 1,
      default: 'ask',
      rules: [
        {
          name: 'allow-read-md',
          tools: ['read_file'],
          decision: 'allow',
          when: { argMatches: { path: '\\.md$' } },
        },
      ],
    })
    expect(policy.evaluate(toolCall('read_file', { path: 'README.md' }))).toBe('allow')
    expect(policy.evaluate(toolCall('read_file', { path: 'config.ts' }))).toBe('ask')
  })

  it('rejects rules beyond TOOL_PERMISSION_MAX_RULES', () => {
    const rules = Array.from({ length: TOOL_PERMISSION_MAX_RULES + 1 }, (_, i) => ({
      name: `r${i}`,
      tools: [`tool-${i}`],
      decision: 'allow' as const,
    }))
    expect(() => createStaticToolPermissionPolicy({ version: 1, default: 'ask', rules })).toThrow(
      /too many rules/,
    )
  })

  it('coerces non-string arg values via JSON before regex matching', () => {
    const policy = createStaticToolPermissionPolicy({
      version: 1,
      default: 'ask',
      rules: [
        {
          name: 'allow-large-list',
          tools: ['write_file'],
          decision: 'allow',
          when: { argMatches: { content: 'a' } },
        },
      ],
    })
    expect(policy.evaluate(toolCall('write_file', { content: ['a', 'b'] }))).toBe('allow')
  })
})

describe('createToolPermissionMiddleware', () => {
  it('lets allow through without touching the call', async () => {
    const policy = createStaticToolPermissionPolicy({
      version: 1,
      default: 'ask',
      rules: [{ name: 'allow-echo', tools: ['echo'], decision: 'allow' }],
    })
    const agent = createAgent({
      provider: new FakeProvider([
        {
          message: {
            role: 'assistant',
            content: 'calling',
            toolCalls: [{ id: 't1', name: 'echo', arguments: { message: 'ok' } }],
          },
        },
        { message: { role: 'assistant', content: 'done', toolCalls: [] } },
      ]),
      tools: tools(),
      model: 'fake-model',
      middleware: [createToolPermissionMiddleware({ policy })],
    })
    const result = await agent.run({ userMessage: 'go' })
    expect(result.finalMessage.content).toBe('done')
  })

  it('throws AbortError on deny and the catch path auto-saves a checkpoint', async () => {
    const store = new InMemoryCheckpointStore()
    const policy = createStaticToolPermissionPolicy({
      version: 1,
      default: 'ask',
      rules: [{ name: 'deny-echo', tools: ['echo'], decision: 'deny' }],
    })
    const agent = createAgent({
      provider: new FakeProvider([
        {
          message: {
            role: 'assistant',
            content: 'calling',
            toolCalls: [{ id: 't1', name: 'echo', arguments: { message: 'ok' } }],
          },
        },
      ]),
      tools: tools(),
      model: 'fake-model',
      middleware: [createToolPermissionMiddleware({ policy })],
    })
    const caught = await agent
      .run({ userMessage: 'go', sessionId: 'perm-deny', checkpointStore: store })
      .catch((err: unknown) => err)
    const cause = (caught as { cause?: { message?: string } }).cause
    expect(cause?.message).toMatch(/permission denied: tool "echo"/)
    const list = await store.list('perm-deny')
    expect(list.find((cp) => cp.outcome === 'error')).toBeDefined()
  })

  it('falls through to the call when the decision is ask', async () => {
    const policy = createStaticToolPermissionPolicy({
      version: 1,
      default: 'ask',
      rules: [{ name: 'ask-echo', tools: ['echo'], decision: 'ask' }],
    })
    const agent = createAgent({
      provider: new FakeProvider([
        {
          message: {
            role: 'assistant',
            content: 'calling',
            toolCalls: [{ id: 't1', name: 'echo', arguments: { message: 'ok' } }],
          },
        },
        { message: { role: 'assistant', content: 'done', toolCalls: [] } },
      ]),
      tools: tools(),
      model: 'fake-model',
      middleware: [createToolPermissionMiddleware({ policy })],
    })
    const result = await agent.run({ userMessage: 'go' })
    expect(result.finalMessage.content).toBe('done')
  })
})

describe('tool permission + interrupt coexistence (P22.1)', () => {
  it('chains permission ask → interrupt approve', async () => {
    // Permission: ask. Interrupt: toolNames=[echo] with approve=true. → dispatch.
    const policy = createStaticToolPermissionPolicy({
      version: 1,
      default: 'ask',
      rules: [{ name: 'ask-echo', tools: ['echo'], decision: 'ask' }],
    })
    const agent = createAgent({
      provider: new FakeProvider([
        {
          message: {
            role: 'assistant',
            content: 'calling',
            toolCalls: [{ id: 't1', name: 'echo', arguments: { message: 'ok' } }],
          },
        },
        { message: { role: 'assistant', content: 'done', toolCalls: [] } },
      ]),
      tools: tools(),
      model: 'fake-model',
      middleware: [
        createToolPermissionMiddleware({ policy }),
        createInterruptMiddleware({
          toolNames: ['echo'],
          approve: () => true,
        }),
      ],
    })
    const result = await agent.run({ userMessage: 'go' })
    expect(result.finalMessage.content).toBe('done')
  })

  it('allows the call but the inner interrupt chain still aborts when ask denies', async () => {
    // Permission: allow. Interrupt: toolNames=[echo] with approve=false.
    // Permission does NOT short-circuit interrupt; interrupt's
    // approve callback decides. Result: abort from interrupt.
    const policy = createStaticToolPermissionPolicy({
      version: 1,
      default: 'ask',
      rules: [{ name: 'allow-echo', tools: ['echo'], decision: 'allow' }],
    })
    const store = new InMemoryCheckpointStore()
    const agent = createAgent({
      provider: new FakeProvider([
        {
          message: {
            role: 'assistant',
            content: 'calling',
            toolCalls: [{ id: 't1', name: 'echo', arguments: { message: 'ok' } }],
          },
        },
      ]),
      tools: tools(),
      model: 'fake-model',
      middleware: [
        createToolPermissionMiddleware({ policy }),
        createInterruptMiddleware({
          toolNames: ['echo'],
          approve: () => false,
        }),
      ],
    })
    const caught = await agent
      .run({ userMessage: 'go', sessionId: 'allow-ask-denied', checkpointStore: store })
      .catch((err: unknown) => err)
    const cause = (caught as { cause?: { cause?: { message?: string } } }).cause?.cause?.message
    expect(cause).toMatch(/interrupt: tool "echo" requires approval/)
  })

  it('chains permission deny → interrupt never fires', async () => {
    const policy = createStaticToolPermissionPolicy({
      version: 1,
      default: 'ask',
      rules: [{ name: 'deny-echo', tools: ['echo'], decision: 'deny' }],
    })
    const store = new InMemoryCheckpointStore()
    let approveCalled = false
    const agent = createAgent({
      provider: new FakeProvider([
        {
          message: {
            role: 'assistant',
            content: 'calling',
            toolCalls: [{ id: 't1', name: 'echo', arguments: { message: 'ok' } }],
          },
        },
      ]),
      tools: tools(),
      model: 'fake-model',
      middleware: [
        createToolPermissionMiddleware({ policy }),
        createInterruptMiddleware({
          toolNames: ['echo'],
          approve: () => {
            approveCalled = true
            return true
          },
        }),
      ],
    })
    const caught = await agent
      .run({ userMessage: 'go', sessionId: 'deny-wins', checkpointStore: store })
      .catch((err: unknown) => err)
    expect((caught as { cause?: { message?: string } }).cause?.message).toMatch(
      /permission denied: tool "echo"/,
    )
    expect(approveCalled).toBe(false)
    const list = await store.list('deny-wins')
    expect(list.find((cp) => cp.outcome === 'error')).toBeDefined()
  })
})

describe('ToolPermissionMiddlewareOptionsSchema', () => {
  it('rejects an unknown option key', () => {
    const result = ToolPermissionMiddlewareOptionsSchema.safeParse({ unknown: 1 })
    expect(result.success).toBe(false)
  })

  it('accepts an empty object', () => {
    const result = ToolPermissionMiddlewareOptionsSchema.safeParse({})
    expect(result.success).toBe(true)
  })
})

// Suppress unused-import warning for the helper at the top.
void basePolicy
