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
  .action(async (prompt: string, opts: Record<string, unknown>) => {
    const { runCommand } = await import('./commands/run.js')
    const code = await runCommand({
      prompt,
      model: opts['model'] as string | undefined,
      configPath: opts['config'] as string | undefined,
      cwd: opts['cwd'] as string | undefined,
      apiKey: opts['apiKey'] as string | undefined,
      baseUrl: opts['baseUrl'] as string | undefined,
      noTools: opts['tools'] === false,
      memoryPath: opts['memoryPath'] as string | undefined,
      noMemory: opts['memory'] === false,
      noMcp: opts['mcp'] === false,
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
      model: opts['model'] as string | undefined,
      configPath: opts['config'] as string | undefined,
      cwd: opts['cwd'] as string | undefined,
    })
    process.exit(code)
  })

program
  .command('doctor')
  .description('Diagnose the local Lumen install')
  .action(async () => {
    const { doctorCommand } = await import('./commands/doctor.js')
    const code = await doctorCommand()
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
      const code = await skillsCatCommand({ id, path: opts['path'] as string | undefined })
      process.exit(code)
    }
    const { skillsListCommand } = await import('./commands/skills.js')
    const code = await skillsListCommand({
      path: opts['path'] as string | undefined,
      prompt: opts['prompt'] as string | undefined,
    })
    process.exit(code)
  })

// Default: if no subcommand, show help
program.action(() => {
  program.help()
})

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(`lumen: unexpected error: ${message}\n`)
  process.exit(1)
})
