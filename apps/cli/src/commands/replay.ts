/**
 * `lumen replay` — replay a session from the memory store.
 *
 * Reads the messages of a given session and replays them
 * through the agent, printing the agent's responses. Useful
 * for debugging, regression testing, and demo recordings.
 *
 * Usage:
 *   lumen replay <session-id> [--model <model>] [--max-turns <n>]
 */

import type { AgentConfig } from '@lumen/core'
import { buildAgent } from '../composition.js'

export interface ReplayOptions {
  readonly sessionId: string
  readonly model?: string
  readonly maxTurns?: number
}

export const replayCommand = async (opts: ReplayOptions): Promise<number> => {
  const agent = await buildAgent({
    model: opts.model,
  } as AgentConfig)

  const maxTurns = opts.maxTurns ?? 20
  const sessionId = opts.sessionId

  // Read session messages from the memory store.
  const store = agent.memory
  if (!store || typeof store.getSessionMessages !== 'function') {
    process.stderr.write('lumen replay: no memory store configured\n')
    return 1
  }

  const messages = await store.getSessionMessages(sessionId, { limit: 200 })
  if (messages.length === 0) {
    process.stderr.write(`lumen replay: no messages found for session ${sessionId}\n`)
    return 1
  }

  process.stdout.write(
    `Replaying session ${sessionId} (${messages.length} messages, max ${maxTurns} turns)\n\n`,
  )

  // Filter to user messages and replay them one by one.
  const userMessages = messages.filter((m) => m.role === 'user')
  let turn = 0

  for (const msg of userMessages) {
    if (turn >= maxTurns) {
      process.stdout.write(`\nReached max turns (${maxTurns}). Stopping.\n`)
      break
    }
    turn += 1
    process.stdout.write(`[turn ${turn}] user: ${msg.content}\n`)

    try {
      const result = await agent.agent.run({ userMessage: msg.content })
      process.stdout.write(`[turn ${turn}] assistant: ${result.finalMessage.content}\n\n`)
    } catch (err) {
      process.stderr.write(
        `[turn ${turn}] error: ${err instanceof Error ? err.message : String(err)}\n`,
      )
    }
  }

  process.stdout.write(`\nReplay complete: ${turn} turns.\n`)
  return 0
}
