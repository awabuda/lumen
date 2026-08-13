/**
 * P63 — TUI session resolution in OpenClaw style.
 *
 * ## Why
 *
 * Pre-P63 `lumen chat` resolved the session id from a
 * sha256(cwd) base64url hash (P32.1). The design assumed
 * the operator's primary use case was "I am working in
 * /path/to/project, reopen TUI, continue yesterday's
 * conversation". The hidden cost: every time the operator
 * wanted a blank session, they had to pass `--new-session`;
 * the P59 fallback to "most recent session" actually
 * made the surprise worse — if no cwd-derived session
 * existed, `lumen chat` silently resumed the most
 * recent session, which on a long-lived machine was
 * usually a session the operator had forgotten about.
 *
 * P63 switches the default to OpenClaw's
 * `tui_last_sessions` pattern (see
 * `~/workspace/openclaw-main/src/tui/tui-last-session.ts`
 * and `src/tui/tui.ts:957-1005`):
 *   - The session id is **remembered** per-scope, not
 *     derived from cwd.
 *   - The scope is `sha256(cwd)[:8].base64url` (same as
 *     P32.1's `defaultChatSessionId`), so "different cwd,
 *     different remembered session" still holds — but
 *     within one cwd, the user gets the session they
 *     LAST USED, not the session the cwd hash points to.
 *   - "Last used" is updated on every successful session
 *     resolution; the file is at `~/.lumen/chat_last_session`
 *     (one row per scopeKey, mirroring OpenClaw's
 *     `tui_last_sessions` SQLite table).
 *
 * The 3-layer fallback mirrors OpenClaw's
 * `resolveTuiSessionKey` (line 957 of tui.ts):
 *   1. Explicit `--session-id <id>` flag → use that.
 *      Wins over remembered (operator can always override).
 *   2. No explicit flag → read `chat_last_session` for
 *      the cwd's scopeKey; if a row exists, use the
 *      stored session key.
 *   3. No row yet (fresh install, or first launch in a
 *      new cwd) → use the cwd-derived id (P32.1 default).
 *      The cwd-derived id is then written to the
 *      remembered file so subsequent launches in the
 *      same cwd reuse it.
 *
 * Why a flat file (not SQLite): the `chat_last_session`
 * file holds exactly one row per scopeKey; SQLite is
 * overkill for that. The `lumen` global symlink is a
 * bash wrapper that already calls into a Node binary
 * that has access to `node:fs`; a plain JSON file
 * (`{"<scopeKey>": "<sessionId>"}`) is the simplest
 * shape that round-trips and stays inspectable by the
 * operator. A SQLite table would add a 200ms startup
 * cost for a 50-byte piece of state. OpenClaw uses
 * SQLite because their state database is shared with
 * the Gateway process (which needs a concurrent
 * reader); Lumen's `lumen chat` is single-process so
 * a flat file is the right tool.
 *
 * ## Out of scope
 *
 * - Multi-cwd remembered sessions are NOT grouped under
 *   a single root. The flat file is a flat map; new
 *   cwd launches append a row, never overwrite an
 *   existing one.
 * - Concurrent `lumen chat` processes (e.g. two TUI
 *   sessions open at once) race on the file. The
 *   race is benign: last-writer-wins, the operator
 *   who closes the second TUI second is the one whose
 *   session is remembered. This is OpenClaw's behaviour
 *   too (`writeTuiLastSessionKey` is a plain UPSERT).
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as nodePath from 'node:path'

import { defaultChatSessionId } from './chat-paths.js'

const LUMEN_HOME = process.env['LUMEN_HOME'] ?? nodePath.join(os.homedir(), '.lumen')
const CHAT_LAST_SESSION_PATH = nodePath.join(LUMEN_HOME, 'chat_last_session')

/** sha256(cwd)[:8] base64url — same derivation as P32.1. */
const scopeKeyForCwd = (cwd: string): string => defaultChatSessionId(cwd)

