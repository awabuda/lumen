/**
 * MCP tool discovery and registration.
 *
 * Given a list of MCP server configs, connects to each server, discovers
 * their tools, and creates {@link McpToolProxy} instances that can be
 * registered in a Lumen {@link ToolRegistry}.
 */

import { type ToolRegistry } from '@lumen/core'
import type { McpServerConfig } from '@lumen/config'
import { McpClient, McpToolProxy, McpTransportError } from './base.js'
import { StdioMcpTransport } from './stdio-transport.js'
import { HttpMcpTransport } from './http-transport.js'

export interface DiscoveredMcpServer {
  name: string
  client: McpClient
  tools: McpToolProxy[]
}

/**
 * Connect to one MCP server and discover its tools.
 *
 * Returns the connected client and proxy tools. The caller is responsible
 * for closing the client when done.
 */
export const connectMcpServer = async (
  name: string,
  config: McpServerConfig,
  options?: { timeoutMs?: number },
): Promise<DiscoveredMcpServer> => {
  if (!config.enabled) {
    throw new McpTransportError(`MCP server "${name}" is disabled in config`)
  }

  let transport
  if (config.transport === 'stdio') {
    if (!config.command) {
      throw new McpTransportError(`MCP server "${name}" uses stdio transport but has no command`)
    }
    transport = new StdioMcpTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      timeoutMs: options?.timeoutMs,
    })
  } else if (config.transport === 'http') {
    if (!config.url) {
      throw new McpTransportError(`MCP server "${name}" uses http transport but has no url`)
    }
    // Pick the right auth surface for the user. `apiKey` is the
    // ergonomic default (Bearer token); `headers` is the escape
    // hatch for custom schemes (mTLS, signed JWT, etc.). The
    // `headers` field wins over `apiKey` if both are set — the
    // user knows what they want.
    transport = new HttpMcpTransport({
      url: config.url,
      ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
      ...(config.headers !== undefined ? { headers: config.headers } : {}),
      timeoutMs: options?.timeoutMs,
    })
  } else {
    // Defensive: the schema is `z.enum(['stdio', 'http'])` so we
    // can't actually reach this branch in production, but a
    // future schema widening (e.g. `websocket`) would land here.
    const _exhaustive: never = config.transport
    throw new McpTransportError(
      `MCP server "${name}" uses unsupported transport "${String(_exhaustive)}"`,
    )
  }

  const client = new McpClient(transport, {
    clientInfo: { name: '@lumen/mcp', version: '0.1.0' },
    timeoutMs: options?.timeoutMs,
  })

  await client.initialize()
  const mcpTools = await client.listTools()
  const tools = mcpTools.map(
    (t) => new McpToolProxy(
      `mcp_${name}_${t.name}`.replace(/[-.]/g, '_'),
      t.description ?? t.name,
      t.inputSchema,
      client,
    ),
  )
  return { name, client, tools }
}

/**
 * Connect to all configured MCP servers and register their tools.
 *
 * Returns connected server details so the caller can close them on
 * shutdown. Failed servers are logged and skipped (not thrown).
 */
export const connectAllMcpServers = async (
  servers: Array<{ name: string } & McpServerConfig>,
  registry: ToolRegistry,
  options?: { timeoutMs?: number },
): Promise<DiscoveredMcpServer[]> => {
  const connected: DiscoveredMcpServer[] = []

  for (const serverConfig of servers) {
    try {
      const discovered = await connectMcpServer(serverConfig.name, serverConfig, options)
      for (const tool of discovered.tools) {
        registry.register(tool)
      }
      connected.push(discovered)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[lumen mcp] failed to connect to "${serverConfig.name}": ${message}\n`)
    }
  }

  return connected
}

/**
 * Close all connected MCP servers.
 */
export const closeAllMcpServers = async (servers: DiscoveredMcpServer[]): Promise<void> => {
  await Promise.allSettled(servers.map((s) => s.client.close()))
}
