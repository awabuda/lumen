/**
 * P32.3 — `/sessions` slash command.
 *
 * Five sub-commands:
 *
 *   /sessions                    → list recent 10 sessions
 *   /sessions list [N]           → list, custom limit
 *   /sessions show <id>          → show last-checkpoint preview line
 *   /sessions switch <id>        → queue next-session preference + tell
 *                                  the user to exit and relaunch with
 *                                  --session-id <id> for safety
 *                                  (mid-stream hot-swap of the
 *                                  checkpoint store is intentionally
 *                                  not supported; see commit message
 *                                  for the rationale)
 *   /sessions delete <id>        → drop every checkpoint under the id
 *   /sessions help               → one-line usage
 *
 * The slash handler is intentionally narrow on its public surface:
 * it consumes a `BaseCheckpointStore` (already passed into the TUI
 * via the `checkpointStore` prop wired in P32.1) and an optional
 * `currentSessionId` for marking the active session in `/sessions
 * list` output. It does NOT touch the running `streamRun`, because
 * hot-swapping the store mid-generation corrupts the in-flight
 * checkpoint id sequence; the safer UX is "queue, then exit and
 * relaunch".
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentCheckpoint, BaseCheckpointStore, CheckpointSessionSummary } from '@lumen/core'

const NEXT_SESSION_FILE = 'chat-next-session.json'

const defaultNextSessionPath = (): string => {
  const override = process.env.LUMEN_CHAT_NEXT_SESSION_PATH
  if (override !== undefined && override.length > 0) return override
  const xdgState = process.env.XDG_STATE_HOME
  if (xdgState !== undefined && xdgState.length > 0) {
    return path.join(xdgState, 'lumen', NEXT_SESSION_FILE)
  }
  return path.join(os.homedir(), '.local', 'state', 'lumen', NEXT_SESSION_FILE)
}

export interface SessionsSlashContext {
  /** The store backing this TUI session. Required for every command. */
  readonly checkpointStore: BaseCheckpointStore
  /**
   * The sessionId that the running TUI was started with. Used by
   * `list` to mark the active row with a `←` indicator so the user
   * can see at a glance which row they are currently on.
   */
  readonly currentSessionId?: string
  /** Path to the next-session queue file. Override is for tests. */
  readonly nextSessionPath?: string
}

export interface SessionsSlashResult {
  readonly message: string
  /**
   * Set when the command queues a session-switch for the next
   * launch; the caller (Chat.tsx) uses this to refresh the
   * visible hint. Today, the only such case is `/sessions switch
   * <id>`. Empty for read-only commands.
   */
  readonly queuedSessionId?: string
}

const rfc3339ish = (epochMs: number): string => {
  const d = new Date(epochMs)
  // Locale-free short format: YYYY-MM-DD HH:MM UTC
  const pad = (n: number): string => `${n}`.padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
  )
}

const sessionShort = (id: string): string => {
  // Sessions look like `chat-AbCdEfGhIjK` from P32.1 — keep the
  // prefix + 8 chars so a wide TUI can show the active marker
  // without crowding the list.
  if (id.length <= 14) return id
  return `${id.slice(0, 14)}…`
}

const formatListLine = (s: CheckpointSessionSummary, isActive: boolean): string => {
  const marker = isActive ? '← ' : '  '
  const id = sessionShort(s.sessionId)
  return (
    `${marker}${id}  ` +
    `${rfc3339ish(s.lastCreatedAt)}  ` +
    `${s.checkpointCount} cp${s.hasInProgress ? '  (live)' : ''}`
  )
}

export const handleSessionsSlash = async (
  raw: string,
  ctx: SessionsSlashContext,
): Promise<SessionsSlashResult> => {
  const parts = raw.split(/\s+/).filter((p) => p.length > 0)
  const sub = parts[1]
  if (sub === undefined) {
    return listSessions(ctx, 10)
  }
  if (sub === 'list') {
    const limitRaw = parts[2]
    const limit = limitRaw !== undefined ? Number.parseInt(limitRaw, 10) : 10
    if (!Number.isInteger(limit) || limit < 1) {
      return { message: '[sessions] list limit must be a positive integer' }
    }
    return listSessions(ctx, limit)
  }
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    return { message: SESSIONS_HELP }
  }
  if (sub === 'show') {
    const id = parts[2]
    if (id === undefined) return { message: '[sessions] show <id> — id required' }
    return showSession(ctx, id)
  }
  if (sub === 'switch') {
    const id = parts[2]
    if (id === undefined) return { message: '[sessions] switch <id> — id required' }
    return await queueSessionSwitch(ctx, id)
  }
  if (sub === 'delete') {
    const id = parts[2]
    if (id === undefined) return { message: '[sessions] delete <id> — id required' }
    return await deleteSession(ctx, id)
  }
  return {
    message: `[sessions] unknown sub-command: ${sub}\n\n${SESSIONS_HELP}`,
  }
}

