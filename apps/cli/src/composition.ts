/**
 * The composition root.
 *
 * Everything in the CLI eventually comes through this file. It is the ONE
 * place that knows about concrete implementations (OpenAICompatibleProvider,
 * SqliteMemoryStore, real tools). The agent runtime stays blissfully
 * unaware of these choices.
 *
 * Why centralize here:
 *   - Tests construct their own composition roots with fakes.
 *   - Production code composes real instances from config.
 *   - The rest of the codebase stays free of "if production, use X" branches.
 *
 * Public surface:
 *   - {@link buildAgent}: build a ready-to-run Agent from CLI flags + env.
 *   - {@link loadCliConfig}: load + merge config for the CLI.
 */

import * as os from 'node:os'
import * as path from 'node:path'
import { type LumenConfig, loadConfig } from '@lumen/config'
import { Agent, type BaseProvider, HookRegistry, ToolRegistry } from '@lumen/core'
import { OpenAICompatibleProvider } from '@lumen/llm'
import { type DiscoveredMcpServer, closeAllMcpServers, connectAllMcpServers } from '@lumen/mcp'
import { SqliteStore } from '@lumen/memory'
import { createFilesystemTools } from '@lumen/tools'

export interface CliAgentOptions {
  /** Path to a config file (overrides lookup). */
  configPath?: string
  /** Override the LLM model. */
  model?: string
  /** Working directory for tool execution. */
  cwd?: string
  /** Override the API key. */
  apiKey?: string
  /** Override the API base URL. */
  baseUrl?: string
  /** Disable filesystem tools (for testing or sandboxed use). */
  noTools?: boolean
  /**
   * Override the SQLite memory database path. When omitted,
   * the default is `~/.lumen/memory.db` (the XDG-friendly
   * home-directory choice). Tests pass `:memory:` to keep
   * the database hermetic.
   */
  memoryPath?: string
  /**
   * Skip wiring a memory store at all. The agent runs
   * ephemerally; every `lumen run` starts a fresh session.
   * Useful for one-off scripts and CI.
   */
  noMemory?: boolean
  /**
   * Skip MCP server discovery + connection. The default
   * (`false`) connects to every enabled entry in
   * `config.mcp.servers` and registers their tools. Set to
   * `true` to run the agent with only the built-in tools.
   */
  noMcp?: boolean
  /**
   * Override the per-server connect timeout (ms). Defaults
   * to 5000 — long enough to spawn stdio servers, short
   * enough that a single misbehaving server can't hang the
   * whole CLI.
   */
  mcpTimeoutMs?: number
}

export interface BuiltAgent {
  readonly agent: Agent
  readonly provider: BaseProvider
  readonly tools: ToolRegistry
  readonly hooks: HookRegistry
  readonly config: LumenConfig
  readonly model: string
  /**
   * The memory store the agent was wired with, or `undefined`
   * when the caller asked for `noMemory: true`.
   */
  readonly memory?: SqliteStore
  /**
   * Connected MCP servers owned by this composition root. CLI commands
   * must close them when the run/chat session ends.
   */
  readonly mcpServers: DiscoveredMcpServer[]
}

/**
 * Read the Lumen config from disk + env, returning a fully validated
 * {@link LumenConfig}. CLI flags (when constructing {@link buildAgent})
 * are applied on top of this.
 */
export const loadCliConfig = async (configPath?: string): Promise<LumenConfig> => {
  return loadConfig({ projectPath: configPath })
}

/**
 * Build an {@link Agent} ready to run. This is the single place that
 * reads process.env.LUMEN_* style secrets and turns them into a real
 * Provider instance.
 */
export const buildAgent = async (options: CliAgentOptions = {}): Promise<BuiltAgent> => {
  const config = await loadCliConfig(options.configPath)
  const cwd = options.cwd ?? process.cwd()

  // Resolve provider config: CLI flag > env > first entry in config
  const apiKey =
    options.apiKey ??
    process.env.OPENAI_API_KEY ??
    process.env.LUMEN_API_KEY ??
    config.providers[0]?.apiKey ??
    ''
  const baseUrl =
    options.baseUrl ??
    process.env.OPENAI_BASE_URL ??
    process.env.LUMEN_BASE_URL ??
    config.providers[0]?.baseUrl ??
    'https://api.openai.com/v1'
  const model = options.model ?? config.defaultModel ?? process.env.LUMEN_MODEL ?? 'gpt-4o-mini'

  const provider: BaseProvider = new OpenAICompatibleProvider({
    id: 'openai',
    apiKey,
    baseUrl,
    defaultModel: model,
  })

  const tools = new ToolRegistry()
  if (!options.noTools) {
    for (const t of createFilesystemTools()) {
      tools.register(t)
    }
  }

  const hooks = new HookRegistry()

  // The CLI's default memory store is a per-user SQLite file
  // in `~/.lumen/memory.db`. We construct it **before** the
  // agent so the agent's first `appendMessage` finds the
  // schema already in place. We never pass `noMemory: true`
  // without also ensuring the caller is OK with ephemeral
  // sessions — that's why the flag is opt-out via env, not
  // opt-in via defaults.
  let memory: SqliteStore | undefined
  if (!options.noMemory) {
    const dbPath = options.memoryPath ?? defaultMemoryPath()
    memory = new SqliteStore({ path: dbPath })
    await memory.init()
  }

  const agent = new Agent({
    provider,
    tools,
    memory,
    hooks,
    config,
    model,
    cwd,
  })

  // MCP server discovery. We connect AFTER the Agent is
  // constructed so the Agent holds the registry reference
  // (any tools registered post-construction are visible to
  // the next `agent.run()` call). Failures are logged and
  // skipped — one broken server must not take down the CLI.
  let mcpServers: DiscoveredMcpServer[] = []
  if (!options.noMcp && config.mcp?.servers?.length) {
    mcpServers = await connectAllMcpServers(config.mcp.servers, tools, {
      timeoutMs: options.mcpTimeoutMs ?? 5_000,
    })
  }

  return { agent, provider, tools, hooks, config, model, memory, mcpServers }
}

/**
 * Default location for the CLI's SQLite memory database.
 *
 * `~/.lumen/memory.db` is the Lumen convention; it puts the
 * file under the user's home where every other tool (ssh,
 * docker, .gitconfig) also lives. Operators who want a
 * different location set `LUMEN_MEMORY_PATH` or pass
 * `--memory-path` (when those options land in the CLI args
 * surface).
 */
const defaultMemoryPath = (): string => {
  const override = process.env.LUMEN_MEMORY_PATH
  if (override) return override
  return path.join(os.homedir(), '.lumen', 'memory.db')
}
