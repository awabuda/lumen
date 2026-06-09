/**
 * `lumen run "<prompt>"` — single-shot CLI: run one prompt, print the
 * answer, exit. No TUI, no streaming, no interactivity. Designed for
 * scripts and one-off questions.
 *
 * Exit codes:
 *   0 — success
 *   1 — agent error (network, provider, validation)
 *   2 — configuration error (missing API key, etc.)
 *   130 — interrupted (SIGINT)
 */

import { loadCliConfig } from '../composition.js'

export interface RunCommandOptions {
  prompt: string
  model?: string
  configPath?: string
  cwd?: string
  apiKey?: string
  baseUrl?: string
  noTools?: boolean
  /** Skip wiring a memory store (defaults to in-memory SQLite at
   *  `~/.lumen/memory.db`). Tests pass `:memory:` for hermetic
   *  runs. */
  memoryPath?: string
  noMemory?: boolean
  /** Skip MCP server discovery + connection. */
  noMcp?: boolean
}

export const runCommand = async (options: RunCommandOptions): Promise<number> => {
  // Defer the heavy import so the command surface stays light.
  const { buildAgent } = await import('../composition.js')

  // Pre-flight: surface the missing-key error **before** we
  // touch the filesystem (buildAgent opens the SQLite
  // memory file). This keeps the failure cheap and the
  // error message specific — the user is told they need
  // a key, not that we couldn't open a database.
  if (!process.env.OPENAI_API_KEY && !process.env.LUMEN_API_KEY && !options.apiKey) {
    process.stderr.write(
      'lumen: missing API key. Set OPENAI_API_KEY or LUMEN_API_KEY, or pass --api-key.\n',
    )
    return 2
  }

  let built: Awaited<ReturnType<typeof buildAgent>> | undefined
  try {
    built = await buildAgent(options)
    const result = await built.agent.run({ userMessage: options.prompt })
    if (result.finalMessage.content) {
      process.stdout.write(result.finalMessage.content)
      if (!result.finalMessage.content.endsWith('\n')) {
        process.stdout.write('\n')
      }
    } else if (result.finalMessage.toolCalls.length > 0) {
      // The model called tools but never produced text. Surface what it did.
      process.stdout.write(
        `[lumen] agent stopped after ${result.iterations} iteration(s) with ${result.finalMessage.toolCalls.length} tool call(s) and no final text.\n`,
      )
    }
    return 0
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`lumen: ${message}\n`)
    return 1
  } finally {
    // Always dispose the memory store. We do this even on
    // error because a half-finished run may have already
    // appended the user message; we want the connection
    // closed cleanly so WAL gets checkpointed.
    await built?.memory?.dispose()
    // Close any MCP server connections. `closeAllMcpServers`
    // already uses Promise.allSettled, so a single stuck
    // server can't keep the CLI alive.
    if (built?.mcpServers.length) {
      const { closeAllMcpServers } = await import('@lumen/mcp')
      await closeAllMcpServers(built.mcpServers)
    }
  }
}

// Mark the side-effect import as used; the command delegates to buildAgent.
void loadCliConfig
