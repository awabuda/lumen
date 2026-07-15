/**
 * CLI entry point. Uses commander for argument parsing and dispatches
 * to the appropriate command module. The TUI command (chat) is loaded
 * lazily because it pulls in Ink/React.
 */

import { Command } from 'commander'

const program = new Command()

program
  .name('lumen')
  .description('A self-improving TypeScript agent framework')
  .version('0.1.0')
  .option('-m, --model <model>', 'Override the LLM model (default: chat)')
  .option('-c, --config <path>', 'Path to a Lumen config file (default: chat)')
  .option('--cwd <path>', 'Working directory for tool execution (default: chat)')

program
  .command('run')
  .description('Run a single prompt and print the result, then exit')
  .argument('<prompt>', 'The prompt to send to the agent')
  .option('-m, --model <model>', 'Override the LLM model')
  .option('-c, --config <path>', 'Path to a Lumen config file')
  .option('--cwd <path>', 'Working directory for tool execution')
  .option('--api-key <key>', 'Override the API key')
  .option('--base-url <url>', 'Override the API base URL')
  .option('--no-tools', 'Disable filesystem tools')
  .option('--memory-path <path>', 'Override the SQLite memory database path')
  .option('--no-memory', 'Run without wiring a memory store')
  .option('--no-mcp', 'Skip MCP server discovery and connection')
  .option('--interrupt-on <names>', 'Comma-separated tool names to interrupt on (HITL)')
  .option(
    '--approve-on <names>',
    'Comma-separated tool names to pre-approve when they appear in --interrupt-on. The TUI can also /approve on the fly; this flag is the static allow-list.',
  )
  .option(
    '--permissions <path>',
    'Path to a YAML tool-permission policy file (P22.2). The file is validated against the Zod policy schema; a missing or malformed file throws a typed ConfigError.',
  )
  .option(
    '--auto-mode',
    "P22.5.3: print a one-line status that auto-mode is enabled (based on the policy file's autoMode.enabled flag). The flag does NOT override the policy file; the file is the source of truth. Requires --permissions.",
  )
  .option('--plan [mode]', "Wire PlanMiddleware; mode is 'plan' / 'act' / 'auto' (default 'auto')")
  .option('--checkpoint <path>', 'Path to a SQLite checkpoint database (P20.4)')
  .option('--session-id <id>', 'Scope durable checkpoints and auto-resume to one session')
  .option('--no-resume', 'Do not resume a fresh in-progress checkpoint')
  .option('--resume-ttl <ms>', 'Maximum checkpoint age for auto-resume (default 600000)')
  .option('--checkpoint-interval <steps>', 'Save every N completed steps (default 1)')
  .option(
    '--enable-skill-trigger',
    'Wire SkillTriggerMiddleware (P20.6.2). Activates skills from the local skill registry (default ~/.lumen/skills) by keyword-matching each user message and injects active skill descriptions into the system prompt. Off by default to preserve the pre-P20.6.2 behaviour.',
  )
  .option(
    '--skills-path <path>',
    'Override the skill root directory used with --enable-skill-trigger (defaults to the LUMEN_SKILLS_PATH env var or ~/.lumen/skills).',
  )
  .action(async (prompt: string, opts: Record<string, unknown>) => {
    const { runCommand } = await import('./commands/run.js')
    const splitNames = (raw: string | undefined): ReadonlyArray<string> | undefined =>
      raw === undefined || raw.length === 0
        ? undefined
        : raw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
    const interruptOn = splitNames(opts.interruptOn as string | undefined)
    const approveOn = splitNames(opts.approveOn as string | undefined)
    const planRaw = opts.plan as string | boolean | undefined
    const planMode =
      planRaw === true || planRaw === undefined ? undefined : (planRaw as 'plan' | 'act' | 'auto')
    const code = await runCommand({
      prompt,
      model: opts.model as string | undefined,
      configPath: opts.config as string | undefined,
      cwd: opts.cwd as string | undefined,
      apiKey: opts.apiKey as string | undefined,
      baseUrl: opts.baseUrl as string | undefined,
      noTools: opts.tools === false,
      memoryPath: opts.memoryPath as string | undefined,
      noMemory: opts.memory === false,
      noMcp: opts.mcp === false,
      interruptOn,
      approveOn,
      permissionsPath: opts.permissions as string | undefined,
      autoMode: opts.autoMode === true,
      enablePlanMiddleware: planRaw !== undefined,
      planMode,
      checkpointPath: opts.checkpoint as string | undefined,
      sessionId: opts.sessionId as string | undefined,
      noResume: opts.resume === false,
      resumeTtlMs:
        typeof opts.resumeTtl === 'string' ? Number.parseInt(opts.resumeTtl, 10) : undefined,
      checkpointInterval:
        typeof opts.checkpointInterval === 'string'
          ? Number.parseInt(opts.checkpointInterval, 10)
          : undefined,
      enableSkillTrigger: opts.enableSkillTrigger === true,
      skillsPath: opts.skillsPath as string | undefined,
    })
    process.exit(code)
  })

