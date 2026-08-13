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

import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentCheckpoint } from '@lumen/core'
import {
  defaultChatCheckpointPath,
  defaultChatSessionId,
  resolveChatSessionId,
} from '../chat-paths.js'
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
   * P63: force the cwd-derived session id every launch
   * and skip the OpenClaw-style "remember last-used"
   * fallback. Mirrors `openclaw` `tui-last-session`
   * semantics: `--pinned-to-cwd` is the opt-in for
   * operators who want the P32.1 cwd-pinned behaviour
   * (per-project stable session) instead of the P63
   * default (per-scope remembered last-used session).
   * The cwd-derived id is NOT written to the remember
   * file when this flag is set, so it does not
   * override the operator's other cwd launches.
   */
  pinnedToCwd?: boolean
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
  // P59 — initialize the memory store first so the
  // session-id resolution can read `listSessions` and
  // fall back to the most recent session when the
  // cwd-derived id has no matching session (e.g. the
  // cwd hash changed, or the session was created with
  // a different id strategy). The P32.1 docblock
  // below was kept intact for the contract description.
  // P57 — the same `~/.lumen/memory.db` the agent
  // uses for its `session_messages` writes. The
  // path resolution matches `composition.ts`'s
  // `defaultMemoryPath` (`LUMEN_MEMORY_PATH`
  // override + `$HOME/.lumen/memory.db` fallback).
  // We import the host-relative `os` + `path` once
  // at the top of the file in the regular import
  // block; here we read them off the synchronous
  // `node:os` / `node:path` modules rather than
  // through `import()` because path resolution is
  // sync.
  const memoryPath = ((): string => {
    const override = process.env.LUMEN_MEMORY_PATH
    if (override) return override
    return path.join(os.homedir(), '.lumen', 'memory.db')
  })()
  const memoryStore = persist
    ? await (async () => {
        const { SqliteStore } = await import('@lumen/memory')
        return new SqliteStore({ path: memoryPath })
      })()
    : undefined
  if (memoryStore) {
    try {
      await memoryStore.init()
    } catch {
      // fresh install — init throws when the file
      // does not exist; the store stays uninit and
      // the P57 effect no-ops.
    }
  }

  // P32.1 / P59 / P63 — pick a session id when persistence is on.
  // The user can override with `--session-id`. `--new-session`
  // forces a fresh uuid (useful when the user wants to start a
  // fork of the current conversation without leaving the cwd).
  //
  // P59 adds a SqliteStore-based fallback: if the cwd-derived
  // id has no matching session in the store (e.g. the cwd
  // hash changed), `resolveChatSessionId` falls back to the
  // most recent session so the operator's prior conversation
  // is preserved.
  //
  // P63 changes the **default** to OpenClaw's
  // `tui_last_sessions` pattern
  // (`~/workspace/openclaw-main/src/tui/tui-last-session.ts`):
  // the session id is **remembered** per-scope, not derived
  // from cwd. The 3-layer fallback is:
  //   1. `--session-id <id>` (explicit, wins over everything)
  //   2. `~/.lumen/chat_last_session` (last-used key for the
  //      cwd's scope; persists across launches)
  //   3. cwd-derived id (P32.1 default, written to the
  //      remember file on first use so subsequent launches
  //      reuse it)
  //
  // `--pinned-to-cwd` forces layer 3 every launch and skips
  // the remember-write. The previous P59 SqliteStore
  // fallback is preserved as a final safety net for the
  // "cwd hash changed" case (so the user does not lose
  // access to a session they did use, just under a
  // different cwd-derived id).
  let sessionId: string | undefined
  if (persist && options.newSession !== true) {
    const { resolveChatSession, rememberChatSession } = await import('../chat-session.js')
    const { resolveChatSessionId: resolveP59 } = await import('../chat-paths.js')
    const p63 = await resolveChatSession({
      cwd,
      ...(options.sessionId !== undefined ? { explicitSessionId: options.sessionId } : {}),
      ...(options.pinnedToCwd === true ? { pinnedToCwd: true } : {}),
    })
    if (memoryStore && options.pinnedToCwd !== true) {
      // P59 safety net: if the P63-remembered key has no
      // matching row in the SqliteStore, fall through to
      // the most-recent session (P59 contract). This
      // protects against the "I upgraded lumen, my old
      // session was keyed by a different id strategy" case.
      const sessions = await memoryStore.listSessions(1000)
      const hit = sessions.some((s) => s.id === p63.sessionId)
      if (!hit) {
        sessionId = await resolveP59({ store: memoryStore, cwd })
      } else {
        sessionId = p63.sessionId
      }
    } else {
      sessionId = p63.sessionId
    }
    // Persist last-used. The outer `if` already guards
    // `options.newSession !== true`, so the operator
    // reached this line only when `--new-session` was
    // NOT set. The remember file is updated on every
    // launch so the next `lumen chat` in the same cwd
    // resumes the same session.
    await rememberChatSession({ cwd, sessionId })
  }

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
  // P57 — the SqliteStore is the same instance the
  // agent writes `session_messages` to on every
  // turn. We pass it into the Chat component so
  // the P57 effect can fetch prior-conversation
  // messages on mount. Pre-P57 the TUI was
  // limited to the in-progress checkpoint path
  // (P32.2), which only restores unfinished
  // runs; a `success` / `error` outcome cleared
  // the checkpoint and the TUI would reopen to
  // an empty log even though every turn was on
  // disk.
  // P59 — the memory store is now initialised
  // before `sessionId` (see above) so the
  // resolver can read existing sessions. The
  // P57 docblock is preserved here.
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
      ...(memoryStore !== undefined ? { memoryStore } : {}),
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
