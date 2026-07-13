/**
 * The Ink TUI chat command. Loaded lazily by `src/index.ts` so that
 * users who only use `lumen run` don't pay the Ink/React startup cost.
 *
 * This file owns the **bridge** between the imperative agent runtime
 * (returns Promises / async iterators) and the declarative React/Ink
 * UI (driven by props + state). The bridge has three concerns:
 *
 *   1. Mount the React app under Ink.
 *   2. Build the {@link Agent} from CLI options before mounting.
 *   3. Translate the result of `agent.run()` (a single Promise) into
 *      a stream of UI events the React tree can consume.
 *
 * The React component itself is in `../components/Chat.jsx`. We keep
 * the JSX in a separate file so this file can stay pure TypeScript.
 */

import type { AgentCheckpoint } from '@lumen/core'
import { findResumeCheckpoint } from '../checkpoint-resume.js'
import { type BuiltAgent, buildAgent } from '../composition.js'

/**
 * Options for {@link chatCommand}.
 *
 * `interruptOn` mirrors the `lumen run --interrupt-on` flag: when set,
 * `buildAgent` wires `createInterruptMiddleware({ toolNames: [...] })` so
 * the agent loop throws `AbortError` the moment a matching tool is about
 * to dispatch. The TUI surfaces the resulting `AbortError.message`
 * (which starts with "interrupt: ...") in the turn log instead of
 * silently resetting to idle, so the user can see *why* the run was
 * interrupted and decide to retry with a different tool list.
 */
export interface ChatCommandOptions {
  model?: string
  configPath?: string
  cwd?: string
  /**
   * Tool names whose dispatch should trigger an `AbortError` from
   * `createInterruptMiddleware`. Forwarded to
   * `buildAgent({ interruptOn })`; empty / undefined means no
   * interrupt rules are wired (backwards-compatible default).
   */
  interruptOn?: ReadonlyArray<string>
  /** SQLite checkpoint database used for durable TUI turns. */
  checkpointPath?: string
  /** Disable startup auto-resume. */
  noResume?: boolean
  /** Maximum checkpoint age for startup auto-resume. */
  resumeTtlMs?: number
  /** Checkpoint cadence for each streamed turn. */
  checkpointInterval?: number
}

export const chatCommand = async (options: ChatCommandOptions): Promise<number> => {
  // Pre-flight: ensure an API key is set, otherwise Ink would mount
  // and then fail mid-render.
  if (!process.env.OPENAI_API_KEY && !process.env.LUMEN_API_KEY) {
    process.stderr.write(
      'lumen chat: missing API key. Set OPENAI_API_KEY or LUMEN_API_KEY before starting.\n',
    )
    return 2
  }

  let built: BuiltAgent
  try {
    built = await buildAgent(options)
  } catch (err) {
    process.stderr.write(
      `lumen chat: failed to build agent: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  // Lazy-load Ink to keep cold start cheap for non-TUI commands.
  const React = await import('react')
  const { render } = await import('ink')
  const { Chat } = await import('../components/Chat.js')
  const { SqliteCheckpointStore } = await import('@lumen/memory')
  const checkpointStore = options.checkpointPath
    ? new SqliteCheckpointStore({ path: options.checkpointPath })
    : undefined
  let initialResumeFrom: AgentCheckpoint | undefined
  try {
    initialResumeFrom = checkpointStore
      ? await findResumeCheckpoint({
          store: checkpointStore,
          enabled: options.noResume !== true,
          ...(options.resumeTtlMs !== undefined ? { ttlMs: options.resumeTtlMs } : {}),
        })
      : undefined
  } catch (err) {
    await checkpointStore?.dispose()
    process.stderr.write(
      `lumen chat: checkpoint setup failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  const app = render(
    React.createElement(Chat, {
      built,
      checkpointStore,
      initialResumeFrom,
      ...(options.checkpointInterval !== undefined
        ? { checkpointInterval: options.checkpointInterval }
        : {}),
    }),
  )
  return new Promise<number>((resolve) => {
    app
      .waitUntilExit()
      .then(() => resolve(0))
      .catch((err: unknown) => {
        process.stderr.write(`lumen chat: ${err instanceof Error ? err.message : String(err)}\n`)
        resolve(1)
      })
      // Dispose the memory store **after** the user exits
      // the TUI. The TUI may have persisted several turns
      // already; we want the connection closed cleanly so
      // the WAL gets checkpointed and the next `lumen run`
      // sees the most recent state.
      .finally(() => {
        checkpointStore?.dispose().catch(() => {})
        built.memory?.dispose().catch(() => {
          // The TUI is already exiting; an error here
          // would just confuse the user. We swallow.
        })
        // Same story for MCP — close any connected
        // servers so the TUI can exit promptly. A
        // single stuck server still can't keep us alive
        // because `closeAllMcpServers` uses
        // `Promise.allSettled` internally.
        if (built.mcpServers.length) {
          import('@lumen/mcp').then(({ closeAllMcpServers }) => {
            closeAllMcpServers(built.mcpServers).catch(() => {})
          })
        }
      })
  })
}
