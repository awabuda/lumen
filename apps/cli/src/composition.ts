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
import {
  type LumenConfig,
  type ProductAssembly,
  loadConfigWithProfile,
  profileNameToAssembly,
  resolveProductAssembly,
} from '@lumen/config'
import {
  type Agent,
  type BaseProvider,
  ConfigError,
  type DynamicRuntimeInputs,
  HookRegistry,
  PlanStore,
  type SectionContext,
  StablePromptCache,
  type ToolPermissionAutoModeBlock,
  type ToolPermissionPolicy,
  ToolPermissionPolicySchema,
  ToolRegistry,
  createAgent,
  createAutoModeMiddleware,
  createHeuristicRiskClassifier,
  createInterruptMiddleware,
  createPlanMiddleware,
  createReflectionMiddleware,
  createSkillTriggerMiddleware,
  createStaticToolPermissionPolicy,
  createToolPermissionMiddleware,
  loadOptionalContextFiles,
  loadProjectContext,
} from '@lumen/core'
import { OpenAICompatibleProvider } from '@lumen/llm'
import { type DiscoveredMcpServer, closeAllMcpServers, connectAllMcpServers } from '@lumen/mcp'
import { SqliteStore } from '@lumen/memory'
import { defaultSkillsPath } from '@lumen/skills'
import { HeuristicEvolver } from '@lumen/skills'
import { createBrowserTools, createFilesystemTools } from '@lumen/tools'
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
   * P24.4 (bug.md #9) — opt-in browser automation. The CLI
   * does NOT register `web_browser` by default (it has
   * `approval-required` risk and is high-trust-only). When
   * the operator passes `--web-browser`, the tool lands in
   * the agent's tool palette. The flag may be paired with
   * `webBrowserExe` to point at a system Chrome path (the
   * default is the bundled Playwright driver, which is
   * available on the dev sandbox).
   */
  webBrowser?: boolean
  /** Override the Chromium executable path. */
  webBrowserExe?: string
  /** Optional domain allow-list (see `WebBrowserTool.allowedDomains`). */
  webBrowserAllowedDomains?: ReadonlyArray<string>
  /**
   * P28.2 (bug.md #10 Path A) — opt-in coordinate-based
   * `computer_use` tool. The CLI does NOT register it by
   * default (it has `dangerous` risk). When the
   * operator passes `--computer-use`, the tool lands in
   * the agent's tool palette.
   */
  computerUse?: boolean
  /** Optional override for the Chromium executable
   *  path used by the `computer_use` tool. */
  computerUseExe?: string
  /** Optional domain allow-list for the coordinate-based
   *  tool's screenshot anchor (rare; default is "no
   *  enforcement"). */
  computerUseAllowedDomains?: ReadonlyArray<string>
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
  /**
   * P62: when true, skip wiring `createMemoryInjectMiddleware`.
   * The middleware reads `~/.lumen/MEMORY.md` + `USER.md` at
   * composition time and renders a frozen snapshot into the
   * system-prompt dynamic suffix on the first model call
   * (Hermes `MemoryStore._system_prompt_snapshot` parity,
   * `tools/memory_tool.py:178-211`). Default: false (memory
   * injection is ON). Mirrors the `lumen chat/run
   * --no-memory-inject` flag and `LUMEN_NO_MEMORY_INJECT=1`
   * env. Has no effect when `noMemory` is true (no
   * composition root has a memory file to read in that
   * case).
   */
  noMemoryInject?: boolean
  /**
   * P33.B Day4 — programmatic override for the
   * ProductAssembly name. Higher priority than
   * `config.product.assembly` and the profile default.
   * Used by the `--profile bare` CLI flag and the
   * `LUMEN_PRODUCT` env var. Unknown names fall back to
   * `assistant` per the resolver in
   * {@link resolveProductAssembly}.
   */
  product?: string
  /**
   * P33.B Day5 — opt out of the assistant-assembly
   * reflection middleware. Default `undefined` /
   * `true` = reflection mounts; `false` = skip.
   * Per P19+ rule 11 this is an opt-out, not a
   * `enableReflection` boolean flag (the assembly
   * bundle IS the configuration surface).
   */
  enableReflection?: boolean
  /**
   * P33.B Day5 — opt out of the assistant-assembly plan
   * middleware. Default `undefined` = plan mounts;
   * `false` = skip.
   */
  enablePlan?: boolean
  /**
   * P34.5.b — when true, every `approval-required` or
   * `dangerous` tool call is auto-allowed (after the
   * approver is consulted). This is the inverse of
   * `--deny-all`; both cannot be set at once. Useful
   * for scripted runs where the operator has reviewed
   * the agent's plan in advance. Per P19+ rule 11 the
   * approver is still a callback, not a boolean — this
   * option threads a pre-resolved map into the approver
   * factory so the callback can answer consistently.
   */
  approveAll?: boolean
  /**
   * P34.5.b — when true, every `approval-required` or
   * `dangerous` tool call is hard-denied. Mirror of
   * `approveAll`. Useful for sandboxed CI runs.
   */
  denyAll?: boolean
  /** P34.2 — opt out of the assistant-assembly skill
   *  evolution middleware. Default `undefined` =
   *  evolution mounts (when the assembly bundles
   *  `skillEvolution: 'trajectory'`); `true` = skip. */
  noSkillEvolve?: boolean
  /**
   * P33.B Day5 — opt out of the assistant-assembly
   * tool-permission middleware. Default `undefined` =
   * permission mounts; `true` = skip (operator has no
   * permissions file or wants the bare behaviour).
   */
  noPermission?: boolean
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
   * P34.3 (Phase B.3) — the live `PlanStore` that
   * PlanMiddleware writes into. The `/plan` slash
   * command reads this for the TUI snapshot. When
   * PlanMiddleware is not mounted (bare assembly /
   * `--no-plan`) the field is `undefined`.
   */
  readonly planStore?: PlanStore
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
  const { profile: _p, ...config } = await loadConfigWithProfile({ projectPath: configPath })
  // P33.B Day4 — composition root no longer needs the
  // resolved profile name (it is consumed by the
  // middleware-wiring branch in `buildAgent`); strip it
  // from the public return shape so callers that imported
  // `loadCliConfig` for the bare LumenConfig keep their
  // original type.
  void _p
  return config
}

