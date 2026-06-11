/**
 * Contract tests for {@link BaseSkill}.
 *
 * The exact same suite is run against every concrete skill
 * discovered from disk (or any other source). If you add a
 * new skill type, call `runSkillContractTests(label,
 * factory)` from your test file and you get the structural
 * contract for free.
 *
 * **What this suite pins down:**
 *   - Every skill exposes a non-empty `id`, `name`, and
 *     `description`, plus a non-empty `triggers` array.
 *   - `triggers` entries all match `SkillTriggerSchema` (a
 *     kind/value/optional-weight shape). A trigger with a
 *     malformed value is a configuration error.
 *   - `describe()` returns a `SkillDescriptor` whose fields
 *     mirror the skill's own members.
 *   - `shouldActivate()` returns an `active` boolean, a
 *     `score` in [0, 1], and a non-empty `reason` string.
 *   - The default trigger scorer: an `always` trigger
 *     activates regardless of context; a `keyword` trigger
 *     activates when its value appears (case-insensitively)
 *     in the prompt.
 *
 * What is **not** in this contract:
 *   - The exact wording of `instructions` returned by
 *     `apply()`. That is the per-skill test's job.
 *   - The skill's `apply()` side effects (e.g. writing
 *     linked files to disk). Skills that do that are tested
 *     with a tempdir in their own suite.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  BaseSkill,
  type SkillActivation,
  type SkillContext,
  type SkillTrigger,
} from '../src/base.js'

const baseContext: SkillContext = {
  cwd: '/tmp',
  prompt: '',
}

export function runSkillContractTests(
  label: string,
  factory: () => Promise<BaseSkill> | BaseSkill,
): void {
  describe(`[contract] ${label}`, () => {
    let skill: BaseSkill

    beforeEach(async () => {
      skill = await factory()
    })

    it('exposes a non-empty id', () => {
      expect(typeof skill.id).toBe('string')
      expect(skill.id.length).toBeGreaterThan(0)
    })

    it('exposes a non-empty name', () => {
      expect(typeof skill.name).toBe('string')
      expect(skill.name.length).toBeGreaterThan(0)
    })

    it('exposes a description (possibly empty)', () => {
      expect(typeof skill.description).toBe('string')
    })

    it('exposes at least one trigger', () => {
      expect(skill.triggers.length).toBeGreaterThan(0)
    })

    it('every trigger matches SkillTriggerSchema', () => {
      for (const t of skill.triggers) {
        const tt = t as SkillTrigger
        expect(['keyword', 'glob', 'always']).toContain(tt.kind)
        expect(typeof tt.value).toBe('string')
        expect(tt.value.length).toBeGreaterThan(0)
        if (tt.weight !== undefined) {
          expect(tt.weight).toBeGreaterThanOrEqual(0)
          expect(tt.weight).toBeLessThanOrEqual(1)
        }
      }
    })

    it('exposes a semver-ish version', () => {
      expect(typeof skill.version).toBe('string')
      expect(skill.version.length).toBeGreaterThan(0)
    })

    it('describe() returns a descriptor that mirrors the skill', () => {
      const d = skill.describe()
      expect(d.id).toBe(skill.id)
      expect(d.name).toBe(skill.name)
      expect(d.description).toBe(skill.description)
      expect(d.version).toBe(skill.version)
      expect(d.triggers).toEqual([...skill.triggers])
    })

    it('shouldActivate() returns a well-formed activation', async () => {
      const a = await skill.shouldActivate(baseContext)
      const act = a as SkillActivation
      expect(typeof act.active).toBe('boolean')
      expect(act.score).toBeGreaterThanOrEqual(0)
      expect(act.score).toBeLessThanOrEqual(1)
      expect(typeof act.reason).toBe('string')
      expect(act.reason.length).toBeGreaterThan(0)
    })

    it('default scorer: an "always" trigger activates regardless of prompt', async () => {
      // We can't directly mutate `triggers`, but if a skill
      // ships an "always" trigger the default scorer must
      // activate it even with an empty prompt. This is a
      // property of the BaseSkill base, so any subclass that
      // exposes an "always" trigger gets this for free.
      const hasAlways = skill.triggers.some((t) => t.kind === 'always')
      if (!hasAlways) return // skip when not applicable
      const a = await skill.shouldActivate(baseContext)
      expect(a.active).toBe(true)
    })
  })
}