const readMapAt = async (filePath: string): Promise<Record<string, string>> => {
  try {
    const text = await fs.readFile(filePath, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
    ) {
      const out: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v
      }
      return out
    }
    return {}
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    return {}
  }
}

const readMap = (): Promise<Record<string, string>> => readMapAt(CHAT_LAST_SESSION_PATH)

const writeMapAt = async (filePath: string, map: Record<string, string>): Promise<void> => {
  const text = `${JSON.stringify(map, null, 2)}\n`
  try {
    await fs.mkdir(nodePath.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, text, 'utf8')
  } catch {
    // best-effort: a failed write on the "remember" step
    // is not fatal — the session still works for the
    // current launch; only the cross-launch restore is
    // affected. Surfacing a hard error here would be
    // worse UX than silently losing the remembered key.
  }
}

const writeMap = (map: Record<string, string>): Promise<void> => writeMapAt(CHAT_LAST_SESSION_PATH, map)

export interface ResolveChatSessionOptions {
  /** cwd-derived scope key (P32.1 hash). Always required. */
  readonly cwd: string
  /** Explicit `--session-id` flag. Wins over remembered. */
  readonly explicitSessionId?: string
  /**
   * When true, skip the remembered lookup and use the
   * cwd-derived id (P32.1 behaviour). The cwd-derived
   * id is NOT written to the remembered file when this
   * flag is set — the operator is asking for a
   * one-shot cwd-bound session, not a permanent
   * override of the remembered key.
   */
  readonly pinnedToCwd?: boolean
  /**
   * Override the default file path. Tests use this; the
   * CLI passes undefined and the `LUMEN_HOME` env
   * resolves it.
   */
  readonly rememberPath?: string
}

/**
 * Resolve the session id for `lumen chat`. Returns the
 * chosen id AND the path that the CLI should write back
 * to (so the caller can persist `last-used` without
 * re-reading the file). The function is pure except for
 * the read of the remember file; the write is the
 * caller's responsibility (via {@link rememberChatSession}).
 */
export const resolveChatSession = async (
  options: ResolveChatSessionOptions,
): Promise<{ readonly sessionId: string; readonly scopeKey: string }> => {
  const scopeKey = scopeKeyForCwd(options.cwd)
  if (options.explicitSessionId !== undefined && options.explicitSessionId.length > 0) {
    return { sessionId: options.explicitSessionId, scopeKey }
  }
  if (options.pinnedToCwd === true) {
    return { sessionId: scopeKey, scopeKey }
  }
  const path = options.rememberPath ?? CHAT_LAST_SESSION_PATH
  const map = await readMapAt(path)
  const remembered = map[scopeKey]
  if (remembered !== undefined && remembered.length > 0) {
    return { sessionId: remembered, scopeKey }
  }
  return { sessionId: scopeKey, scopeKey }
}

/**
 * Persist the last-used session id for the scopeKey.
 * No-op when `sessionId` is the same as the existing
 * value (avoids unnecessary fs writes on every chat
 * launch). Best-effort: a write failure is swallowed
 * (see `writeMap` for rationale).
 *
 * The optional `rememberPath` override is for tests
 * (the real path is resolved at module load from
 * `LUMEN_HOME`).
 */
export const rememberChatSession = async (
  options: { readonly cwd: string; readonly sessionId: string; readonly rememberPath?: string },
): Promise<void> => {
  const scopeKey = scopeKeyForCwd(options.cwd)
  const path = options.rememberPath ?? CHAT_LAST_SESSION_PATH
  const map = await readMapAt(path)
  if (map[scopeKey] === options.sessionId) return
  map[scopeKey] = options.sessionId
  await writeMapAt(path, map)
}

/** Test-only: clear the remembered file (used by integration tests). */
export const _clearRememberedSessions = async (): Promise<void> => {
  try {
    await fs.unlink(CHAT_LAST_SESSION_PATH)
  } catch {
    /* file absent is the desired state */
  }
}