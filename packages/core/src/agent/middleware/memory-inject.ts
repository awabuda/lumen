/**
 * Memory-inject middleware (P62) — frozen MEMORY.md / USER.md
 * snapshot rendered into the system-prompt dynamic suffix on the
 * first model call.
 *
 * ## Why a middleware
 *
 * Injecting content into the system prompt on every model call is
 * an **Agent loop extension** (P19+ rule 11). The wire-up pattern
 * is identical to `createSkillTriggerMiddleware` (P20.6): a
 * factory function returning an `AgentMiddleware` that uses
 * `ctx.appendDynamicChunk` (the sanctioned R3 surface) so the
 * chunk lands in the **dynamic suffix** of the system prompt,
 * not as a standalone `{ role: 'system' }` message (which would
 * break Anthropic prefix cache + P31.1 byte-stability).
 *
 * ## Why a frozen snapshot
 *
 * Reading `MEMORY.md` / `USER.md` on every model call would mutate
 * the system-prompt prefix whenever the user edited those files,
 * invalidating the per-conversation prompt cache (see
 * `docs/P62-DESIGN.md` §1.1 for the full invariant). The middleware
 * captures the snapshot at composition time and pushes the rendered
 * block into `appendDynamicChunk` only on the **first**
 * `beforeModel` call (gated by an internal `pushed` flag). Mid-session
 * edits to MEMORY.md propagate on the next session start.
 *
 * Hermes implements the same shape via
 * `MemoryStore._system_prompt_snapshot`
 * (`tools/memory_tool.py:178-211`, comment line 195-197
 * "stable for the entire session (prefix-cache invariant holds)").
 * OpenClaw via `cacheStablePromptPrefix`
 * (`src/agents/system-prompt.ts:1050-1053`). P62 follows the same
 * pattern.
 *
 * ## Threat pattern scan
 *
 * On `loadMemorySnapshot()` (composition time, NOT in this file),
 * each entry is scanned with the 4-pattern minimal set in
 * `packages/memory/src/snapshot.ts` (system_override / prompt_leak
 * / tool_inject / secret_exfil). A hit replaces the entry in the
 * snapshot with `[BLOCKED: <file> entry contained pattern: <id>]`.
 * The original entry stays in the markdown file unchanged so the
 * user can see + remove it via their editor — silently dropping
 * poisoned entries would hide the attack from the user (Hermes
 * `tools/memory_tool.py:185-187` explicit comment).
 *
 * The scan is deterministic from disk bytes; no LLM involvement.
 * Full pattern-library expansion is deferred to P65.
 *
 * ## Out of scope (deferred P-tickets)
 *
 * - **P63** — reflection middleware auto-promote user fact to records
 *   + MEMORY.md (the WRITE side; P62 is the READ side)
 * - **P64** — `lumen memory put` / `lumen memory get` subcommand
 * - **P65** — full threat pattern library (P62 ships 4 patterns)
 * - **P66** — cross-cwd MEMORY scoping
 */

import { z } from 'zod'

import type { AgentMiddleware } from '../middleware.js'

/** Minimum shape a composition root must surface to the middleware. */
export const MemorySnapshotSchema = z
  .object({
    /**
     * Markdown body of `~/.lumen/MEMORY.md`, already sanitised by
     * `loadMemorySnapshot()`. Empty string means "no memory file
     * exists" — the middleware skips the chunk.
     */
    memory: z.string(),
    /**
     * Markdown body of `~/.lumen/USER.md`, already sanitised.
     * Empty string means "no user file".
     */
    user: z.string(),
  })
  .strict()

export type MemorySnapshot = z.infer<typeof MemorySnapshotSchema>

/** Configurable rule set. */
export const MemoryInjectOptionsSchema = z
  .object({
    /**
     * Frozen snapshot. Required. The middleware closes over it
     * and never re-reads; the caller is responsible for calling
     * `loadMemorySnapshot()` at composition time and passing
     * the result here.
     */
    snapshot: MemorySnapshotSchema,
  })
  .strict()

export type MemoryInjectOptions = z.infer<typeof MemoryInjectOptionsSchema>

/** State slice (intentionally empty — the snapshot is in the closure). */
export type MemoryInjectState = Record<string, never>

/**
 * Render the snapshot into the dynamic-suffix block. The shape is
 * stable across sessions (Hermes `MemoryStore._render_block`
 * parity). Empty blocks are dropped so the system prompt is
 * unaffected when both files are absent.
 */
const formatSnapshot = (snapshot: MemorySnapshot): string => {
  const parts: string[] = []
  if (snapshot.memory.length > 0) {
    parts.push(`[MEMORY]\n${snapshot.memory}`)
  }
  if (snapshot.user.length > 0) {
    parts.push(`[USER PROFILE]\n${snapshot.user}`)
  }
  return parts.join('\n\n')
}

/**
 * Create a memory-inject middleware.
 *
 * Algorithm:
 *   1. Render the snapshot into one chunk.
 *   2. On the first `beforeModel` call, push the chunk via
 *      `ctx.appendDynamicChunk`. Subsequent calls are
 *      no-ops (the chunk is already in the system prompt
 *      suffix; the cache-stable prefix invariant holds).
 *   3. If the rendered chunk is empty (both files absent),
 *      skip the push entirely.
 */
export const createMemoryInjectMiddleware = (
  options: MemoryInjectOptions,
): AgentMiddleware<MemoryInjectState> => {
  const parsed = MemoryInjectOptionsSchema.parse(options)
  const chunk = formatSnapshot(parsed.snapshot)
  const hasContent = chunk.length > 0
  let pushed = false

  return {
    name: 'memory-inject',
    stateSchema: z.object({}).strict(),
    initialState: {},
    beforeModel: async (messages, ctx) => {
      if (!hasContent || pushed) return messages
      // P31.6B — write to the dynamic suffix via the
      // sanctioned `appendDynamicChunk` surface (R3). The
      // chunk lands in the post-marker suffix via
      // `Agent.spliceDynamicChunks`; prepending a standalone
      // `{role: 'system'}` message would break the
      // single-string protocol and Anthropic prefix cache.
      ctx.appendDynamicChunk(chunk)
      pushed = true
      return messages
    },
  }
}