const SESSIONS_HELP = [
  '[sessions] commands:',
  '  /sessions                  list recent 10',
  '  /sessions list [N]         list recent N (default 10)',
  '  /sessions show <id>        show last checkpoint summary',
  '  /sessions switch <id>      queue <id> for next launch (then exit + restart)',
  '  /sessions delete <id>      delete all checkpoints under <id>',
  '  /sessions help             this message',
].join('\n')

const listSessions = async (
  ctx: SessionsSlashContext,
  limit: number,
): Promise<SessionsSlashResult> => {
  const summaries = await ctx.checkpointStore.listSessions({ limit })
  if (summaries.length === 0) {
    return {
      message: '[sessions] no stored sessions yet — `lumen chat` writes here after the first turn',
    }
  }
  const lines = ['[sessions] recent conversations:']
  for (const s of summaries) {
    lines.push(formatListLine(s, s.sessionId === ctx.currentSessionId))
  }
  return { message: lines.join('\n') }
}

const showSession = async (
  ctx: SessionsSlashContext,
  sessionId: string,
): Promise<SessionsSlashResult> => {
  const summaries = await ctx.checkpointStore.listSessions({ limit: 1_000 })
  const match = summaries.find((s) => s.sessionId === sessionId)
  if (match === undefined) {
    return { message: `[sessions] no such session: ${sessionId}` }
  }
  const checkpoints = await ctx.checkpointStore.list(sessionId)
  const last = checkpoints[0]
  const lastInfo = formatLastCheckpoint(last)
  const lines = [
    `[sessions] ${sessionShort(sessionId)}`,
    `  last activity: ${rfc3339ish(match.lastCreatedAt)}`,
    `  checkpoints: ${match.checkpointCount}${match.hasInProgress ? ' (1+ live)' : ''}`,
    `  last checkpoint: ${lastInfo}`,
  ]
  return { message: lines.join('\n') }
}

const formatLastCheckpoint = (cp: AgentCheckpoint | undefined): string => {
  if (cp === undefined) return '(none)'
  const ts = rfc3339ish(cp.createdAt)
  const outcome = cp.outcome ?? 'in_progress'
  const iter = `it=${cp.iterations}`
  return `${ts} ${outcome} ${iter}`
}

const queueSessionSwitch = async (
  ctx: SessionsSlashContext,
  sessionId: string,
): Promise<SessionsSlashResult> => {
  if (sessionId === ctx.currentSessionId) {
    return {
      message: `[sessions] already in ${sessionShort(sessionId)} — nothing to switch`,
    }
  }
  const target = ctx.nextSessionPath ?? defaultNextSessionPath()
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, JSON.stringify({ sessionId, queuedAt: Date.now() }, null, 0), 'utf8')
  return {
    message:
      `[sessions] queued ${sessionShort(sessionId)} as next launch.\n` +
      `[sessions] exit this TUI and run: lumen chat --session-id ${sessionId}`,
    queuedSessionId: sessionId,
  }
}

const deleteSession = async (
  ctx: SessionsSlashContext,
  sessionId: string,
): Promise<SessionsSlashResult> => {
  if (sessionId === ctx.currentSessionId) {
    return {
      message: `[sessions] refuse: cannot delete the running session ${sessionShort(sessionId)}.\n[sessions] exit and remove it from another shell: lumen session delete <id>`,
    }
  }
  const removed = await ctx.checkpointStore.deleteSession(sessionId)
  if (removed === 0) {
    return { message: `[sessions] no checkpoints under ${sessionShort(sessionId)}` }
  }
  return {
    message: `[sessions] removed ${removed} checkpoint${removed === 1 ? '' : 's'} from ${sessionShort(sessionId)}`,
  }
}
