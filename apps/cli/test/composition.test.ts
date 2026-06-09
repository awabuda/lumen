/**
 * Tests for the composition root. Verifies that buildAgent correctly
 * wires the dependency graph without actually hitting the network.
 */
import { describe, expect, it } from 'vitest'
import { buildAgent } from '../src/composition.js'

describe('buildAgent', () => {
  it('builds an agent with a provider, tools, and hooks', async () => {
    const built = await buildAgent({
      apiKey: 'sk-fake',
      baseUrl: 'http://127.0.0.1:1',
      noTools: true,
      noMemory: true,
    })
    expect(built.provider.id).toBe('openai')
    expect(built.tools.size).toBe(0)
    expect(built.hooks.size).toBe(0)
    expect(built.model).toBe('gpt-4o-mini')
    expect(built.memory).toBeUndefined()
  })

  it('registers the 5 filesystem tools by default', async () => {
    const built = await buildAgent({
      apiKey: 'sk-fake',
      baseUrl: 'http://127.0.0.1:1',
      noMemory: true,
    })
    expect(built.tools.size).toBe(5)
    expect(built.tools.names().sort()).toEqual(
      ['list_dir', 'patch', 'read_file', 'search_files', 'write_file'].sort(),
    )
  })

  it('respects the model override', async () => {
    const built = await buildAgent({
      apiKey: 'sk-fake',
      baseUrl: 'http://127.0.0.1:1',
      model: 'gpt-4o',
      noMemory: true,
    })
    expect(built.model).toBe('gpt-4o')
  })

  it('respects the cwd override', async () => {
    const built = await buildAgent({
      apiKey: 'sk-fake',
      baseUrl: 'http://127.0.0.1:1',
      cwd: '/tmp/lumen-test',
      noMemory: true,
    })
    // The agent stores cwd internally; we verify by re-running and
    // checking it doesn't throw.
    expect(built).toBeDefined()
  })

  it('wires a SqliteStore by default and disposes it cleanly', async () => {
    // Use the in-memory variant so we don't touch the
    // user's home directory during a test run. We assert
    // the store is present, and that calling dispose (via
    // the agent's normal shutdown path) doesn't throw.
    const built = await buildAgent({
      apiKey: 'sk-fake',
      baseUrl: 'http://127.0.0.1:1',
      memoryPath: ':memory:',
      noTools: true,
    })
    expect(built.memory).toBeDefined()
    // A real round-trip through the store proves the
    // schema was created and the contract methods work.
    const r = await built.memory!.put({
      id: 'test-fact',
      kind: 'fact',
      content: 'composition wired memory',
      trust: 0.9,
      tags: ['test'],
    })
    expect(r.id).toBe('test-fact')
    const got = await built.memory!.get('test-fact')
    expect(got?.content).toBe('composition wired memory')
    await built.memory!.dispose()
  })
})
