/**
 * createAgent factory (P19.0.3) — the composition root's entry point.
 *
 * Why a factory (CLAUDE.md P19+ rule 13 + P19-DESIGN.md §1.5):
 *   "Any 'Agent entry-point encapsulation' = createAgent factory. Do
 *    NOT hand-roll `new Agent({...})` + a stack of middleware in
 *    `apps/cli/src/composition.ts`. Encapsulate behind
 *    `createAgent(config)` so the composition root stays a flat
 *    list of collaborators."
 *
 * P19.0.3 scope (additive, not breaking):
 *   - Accepts a `CreateAgentConfig` that extends `AgentConfig` with
 *     a `middleware?: ReadonlyArray<AgentMiddleware>` field.
 *   - Validates the middleware list via `parseMiddleware` (P19.0.1)
 *     at construction time. Throws `MiddlewareError` on duplicate
 *     names / missing names.
 *   - Returns a regular `Agent` instance. P19.0.3 does NOT modify
 *     `Agent` itself — the middleware list is stored on a private
 *     symbol-keyed property so the public AgentConfig surface is
 *     not affected. P19.0.2 will read this list and dispatch the
 *     5 hook points in the run loop.
 *
 * Why a symbol (not a public field):
 *   - P19.0.2 will add a real `middleware` field to AgentConfig
 *     once the wire-up lands. The symbol keeps the field off the
 *     public surface until then (lumen hard rule 9: no new
 *     top-level folders / no API surface change without a
 *     changeset).
 *   - The symbol is exported as a `Symbol` const (not a string) so
 *     external code cannot accidentally collide with the internal
 *     key.
 *
 * Composition order (lumen CLAUDE.md P19+ rule 11 + rule 19):
 *   - Middleware is applied in registration order. The same
 *     order is enforced by the agent loop (P19.0.2).
 *   - Hooks and middleware coexist: `HookRegistry` events still
 *     fire as before; middleware hooks fire **in addition** to
 *     the events, not as a replacement.
 *
 * Usage:
 *   ```typescript
 *   const agent = createAgent({
 *     provider,
 *     tools,
 *     model: 'gpt-4o-mini',
 *     middleware: [
 *       createPlanMiddleware({ mode: 'auto' }),
 *       createInlineReflectionMiddleware(),
 *     ],
 *   })
 *   await agent.run({ userMessage: 'hi' })
 *   ```
 */

import { Agent, type AgentConfig } from '../index.js'
import {
  type AgentMiddleware,
  type ParsedMiddleware,
  attachAgentMiddleware,
  parseMiddleware,
} from './middleware.js'

export { AGENT_MIDDLEWARE, getAgentMiddleware } from './middleware.js'

/**
 * Config accepted by {@link createAgent}. Extends `AgentConfig` with
 * one optional `middleware` field.
 *
 * Why not push `middleware` into `AgentConfig` itself:
 *   - P19.0.2 will move middleware dispatch into `Agent.run` and
 *     will add `middleware` to `AgentConfig` directly. P19.0.3
 *     deliberately keeps `AgentConfig` unchanged so the factory
 *     can be adopted incrementally without breaking existing
 *     `new Agent({...})` call sites (lumen P19 audit 6 questions
 *     #4: backwards compat).
 *   - When P19.0.2 lands, `CreateAgentConfig.middleware` becomes
 *     a thin re-export of `AgentConfig.middleware`. The factory
 *     keeps its current signature.
 */
export interface CreateAgentConfig extends AgentConfig {
  /**
   * Middleware to layer on top of the agent loop (P19.0 spec).
   * Each entry is dispatched at the 5 hook points
   * (beforeModel / afterModel / wrapModelCall / wrapToolCall /
   * state injection) in registration order.
   *
   * `name` is required on every middleware and must be unique
   * within this list — {@link createAgent} throws
   * `MiddlewareError` on duplicates at construction time.
   *
   * Optional. Defaults to `[]` (no middleware). The agent loop
   * falls back to the bare `Agent.run` behaviour when no
   * middleware is registered, so this field is fully additive.
   */
  readonly middleware?: ReadonlyArray<AgentMiddleware>
}

/**
 * The composition root's primary collaborator.
 *
 * Returns a fully-initialised {@link Agent} instance with the
 * provided middleware parsed and stored under
 * {@link AGENT_MIDDLEWARE}. The returned agent behaves exactly
 * like one constructed via `new Agent({...})` until P19.0.2 lands
 * — P19.0.3 is intentionally a no-op wrapper that:
 *   1. Validates the middleware list (so bad configs fail at
 *      composition time, not at the first `agent.run` call).
 *   2. Tags the agent with a symbol-keyed middleware list so
 *      P19.0.2 can read it without changing AgentConfig.
 *
 * @param config - the agent config, plus an optional middleware
 *                 list.
 * @returns a configured `Agent` instance.
 * @throws {MiddlewareError} on a duplicate / missing middleware
 *         name.
 */
export const createAgent = (config: CreateAgentConfig): Agent => {
  // Parse + validate the middleware list at construction time
  // so callers learn about bad configs immediately, not on the
  // first `agent.run` invocation. parseMiddleware is the
  // P19.0.1 function; this is its first real consumer outside
  // the test file.
  const parsedMiddleware: ReadonlyArray<ParsedMiddleware> = config.middleware
    ? parseMiddleware(config.middleware)
    : []

  // Build the Agent via `new Agent(config)` — the canonical path
  // — then attach the parsed middleware list to the instance
  // under AGENT_MIDDLEWARE. P19.0.2 will read this property.
  //
  // We avoid passing middleware as a public AgentConfig field
  // because P19.0.3 should be additive; P19.0.2 is the commit
  // that promotes middleware into AgentConfig. See the
  // CreateAgentConfig JSDoc for the rationale.
  const agent = new Agent(config)
  // The symbol is unique per process (Symbol.for reuses the
  // cross-realm identity, which is what we want: P19.0.2 lives
  // in the same package and uses Symbol.for too).
  attachAgentMiddleware(agent, parsedMiddleware)

  return agent
}
