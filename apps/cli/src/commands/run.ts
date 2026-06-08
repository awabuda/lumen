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
}

export const runCommand = async (options: RunCommandOptions): Promise<number> => {
  // Defer the heavy import so the command surface stays light.
  const { buildAgent } = await import('../composition.js')
  try {
    const built = await buildAgent(options)
    if (!process.env.OPENAI_API_KEY && !process.env.LUMEN_API_KEY && !options.apiKey) {
      process.stderr.write(
        'lumen: missing API key. Set OPENAI_API_KEY or LUMEN_API_KEY, or pass --api-key.\n',
      )
      return 2
    }
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
  }
}

// Mark the side-effect import as used; the command delegates to buildAgent.
void loadCliConfig
