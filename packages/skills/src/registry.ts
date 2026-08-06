/**
 * Skill registry.
 *
 * The registry is intentionally small: it owns registration order, duplicate
 * detection, and activation sorting. It does not know where skills came from.
 */

import type {
  BaseSkill,
  SkillActivation,
  SkillApplication,
  SkillContext,
  SkillDescriptor,
} from './base.js'
import { SkillConfigError } from './errors.js'

/** P52.a — bug.md #67 follow-up. Substitute
 *  `${ARG[i]}` / `${ARGUMENTS}` / `$ARG[0]`
 *  placeholders in the input string with the
 *  corresponding element of `args`. Out-of-range
 *  placeholders are left untouched. The
 *  `${ARGUMENTS}` placeholder joins the array
 *  with spaces (the pre-P52.a Claude Code
 *  convention). */
const substituteArgs = (input: string, args: ReadonlyArray<string>): string => {
  if (!input.includes('${')) return input
  // Special case: ${ARGUMENTS} joins the array
  // with spaces (the pre-P52.a Claude Code
  // convention). The local `result` variable
  // is used to avoid reassigning the `input`
  // parameter (biome `noParameterAssign`).
  const result = input.includes('${ARGUMENTS}')
    ? input.replace(/\$\{ARGUMENTS\}/g, args.join(' '))
    : input
  // Indexed: ${ARG[0]} / ${ARG[1]} / ...
  return result.replace(/\$\{ARG\[(\d+)\]\}/g, (match, idxStr) => {
    const idx = Number.parseInt(idxStr, 10)
    if (idx < 0 || idx >= args.length) return match
    return args[idx] ?? match
  })
}

/** Activated skill paired with its score. */
export interface ActivatedSkill {
  /** Skill instance. */
  readonly skill: BaseSkill
  /** Activation metadata returned by the skill. */
  readonly activation: SkillActivation
}

/** Registry of reusable skills. */
export class SkillRegistry {
  private readonly skills = new Map<string, BaseSkill>()

  /** Register one skill. Throws on duplicate id. */
  public register(skill: BaseSkill): this {
    if (this.skills.has(skill.id)) {
      throw new SkillConfigError(`Skill "${skill.id}" is already registered`, {
        skillId: skill.id,
      })
    }
    this.skills.set(skill.id, skill)
    return this
  }

  /** Register multiple skills. Returns this for chaining. */
  public registerAll(skills: ReadonlyArray<BaseSkill>): this {
    for (const skill of skills) this.register(skill)
    return this
  }

  /** Lookup by id. */
  public get(id: string): BaseSkill | undefined {
    return this.skills.get(id)
  }

  /** Require a skill by id. */
  public require(id: string): BaseSkill {
    const skill = this.skills.get(id)
    if (!skill) throw new SkillConfigError(`Skill "${id}" is not registered`, { skillId: id })
    return skill
  }

  /** List descriptors in registration order. */
  public list(): SkillDescriptor[] {
    return [...this.skills.values()].map((skill) => skill.describe())
  }

  /** Score and return active skills, sorted by descending score. */
  public async activate(ctx: SkillContext): Promise<ActivatedSkill[]> {
    // P23.10 (fix #35) — score every skill in parallel. The
    // shouldActivate() check is read-only against the skill's
    // own configuration + the ctx; there is no shared mutable
    // state between skills, so Promise.all is safe.
    const evaluated = await Promise.all(
      [...this.skills.values()].map(async (skill) => ({
        skill,
        activation: await skill.shouldActivate(ctx),
      })),
    )
    return evaluated
      .filter((e) => e.activation.active)
      .map((e) => ({ skill: e.skill, activation: e.activation }))
      .sort(
        (a, b) => b.activation.score - a.activation.score || a.skill.id.localeCompare(b.skill.id),
      )
  }

  /** Apply all active skills and return their instruction payloads. */
  public async applyActive(ctx: SkillContext): Promise<SkillApplication[]> {
    const active = await this.activate(ctx)
    // P23.10 (fix #35) — same parallel rationale: apply()
    // is read-only against ctx and writes only to the
    // returned array, so Promise.all is safe.
    const applied = await Promise.all(active.map((item) => item.skill.apply(ctx)))
    // P52.a — bug.md #67 follow-up. When the
    // composition root passes `ctx.arguments`,
    // substitute each `${ARG[i]}` /
    // `${ARGUMENTS}` / `$ARG[0]` placeholder
    // in the skill's `instructions` text with
    // the corresponding element. The
    // `arguments` array is positional (the
    // operator typed `/code-review <branch>`
    // — `branch` is `arguments[0]`). The
    // `${ARGUMENTS}` placeholder is a special
    // case that joins the array with spaces
    // (the pre-P52.a Claude Code convention).
    // Out-of-range placeholders are left
    // untouched (the operator should see
    // the raw `${ARG[1]}` in the output so
    // they can fix the invocation).
    if (ctx.arguments === undefined) return applied
    return applied.map((app) => {
      if (app.instructions.length === 0) return app
      return {
        ...app,
        instructions: app.instructions.map((s) => substituteArgs(s, ctx.arguments ?? [])),
      }
    })
  }

  /** Number of registered skills. */
  public get size(): number {
    return this.skills.size
  }
}
