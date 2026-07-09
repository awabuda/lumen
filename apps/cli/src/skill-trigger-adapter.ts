/**
 * Adapter: turn a `SkillRegistry` into a `SkillTriggerFn` (P20.6.2).
 *
 * `createSkillTriggerMiddleware` (in `@lumen/core`) accepts a pure
 * function `(userMessage) => Promise<ReadonlyArray<ActiveSkill>>`.
 * `SkillRegistry` (in `@lumen/skills`) exposes `activate(ctx)` which
 * returns `ActivatedSkill[]` — a different shape (it carries the
 * full `BaseSkill` instance plus a `SkillActivation` metadata
 * object). This adapter is the single place that knows both
 * shapes and maps one to the other.
 *
 * The adapter delegates scoring to the registry's default
 * `shouldActivate` implementation, which walks each skill's
 * declared `triggers` (kind: 'keyword' | 'glob' | 'always') and
 * returns a score in [0, 1]. So this is a "default keyword
 * trigger" adapter; richer strategies (embedding-based
 * similarity, hybrid keyword+embedding) are out of scope and
 * can be added by writing a new adapter on top of a custom
 * registry, or by replacing the registry's `shouldActivate`
 * implementation directly.
 *
 * Why a separate file:
 *   - The composition root (`apps/cli/src/composition.ts`)
 *     stays free of `@lumen/skills` imports beyond the single
 *     `loadSkillRegistry` helper; the adapter keeps the
 *     type-bridging logic in one place, unit-testable without
 *     touching composition or the command parser.
 *   - Tests can mock either side (registry or middleware) and
 *     pin the shape mapping here, which is the actual contract
 *     P20.6.2 ships.
 */
import type { ActiveSkill } from '@lumen/core'
import type { SkillRegistry } from '@lumen/skills'

/** Options for {@link buildKeywordTriggerFn}. */
export interface BuildKeywordTriggerFnOptions {
  /** Registry to query. */
  readonly registry: SkillRegistry
  /**
   * Working directory passed to the registry's `activate` call.
   * Glob triggers (kind: 'glob') evaluate against this path.
   * Defaults to `process.cwd()`.
   */
  readonly cwd?: string
}

/**
 * Build a `SkillTriggerFn` that, for each user message, asks the
 * registry which skills should activate and projects the result
 * into the middleware-facing `ActiveSkill` shape.
 *
 * The function never throws. If the registry throws (e.g. a
 * misbehaving `shouldActivate`), the error is swallowed and the
 * run proceeds with no active skills — failing to activate a
 * skill must never take down the agent loop.
 */
export const buildKeywordTriggerFn = (
  options: BuildKeywordTriggerFnOptions,
): ((userMessage: string) => Promise<ReadonlyArray<ActiveSkill>>) => {
  const cwd = options.cwd ?? process.cwd()
  return async (userMessage: string): Promise<ReadonlyArray<ActiveSkill>> => {
    let activated
    try {
      activated = await options.registry.activate({ cwd, prompt: userMessage })
    } catch {
      return []
    }
    return activated.map((item): ActiveSkill => {
      const descriptor = item.skill.describe()
      // Project the registry's `SkillActivation` score (in
      // [0, 1]) into the middleware's `ActiveSkill.score` field.
      // Clamp to be safe — a misbehaving skill could in theory
      // return a score outside the documented range.
      const raw = item.activation.score
      const score = raw < 0 ? 0 : raw > 1 ? 1 : raw
      return {
        id: item.skill.id,
        name: item.skill.name,
        description: descriptor.description,
        score,
      }
    })
  }
}
