/**
 * P25.10 (bug.md #44) \u2014 Message Channel interface.
 *
 * Pluggable adapter for non-CLI surfaces (Slack,
 * Telegram, WhatsApp, custom HTTP, etc.). The
 * \`MessageChannel\` interface is the canonical
 * primitive; reference adapters ship as separate
 * files (\`@lumen/core/agent/channels/slack.ts\` etc.)
 * to keep the core bundle hermetic.
 *
 * Why a small interface and not an abstract
 * \`BaseChannel\` class (P19+ rule 14): the channel
 * surface is small enough that a class adds zero
 * behavioural gain. Operators wire whichever adapter
 * they want via \`buildChannel()\`.
 */

import { z } from 'zod'

export const ChannelMessageSchema = z
  .object({
    /** Stable id for the message (channel-provided). */
    id: z.string().min(1),
    /** Channel id (\`slack\` / \`telegram\` / etc.). */
    channelId: z.string().min(1),
    /** Id of the operator / user on the channel's side. */
    senderId: z.string().min(1),
    /** Display label (best-effort). */
    senderLabel: z.string().optional(),
    /** Body text. */
    body: z.string().min(1),
    /** Wall-clock ms of message arrival. */
    receivedAtMs: z.number().int().min(0),
    /** Optional thread id for threaded channels. */
    threadId: z.string().optional(),
  })
  .strict()

export type ChannelMessage = z.infer<typeof ChannelMessageSchema>

export const ChannelSendSchema = z
  .object({
    /** Recipient id (channel-specific: chatId, channelId, etc.). */
    to: z.string().min(1),
    /** Body text. */
    body: z.string().min(1),
    /** Optional thread id (for threaded channels). */
    threadId: z.string().optional(),
  })
  .strict()

export type ChannelSend = z.infer<typeof ChannelSendSchema>

/**
 * Pluggable channel contract. Reference adapters
 * implement this surface; the agent loop consumes the
 * messages via \`poll()\`.
 */
export interface MessageChannel {
  /** Stable id (\`slack\` / \`telegram\` / etc.). */
  readonly id: string
  /** Optional one-time setup (auth handshake, etc.). */
  start: () => Promise<void>
  /** Tear down the channel. */
  stop: () => Promise<void>
  /** Non-blocking poll: returns any messages received
   *  since the last poll. Empty array is fine. */
  poll: () => Promise<ReadonlyArray<ChannelMessage>>
  /** Send a reply. */
  send: (send: ChannelSend) => Promise<void>
}

/** Channel options (passed to the reference adapter). */
export interface ChannelOptions {
  /** Free-form credentials blob (token, appId, etc.).
   *  Each adapter documents the expected shape. */
  readonly credentials?: Readonly<Record<string, unknown>>
  /** Optional logger adapter (defaults to console). */
  readonly log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

const noLog = (level: 'info' | 'warn' | 'error', message: string): void => {
  if (level === 'error') process.stderr.write(`[lumen channel] ${message}\n`)
  else process.stdout.write(`[lumen channel] ${message}\n`)
}

/** Validate an inbound message against the schema. */
export const validateChannelMessage = (raw: unknown): ChannelMessage =>
  ChannelMessageSchema.parse(raw)

/** Validate an outbound send. */
export const validateChannelSend = (raw: unknown): ChannelSend =>
  ChannelSendSchema.parse(raw)

/** Convenience: a no-op channel implementation for
 *  tests + documentation. The reference adapters
 *  (Slack / Telegram / WhatsApp) ship in separate
 *  files. */
export const NullChannel = (id = 'null'): MessageChannel => ({
  id,
  async start() {
    noLog('info', `${id}: start`)
  },
  async stop() {
    noLog('info', `${id}: stop`)
  },
  async poll() {
    return []
  },
  async send(send) {
    noLog('info', `${id}: send to=${send.to} bytes=${send.body.length}`)
  },
})