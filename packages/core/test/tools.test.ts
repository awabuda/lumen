import { describe, expect, it } from 'vitest'
import { type ToolDescriptor, ToolRegistry } from '../src/tools/index.js'
import { EchoTool, FailingTool } from './fake-tools.js'

describe('ToolRegistry', () => {
  it('registers and retrieves a tool by name', () => {
    const reg = new ToolRegistry()
    const tool = new EchoTool()
    reg.register(tool)
    expect(reg.get('echo')).toBe(tool)
  })

  it('throws on duplicate name', () => {
    const reg = new ToolRegistry()
    reg.register(new EchoTool())
    expect(() => reg.register(new EchoTool())).toThrow('already registered')
  })

  it('lists descriptors in registration order', () => {
    const reg = new ToolRegistry()
    reg.register(new EchoTool())
    reg.register(new FailingTool())
    const list = reg.list()
    expect(list.map((d: ToolDescriptor) => d.name)).toEqual(['echo', 'failing'])
  })

  it('returns undefined for unknown tool', () => {
    const reg = new ToolRegistry()
    expect(reg.get('nope')).toBeUndefined()
  })
})
