/**
 * MCP tool discovery and registration.
 *
 * Given a list of MCP server configs, connects to each server, discovers
 * their tools, and creates {@link McpToolProxy} instances that can be
 * registered in a Lumen {@link ToolRegistry}.
 */

import type { McpServerConfig } from '@lumen/config'
import type { ToolRegistry } from '@lumen/core'
import { McpClient, McpToolProxy, type McpTransport, McpTransportError } from './base.js'
import { HttpMcpTransport } from './http-transport.js'
import { StdioMcpTransport } from './stdio-transport.js'

export interface DiscoveredMcpServer {
  name: string
  client: McpClient
  tools: McpToolProxy[]
}

/**
 * P24.3 (fix #47) — fail-closed MCP server registration.
 *
 * Pre-P24.3 every server in `config.mcp.servers` was accepted
 * without any operator-side gate. A misconfigured `mcpServers`
 * entry was a security incident.
 *
 * `connectAllMcpServers` now accepts an optional
 * {@link McpSecurityOptions} block:
 *
 *   - `failClosed: true` (default) — refuse to connect any
 *     server whose name is not on the explicit `allowServerIds`
 *     list. If `allowServerIds` is absent, EVERY server is
 *     rejected (fail-closed posture).
 *   - `failClosed: false` — legacy / opt-out behaviour; every
 *     server is allowed. The CLI surfaces a stderr warning
 *     when this is set so operators know what they did.
 *   - `allowServerIds` — optional explicit allow-list. When
 *     `failClosed: true` AND `allowServerIds` is set, only
 *     those IDs are allowed.
 */
export interface McpSecurityOptions {
  /** Default `true` per P24.3. */
  readonly failClosed?: boolean
  /** Explicit allow-list of server ids. Empty / absent means
   *  "no servers allowed" when failClosed is true. */
  readonly allowServerIds?: ReadonlyArray<string>
}

/**
 * Decide whether a server id is allowed by the security policy.
 * Extracted so tests can pin the policy and the CLI can call
 * it from `lumen doctor` to render the active policy.
 */
export const isServerIdAllowed = (
  id: string,
  security: McpSecurityOptions = {},
): boolean => {
  // failClosed defaults to true. Legacy opt-out is `false`.
  if (security.failClosed === false) return true
  const allow = security.allowServerIds ?? []
  return allow.includes(id)
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

  let transport: McpTransport
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
    (t) =>
      new McpToolProxy(
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
 *
 * P24.2 (fix #48) — this function used to loop sequentially over
 * `servers`, which made startup latency grow linearly with the
 * server count. We now build an array of per-server promises
 * with each one wrapping its own `try` / `catch` so a single
 * bad server does NOT abort the others. The `Promise.all`
 * itself never rejects because every per-promise rejection
 * is caught and turned into a stderr warning — same contract
 * as the pre-P24.2 loop, just parallel.
 */
export const connectAllMcpServers = async (
  servers: Array<{ name: string } & McpServerConfig>,
  registry: ToolRegistry,
  options?: { timeoutMs?: number },
  security: McpSecurityOptions = {},
): Promise<DiscoveredMcpServer[]> => {
  // P24.3 (fix #47) — fail-closed gate. Refuse to connect
  // any server whose id is not on the explicit allow-list.
  // The gate fires BEFORE the per-server task starts so a
  // disallowed server never even spawns a child process or
  // opens a TCP connection.
  const isClosed = security.failClosed !== false
  if (isClosed && security.allowServerIds === undefined) {
    process.stderr.write(
      `[lumen mcp] fail-closed mode is on (default) and no allowServerIds are configured — skipping all ${servers.length} configured server(s). Add \`mcp.security.allowServerIds: [...]' to your config to opt in.\n`,
    )
    return []
  }
  if (!isClosed && security.failClosed === false) {
    process.stderr.write(
      `[lumen mcp] warn: MCP fail-closed posture is OFF. Every configured server is allowed regardless of id. Set \`mcp.security.failClosed: true' (default) to require an explicit allow-list.\n`,
    )
  }

  // Build the per-server tasks first. Each task is independent;
  // failures stay isolated. `Promise.all` (NOT `allSettled`)
  // because every per-promise rejection is caught and converted
  // to a stderr warning here, so the outer promise never sees
  // a rejection. If we later switch to `allSettled` to expose
  // partial failures, the contract stays the same.
  const tasks = servers.map(async (serverConfig): Promise<DiscoveredMcpServer | null> => {
    // P24.3 — the security gate is the first line in the task
    // so a disallowed id never reaches `connectMcpServer`.
    if (isClosed && !isServerIdAllowed(serverConfig.name, security)) {
      process.stderr.write(
        `[lumen mcp] refuse: server "${serverConfig.name}" is not on the operator's allowServerIds list (fail-closed is on). Add the id to \`mcp.security.allowServerIds' to permit it.\n`,
      )
      return null
    }
    try {
      const discovered = await connectMcpServer(serverConfig.name, serverConfig, options)
      // Register the server's tools. We do this inside the
      // task so that an unrelated server's failure can't
      // race the registration.
      for (const tool of discovered.tools) {
        registry.register(tool)
      }
      return discovered
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      process.stderr.write(`[lumen mcp] failed to connect to "${serverConfig.name}": ${message}\n`)
      return null
    }
  })

  const settled = await Promise.all(tasks)
  return settled.filter((s): s is DiscoveredMcpServer => s !== null)
}

/**
 * Close all connected MCP servers.
 */
export const closeAllMcpServers = async (servers: DiscoveredMcpServer[]): Promise<void> => {
  await Promise.allSettled(servers.map((s) => s.client.close()))
}
