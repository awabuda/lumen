/**
 * P31.5 — Marker-aware Anthropic system-prompt split.
 *
 * Mirrors §1.8 of the design doc: a single system-prompt
 * string that carries the lumen cache-boundary marker
 * (`<!-- LUMEN_CACHE_BOUNDARY -->`) is split into two
 * Anthropic system blocks — the stable prefix carries
 * `cache_control: { type: 'ephemeral' }` so Anthropic
 * caches it across requests, and the dynamic suffix
 * stays a plain text block (per-turn ephemeral).
 *
 * Without a marker, the helper degrades to a single
 * plain text block — preserving the pre-P31 wire shape
 * for callers that haven't yet been wired through
 * `buildSystemPrompt` (P31.6).
 */

import {
  splitByBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from '@lumen/core'
import type { AnthropicSystemBlock } from './anthropic.js'

/**
 * Build the Anthropic system blocks from a system-prompt
 * string. When the string contains the cache-boundary
 * marker, returns a two-block array (stable → cached,
 * dynamic → uncached). When the string has no marker,
 * returns a single plain block so the wire shape is
 * unchanged for callers without P31 wiring.
 *
 * Per design doc §1.8: "v1 only Anthropic really benefits"
 * — other providers ignore the marker (they receive one
 * string with the marker literal in it; that's harmless).
 */
export const buildAnthropicSystemBlocks = (
  prompt: string,
): ReadonlyArray<AnthropicSystemBlock> => {
  if (!prompt.includes(SYSTEM_PROMPT_CACHE_BOUNDARY)) {
    return [{ type: 'text', text: prompt }]
  }
  const { prefix, suffix } = splitByBoundary(prompt)
  // Edge case: marker was inserted but the stable prefix
  // is empty (very narrow constructor bug — defensive).
  // We fall back to a single uncached block so the request
  // still goes through.
  if (prefix.length === 0 && suffix.length === 0) {
    return [{ type: 'text', text: prompt }]
  }
  const blocks: AnthropicSystemBlock[] = []
  if (prefix.length > 0) {
    blocks.push({
      type: 'text',
      text: prefix,
      cache_control: { type: 'ephemeral' },
    })
  }
  if (suffix.length > 0) {
    blocks.push({ type: 'text', text: suffix })
  }
  return blocks
}

/**
 * Compose the complete `system` field for the Anthropic
 * request body. Joins the structured blocks produced by
 * {@link buildAnthropicSystemBlocks} with any caller-
 * supplied `providerOptions.anthropicSystemBlocks` (which
 * still take precedence per the pre-P31 fallback in
 * `splitSystemAndMessages`). If both are present we
 * concatenate them — Anthropic accepts an array of
 * blocks; the impl in {@link splitSystemAndMessages}
 * honours this contract.
 */
export const composeAnthropicSystemFromBlocks = (
  promptBlocks: ReadonlyArray<AnthropicSystemBlock>,
  callerBlocks?: ReadonlyArray<AnthropicSystemBlock>,
): ReadonlyArray<AnthropicSystemBlock> | undefined => {
  if (callerBlocks !== undefined && callerBlocks.length > 0) {
    return callerBlocks
  }
  return promptBlocks.length === 0 ? undefined : promptBlocks
}
