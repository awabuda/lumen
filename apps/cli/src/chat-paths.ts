/**
 * P32.1 — Default-path helpers for `lumen chat`.
 *
 * Two concerns live here:
 *
 *   1. `defaultChatCheckpointPath` — where to put the per-chat
 *      SQLite checkpoint database. Distinct from
 *      `~/.lumen/memory.db` (the SqliteStore) on purpose: chat
 *      checkpoints are full-message snapshots with a TTL and
 *      session scoping; memory facts are smaller scoped records.
 *      Mixing the two schemas into one file would couple two
 *      lifecycles that have different retention policies.
 *
 *      Resolution order (XDG-style):
 *        $LUMEN_CHAT_CHECKPOINT_PATH  (override, useful for tests)
 *        $XDG_STATE_HOME/lumen/chat.sqlite
 *        $HOME/.local/state/lumen/chat.sqlite
 *        $HOME/.lumen/chat.sqlite    (legacy fallback)
 *
 *   2. `defaultChatSessionId` — a stable session identifier
 *      derived from the cwd. The shape (`chat-<cwdHash>`) makes
 *      "I am working in /path/to/project" deterministic across
 *      restarts so the user reopens `lumen chat` and lands back
 *      in the same conversation. The hash gives:
 *        - cwd privacy (no full path leaks into the session id)
 *        - portable length (≤ 64 chars, well under LangGraph's
 *          thread_id ≤ 255 char ceiling)
 *        - filesystem-safety (only `[A-Za-z0-9_-]`, no `.` or `/`)
 *
 *      User can override with `--session-id` on the CLI, force a
 *      fresh session with `--new-session`, or opt out of disk
 *      persistence entirely with `--no-persist`.
 *
 * Why a separate module: composition.ts / checkpoint-resume.ts
 * already keep their own path resolution helpers
 * (`defaultMemoryPath`, `DEFAULT_RESUME_TTL_MS`). Centralising
 * chat's path logic in one file means tests can exercise
 * XDG_STATE_HOME precedence and cwd-hash stability without
 * pulling in Ink, React, or the better-sqlite3 ABI.
 */

import * as crypto from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Resolve the file path for `lumen chat`'s SQLite checkpoint
 * store. Pure function — no filesystem I/O, no env mutation
 * beyond `process.env` reads.
 */
export const defaultChatCheckpointPath = (): string => {
  const override = process.env.LUMEN_CHAT_CHECKPOINT_PATH
  if (override !== undefined && override.length > 0) return override
  const xdgState = process.env.XDG_STATE_HOME
  if (xdgState !== undefined && xdgState.length > 0) {
    return path.join(xdgState, 'lumen', 'chat.sqlite')
  }
  return path.join(os.homedir(), '.local', 'state', 'lumen', 'chat.sqlite')
}

/**
 * Stable session id derived from `cwd`. Same cwd → same id →
 * same conversation across restarts. Uses sha256 (first 8 bytes,
 * base64url) so the id is short, filesystem-safe, and
 * cwd-revealing only to the operator who already knows the cwd.
 */
export const defaultChatSessionId = (cwd: string): string => {
  const normalised = path.resolve(cwd)
  const digest = crypto.createHash('sha256').update(normalised).digest()
  // Take 8 bytes (64 bits), base64url → 11 chars. Base64url has
  // no `=` padding, no `/` or `+`, so the result is safe to embed
  // in checkpoint ids (`sessionId-iterations` is the primary key)
  // and CLI flags.
  const short = digest
    .subarray(0, 8)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `chat-${short}`
}

/**
 * P59 — resolve the `sessionId` for `lumen chat`.
 *
 * Pre-P59 the chat command always used
 * `defaultChatSessionId(cwd)` (a sha256-derived
 * stable id). If the cwd hash changed (e.g. a
 * mid-life `path.resolve` change, a different
 * invocation path, or a `--session-id` override
 * that landed before P32.1's `defaultChatSessionId`
 * shipped), the operator's existing session
 * history was orphaned: every `lumen chat` re-launch
 * created a fresh session (the chat log rendered
 * empty, the agent said "this is the first
 * message", whether or not prior turns had landed
 * in `session_messages`).
 *
 * P59 keeps the cwd-derived default for new installs
 * but adds a fallback: if no session with the
 * cwd-derived id exists, `lumen chat` looks up the
 * most recent session in the SqliteStore and
 * resumes it. The operator's prior conversation
 * is preserved without an explicit `--resume`
 * flag. The fallback is gated on a SqliteStore
 * read (best-effort: corrupted memory file → falls
 * back to the cwd-derived default).
 *
 * Pass `store.listSessions` directly so the CLI
 * surface stays a pure function over the store
 * API rather than a side-effecting helper.
 */
export const resolveChatSessionId = async (options: {
  readonly store: { listSessions: (limit?: number) => Promise<ReadonlyArray<{ id: string }>> }
  readonly cwd: string
}): Promise<string> => {
  const cwdDerived = defaultChatSessionId(options.cwd)
  let sessions: ReadonlyArray<{ id: string }>
  try {
    sessions = await options.store.listSessions(1000)
  } catch {
    // best-effort
    return cwdDerived
  }
  // 1. cwd-derived id wins if it exists.
  if (sessions.some((s) => s.id === cwdDerived)) {
    return cwdDerived
  }
  // 2. Fall back to the most recent session. The
  //    listSessions contract is `ORDER BY updated_at DESC`,
  //    so the first row is the most recent.
  const first = sessions[0]
  if (first !== undefined) {
    return first.id
  }
  // 3. No sessions at all → use the cwd-derived id
  //    (a fresh session will be created on the
  //    first persistMessage).
  return cwdDerived
}
