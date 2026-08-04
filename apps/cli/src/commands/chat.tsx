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
import { defaultChatCheckpointPath, defaultChatSessionId } from '../chat-paths.js'
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
 *
 * P32.1 — chat now defaults to durable persistence. Resolution:
 *   `checkpointPath ?? defaultChatCheckpointPath()`
 *   `sessionId ?? defaultChatSessionId(cwd)` (unless `noPersist`,
 *   which disables both to keep the pre-P32.1 in-memory behavior
 *   available as an explicit opt-out, not a silent default).
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
  /** Pre-approve tool names listed in interruptOn. */
  approveOn?: ReadonlyArray<string>
  /** P34.5.b — auto-approve every `approval-required` /
   *  `dangerous` tool call. Mutually exclusive with
   *  `denyAll`. */
  approveAll?: boolean
  /** P34.5.b — hard-deny every `approval-required` /
   *  `dangerous` tool call. */
  denyAll?: boolean
  /** P22.2: path to a YAML permission policy file. */
  permissionsPath?: string
  /**
   * SQLite checkpoint database used for durable TUI turns. When
   * omitted (and `noPersist` is false), defaults to
   * `defaultChatCheckpointPath()` — the XDG_STATE_HOME-aware
   * `chat.sqlite` location. Pass `:memory:` only for tests.
   */
  checkpointPath?: string
  /** P32.1: explicit session id (replaces cwd-derived default). */
  sessionId?: string
  /** P32.1: force a fresh sessionId even when cwd is unchanged. */
  newSession?: boolean
  /**
   * P32.1: disable the new persistence defaults and run like the
   * pre-P32.1 chat — in-memory checkpoint, fresh uuid per launch.
   * Used by `--no-persist` and by tests that don't want a
   * chat.sqlite file left in the user's home.
   */
  noPersist?: boolean
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
  const cwd = options.cwd ?? process.cwd()
  // P32.1 — chat defaults to durable persistence. `--no-persist`
  // (or tests passing `noPersist: true`) opts back into the
  // pre-P32.1 in-memory behaviour: no chat.sqlite is created
  // and `newSessionId()` runs every launch, so there is
  // nothing to leak across processes.
  const persist = options.noPersist !== true
  const checkpointPath = persist
    ? (options.checkpointPath ?? defaultChatCheckpointPath())
    : options.checkpointPath
  // P32.1 — pick a stable session id when persistence is on. The
  // user can override with `--session-id`. `--new-session`
  // forces a fresh uuid (useful when the user wants to start a
  // fork of the current conversation without leaving the cwd).
  const sessionId = !persist
    ? undefined
    : options.newSession === true
      ? undefined
      : (options.sessionId ?? defaultChatSessionId(cwd))

  const { SqliteCheckpointStore, SqliteLoopsStore } = await import('@lumen/memory')
  const checkpointStore = checkpointPath
    ? new SqliteCheckpointStore({ path: checkpointPath })
    : undefined
  // P32.4 — the cron registry lives in its own sqlite file at
  // $XDG_STATE_HOME/lumen/loops.sqlite (default). The default-path
  // helper inside `SqliteLoopsStore` handles the mkdirSync
  // invariant from P32.1.1. `--no-persist` opts out of cron
  // persistence too: registry entries survive across launches
  // is part of the same durability surface as chat history.
  const loopsStore = persist ? new SqliteLoopsStore({}) : undefined
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
    await loopsStore?.dispose().catch(() => {})
    process.stderr.write(
      `lumen chat: checkpoint setup failed: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return 1
  }

  const app = render(
    React.createElement(Chat, {
      built,
      checkpointStore,
      ...(loopsStore !== undefined ? { loopsStore } : {}),
      initialResumeFrom,
      ...(sessionId !== undefined ? { sessionId } : {}),
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
