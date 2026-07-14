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
import {
  type Agent,
  type BaseProvider,
  ConfigError,
  HookRegistry,
  type ToolPermissionPolicy,
  ToolPermissionPolicySchema,
  ToolRegistry,
  createAgent,
  createInterruptMiddleware,
  createPlanMiddleware,
  createSkillTriggerMiddleware,
  createStaticToolPermissionPolicy,
  createToolPermissionMiddleware,
} from '@lumen/core'
import { OpenAICompatibleProvider } from '@lumen/llm'
import { type DiscoveredMcpServer, closeAllMcpServers, connectAllMcpServers } from '@lumen/mcp'
import { SqliteStore } from '@lumen/memory'
import { defaultSkillsPath } from '@lumen/skills'
import { createFilesystemTools } from '@lumen/tools'
import { loadSkillRegistry } from './commands/skills.js'
import { loadPermissionPolicyFromFile } from './permissions-loader.js'
import { buildKeywordTriggerFn } from './skill-trigger-adapter.js'

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
  /**
   * P19.0.3 / P19.1 wire-up: when true, build the agent via
   * `createAgent({ ...config, middleware: [createPlanMiddleware({ mode: 'auto' })] })`
   * instead of `new Agent({...})`. The factory path is the only
   * documented way to layer middleware on the agent loop; CLI
   * commands that want plan/act behaviour opt in here.
   *
   * Default: false. The bare `new Agent({...})` path is preserved
   * for backward compatibility — existing CLI commands that
   * don't opt in keep their original behaviour exactly.
   */
  enablePlanMiddleware?: boolean
  /**
   * P19.1 plan mode override. Only meaningful when
   * `enablePlanMiddleware` is true. Defaults to `'auto'`
   * (first turn plans, second turn acts). Other values:
   * `'plan'` (plan only, never act) and `'act'` (act without
   * a planning turn).
   */
  planMode?: 'plan' | 'act' | 'auto'
  /**
   * P20.1.3: when set, wire `createInterruptMiddleware({ toolNames })`
   * into the agent loop. Each entry in the array is a tool
   * name whose dispatch will throw `AbortError` so the
   * P20.4.2 catch path can auto-save a checkpoint. Mirrors
   * the `lumen run --interrupt-on <tool-name>` CLI flag.
   * Multiple tools can be listed; an empty array is a no-op.
   */
  interruptOn?: ReadonlyArray<string>
  /**
   * P20.1.2 follow-up: pre-approve a list of tool names so
   * they bypass the `interruptOn` AbortError. Used by the
   * TUI's persistent approve list and by the CLI
   * `--approve-on` flag. When both `interruptOn` and
   * `approveOn` contain the same name, the tool always
   * dispatches (the rule effectively becomes a no-op for
   * that tool). Empty / undefined is a no-op.
   */
  approveOn?: ReadonlyArray<string>
  /**
   * P22.2: optional path to a YAML permission policy file.
   * When set, the composition root wires
   * `createToolPermissionMiddleware({ policy: loadPolicy(path) })`
   * in front of the interrupt chain. A non-existent file
   * throws a typed `ConfigError`; a malformed file throws
   * with the Zod issue list. When omitted, the bare path
   * runs (no permission middleware) so pre-P22 commands
   * keep their original behaviour.
   */
  permissionsPath?: string
  /**
   * P20.6.2: when true, wire `createSkillTriggerMiddleware`
   * into the agent loop. The trigger function is built from
   * the discovered `SkillRegistry` (see {@link CliAgentOptions.skillsPath})
   * via `buildKeywordTriggerFn`, so skill activation is
   * driven by the registry's default keyword scoring
   * (`BaseSkill.shouldActivate` walks each skill's declared
   * `triggers`). Mirrors the `lumen run --enable-skill-trigger`
   * CLI flag.
   *
   * Default: false. Bare `lumen run` sessions that have not
   * opted in keep the pre-P20.6.2 behaviour (no skill
   * activation, no extra system-prompt augmentation).
   */
  enableSkillTrigger?: boolean
  /**
   * P20.6.2: override the skill root directory used when
   * `enableSkillTrigger` is true. Defaults to
   * `defaultSkillsPath()` (`~/.lumen/skills`). Mirrors the
   * `lumen run --skills-path <path>` CLI flag. Has no effect
   * when `enableSkillTrigger` is false.
   */
  skillsPath?: string
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
  // P19.0.3 / P19.1 / P20.1.3 wire-up: when an opt-in flag is
  // set, the composition root goes through `createAgent({ ...config, middleware })`
  // instead of `new Agent({...})`. This is the only documented
  // way to layer middleware on the agent loop (lumen P19+ rule
  // 11: middleware > AgentConfig boolean flag). Default is the
  // bare path so existing CLI commands that have not opted in
  // keep their original behaviour exactly.
  const middleware: import('@lumen/core').AgentMiddleware[] = []
  // P22.2: permission policy is the outermost gate. When the
  // file is missing or malformed we surface the typed
  // ConfigError rather than silently fall through, because
  // a misconfigured permission file is a security incident
  // (the operator expects the rule to fire, but it would
  // not). The wiring is opt-in: callers that do not pass
  // `permissionsPath` keep the pre-P22 behaviour exactly.
  if (options.permissionsPath !== undefined) {
    const parsed = await loadPermissionPolicyFromFile(options.permissionsPath)
    const policy = createStaticToolPermissionPolicy(parsed)
    middleware.push(createToolPermissionMiddleware({ policy }))
  }
  if (options.enablePlanMiddleware === true) {
    middleware.push(createPlanMiddleware({ mode: options.planMode ?? 'auto' }))
  }
  if (options.interruptOn && options.interruptOn.length > 0) {
    const approveSet = new Set(options.approveOn ?? [])
    middleware.push(
      createInterruptMiddleware({
        toolNames: [...options.interruptOn],
        ...(approveSet.size > 0
          ? {
              approve: (call: { readonly name: string }) =>
                Promise.resolve(approveSet.has(call.name)),
            }
          : {}),
      }),
    )
  }
  // P20.6.2: skill-trigger wiring. Opt-in via
  // `enableSkillTrigger: true` so a bare `lumen run` keeps
  // the pre-P20.6.2 behaviour (no skill activation, no
  // system-prompt augmentation). The adapter bridges the
  // `@lumen/skills` registry shape into the middleware's
  // `SkillTriggerFn` shape; see `skill-trigger-adapter.ts`
  // for the contract. Skill discovery is async and may
  // fail on a misconfigured path; we log and proceed
  // without the middleware rather than aborting the run,
  // so a broken skills directory never blocks the agent.
  if (options.enableSkillTrigger === true) {
    try {
      const skillsRoot = options.skillsPath ?? defaultSkillsPath()
      const registry = await loadSkillRegistry(skillsRoot)
      const triggerFn = buildKeywordTriggerFn({ registry, cwd })
      // The adapter's return type is ReadonlyArray<ActiveSkill> but
      // Zod's z.function().returns() infers a mutable array; spread
      // through a fresh array so the type is assignable and we never
      // hand the registry a typed mutable view.
      const zodCompatTrigger = async (userMessage: string) => [...(await triggerFn(userMessage))]
      middleware.push(createSkillTriggerMiddleware({ trigger: zodCompatTrigger }))
    } catch (err) {
      process.stderr.write(
        `lumen: skill trigger wiring skipped: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  const agent = createAgent({
    provider,
    tools,
    memory,
    hooks,
    config,
    model,
    cwd,
    middleware,
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
