/** Public exports for @lumen/mcp. */

export {
  McpClient,
  McpToolProxy,
  McpTransport,
  McpTransportError,
  type JsonRpcError,
  type JsonRpcNotification,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type McpCallToolParams,
  type McpCallToolResult,
  type McpClientOptions,
  type McpInitializeRequest,
  type McpInitializeResult,
  type McpListToolsResult,
  type McpTool,
  type McpTransportOptions,
} from './base.js'
export { buildSafeMcpEnv, StdioMcpTransport, type StdioMcpTransportOptions } from './stdio-transport.js'
export {
  HttpMcpTransport,
  type HttpMcpTransportOptions,
  parseSseEvent,
} from './http-transport.js'
export {
  closeAllMcpServers,
  connectAllMcpServers,
  connectMcpServer,
  type DiscoveredMcpServer,
} from './discover.js'
