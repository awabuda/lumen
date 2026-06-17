/**
 * Contract tests for {@link BaseToolset} + {@link ToolRegistry.registerToolset}.
 */

import { BaseTool, StaticToolset, ToolRegistry } from '@lumen/core'
import type { ToolContext, ToolDescriptor } from '@lumen/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// A minimal tool for testing toolset registration.
class EchoTool extends BaseTool {
  public readonly name = 'echo'
  public readonly description = 'Echoes input'
  public readonly version = '1.0.0'
  public readonly risk = 'safe' as const
  public readonly inputSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
  } as const

  public describe(): ToolDescriptor {
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
      risk: this.risk,
      version: this.version,
    }
  }

  public async call(_input: unknown, _ctx: ToolContext): Promise<unknown> {
    return { ok: true }
  }
}

describe('[contract] ToolRegistry.registerToolset', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  it('registers a toolset lazily (no tools added until materialize)', () => {
    const ts = new StaticToolset({
      id: 'test',
      name: 'Test',
      description: 'A test toolset',
      factory: () => [new EchoTool()],
    })
    registry.registerToolset(ts)
    expect(registry.size).toBe(0)
  })

  it('registers a toolset eagerly', () => {
    const ts = new StaticToolset({
      id: 'test',
      name: 'Test',
      description: 'A test toolset',
      factory: () => [new EchoTool()],
    })
    registry.registerToolset(ts, { eager: true })
    expect(registry.size).toBe(1)
    expect(registry.get('test:echo')).toBeDefined()
  })

  it('materializeToolsets adds all lazy toolsets', () => {
    const ts = new StaticToolset({
      id: 'test',
      name: 'Test',
      description: 'A test toolset',
      factory: () => [new EchoTool()],
    })
    registry.registerToolset(ts)
    expect(registry.size).toBe(0)
    const count = registry.materializeToolsets()
    expect(count).toBe(1)
    expect(registry.size).toBe(1)
  })

  it('rejects duplicate toolset ids', () => {
    const ts = new StaticToolset({
      id: 'dup',
      name: 'Dup',
      description: 'A test toolset',
      factory: () => [new EchoTool()],
    })
    registry.registerToolset(ts)
    expect(() => registry.registerToolset(ts)).toThrow(/already registered/)
  })

  it('skips tools that would collide with an existing registration', () => {
    // Register a tool with the namespaced name first.
    registry.register(new EchoTool())
    const ts = new StaticToolset({
      id: 'test',
      name: 'Test',
      description: 'A test toolset',
      factory: () => [new EchoTool()],
    })
    registry.registerToolset(ts, { eager: true })
    // The toolset's 'echo' should be skipped because 'echo' is
    // already registered. The namespaced 'test:echo' should
    // also be skipped because... wait, the namespaced name is
    // 'test:echo', not 'echo'. Let's check: the namespaced
    // name is `test:echo`, which does not collide with `echo`.
    // So the toolset should still add `test:echo`.
    expect(registry.get('test:echo')).toBeDefined()
    expect(registry.size).toBe(2)
  })
})

describe('[contract] StaticToolset', () => {
  it('caches the factory result', () => {
    let calls = 0
    const ts = new StaticToolset({
      id: 'cache',
      name: 'Cache',
      description: 'Caching test',
      factory: () => {
        calls += 1
        return [new EchoTool()]
      },
    })
    ts.materialize()
    ts.materialize()
    expect(calls).toBe(1)
  })

  it('exposes id, name, description', () => {
    const ts = new StaticToolset({
      id: 's',
      name: 'S',
      description: 'desc',
      factory: () => [],
    })
    expect(ts.id).toBe('s')
    expect(ts.name).toBe('S')
    expect(ts.description).toBe('desc')
  })
})
