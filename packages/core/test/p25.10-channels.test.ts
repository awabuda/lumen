/**
 * P25.10 \u2014 Message Channel interface (bug.md #44).
 *
 * Pure interface + schema tests. The Slack / Telegram /
 * WhatsApp reference adapters ship as separate files in
 * a future P-ticket; this file pins the contract.
 */

import { describe, expect, it } from 'vitest'

import {
  ChannelMessageSchema,
  ChannelSendSchema,
  NullChannel,
  validateChannelMessage,
  validateChannelSend,
} from '../src/agent/channels/index.js'

describe('P25.10 \u2014 ChannelMessageSchema', () => {
  it('accepts a minimal valid message', () => {
    const r = ChannelMessageSchema.safeParse({
      id: 'm1',
      channelId: 'slack',
      senderId: 'u1',
      body: 'hi',
      receivedAtMs: 1000,
    })
    expect(r.success).toBe(true)
  })

  it('rejects an empty body', () => {
    expect(
      ChannelMessageSchema.safeParse({
        id: 'm1',
        channelId: 'slack',
        senderId: 'u1',
        body: '',
        receivedAtMs: 1000,
      }).success,
    ).toBe(false)
  })

  it('rejects unknown fields (strict)', () => {
    expect(
      ChannelMessageSchema.safeParse({
        id: 'm1',
        channelId: 'slack',
        senderId: 'u1',
        body: 'hi',
        receivedAtMs: 1000,
        rogue: 'x',
      }).success,
    ).toBe(false)
  })

  it('validateChannelMessage parses + throws on bad input', () => {
    expect(validateChannelMessage({
      id: 'm1',
      channelId: 'telegram',
      senderId: 'u1',
      body: 'hi',
      receivedAtMs: 1000,
    }).channelId).toBe('telegram')
    expect(() => validateChannelMessage({ body: 'no id' })).toThrow()
  })
})

describe('P25.10 \u2014 ChannelSendSchema', () => {
  it('accepts a valid send', () => {
    expect(ChannelSendSchema.safeParse({ to: 'u1', body: 'reply' }).success).toBe(true)
  })

  it('rejects an empty body', () => {
    expect(ChannelSendSchema.safeParse({ to: 'u1', body: '' }).success).toBe(false)
  })

  it('validateChannelSend round-trip', () => {
    const parsed = validateChannelSend({ to: 'u1', body: 'hello', threadId: 't1' })
    expect(parsed.threadId).toBe('t1')
  })
})

describe('P25.10 \u2014 NullChannel', () => {
  it('id defaults to "null"', () => {
    expect(NullChannel().id).toBe('null')
  })

  it('id honours a custom value', () => {
    expect(NullChannel('slack-test').id).toBe('slack-test')
  })

  it('start / stop / send are no-ops that resolve', async () => {
    const c = NullChannel()
    await expect(c.start()).resolves.toBeUndefined()
    await expect(c.stop()).resolves.toBeUndefined()
    await expect(c.send({ to: 'u1', body: 'hi' })).resolves.toBeUndefined()
  })

  it('poll returns an empty array', async () => {
    const c = NullChannel()
    expect(await c.poll()).toEqual([])
  })
})