program
  .command('chat')
  .description('Start an interactive TUI chat session')
  .option('-m, --model <model>', 'Override the LLM model')
  .option('-c, --config <path>', 'Path to a Lumen config file')
  .option('--cwd <path>', 'Working directory for tool execution')
  .option('--permissions <path>', 'Path to a YAML tool-permission policy file (P22.2)')
  .option('--checkpoint <path>', 'Path to a SQLite checkpoint database')
  .option('--no-resume', 'Do not resume a fresh in-progress checkpoint')
  .option('--resume-ttl <ms>', 'Maximum checkpoint age for auto-resume (default 600000)')
  .option('--checkpoint-interval <steps>', 'Save every N completed steps (default 1)')
  .option(
    '--interrupt-on <names>',
    'Comma-separated tool names to interrupt on (HITL). When a tool in this list is about to dispatch, the run aborts and the TUI surfaces the AbortError message.',
  )
  .option(
    '--approve-on <names>',
    'Comma-separated tool names to pre-approve on the interrupt list (TUI lets the user /approve on the fly; this flag is the static allow-list).',
  )
  .action(async (opts: Record<string, unknown>) => {
    // Lazy-load Ink only when actually entering the TUI.
    const { chatCommand } = await import('./commands/chat.js')
    // Parse --interrupt-on / --approve-on the same way as
    // `lumen run`: comma split, trim, drop empties. Empty /
    // missing list = no interrupt rules, matching the
    // pre-P20.1.2 chat behaviour.
    const splitNames = (raw: string | undefined): ReadonlyArray<string> | undefined =>
      raw === undefined || raw.length === 0
        ? undefined
        : raw
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
    const interruptOn = splitNames(opts.interruptOn as string | undefined)
    const approveOn = splitNames(opts.approveOn as string | undefined)
    const code = await chatCommand({
      model: opts.model as string | undefined,
      configPath: opts.config as string | undefined,
      cwd: opts.cwd as string | undefined,
      interruptOn,
      approveOn,
      permissionsPath: opts.permissions as string | undefined,
      checkpointPath: opts.checkpoint as string | undefined,
      noResume: opts.resume === false,
      resumeTtlMs:
        typeof opts.resumeTtl === 'string' ? Number.parseInt(opts.resumeTtl, 10) : undefined,
      checkpointInterval:
        typeof opts.checkpointInterval === 'string'
          ? Number.parseInt(opts.checkpointInterval, 10)
          : undefined,
    })
    process.exit(code)
  })

program
  .command('doctor')
  .description('Diagnose the local Lumen install')
  .option('-v, --verbose', 'Print extra detail for each check')
  .action(async (opts: Record<string, unknown>) => {
    const { doctorCommand } = await import('./commands/doctor.js')
    const code = await doctorCommand({ verbose: opts.verbose === true })
    process.exit(code)
  })

