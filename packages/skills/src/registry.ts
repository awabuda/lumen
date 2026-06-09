/**
 * Skill registry.
 *
 * The registry is intentionally small: it owns registration order, duplicate
 * detection, and activation sorting. It does not know where skills came from.
 */

import type { BaseSkill, SkillActivation, SkillApplication, SkillContext, SkillDescriptor } from './base.js'

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
      throw new Error(`Skill "${skill.id}" is already registered`)
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
    if (!skill) throw new Error(`Skill "${id}" is not registered`)
    return skill
  }

  /** List descriptors in registration order. */
  public list(): SkillDescriptor[] {
    return [...this.skills.values()].map((skill) => skill.describe())
  }

  /** Score and return active skills, sorted by descending score. */
  public async activate(ctx: SkillContext): Promise<ActivatedSkill[]> {
    const out: ActivatedSkill[] = []
    for (const skill of this.skills.values()) {
      const activation = await skill.shouldActivate(ctx)
      if (activation.active) out.push({ skill, activation })
    }
    return out.sort((a, b) => b.activation.score - a.activation.score || a.skill.id.localeCompare(b.skill.id))
  }

  /** Apply all active skills and return their instruction payloads. */
  public async applyActive(ctx: SkillContext): Promise<SkillApplication[]> {
    const active = await this.activate(ctx)
    const out: SkillApplication[] = []
    for (const item of active) {
      out.push(await item.skill.apply(ctx))
    }
    return out
  }

  /** Number of registered skills. */
  public get size(): number {
    return this.skills.size
  }
}
