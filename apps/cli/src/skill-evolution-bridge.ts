/**
 * P34.2 (Phase B.2) — Skill auto-evolution bridge.
 *
 * Wires the assistant assembly's
 * `skillEvolution: 'reserved'` slot from P33.B Day1 to
 * `'trajectory'` (the active evolver) via a thin
 * composition over `HeuristicEvolver` from
 * `@lumen/skills`. The bridge's `afterRun` middleware
 * hook inspects the completed run and writes a new
 * SKILL.md when the conversation meets the
 * heuristic threshold (≥3 tool calls + non-error
 * final message + ≥10-char task description).
 *
 * Tier isolation: `@lumen/core` does NOT import
 * `@lumen/skills` (per P19+ rule 1). The bridge lives
 * in `apps/cli` where both packages are reachable.
 */

import { type EvolutionResult, HeuristicEvolver } from '@lumen/skills'
import { loadSkillRegistry } from './commands/skills.js'

export interface SkillEvolutionBridgeOptions {
  /** Skill root directory. Default `~/.lumen/skills`. */
  readonly skillsDir?: string
  /**
   * Override the evolver. The default is the
   * `HeuristicEvolver` (no LLM call); LLM-backed
   * evolution is a future ticket (per OPTIMIZATION-PLAN
   * §3 B.2 — out of phase B.2 scope).
   */
  readonly evolver?: HeuristicEvolver
}

/**
 * Adapter from `MiddlewareContext` (the shape every
 * `AgentMiddleware` afterRun hook sees) to the
 * `ChatMessage[]` shape the evolver expects.
 */
const toEvolverMessages = (
  messages: ReadonlyArray<{
    role: string
    content?: string | null
    toolCalls?: ReadonlyArray<{ name: string }>
  }>,
): ReadonlyArray<{ role: string; content: string; toolName?: string }> => {
  const out: Array<{ role: string; content: string; toolName?: string }> = []
  for (const m of messages) {
    if (m.role === 'user' || m.role === 'system' || m.role === 'assistant') {
      out.push({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })
    } else if (m.role === 'tool') {
      // The evolver counts role='tool' messages as the
      // tool-call signal. The tool name lives on the
      // assistant message's `toolCalls` array in
      // @lumen/core's Message shape; we look it up by
      // matching the most-recent assistant message
      // before each tool message. Simpler: use the
      // assistant-side toolCalls length as the
      // proxy when the evolver only needs the count.
      out.push({ role: 'tool', content: '', toolName: undefined })
    }
  }
  return out
}

export interface SkillEvolutionBridge {
  /** `afterRun` middleware hook. Returns the result
   *  for diagnostic logging in the composition root. */
  afterRunHook(result: {
    readonly messages: ReadonlyArray<{
      role: string
      content?: string | null
      toolCalls?: ReadonlyArray<{ name: string }>
    }>
  }): Promise<EvolutionResult | undefined>
}

/**
 * Build the skill-evolution bridge. The returned object
 * exposes a single `afterRunHook` method the composition
 * root can push onto the `middleware` array via a thin
 * wrapper that calls it from an `afterRun` middleware.
 */
export const createSkillEvolutionBridge = async (
  options: SkillEvolutionBridgeOptions = {},
): Promise<SkillEvolutionBridge> => {
  const evolver = options.evolver ?? new HeuristicEvolver()
  const skillsDir = options.skillsDir ?? (await import('@lumen/skills')).defaultSkillsPath()
  return {
    async afterRunHook(result): Promise<EvolutionResult | undefined> {
      // Load (or reload) the registry so the new skill
      // lands in a fresh view. The evolver writes to
      // `skillsDir` and registers in this registry; a
      // subsequent `lumen run` re-discovers it via the
      // filesystem source.
      const registry = await loadSkillRegistry(skillsDir)
      const messages = toEvolverMessages(result.messages)
      try {
        return await evolver.evolve(messages, registry, skillsDir)
      } catch (err) {
        // Skill evolution is best-effort — never throw
        // out of an afterRun hook. The agent result is
        // already settled by this point.
        process.stderr.write(
          `lumen: skill evolution skipped (${err instanceof Error ? err.message : String(err)})\n`,
        )
        return undefined
      }
    },
  }
}
