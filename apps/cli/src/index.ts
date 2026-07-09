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
  .option('--plan [mode]', "Wire PlanMiddleware; mode is 'plan' / 'act' / 'auto' (default 'auto')")
  .option('--checkpoint <path>', 'Path to a SQLite checkpoint database (P20.4)')
  .action(async (prompt: string, opts: Record<string, unknown>) => {
    const { runCommand } = await import('./commands/run.js')
    const interruptOnRaw = opts.interruptOn as string | undefined
    const interruptOn = interruptOnRaw
      ? interruptOnRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
      : undefined
    const planRaw = opts.plan as string | boolean | undefined
    const planMode = planRaw === true || planRaw === undefined
      ? undefined
      : (planRaw as 'plan' | 'act' | 'auto')
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
      enablePlanMiddleware: planRaw !== undefined,
      planMode,
      checkpointPath: opts.checkpoint as string | undefined,
    })
    process.exit(code)
  })

program
  .command('chat')
  .description('Start an interactive TUI chat session')
  .option('-m, --model <model>', 'Override the LLM model')
  .option('-c, --config <path>', 'Path to a Lumen config file')
  .option('--cwd <path>', 'Working directory for tool execution')
  .action(async (opts: Record<string, unknown>) => {
    // Lazy-load Ink only when actually entering the TUI.
    const { chatCommand } = await import('./commands/chat.js')
    const code = await chatCommand({
      model: opts.model as string | undefined,
      configPath: opts.config as string | undefined,
      cwd: opts.cwd as string | undefined,
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
  .action(async (subcommand: string, arg: string | undefined) => {
    const {
      checkpointDeleteCommand,
      checkpointListCommand,
      checkpointShowCommand,
    } = await import('./commands/checkpoint.js')
    let code = 0
    if (subcommand === 'list') {
      if (!arg) {
        process.stderr.write('lumen checkpoint: missing <session-id> for "list"\n')
        code = 1
      } else {
        code = await checkpointListCommand({ sessionId: arg })
      }
    } else if (subcommand === 'show') {
      if (!arg) {
        process.stderr.write('lumen checkpoint: missing <id> for "show"\n')
        code = 1
      } else {
        code = await checkpointShowCommand({ id: arg })
      }
    } else if (subcommand === 'delete') {
      if (!arg) {
        process.stderr.write('lumen checkpoint: missing <id> for "delete"\n')
        code = 1
      } else {
        code = await checkpointDeleteCommand({ id: arg })
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
  .argument('[subcommand]', '"run" (per-session rule-based) or "meta" (cross-run trust delta)', 'run')
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
        ...(typeof intervalRaw === 'string'
          ? { interval: Number.parseInt(intervalRaw, 10) }
          : {}),
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