program
  .command('session')
  .description('Inspect and manage stored agent sessions')
  .argument('[subcommand]', '"list" (default), "show <id>", "delete <id>", or "prune"', 'list')
  .argument('[id]', 'Session id (for "show" and "delete")')
  .option('--memory-path <path>', 'Override the SQLite memory database path')
  .option('--force', 'Confirm destructive operations (delete, prune)')
  .option('--older-than <days>', 'prune: cut-off age in days (default 30)', '30')
  .option('--limit <n>', 'show: limit messages returned (default 100)', '100')
  .action(async (subcommand: string, id: string | undefined, opts: Record<string, unknown>) => {
    const { sessionListCommand, sessionShowCommand, sessionDeleteCommand, sessionPruneCommand } =
      await import('./commands/session.js')
    const memoryPath = opts.memoryPath as string | undefined
    const force = opts.force === true
    let code = 0
    if (subcommand === 'list') {
      code = await sessionListCommand({ memoryPath })
    } else if (subcommand === 'show') {
      if (!id) {
        process.stderr.write('lumen session: missing <id> for "show"\n')
        code = 1
      } else {
        const limitRaw = opts.limit
        const limit = typeof limitRaw === 'string' ? Number.parseInt(limitRaw, 10) : undefined
        code = await sessionShowCommand(id, { memoryPath, limit })
      }
    } else if (subcommand === 'delete') {
      if (!id) {
        process.stderr.write('lumen session: missing <id> for "delete"\n')
        code = 1
      } else {
        code = await sessionDeleteCommand(id, { memoryPath, force })
      }
    } else if (subcommand === 'prune') {
      const daysRaw = opts.olderThan
      const days = typeof daysRaw === 'string' ? Number.parseInt(daysRaw, 10) : 30
      code = await sessionPruneCommand({ memoryPath, force, olderThanDays: days })
    } else {
      process.stderr.write(`lumen session: unknown subcommand: ${subcommand}\n`)
      code = 1
    }
    process.exit(code)
  })

program
  .command('plan')
  .description('Inspect and manage persisted plans (list / approve / reject)')
  .argument('[subcommand]', '"list" (default), "approve <id>", or "reject <id>"', 'list')
  .argument('[id]', 'Plan id (for "approve" and "reject")')
  .option('--notes <text>', 'Approve/reject: free-form notes to record on the plan')
  .option('--plans-path <path>', 'Override the plans JSON file path')
  .action(async (subcommand: string, id: string | undefined, opts: Record<string, unknown>) => {
    const { planApproveCommand, planListCommand, planRejectCommand } = await import(
      './commands/plan.js'
    )
    const file = opts.plansPath as string | undefined
    const notes = opts.notes as string | undefined
    let code = 0
    if (subcommand === 'list') {
      code = await planListCommand({ file })
    } else if (subcommand === 'approve') {
      if (!id) {
        process.stderr.write('lumen plan: missing <id> for "approve"\n')
        code = 1
      } else {
        code = await planApproveCommand({ id, notes, file })
      }
    } else if (subcommand === 'reject') {
      if (!id) {
        process.stderr.write('lumen plan: missing <id> for "reject"\n')
        code = 1
      } else {
        code = await planRejectCommand({ id, notes, file })
      }
    } else {
      process.stderr.write(`lumen plan: unknown subcommand: ${subcommand}\n`)
      code = 1
    }
    process.exit(code)
  })

program
  .command('checkpoint')
  .description('Inspect and manage saved agent run checkpoints')
  .argument('<subcommand>', '"list <session-id>", "show <id>", or "delete <id>"')
  .argument('[arg]', 'Session id (for "list") or checkpoint id (for "show"/"delete")')
  .option(
    '--plans-path <path>',
    'P20.4.5: path to a SQLite checkpoint database (defaults to in-memory)',
  )
  .action(async (subcommand: string, arg: string | undefined, opts: Record<string, unknown>) => {
    const { checkpointDeleteCommand, checkpointListCommand, checkpointShowCommand } = await import(
      './commands/checkpoint.js'
    )
    const file = opts.plansPath as string | undefined
    let code = 0
    if (subcommand === 'list') {
      if (!arg) {
        process.stderr.write('lumen checkpoint: missing <session-id> for "list"\n')
        code = 1
      } else {
        code = await checkpointListCommand({ sessionId: arg, file })
      }
    } else if (subcommand === 'show') {
      if (!arg) {
        process.stderr.write('lumen checkpoint: missing <id> for "show"\n')
        code = 1
      } else {
        code = await checkpointShowCommand({ id: arg, file })
      }
    } else if (subcommand === 'delete') {
      if (!arg) {
        process.stderr.write('lumen checkpoint: missing <id> for "delete"\n')
        code = 1
      } else {
        code = await checkpointDeleteCommand({ id: arg, file })
      }
    } else {
      process.stderr.write(`lumen checkpoint: unknown subcommand: ${subcommand}\n`)
      code = 1
    }
    process.exit(code)
  })

