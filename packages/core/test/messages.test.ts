import { describe, expect, it } from 'vitest'
import { MessageSchema, Role } from '../src/message/index.js'

describe('Message schemas', () => {
  it('parses a system message', () => {
    const m = MessageSchema.parse({ role: 'system', content: 'hi' })
    expect(m.role).toBe(Role.System)
  })

  it('parses a user message with text', () => {
    const m = MessageSchema.parse({ role: 'user', content: 'hello' })
    expect(m.role).toBe('user')
  })

  it('parses an assistant message with tool calls', () => {
    const m = MessageSchema.parse({
      role: 'assistant',
      content: 'thinking...',
      toolCalls: [{ id: 'c1', name: 'foo', arguments: { x: 1 } }],
    })
    expect(m.role).toBe('assistant')
    if (m.role === 'assistant') {
      expect(m.toolCalls[0]!.name).toBe('foo')
    }
  })

  it('rejects a malformed message', () => {
    expect(() => MessageSchema.parse({ role: 'user' })).toThrow()
  })
})
