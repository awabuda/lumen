/**
 * P32.2 unit tests for `restore-turns.ts`.
 *
 * The helper translates `AgentCheckpoint.messages` back into
 * `RestoredTurn[]` for the Chat TUI to render at mount time. The
 * mapping has four non-obvious rules (drop system, fold tool-calls,
 * keep in-progress tail, render lone leading assistants as
 * `user: ''`); each test here pins down one of them so future
 * refactors do not silently regress the visible-history behaviour
 * the user expects when reopening a `lumen chat` session.
 */

import type { AssistantMessage, ContentPart, Message, ToolCall, UserMessage } from '@lumen/core'
import { describe, expect, it } from 'vitest'
import { messagesToTurns } from '../src/components/restore-turns.js'

const sys = (content: string): Message => ({ role: 'system', content })
const user = (content: string | ContentPart[]): Message =>
  ({
    role: 'user',
    content: typeof content === 'string' ? content : content,
  }) as UserMessage as Message
const asst = (content: string, toolCalls: readonly ToolCall[] = []): Message =>
  ({
    role: 'assistant',
    content,
    toolCalls: [...toolCalls],
  }) as AssistantMessage as Message
const asstToolOnly = (toolCalls: readonly ToolCall[]): Message =>
  ({
    role: 'assistant',
    toolCalls: [...toolCalls],
  }) as AssistantMessage as Message
const tool = (name: string): Message => ({
  role: 'tool',
  results: [
    {
      toolCallId: name,
      content: `${name}-result`,
      isError: false,
    },
  ],
})

const toolCall = (id: string, name: string): ToolCall => ({
  id,
  name,
  arguments: {},
})

describe('messagesToTurns', () => {
  it('returns no turns for an empty message list', () => {
    expect(messagesToTurns([])).toEqual([])
  })

  it('drops system messages and pairs the rest', () => {
    const turns = messagesToTurns([sys('you are lumen'), user('hi'), asst('hello')])
    expect(turns).toHaveLength(1)
    expect(turns[0]?.user).toBe('hi')
    expect(turns[0]?.assistant?.content).toBe('hello')
    expect(turns[0]?.assistant?.toolCalls).toEqual([])
  })

  it('folds a tool-call loop into a single turn with merged tool calls and content', () => {
    const turns = messagesToTurns([
      user('find files modified today'),
      asstToolOnly([toolCall('c1', 'bash')]),
      tool('bash'),
      asstToolOnly([toolCall('c2', 'grep')]),
      tool('grep'),
      asst('3 files match: a.ts, b.ts, c.ts'),
    ])
    expect(turns).toHaveLength(1)
    const assistant = turns[0]?.assistant
    expect(assistant?.content).toBe('3 files match: a.ts, b.ts, c.ts')
    expect(assistant?.toolCalls.map((t) => t.name)).toEqual(['bash', 'grep'])
  })

  it('keeps an in-progress tail user message as a turn with no assistant field', () => {
    const turns = messagesToTurns([
      user('first question'),
      asst('first answer'),
      user('awaiting response'),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[0]?.user).toBe('first question')
    expect(turns[0]?.assistant?.content).toBe('first answer')
    expect(turns[1]?.user).toBe('awaiting response')
    expect(turns[1]?.assistant).toBeUndefined()
  })

  it('renders a leading assistant (no preceding user) as a turn with user=""', () => {
    const turns = messagesToTurns([sys('prompt'), asst('opening greeting')])
    expect(turns).toHaveLength(1)
    expect(turns[0]?.user).toBe('')
    expect(turns[0]?.assistant?.content).toBe('opening greeting')
  })

  it('flattens multipart user content (text + attachment) to a readable string', () => {
    // Schema requires array<ContentPart>. The helper must handle
    // both text and attachment parts and join them so the TUI
    // does not have to import ContentPartSchema.
    const parts: ContentPart[] = [
      { type: 'text', text: 'what is in this image?' },
      { type: 'image', url: 'https://example.com/x.png' },
      { type: 'text', text: 'be specific' },
    ]
    const turns = messagesToTurns([user(parts), asst('it is a small red square')])
    expect(turns).toHaveLength(1)
    expect(turns[0]?.user).toBe('what is in this image?\n[attachment]\nbe specific')
  })

  it('drops tool result messages (folded into the prior assistant turn)', () => {
    const turns = messagesToTurns([
      user('q1'),
      asstToolOnly([toolCall('c1', 'bash')]),
      tool('bash'),
      user('q2'),
      asst('a2'),
    ])
    expect(turns).toHaveLength(2)
    expect(turns[0]?.assistant?.toolCalls).toHaveLength(1)
    expect(turns[1]?.user).toBe('q2')
  })

  it('assigns stable, sequential keys starting from 1', () => {
    const turns = messagesToTurns([user('a'), asst('b'), user('c'), asst('d')])
    expect(turns.map((t) => t.key)).toEqual([1, 2])
  })

  it('preserves tool calls across the entire loop including content-bearing assistant', () => {
    // Real agent loop pattern: user → assistant(tool_calls) →
    // tool result → assistant(content + no more tool calls).
    // The folded turn should keep BOTH the tool calls and the
    // content because the TUI's ToolCallChip renders tool calls
    // even when the assistant also produced prose.
    const t = toolCall('call-1', 'terminal')
    const turns = messagesToTurns([
      user('list files'),
      asstToolOnly([t]),
      tool('terminal'),
      asst('a.ts\nb.ts\nc.ts'),
    ])
    expect(turns).toHaveLength(1)
    expect(turns[0]?.assistant?.toolCalls.map((c) => c.name)).toEqual(['terminal'])
    expect(turns[0]?.assistant?.content).toBe('a.ts\nb.ts\nc.ts')
  })
})
