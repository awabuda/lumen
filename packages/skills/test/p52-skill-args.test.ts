/**
 * P52.a — bug.md #67 follow-up.
 *
 * `SkillRegistry.applyActive` now substitutes
 * `${ARG[i]}` / `${ARGUMENTS}` placeholders in
 * the skill's `instructions` text with the
 * positional args supplied via `ctx.arguments`.
 * Out-of-range placeholders are left untouched
 * (so the operator can see the raw `${ARG[1]}`
 * in the output and fix the invocation).
 *
 * Two tests:
 *   1. `${ARG[0]}` and `${ARG[1]}` substitute
 *      positional args.
 *   2. `${ARGUMENTS}` joins the array with spaces.
 */

import { describe, expect, it } from 'vitest'
import { BaseSkill } from '../src/base.js'
import type { SkillApplication, SkillContext, SkillTrigger } from '../src/base.js'
import { SkillRegistry } from '../src/registry.js'

class StaticSkill extends BaseSkill {
  public override readonly id = 'static-skill'
  public override readonly name = 'Static Skill'
  public override readonly description = 'A skill with templated instructions'
  public override readonly version = '0.1.0'
  public override readonly triggers: ReadonlyArray<SkillTrigger> = [{ kind: 'always', value: '*' }]
  constructor(private readonly templateInstructions: ReadonlyArray<string>) {
    super()
  }
  public override async apply(_ctx: SkillContext): Promise<SkillApplication> {
    return {
      id: this.id,
      instructions: [...this.templateInstructions],
    }
  }
}

describe('P52.a — Skill argument substitution (bug.md #67)', () => {
  it('substitutes ${ARG[i]} placeholders with positional args', async () => {
    const registry = new SkillRegistry()
    registry.register(
      new StaticSkill([
        'Review the changes on branch ${ARG[0]} and report the diff for ${ARG[1]}.',
      ]),
    )
    const app = await registry.applyActive({
      cwd: '/tmp',
      arguments: ['feature/foo', 'main'],
    })
    expect(app.length).toBe(1)
    expect(app[0]!.instructions[0]).toBe(
      'Review the changes on branch feature/foo and report the diff for main.',
    )
  })

  it('substitutes ${ARGUMENTS} with space-joined args', async () => {
    const registry = new SkillRegistry()
    registry.register(new StaticSkill(['Review ${ARGUMENTS} in one pass.']))
    const app = await registry.applyActive({
      cwd: '/tmp',
      arguments: ['foo', 'bar', 'baz'],
    })
    expect(app[0]!.instructions[0]).toBe('Review foo bar baz in one pass.')
  })

  it('leaves out-of-range placeholders untouched', async () => {
    const registry = new SkillRegistry()
    registry.register(new StaticSkill(['First arg: ${ARG[0]}, second: ${ARG[1]}.']))
    const app = await registry.applyActive({
      cwd: '/tmp',
      arguments: ['only-one'],
    })
    expect(app[0]!.instructions[0]).toBe('First arg: only-one, second: ${ARG[1]}.')
  })

  it('leaves instructions untouched when arguments is undefined', async () => {
    const registry = new SkillRegistry()
    registry.register(new StaticSkill(['Static: ${ARG[0]}.']))
    const app = await registry.applyActive({
      cwd: '/tmp',
    })
    expect(app[0]!.instructions[0]).toBe('Static: ${ARG[0]}.')
  })
})
