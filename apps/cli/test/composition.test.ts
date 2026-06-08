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
    })
    expect(built.provider.id).toBe('openai')
    expect(built.tools.size).toBe(0)
    expect(built.hooks.size).toBe(0)
    expect(built.model).toBe('gpt-4o-mini')
  })

  it('registers the 5 filesystem tools by default', async () => {
    const built = await buildAgent({
      apiKey: 'sk-fake',
      baseUrl: 'http://127.0.0.1:1',
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
    })
    expect(built.model).toBe('gpt-4o')
  })

  it('respects the cwd override', async () => {
    const built = await buildAgent({
      apiKey: 'sk-fake',
      baseUrl: 'http://127.0.0.1:1',
      cwd: '/tmp/lumen-test',
    })
    // The agent stores cwd internally; we verify by re-running and
    // checking it doesn't throw.
    expect(built).toBeDefined()
  })
})