program
  .command('reflect')
  .description('Manually trigger reflection (rule-based or cross-run meta)')
  .argument(
    '[subcommand]',
    '"run" (per-session rule-based) or "meta" (cross-run trust delta)',
    'run',
  )
  .option('--memory-path <path>', 'Override the SQLite memory database path')
  .option('--session-id <id>', 'reflect run: explicit session id (default: most recent)')
  .option('--interval <n>', 'reflect meta: trust-delta interval (default 10)')
  .option('--similarity <n>', 'reflect meta: Jaccard similarity threshold (default 0.5)')
  .action(async (subcommand: string, opts: Record<string, unknown>) => {
    const { reflectMetaCommand, reflectRunCommand } = await import('./commands/reflect.js')
    const memoryPath = opts.memoryPath as string | undefined
    let code = 0
    if (subcommand === 'run') {
      code = await reflectRunCommand({
        ...(memoryPath !== undefined ? { memoryPath } : {}),
        ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId as string } : {}),
      })
    } else if (subcommand === 'meta') {
      const intervalRaw = opts.interval
      const similarityRaw = opts.similarity
      code = await reflectMetaCommand({
        ...(memoryPath !== undefined ? { memoryPath } : {}),
        ...(typeof intervalRaw === 'string' ? { interval: Number.parseInt(intervalRaw, 10) } : {}),
        ...(typeof similarityRaw === 'string'
          ? { similarityThreshold: Number.parseFloat(similarityRaw) }
          : {}),
      })
    } else {
      process.stderr.write(`lumen reflect: unknown subcommand: ${subcommand}\n`)
      code = 1
    }
    process.exit(code)
  })

program
  .command('update')
  .description('Check for newer Lumen releases')
  .argument('[subcommand]', '"check" (default) or "print-version"', 'check')
  .option('--quiet', 'Skip the "you are up to date" recommendation')
  .action(async (subcommand: string, opts: Record<string, unknown>) => {
    const { updateCheckCommand, updatePrintVersionCommand } = await import('./commands/update.js')
    let code = 0
    if (subcommand === 'print-version') {
      code = await updatePrintVersionCommand()
    } else if (subcommand === 'check') {
      code = await updateCheckCommand({ quiet: opts.quiet === true })
    } else {
      process.stderr.write(`lumen update: unknown subcommand: ${subcommand}\n`)
      code = 1
    }
    process.exit(code)
  })

program
  .command('model')
  .description('Inspect configured LLM models and providers')
  .argument('[subcommand]', '"list" (default), "show <name>", or "providers"', 'list')
  .argument('[name]', 'Model name (for "show")')
  .option('-c, --config <path>', 'Path to a Lumen config file')
  .action(async (subcommand: string, name: string | undefined, opts: Record<string, unknown>) => {
    const { modelListCommand, modelShowCommand, modelProvidersCommand } = await import(
      './commands/model.js'
    )
    const configPath = opts.config as string | undefined
    let code = 0
    if (subcommand === 'show') {
      if (!name) {
        process.stderr.write('lumen model: missing <name> for "show"\n')
        code = 1
      } else {
        code = await modelShowCommand({ configPath, name })
      }
    } else if (subcommand === 'providers') {
      code = await modelProvidersCommand({ configPath })
    } else if (subcommand === 'list') {
      code = await modelListCommand({ configPath })
    } else {
      process.stderr.write(`lumen model: unknown subcommand: ${subcommand}\n`)
      code = 1
    }
    process.exit(code)
  })

program
  .command('config')
  .description('Inspect the resolved Lumen config')
  .argument('[subcommand]', '"show" (default), "path", or "validate"', 'show')
  .option('-c, --config <path>', 'Path to a Lumen config file')
  .action(async (subcommand: string, opts: Record<string, unknown>) => {
    const { configShowCommand, configPathCommand, configValidateCommand } = await import(
      './commands/config.js'
    )
    const configPath = opts.config as string | undefined
    let code = 0
    if (subcommand === 'path') {
      code = await configPathCommand({ configPath })
    } else if (subcommand === 'validate') {
      code = await configValidateCommand({ configPath })
    } else if (subcommand === 'show') {
      code = await configShowCommand({ configPath })
    } else {
      process.stderr.write(`lumen config: unknown subcommand: ${subcommand}\n`)
      code = 1
    }
    process.exit(code)
  })

