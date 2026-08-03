/**
 * P31.5 — marker-aware Anthropic system-block builder
 * invariants.
 *
 * Mirrors design doc §1.8 + §2.1. Tests pin the wire shape
 * directly — every Anthropic call constructed by the helper
 * is asserted at the `cache_control` field level because a
 * regression there costs real money (missed prompt-cache
 * hits on repeated stable-prefix calls).
 */

import { describe, expect, it } from 'vitest'
import {
  buildAnthropicSystemBlocks,
  composeAnthropicSystemFromBlocks,
} from '../src/anthropic-marker.js'
import {
  joinWithBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from '@lumen/core'

describe('buildAnthropicSystemBlocks (P31.5 §1.8)', () => {
  it('returns a single plain block when there is no marker (pre-P31 wire shape)', () => {
    const out = buildAnthropicSystemBlocks('kernel text only')
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ type: 'text', text: 'kernel text only' })
    expect(out[0]?.cache_control).toBeUndefined()
  })

  it('returns a cached-stable + plain-dynamic pair when the marker is present', () => {
    const prompt = joinWithBoundary('STABLE KERNEL', 'D1: time=T0')
    const out = buildAnthropicSystemBlocks(prompt)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      type: 'text',
      text: 'STABLE KERNEL',
      cache_control: { type: 'ephemeral' },
    })
    expect(out[1]).toMatchObject({
      type: 'text',
      text: 'D1: time=T0',
    })
    expect(out[1]?.cache_control).toBeUndefined()
  })

  it('omits the dynamic block when the suffix is empty', () => {
    const prompt = joinWithBoundary('STABLE KERNEL', '')
    const out = buildAnthropicSystemBlocks(prompt)
    expect(out).toHaveLength(1)
    expect(out[0]?.cache_control).toEqual({ type: 'ephemeral' })
    expect(out[0]?.text).toBe('STABLE KERNEL')
  })

  it('omits the stable block when the prefix is empty (degenerate)', () => {
    // marker right at the start → prefix is empty, dynamic
    // is the whole prompt. We emit just the dynamic block.
    const prompt = `${SYSTEM_PROMPT_CACHE_BOUNDARY}\nD1: time=T0`
    const out = buildAnthropicSystemBlocks(prompt)
    expect(out).toHaveLength(1)
    expect(out[0]?.text).toContain('D1: time=T0')
    expect(out[0]?.cache_control).toBeUndefined()
  })

  it('falls back to a single block when both halves are empty', () => {
    const out = buildAnthropicSystemBlocks(SYSTEM_PROMPT_CACHE_BOUNDARY)
    expect(out).toHaveLength(1)
    expect(out[0]?.text).toBe(SYSTEM_PROMPT_CACHE_BOUNDARY)
  })
})

describe('composeAnthropicSystemFromBlocks (P31.5 caller-supplied override)', () => {
  it('caller blocks take precedence over prompt blocks', () => {
    const promptBlocks = buildAnthropicSystemBlocks(
      joinWithBoundary('STABLE', 'D1'),
    )
    const callerBlocks = [
      { type: 'text' as const, text: 'CALLER-OWN' },
    ]
    const composed = composeAnthropicSystemFromBlocks(promptBlocks, callerBlocks)
    expect(composed).toEqual(callerBlocks)
  })

  it('returns undefined when both inputs are empty / undefined', () => {
    expect(composeAnthropicSystemFromBlocks([])).toBeUndefined()
    expect(composeAnthropicSystemFromBlocks([], [])).toBeUndefined()
  })

  it('falls back to prompt blocks when caller blocks absent', () => {
    const promptBlocks = buildAnthropicSystemBlocks(
      joinWithBoundary('STABLE', 'D1'),
    )
    expect(composeAnthropicSystemFromBlocks(promptBlocks)).toEqual(promptBlocks)
  })
})