/**
 * P33.B Day4 — resolve the ProductAssembly for this
 * composition root. The decision reads (highest priority
 * first):
 *   1. `options.product` (programmatic override — used by
 *      CLI flags like `--profile bare` or
 *      `LUMEN_PRODUCT=off`).
 *   2. `config.product.assembly` from
 *      `~/.lumen/config.yaml` (operator-declared slice).
 *   3. The profile-system default: `bare` profile →
 *      `bare` assembly, anything else → `assistant`.
 *
 * Unknown assembly names fall back to the system default
 * (`assistant`) per OPTIMIZATION-PLAN §3 G-T1 / §2 A.1
 * (graceful degradation). The caller receives the
 * concrete {@link ProductAssembly} bundle; mapping the
 * abstract `middleware` name list to actual factory
 * calls stays in `buildAgent`.
 */
export const resolveCliAssembly = (
  config: LumenConfig & { readonly profile?: string },
  options: CliAgentOptions,
): ProductAssembly => {
  const productOverride = options.product
  if (productOverride !== undefined) {
    const known = resolveProductAssembly(productOverride)
    return known
  }
  if (config.product?.assembly !== undefined) {
    return resolveProductAssembly(config.product.assembly)
  }
  const profile = config.profile ?? 'default'
  return resolveProductAssembly(profileNameToAssembly(profile))
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
  // Resolve the model from the highest-priority source
  // down. Hard-coded `gpt-4o-mini` was removed (P-ticket
  // 2026-07-29 audit GAP-2 follow-up): it was only valid on
  // the OpenAI endpoint and caused silent 2013 rejections on
  // every other OpenAI-compatible provider (MiniMax, local
  // llama.cpp, Mistral, etc.).
  //
  // Resolution order:
  //   1. CLI --model flag (per-invocation override)
  //   2. config.defaultModel from ~/.lumen/config.yaml
  //   3. LUMEN_MODEL env var
  //   4. LUMEN_DEFAULT_MODEL env var (CI / one-off scripts)
  //
  // When none of the four resolve, fail loud with a typed
  // ConfigError so the operator sees "no model configured"
  // instead of "unknown model 'gpt-4o-mini'" after a wasted
  // network round-trip. `run.ts` ALSO prints a pre-flight
  // warning before reaching here; this throw is the
  // belt-and-braces guard for non-`run` entrypoints (chat,
  // computer, team run, etc.) that bypass the pre-flight.
  const model =
    options.model ??
    config.defaultModel ??
    process.env.LUMEN_MODEL ??
    process.env.LUMEN_DEFAULT_MODEL
  if (model === undefined || model.length === 0) {
    throw new ConfigError(
      'No LLM model configured. Pass --model <id>, set `defaultModel` under the `agent:` ' +
        'config block, or set the LUMEN_MODEL (or LUMEN_DEFAULT_MODEL) environment variable. ' +
        '(Lumen no longer ships a hard-coded default because OpenAI-only model ids fail ' +
        'silently on every other OpenAI-compatible endpoint.)',
    )
  }

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
    // P24.4 (bug.md #9) — opt-in browser automation.
    // The flag is FALSE by default because web_browser is
    // approval-required; operators enable it via
    // `--web-browser` on `lumen run`.
    if (options.webBrowser === true) {
      const browserTools = createBrowserTools()
      if (browserTools.length > 0 && browserTools[0] !== undefined) {
        const browser = browserTools[0]
        const browserOpts: { executablePath?: string; allowedDomains?: ReadonlyArray<string> } = {}
        if (options.webBrowserExe !== undefined) browserOpts.executablePath = options.webBrowserExe
        if (options.webBrowserAllowedDomains !== undefined) {
          browserOpts.allowedDomains = options.webBrowserAllowedDomains
        }
        const Ctor = browser.constructor as new (opts: typeof browserOpts) => typeof browser
        tools.register(new Ctor(browserOpts))
      }

      // P28.2 (bug.md #10 Path A) — opt-in coordinate-based
      // computer_use tool. Off by default (dangerous
      // risk). The flag is FALSE by default because
      // computer_use is `dangerous` and only well-scoped
      // operators should enable it.
      if (options.computerUse === true) {
        const { createComputerTools } = await import('@lumen/tools')
        const computerTools = createComputerTools()
        if (computerTools.length > 0 && computerTools[0] !== undefined) {
          const computer = computerTools[0]
          const computerOpts: {
            executablePath?: string
            allowedDomains?: ReadonlyArray<string>
          } = {}
          if (options.computerUseExe !== undefined) {
            computerOpts.executablePath = options.computerUseExe
          }
          if (options.computerUseAllowedDomains !== undefined) {
            computerOpts.allowedDomains = options.computerUseAllowedDomains
          }
          const Ctor2 = computer.constructor as new (opts: typeof computerOpts) => typeof computer
          tools.register(new Ctor2(computerOpts))
        }
      }
    }
  }

  const hooks = new HookRegistry()
  // P34.3 — collect every PlanStore the composition
  // root instantiates so the first one is surfaced on
  // `built.planStore` for the `/plan` slash command.
  // Today there is exactly one (PlanMiddleware is
  // mounted at most once per buildAgent call), but the
  // list shape keeps the door open for future
  // multi-plan scenarios (per-agent plans, sub-agent
  // plans, …).
  const planStores: PlanStore[] = []

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
  //
  // P33.B Day4 — ProfileAssembly gate. When the resolved
  // assembly is `bare`, the middleware array stays empty
  // regardless of any opt-in flag the caller passed. This is
  // the operator's "escape hatch" (per OPTIMIZATION-PLAN §3
  // G-P6): `defaultProfile: bare`, `--profile bare`, or
  // `LUMEN_PRODUCT=off` all bypass every middleware, even
  // when the caller would otherwise have enabled one. The
  // bare assembly is the only path Day4 wires from the
  // profile system into composition; the assistant default
  // (auto-mount plan / permission / skill / interrupt /
  // reflection) ships in Day5 so we do not regress the 17
  // existing call sites that rely on opt-in flags.
  const assembly = resolveCliAssembly({ ...config, profile: 'default' }, options)
  const middleware: import('@lumen/core').AgentMiddleware[] = []
  if (assembly.middleware.length > 0) {
    // P33.B Day5 — assistant assembly default wiring.
    // When the resolved bundle is non-bare (operator
    // opted into `assistant` via `defaultProfile`,
    // `--profile assistant`, `product: 'assistant'`, or
    // the bare default), the composition root auto-mounts
    // the bundled middleware unless the caller passed an
    // explicit opt-out (`--no-reflection`,
    // `--no-plan`, `--no-skill-trigger`,
    // `--no-permission`). The legacy opt-in flags
    // (`enablePlanMiddleware`, `enableSkillTrigger`,
    // `permissionsPath`) remain authoritative for
    // callers that want to force-enable a specific
    // middleware without opting into the bundle.
    //
    // Per OPTIMIZATION-PLAN §7 Day5, this is the
    // "开箱像助手" milestone — bare `lumen run` gets
    // plan + permission + skill + reflection without
    // any flag. The 17 existing call sites that
    // previously relied on opt-in flags keep working
    // (they were opt-in, so an additional auto-mount is
    // additive — non-`assistant` assemblies still bypass
    // the bundled defaults).
    const reflectionEnabled = options.enableReflection !== false
    const planEnabled = options.enablePlan !== false
    const skillEnabled = options.enableSkillTrigger !== false
    const permissionEnabled = options.noPermission !== true
    const reflectionConfig = assembly.reflection
    if (reflectionEnabled && assembly.middleware.includes('reflection')) {
      // Inline confidence is the cheap, opt-in path
      // (1 token appended to the assistant message). The
      // memory for run-end is the SqliteStore already
      // constructed below; pass `memory: undefined` here
      // and let the middleware no-op the run-end write if
      // memory is absent at the call site (it isn't — the
      // composition root always builds one for non-bare
      // assemblies, unless `noMemory: true`).
      // The `runEnd` field on `ProductAssembly` is typed
      // 'rule' | 'off' to match `createReflectionMiddleware`'s
      // accepted runEnd union. The literal is declared
      // here so the compiler narrows the optional
      // assignment without a runtime check.
      const runEnd = reflectionConfig.runEnd
      middleware.push(
        createReflectionMiddleware({
          inline: reflectionConfig.inline,
          ...(runEnd !== undefined ? { runEnd } : {}),
          ...(memory !== undefined ? { memory } : {}),
        }),
      )
    }
    if (planEnabled && assembly.middleware.includes('plan')) {
      const planStore = new PlanStore()
      planStores.push(planStore)
      middleware.push(createPlanMiddleware({ mode: assembly.planMode, planStore }))
    }
    if (permissionEnabled && assembly.middleware.includes('tool-permission')) {
      // The default permissions file path is the
      // operator's `~/.lumen/permissions.yaml`. When the
      // file is missing we silently skip the gate
      // (operator has not run `lumen init` yet); a
      // malformed file IS a loud error so a misconfigured
      // bundle cannot silently drop protection.
      const path = assembly.permissionsDefaultPath
      if (path !== undefined) {
        try {
          const parsed = await loadPermissionPolicyFromFile(path)
          const policy = createStaticToolPermissionPolicy(parsed)
          middleware.push(createToolPermissionMiddleware({ policy }))
          if (parsed.autoMode && parsed.autoMode.enabled === true) {
            const autoModeRules: ToolPermissionAutoModeBlock = parsed.autoMode
            const classifier = createHeuristicRiskClassifier({ rules: autoModeRules })
            middleware.push(createAutoModeMiddleware({ classifier }))
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          // ENOENT is the common case (operator has not
          // run `lumen init`); anything else is a real
          // config error and worth surfacing.
          if (!/not found|ENOENT/.test(message)) {
            process.stderr.write(
              `lumen: assistant assembly default permission file unreadable (${path}): ${message}\n`,
            )
          }
        }
      }
    }
    if (skillEnabled && assembly.middleware.includes('skill-trigger')) {
      try {
        const skillsRoot = options.skillsPath ?? defaultSkillsPath()
        const registry = await loadSkillRegistry(skillsRoot)
        const triggerFn = buildKeywordTriggerFn({ registry, cwd })
        const zodCompatTrigger = async (userMessage: string) => [...(await triggerFn(userMessage))]
        middleware.push(createSkillTriggerMiddleware({ trigger: zodCompatTrigger }))
      } catch (err) {
        process.stderr.write(
          `lumen: assistant assembly skill-trigger wiring skipped: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        )
      }
    }
    // P62 — auto-inject MEMORY.md / USER.md into the system
    // prompt. The middleware closes over a frozen snapshot
    // loaded at composition time (snapshot bytes are stable
    // for the entire session; see Hermes `_system_prompt_snapshot`
    // and P62 design doc). `noMemoryInject: true` opts out;
    // the snapshot loader is also a no-op when `noMemory: true`
    // (no memory file would be useful in that case). The
    // threat pattern scan happens inside `loadMemorySnapshot`
    // (apps/cli/src/memory-snapshot.ts) — a poisoned entry
    // becomes `[BLOCKED: <file> entry contained pattern: <id>]`
    // in the snapshot, the original stays in the markdown
    // file for the user to inspect.
    if (options.noMemory !== true && options.noMemoryInject !== true) {
      try {
        const { loadMemorySnapshot } = await import('./memory-snapshot.js')
        const { createMemoryInjectMiddleware } = await import('@lumen/core')
        const snapshot = await loadMemorySnapshot()
        middleware.push(createMemoryInjectMiddleware({ snapshot }))
      } catch (err) {
        process.stderr.write(
          `lumen: P62 memory-inject wiring skipped: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        )
      }
    }
    // P34.2 (Phase B.2) — skill auto-evolution on afterRun.
    // The assistant assembly's `skillEvolution` field is
    // `'trajectory'` (P33.B Day1 set `'reserved'`; P34.2
    // flips it). When the assembly bundles evolver
    // behaviour AND the operator did not pass
    // `--no-skill-evolve`, we mount an afterRun hook that
    // calls `HeuristicEvolver.evolve` with the final
    // message history. The evolver writes a new
    // SKILL.md into the skills dir on success.
    //
    // This is best-effort (stderr noise on failure,
    // never throws out of afterRun) per the P19+ pattern
    // for evolution hooks. Future P-ticket replaces
    // `HeuristicEvolver` with an LLM-backed evolver
    // (`LLMEvolver`) gated on a config flag.
    if (assembly.skillEvolution === 'trajectory' && options.noSkillEvolve !== true) {
      try {
        const skillsRoot = options.skillsPath ?? defaultSkillsPath()
        const evolver = new HeuristicEvolver()
        middleware.push({
          name: 'skill-evolution',
          afterRun: async (result, _ctx) => {
            try {
              // HeuristicEvolver reads `role` + a string
              // `content`. The shape comes from
              // @lumen/core's Message discriminated
              // union: assistant content is
              // `string | undefined`; user / system
              // content is `string | ContentPart[]`;
              // tool messages have no `content`. We
              // collapse each variant to a plain
              // `{role: string, content: string}` for
              // the evolver; tool-call *count* is what
              // HeuristicEvolver actually uses, and
              // role='tool' messages count as the
              // tool-call signal.
              const evolverMessages: Array<{ role: string; content: string; toolName?: string }> =
                []
              for (const m of result.messages) {
                if (m.role === 'tool') {
                  evolverMessages.push({ role: 'tool', content: '' })
                  continue
                }
                let text = ''
                if (m.role === 'assistant') {
                  text = m.content ?? ''
                } else {
                  const c = m.content
                  if (typeof c === 'string') {
                    text = c
                  } else {
                    text = c
                      .filter(
                        (p): p is { type: 'text'; text: string } =>
                          'type' in p && p.type === 'text',
                      )
                      .map((p) => p.text)
                      .join(' ')
                  }
                }
                evolverMessages.push({ role: m.role, content: text })
              }
              await evolver.evolve(evolverMessages, await loadSkillRegistry(skillsRoot), skillsRoot)
            } catch (err) {
              process.stderr.write(
                `lumen: skill evolution skipped (${err instanceof Error ? err.message : String(err)})\n`,
              )
            }
          },
        })
      } catch (err) {
        process.stderr.write(
          `lumen: skill evolution wiring skipped: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        )
      }
    }
  } else {
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
      // P22.5.1: when the policy file declares an autoMode
      // block with enabled=true, wire the heuristic classifier
      // in front of the interrupt chain. The classifier
      // short-circuits `allow` decisions (operator's explicit
      // opt-in); `ask` falls through to the interrupt chain
      // unchanged. Composition order is alphabetical by
      // `name` (tool-permission < tool-permission-auto <
      // interrupt), so this is naturally correct.
      if (parsed.autoMode && parsed.autoMode.enabled === true) {
        const autoModeRules: ToolPermissionAutoModeBlock = parsed.autoMode
        const classifier = createHeuristicRiskClassifier({ rules: autoModeRules })
        middleware.push(createAutoModeMiddleware({ classifier }))
      }
    }
    if (options.enablePlanMiddleware === true) {
      const planStore = new PlanStore()
      planStores.push(planStore)
      middleware.push(createPlanMiddleware({ mode: options.planMode ?? 'auto', planStore }))
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
  } // P33.B Day4 — close the `else` branch (bare-assembly override).

  // P31.8 — compose the layered system-prompt context for
  // this agent. The CLI holds one shared `StablePromptCache`
  // per process so `lumen chat` (which constructs a fresh
  // Agent per session) amortises the layered prompt render
  // across consecutive turns whose stable inputs are
  // unchanged.
  const sessionId = `chat-${Math.random().toString(36).slice(2, 10)}`
  const systemPromptContext = await composeSystemPromptContext(cwd, sessionId, model)
  // P34.5.b — `--approve-all` / `--deny-all` flags wire
  // a deterministic approver into the agent. The
  // approver is still a callback (P19+ rule 11) — we
  // pre-resolve the decision from the flag rather than
  // mutating `AgentConfig` boolean. `approveAll` and
  // `denyAll` are mutually exclusive; composition
  // callers should not pass both (we honour whichever
  // is `true`, defaulting to approveAll in the rare
  // typo'd-both case). When neither is set, the
  // approver is `undefined` and the dispatch path
  // falls back to the P33.B Day3 refusal behaviour.
  const approver =
    options.approveAll === true
      ? async () => 'allow' as const
      : options.denyAll === true
        ? async () => 'deny' as const
        : undefined
  const agent = createAgent({
    provider,
    tools,
    memory,
    hooks,
    config,
    model,
    cwd,
    ...(approver !== undefined ? { approver } : {}),
    middleware,
    systemPromptContext,
    systemPromptCache: getSharedPromptCache(),
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

  return {
    agent,
    provider,
    tools,
    hooks,
    config,
    model,
    memory,
    planStore: planStores[0],
    mcpServers,
  }
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

// ---------------------------------------------------------------------------
// P31.8 — composition-root wiring for the layered system prompt.
//
// `buildAgent` is the single composition root in the CLI; it is the
// place where `LumenConfig` + cwd + session id become concrete
// `Provider` / `ToolRegistry` / `SectionContext` instances. Pre-P31.8
// the `createAgent({...})` call passed neither `systemPromptContext`
// nor `systemPromptCache`, so the agent fell back to the bundled
// `DEFAULT_SYSTEM_PROMPT` and the P31 layered-prompt + cache surface
// the other P31.* commits shipped was effectively orphaned.
//
// P31.8 composes the `SectionContext` here and threads it through
// `createAgent`, so `lumen run` / `lumen chat` / `lumen chat-loop`
// actually exercise the P31 sections (K0 / P1 / P2 / G1 / G2 / B1 /
// M1 + D1 Runtime) and the LRU cache shipped by P31.4 / P31.6C.
// ---------------------------------------------------------------------------

/**
 * Build the {@link SectionContext} the Agent's
 * `systemPromptContext` will render. Walks the cwd to git
 * root for AGENTS.md / CLAUDE.md (P1), then loads the
 * profile-gated optional context files (P2 / B1 / M1).
 * The runtime layer is built from the composition's
 * session state.
 */
export const composeSystemPromptContext = async (
  cwd: string,
  sessionId: string,
  model: string,
  profile: CliProfileFlags = {},
): Promise<SectionContext> => {
  // P1 — walk-up AGENTS.md / CLAUDE.md. The loader returns
  // the body string or undefined.
  const projectText = await loadProjectContext({ cwd })
  // P2 / B1 / M1 — profile-gated optional context files.
  // The P31.3 loader returns persona / bootstrap / memory;
  // guidance and skillsIndex are built internally by the
  // assembler from the default texts and the SkillRegistry
  // (P31.2 §1.2 G1 / G2), so they are not fields on the
  // loader result.
  const optional = await loadOptionalContextFiles({
    cwd,
    personas: profile.persona === true ? (['SOUL', 'IDENTITY', 'USER'] as const) : undefined,
    bootstrap: profile.bootstrap === true,
    memorySnapshot: profile.memorySnapshot === true,
  })
  const runtime: DynamicRuntimeInputs = {
    sessionId,
    cwd,
    model,
    capturedAtIso: new Date().toISOString(),
  }
  return {
    profile: {
      persona: profile.persona === true,
      bootstrap: profile.bootstrap === true,
      skillsIndex: profile.skillsIndex === true,
      memorySnapshot: profile.memorySnapshot === true,
    },
    projectText: projectText || undefined,
    personaText: optional?.persona,
    bootstrapText: optional?.bootstrap,
    memorySnapshotText: optional?.memorySnapshot,
    runtime,
  }
}

/**
 * Profile flags consumed by the P31 layered prompt
 * assembler. Reflects the values the operator opted into
 * via `lumen init --with-context` plus CLI flags that
 * toggle the same layers (P33.A's `lumen doctor --product`
 * surfaces the resolver).
 */
export interface CliProfileFlags {
  readonly persona?: boolean
  readonly bootstrap?: boolean
  readonly skillsIndex?: boolean
  readonly memorySnapshot?: boolean
}

/**
 * Shared cache for the layered system prompt. The CLI holds
 * one instance per `lumen chat` session so consecutive
 * `agent.run` calls hit the cache when the stable inputs
 * are unchanged (P31.6C). `lumen run` is single-shot and
 * the cache is GC'd at process exit.
 */
let sharedChatCache: StablePromptCache | undefined

/**
 * Get-or-create the shared {@link StablePromptCache}.
 * Used by `buildAgent` so subsequent agents in the same
 * Node process amortise the layered prompt render.
 */
export const getSharedPromptCache = (): StablePromptCache => {
  if (sharedChatCache === undefined) {
    sharedChatCache = new StablePromptCache()
  }
  return sharedChatCache
}

/** Reset hook for tests; production code never touches this. */
export const _resetSharedPromptCacheForTests = (): void => {
  sharedChatCache = undefined
}
