/**
 * Sub-agent context isolation (P25.1, bug.md #37).
 *
 * Each sub-agent runs inside its own `SubAgentContext` slice.
 * The slice is append-only via the `MiddlewareStateView.set()`
 * surface introduced in P23.3; cross-sub-agent reads are
 * permitted (the parent agent sees every slice) but writes
 * are blocked at runtime.
 *
 * Why a helper function (P19+ rule 15) and not an abstract
 * class: the context is just a typed Map keyed by sub-agent
 * id. Adding a `BaseSubAgentContext` would be wrapper-class
 * overhead for zero behavioural gain.
 */

import { z } from 'zod'
import type { Message } from '../message/index.js'

/** The per-sub-agent context slice. Append-only at the
 *  schema layer; `set()` calls re-parse via Zod before
 *  committing to the underlying store. */
export const SubAgentContextSchema = z
  .object({
    /** Stable id of the owning sub-agent. Required. */
    subAgentId: z.string().min(1),
    /** Display label (defaults to id). */
    label: z.string().optional(),
    /** Conversation history visible to this sub-agent only.
     *  The parent agent can READ this slice but cannot
     *  append to it from a different middleware. */
    history: z.array(z.unknown()).default([]),
    /** Memo for cross-iteration state (counters, caches). */
    memo: z.record(z.unknown()).default({}),
    /** Wall-clock ms of slice creation. */
    createdAtMs: z.number().int().min(0),
    /** Wall-clock ms of the last slice write. */
    lastWriteMs: z.number().int().min(0).optional(),
  })
  .strict()

export type SubAgentContext = z.infer<typeof SubAgentContextSchema>

/**
 * Per-sub-agent message-history filter. The sub-agent's own
 * messages (`role === 'assistant'` produced by the sub-agent
 * itself) appear in the slice; the parent agent's messages
 * are NOT pushed into the slice (they belong to the parent
 * conversation only).
 */
export const filterToSubAgent = (
  messages: ReadonlyArray<Message>,
  subAgentId: string,
): ReadonlyArray<Message> =>
  messages.filter((m) => {
    // The sub-agent id is attached as a meta tag at the
    // assistant message level. If the message has no
    // subAgentId meta, it's a parent message — keep it
    // out of the slice.
    // biome-ignore lint/suspicious/noExplicitAny: meta is
    // intentionally untyped at this layer.
    const id = (m as any).meta?.subAgentId
    return id === undefined || id === subAgentId
  })

/**
 * Factory: create a fresh empty slice for a new sub-agent.
 * P25.1 keeps the shape minimal; future P-tickets may
 * extend the schema (e.g. add `parentSliceRef` for the
 * permission-policy plumbing in P25.4).
 */
export const createSubAgentContext = (params: {
  readonly subAgentId: string
  readonly label?: string
  readonly now?: () => number
}): SubAgentContext => {
  const now = params.now ?? (() => Date.now())
  return SubAgentContextSchema.parse({
    subAgentId: params.subAgentId,
    ...(params.label !== undefined ? { label: params.label } : {}),
    createdAtMs: now(),
  })
}

/**
 * Append a message to a slice, re-parsing the slice
 * afterwards so a malformed write fails closed.
 *
 * Pure helper; the caller is responsible for persisting the
 * new slice via `MiddlewareStateView.set()`.
 */
export const appendToSubAgent = (
  slice: SubAgentContext,
  message: Message,
  now?: () => number,
): SubAgentContext =>
  SubAgentContextSchema.parse({
    ...slice,
    history: [...slice.history, message],
    lastWriteMs: (now ?? (() => Date.now()))(),
  })

/**
 * Memo helper: set a memo key without losing the rest.
 *
 * Why a helper: the slice's `memo` is a Record. The naive
 * `slice.memo[key] = value` violates P19+ rule 12 (Zod
 * strict-mode). We re-parse through the schema.
 */
export const memoSet = (
  slice: SubAgentContext,
  key: string,
  value: unknown,
): SubAgentContext =>
  SubAgentContextSchema.parse({
    ...slice,
    memo: { ...slice.memo, [key]: value },
  })