program
  .command('tools')
  .description('Inspect registered Lumen tools')
  .argument('[subcommand]', '"list" (default), "show <name>", or "check"', 'list')
  .argument('[name]', 'Tool name (for "show")')
  .option('--approval-required', 'Only show tools that require approval at runtime')
  .option('--toolset', 'List built-in toolsets instead of individual tools')
  .action(async (subcommand: string, name: string | undefined, opts: Record<string, unknown>) => {
    const { toolsListCommand, toolsShowCommand, toolsCheckCommand } = await import(
      './commands/tools.js'
    )
    let code = 0
    if (subcommand === 'show') {
      if (!name) {
        process.stderr.write('lumen tools: missing <name> for "show"\n')
        code = 1
      } else {
        code = await toolsShowCommand({ name })
      }
    } else if (subcommand === 'check') {
      code = await toolsCheckCommand()
    } else if (subcommand === 'list') {
      code = await toolsListCommand({
        approvalRequiredOnly: opts.approvalRequired === true,
        toolset: opts.toolset === true,
      })
    } else {
      process.stderr.write(`lumen tools: unknown subcommand: ${subcommand}\n`)
      code = 1
    }
    process.exit(code)
  })

program
  .command('team')
  .description('Inspect and run agent team files (team.json)')
  .argument(
    '[subcommand]',
    '"list" (default), "validate <path>", "show <path>", or "run <path>"',
    'list',
  )
  .argument('[path]', 'Path to a team.json file (for "validate", "show", and "run")')
  .option('--list-dir <dir>', 'list: directory to scan for team.json files (defaults to ./teams)')
  .option(
    '--team-checkpoint <path>',
    'run: persist a team-level checkpoint to this SQLite file after the run resolves (success or failure). Defaults to in-memory (no persistence).',
  )
  .action(
    async (subcommand: string, filePath: string | undefined, opts: Record<string, unknown>) => {
      const { teamCommand } = await import('./commands/team.js')
      let code = 0
      if (subcommand === 'list') {
        code = await teamCommand({
          action: 'list',
          listDir: opts.listDir as string | undefined,
        })
      } else if (subcommand === 'validate') {
        if (!filePath) {
          process.stderr.write('lumen team: missing <path> for "validate"\n')
          code = 2
        } else {
          code = await teamCommand({ action: 'validate', path: filePath })
        }
      } else if (subcommand === 'show') {
        if (!filePath) {
          process.stderr.write('lumen team: missing <path> for "show"\n')
          code = 2
        } else {
          code = await teamCommand({ action: 'show', path: filePath })
        }
      } else if (subcommand === 'run') {
        if (!filePath) {
          process.stderr.write('lumen team: missing <path> for "run"\n')
          code = 2
        } else {
          // P20.7.3: build the parent context via the same
          // composition root that `lumen run` uses, so a team
          // run gets the same provider / tools / memory /
          // hooks / MCP wiring the user has already configured.
          // The pre-flight API-key check lives in buildAgent,
          // so we don't have to duplicate it here.
          const { buildAgent } = await import('./composition.js')
          let built: Awaited<ReturnType<typeof buildAgent>> | undefined
          try {
            built = await buildAgent({
              noMcp: false,
              noMemory: false,
              memoryPath: ':memory:',
            })
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            process.stderr.write(`lumen team run: failed to build agent: ${msg}\n`)
            process.exit(1)
          }
          // P20.7.4: optional team-level SqliteCheckpointStore.
          // Built only when the operator passes --team-checkpoint
          // so a default `lumen team run` keeps the
          // checkpoint-free in-memory behaviour.
          let teamCheckpointStore: import('@lumen/core').BaseCheckpointStore | undefined
          const teamCheckpointPath = opts.teamCheckpoint as string | undefined
          if (teamCheckpointPath) {
            const { SqliteCheckpointStore } = await import('@lumen/memory')
            // SqliteCheckpointStore opens its own database
            // connection + runs the DDL in the constructor
            // (P20.4.4). No init() call is required.
            teamCheckpointStore = new SqliteCheckpointStore({ path: teamCheckpointPath })
          }
          code = await teamCommand({
            action: 'run',
            path: filePath,
            runParent: {
              provider: built.provider,
              tools: built.tools,
              model: built.model,
              // Agent.cwd is private; buildAgent already
              // resolved cwd via the same fallback, so we
              // re-derive it here to keep runParent in sync
              // with the agent's actual working directory.
              cwd: process.cwd(),
            },
            ...(teamCheckpointStore ? { teamCheckpointStore } : {}),
          })
        }
      } else {
        process.stderr.write(`lumen team: unknown subcommand: ${subcommand}\n`)
        code = 1
      }
      process.exit(code)
    },
  )

