# @lumen/mcp

MCP (Model Context Protocol) client. Implements the JSON-RPC 2.0
transport layer for the MCP 2025-03-26 spec, with two concrete
transports:

| Transport | Use it for |
|---|---|
| `StdioMcpTransport` | Local MCP servers spawned as child processes (e.g. `npx -y @modelcontextprotocol/server-filesystem`) |
| `HttpMcpTransport` | Remote MCP servers over HTTP + SSE (Streamable HTTP transport) |

## Quick start

```ts
import {
  StdioMcpTransport,
  McpClient,
  McpToolProxy,
} from '@lumen/mcp'
import { ToolRegistry } from '@lumen/core'

const transport = new StdioMcpTransport({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', process.cwd()],
  env: buildSafeMcpEnv(process.env),
})

const client = new McpClient({ transport })
await client.connect()

const registry = new ToolRegistry()
registry.registerAll(
  (await client.listTools()).tools.map(
    (tool) => new McpToolProxy(client, tool),
  ),
)
```

## Discovery

`connectAllMcpServers({ config })` reads `~/.lumen/mcp.json` (or any
path the caller supplies) and connects every entry in parallel.

## License

MIT
