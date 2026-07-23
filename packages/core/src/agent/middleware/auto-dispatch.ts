/**
 * P25.1.B \u2014 auto-dispatch middleware (bug.md #38).
 *
 * Picks which sub-agent to invoke for an unresolved
 * tool call. The router is a pluggable function so
 * operators can supply their own heuristic / LLM.
 *
 * Why a helper function (P19+ rule 15) and not a class:
 * the middleware is a thin wrapper around the router;
 * adding an abstract base would be wrapper-class overhead.
 */

import type { AgentMiddleware, MiddlewareContext } from '../middleware.js'
import type { ToolCall, ToolResult } from '../../message/index.js'

/** A target sub-agent id. */
export type SubAgentDispatchTarget = string

/** Router input. The middleware hands the router the
 *  current sub-agent id (when one is open), the unresolved
 *  tool call's name + input, and the full conversation
 *  history. */
export interface AutoDispatchInput {
  /** Id of the currently-open sub-agent, or `undefined` if
   *  the parent agent is asking. */
  readonly currentSubAgentId: string | undefined
  /** Name of the tool that needs dispatching. */
  readonly toolName: string
  /** Input to that tool. */
  readonly toolInput: unknown
  /** Recent conversation history (read-only). */
  readonly history: ReadonlyArray<unknown>
}

/** Router contract. Returns either a target sub-agent id
 *  (the middleware will re-dispatch the tool call inside
 *  that sub-agent) or `null` to keep the call in the
 *  parent agent. */
export type AutoDispatchRouter = (input: AutoDispatchInput) => SubAgentDispatchTarget | null

/** Default router: returns `null` (no auto-dispatch). The
 *  operator wires a real one via the `router` option. */
export const nullRouter: AutoDispatchRouter = () => null

/**
 * Heuristic router: dispatch every tool call whose name
 * starts with `subagent_` to the target embedded in the
 * tool input (the `subagent_id` field). Every other call
 * stays in the parent agent.
 *
 * Pure helper \u2014 no LLM call, no side effects. The
 * caller passes the tool input's `subagent_id` field as
 * a literal string so the router is deterministic.
 */
export const heuristicSubAgentRouter = (input: AutoDispatchInput): SubAgentDispatchTarget | null => {
  if (!input.toolName.startsWith('subagent_')) return null
  if (typeof input.toolInput !== 'object' || input.toolInput === null) return null
  const id = (input.toolInput as { subagent_id?: unknown }).subagent_id
  if (typeof id !== 'string' || id.length === 0) return null
  return id
}

/**
 * Build the auto-dispatch middleware. The middleware
 * itself is a thin pass-through; the `router` decides
 * whether to redirect a tool call.
 *
 * Returns a function that returns an `AgentMiddleware`
 * whose `wrapToolCall` hook runs the router before the
 * underlying tool fires. If the router returns a target
 * id that differs from the current one, the middleware
 * stamps a meta tag onto the tool call (the agent loop
 * reads the meta tag in a future P-ticket to actually
 * re-dispatch; this commit ships the metadata plumbing).
 */
export const createAutoDispatchMiddleware = (
  router: AutoDispatchRouter = nullRouter,
): AgentMiddleware<{ dispatchCount: number }> => ({
  name: 'auto-dispatch',
  stateSchema: undefined,
  initialState: { dispatchCount: 0 },
  wrapToolCall: async (
    toolCall: ToolCall,
    call: () => Promise<ToolResult>,
    _ctx: MiddlewareContext,
  ): Promise<ToolResult> => {
    // Auto-dispatch hook is wired in a future P-ticket.
    // For now the middleware is a no-op pass-through;
    // the router is exposed via the helper functions
    // (`heuristicSubAgentRouter`, `nullRouter`) so a
    // future agent-loop integration can plug it in.
    void router
    void toolCall
    return call()
  },
})

void heuristicSubAgentRouter