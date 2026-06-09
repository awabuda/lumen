import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { McpClient, StdioMcpTransport } from '../src/index.js'

const dirname = path.dirname(fileURLToPath(import.meta.url))

describe('StdioMcpTransport integration', () => {
  it('talks to a real newline-json stdio MCP fixture', async () => {
    const transport = new StdioMcpTransport({
      command: process.execPath,
      args: [path.join(dirname, 'fixtures', 'stdio-server.mjs')],
      timeoutMs: 1_000,
    })
    const client = new McpClient(transport)
    try {
      await client.initialize()
      const tools = await client.listTools()
      expect(tools.map((t) => t.name)).toEqual(['echo'])
      const result = await client.callTool('echo', { text: 'real stdio works' })
      expect(result.content[0]?.text).toBe('real stdio works')
    } finally {
      await client.close()
    }
  })
})