program
  .command('skills')
  .description('Inspect locally installed Lumen skills')
  .argument('[command]', '"list" (default) or "cat <id>"', 'list')
  .argument('[id]', 'Skill id or name (for "cat")')
  .option('-p, --prompt <text>', 'Prompt text for activation scoring (list only)')
  .option('--path <dir>', 'Override the skill root directory')
  .action(async (cmd: string, id: string | undefined, opts: Record<string, unknown>) => {
    if (cmd === 'cat' && id) {
      const { skillsCatCommand } = await import('./commands/skills.js')
      const code = await skillsCatCommand({ id, path: opts.path as string | undefined })
      process.exit(code)
    }
    const { skillsListCommand } = await import('./commands/skills.js')
    const code = await skillsListCommand({
      path: opts.path as string | undefined,
      prompt: opts.prompt as string | undefined,
    })
    process.exit(code)
  })

// `lumen init [--force] [--path <file>]`
//
// P22.3: write a starter `~/.lumen/permissions.yaml` so the
// operator can `lumen run --permissions` immediately. The starter
// ships with `default: ask` and a least-privilege rule set
// (read tools allowed, terminal denied). `--force` overwrites an
// existing file; without it, the command exits 2 and prints a
// hint.
program
  .command('init')
  .description('Write a starter `~/.lumen/permissions.yaml` (P22.3)')
  .option('--force', 'Overwrite an existing file')
  .option('--path <file>', 'Override the destination (default ~/.lumen/permissions.yaml)')
  .action(async (opts: Record<string, unknown>) => {
    const { initCommand } = await import('./commands/init.js')
    const code = await initCommand({
      force: opts.force === true,
      path: opts.path as string | undefined,
    })
    process.exit(code)
  })

// `lumen permissions show [--path <file>] [--json]`
//
// P22.3: print the resolved tool-permission policy in
// human-readable form (default) or as JSON. Reads from the
// same path the run/chat --permissions flag would, and
// surfaces the same Zod-validated shape.
program
  .command('permissions')
  .description('Inspect the resolved tool-permission policy (P22.3)')
  .argument('[subcommand]', '"show" (default), "preset", or "audit"', 'show')
  .option('--path <file>', 'Path to a YAML policy file (default ~/.lumen/permissions.yaml)')
  .option('--json', 'Emit JSON instead of the human-readable form. (show only)')
  .option(
    '--format <format>',
    'Audit output format: human (default), json, or csv. (audit only)',
    'human',
  )
  .action(async (subcommand: string, opts: Record<string, unknown>) => {
    const { permissionsAuditCommand, permissionsPresetCommand, permissionsShowCommand } =
      await import('./commands/permissions.js')
    let code = 0
    if (subcommand === 'show') {
      code = await permissionsShowCommand({
        path: opts.path as string | undefined,
        json: opts.json === true,
      })
    } else if (subcommand === 'preset') {
      code = await permissionsPresetCommand()
    } else if (subcommand === 'audit') {
      code = await permissionsAuditCommand({
        path: opts.path as string | undefined,
        format: (opts.format as 'human' | 'json' | 'csv' | undefined) ?? 'human',
      })
    } else {
      process.stderr.write(`lumen permissions: unknown subcommand: ${subcommand}\n`)
      code = 1
    }
    process.exit(code)
  })

// `lumen` (no subcommand) — alias for `lumen chat`. Allows `lumen -m foo`
// to drop into the TUI without remembering the explicit `chat` keyword.
// We keep the two entry points wired to the *same* handler so a future
// redesign of the chat surface only has to touch one place.
program.action(async (opts: Record<string, unknown>) => {
  // Commander emits this action for both the "no subcommand" and the
  // "subcommand provided" case. Subcommands have their own .action()
  // attached and short-circuit before this fires, so reaching here
  // means the user typed `lumen` (or `lumen --foo`) with nothing else.
  // We deliberately do NOT call program.help() here — the user is
  // trying to chat, not read docs.
  const { chatCommand } = await import('./commands/chat.js')
  const code = await chatCommand({
    model: opts.model as string | undefined,
    configPath: opts.config as string | undefined,
    cwd: opts.cwd as string | undefined,
  })
  process.exit(code)
})

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`lumen: unexpected error: ${message}\n`)
  process.exit(1)
})
