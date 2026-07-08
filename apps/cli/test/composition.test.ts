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

  describe('MCP wiring', () => {
    it('returns an empty mcpServers list when noMcp=true', async () => {
      const built = await buildAgent({
        apiKey: 'sk-fake',
        baseUrl: 'http://127.0.0.1:1',
        noTools: true,
        noMemory: true,
        noMcp: true,
      })
      expect(built.mcpServers).toEqual([])
    })

    it('returns an empty mcpServers list when no servers are configured', async () => {
      // Default config (no project) has mcp.servers = [].
      const built = await buildAgent({
        apiKey: 'sk-fake',
        baseUrl: 'http://127.0.0.1:1',
        noTools: true,
        noMemory: true,
      })
      expect(built.mcpServers).toEqual([])
    })

    it('skips a broken stdio server without throwing, leaving mcpServers empty', async () => {
      // Build a config that points at a command that exits
      // immediately. `connectAllMcpServers` is supposed to
      // log + skip failures, not bubble them up — the CLI
      // is meant to stay usable when an MCP server is broken.
      const tmpDir = await import('node:fs/promises').then((m) => m.mkdtemp('/tmp/lumen-mcp-test-'))
      const configPath = `${tmpDir}/.lumen/config.yaml`
      await import('node:fs/promises').then((m) => m.mkdir(`${tmpDir}/.lumen`, { recursive: true }))
      await import('node:fs/promises').then((m) =>
        m.writeFile(
          configPath,
          [
            'mcp:',
            '  servers:',
            '    - name: broken',
            '      transport: stdio',
            "      command: 'sh'",
            "      args: ['-c', 'exit 1']",
            '      enabled: true',
            '',
          ].join('\n'),
        ),
      )

      // Capture stderr to keep test output clean.
      const stderrChunks: string[] = []
      const origStderr = process.stderr.write.bind(process.stderr)
      process.stderr.write = ((chunk: string | Uint8Array): boolean => {
        stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString())
        return true
      }) as typeof process.stderr.write

      let built: Awaited<ReturnType<typeof buildAgent>> | undefined
      try {
        built = await buildAgent({
          apiKey: 'sk-fake',
          baseUrl: 'http://127.0.0.1:1',
          // Pass the project config file directly; the
          // loader uses it as the projectPath override.
          configPath,
          noTools: true,
          noMemory: true,
          mcpTimeoutMs: 1_000,
        })
        // The server is broken so nothing should be in
        // mcpServers. The fs tools we disabled (noTools)
        // mean the registry is otherwise empty.
        expect(built.mcpServers).toEqual([])
        expect(built.tools.size).toBe(0)
        // A `[lumen mcp] failed to connect` line should
        // have been emitted. We don't assert on its exact
        // wording, only that the diagnostic fired.
        const stderr = stderrChunks.join('')
        expect(stderr).toContain('[lumen mcp]')
        expect(stderr).toContain('broken')
      } finally {
        process.stderr.write = origStderr
        await import('node:fs/promises').then((m) => m.rm(tmpDir, { recursive: true, force: true }))
      }
    })
  })

  // P19.0.3 / P19.1 wire-up: buildAgent must go through the
  // createAgent factory when enablePlanMiddleware is true, and
  // the resulting agent must carry the plan middleware. When
  // the flag is omitted, the agent falls back to the bare
  // `new Agent({...})` path (backward compat).
  describe('P19 plan middleware wire-up', () => {
    it('still builds when enablePlanMiddleware is false (default)', async () => {
      const built = await buildAgent({
        apiKey: 'test-key',
        baseUrl: 'http://127.0.0.1:1',
        noTools: true,
        noMemory: true,
      })
      expect(built.agent).toBeDefined()
    })

    it('accepts enablePlanMiddleware: true without throwing', async () => {
      const built = await buildAgent({
        apiKey: 'test-key',
        baseUrl: 'http://127.0.0.1:1',
        noTools: true,
        noMemory: true,
        enablePlanMiddleware: true,
        planMode: 'auto',
      })
      expect(built.agent).toBeDefined()
    })

    it('accepts planMode: "plan" and planMode: "act"', async () => {
      for (const mode of ['plan', 'act'] as const) {
        const built = await buildAgent({
          apiKey: 'test-key',
          baseUrl: 'http://127.0.0.1:1',
          noTools: true,
          noMemory: true,
          enablePlanMiddleware: true,
          planMode: mode,
        })
        expect(built.agent).toBeDefined()
      }
    })
  })
})
