/**
 * P26.1 — #45 vision schema (Pass-3 audit catch).
 *
 * The UserMessageSchema already accepts `string | ContentPart[]`
 * where ContentPart is a discriminated union on `type`
 * including `image` (URL or base64). This file pins the
 * public surface so a future refactor cannot silently
 * remove the multimodal support.
 *
 * Pass-3 audit catch: P26.0 §1.2 assumed the schema was
 * missing; a code-level grep showed it was already
 * present. The test below is the verification.
 */

import { describe, expect, it } from 'vitest'

import {
  ContentPartSchema,
  ImagePartSchema,
  TextPartSchema,
  UserMessageSchema,
} from '../src/message/index.js'

describe('P26.1 — vision schema (#45) is already shipped', () => {
  it('TextPartSchema accepts a plain text part', () => {
    expect(
      TextPartSchema.safeParse({ type: 'text', text: 'hello' }).success,
    ).toBe(true)
  })

  it('ImagePartSchema accepts a URL source', () => {
    expect(
      ImagePartSchema.safeParse({
        type: 'image',
        source: { kind: 'url', url: 'https://example.com/cat.png' },
      }).success,
    ).toBe(true)
  })

  it('ImagePartSchema accepts a base64 source', () => {
    expect(
      ImagePartSchema.safeParse({
        type: 'image',
        source: { kind: 'base64', mediaType: 'image/png', data: 'iVBORw0KGgo' },
      }).success,
    ).toBe(true)
  })

  it('ImagePartSchema rejects a malformed source', () => {
    expect(
      ImagePartSchema.safeParse({
        type: 'image',
        source: { kind: 'url', url: 'not-a-url' },
      }).success,
    ).toBe(false)
  })

  it('ContentPartSchema discriminates on type', () => {
    expect(
      ContentPartSchema.safeParse({ type: 'text', text: 'hi' }).success,
    ).toBe(true)
    expect(
      ContentPartSchema.safeParse({
        type: 'image',
        source: { kind: 'url', url: 'https://example.com/x.png' },
      }).success,
    ).toBe(true)
    expect(
      ContentPartSchema.safeParse({ type: 'audio' }).success,
    ).toBe(false)
  })

  it('UserMessageSchema accepts a multimodal content array (text + image)', () => {
    const r = UserMessageSchema.safeParse({
      role: 'user',
      content: [
        { type: 'text', text: 'what is in this image?' },
        {
          type: 'image',
          source: { kind: 'url', url: 'https://example.com/cat.png' },
          alt: 'a cat',
        },
      ],
    })
    expect(r.success).toBe(true)
  })

  it('UserMessageSchema still accepts the plain-string form (back-compat)', () => {
    expect(
      UserMessageSchema.safeParse({ role: 'user', content: 'hi' }).success,
    ).toBe(true)
  })

  it('UserMessageSchema rejects a non-string / non-part-array content', () => {
    expect(
      UserMessageSchema.safeParse({ role: 'user', content: 42 }).success,
    ).toBe(false)
  })
})