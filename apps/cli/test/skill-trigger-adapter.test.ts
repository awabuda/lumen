/**
 * Tests for the keyword trigger adapter (P20.6.2).
 *
 * The adapter is the single shape-bridging layer between
 * `@lumen/skills` (`SkillRegistry.activate` returns
 * `ActivatedSkill[]`) and `@lumen/core`
 * (`createSkillTriggerMiddleware` expects
 * `(userMessage) => Promise<ActiveSkill[]>`). It is the actual
 * contract P20.6.2 ships, so we cover every branch here.
 */
import type { ActiveSkill } from '@lumen/core'
import { SkillRegistry, type BaseSkill, type SkillActivation } from '@lumen/skills'
import { describe, expect, it } from 'vitest'
import { buildKeywordTriggerFn } from '../src/skill-trigger-adapter.js'

/** Build a minimal BaseSkill stub for testing. */
const makeSkill = (overrides: Partial<BaseSkill> = {}): BaseSkill => {
  const skill: BaseSkill = {
    id: overrides.id ?? 'test-skill',
    name: overrides.name ?? 'Test Skill',
    description: overrides.description ?? 'A skill used in unit tests',
    version: overrides.version ?? '0.1.0',
    triggers: overrides.triggers ?? [{ kind: 'keyword', value: 'git' }],
    sourcePath: overrides.sourcePath,
    describe: overrides.describe ?? (() => skill as unknown as ReturnType<BaseSkill['describe']>),
    shouldActivate: overrides.shouldActivate ?? (async () => ({ active: false, score: 0, reason: 'noop' })),
    apply: overrides.apply ?? (async () => ({ id: skill.id, instructions: [] })),
  } as unknown as BaseSkill
  return skill
}

describe('buildKeywordTriggerFn', () => {
  it('returns an empty list when no skills are registered', async () => {
    const registry = new SkillRegistry()
    const fn = buildKeywordTriggerFn({ registry })
    const out = await fn('any message')
    expect(out).toEqual([])
  })

  it('returns an empty list when no skill activates', async () => {
    const registry = new SkillRegistry()
    registry.register(
      makeSkill({
        id: 'never',
        shouldActivate: async () => ({ active: false, score: 0, reason: 'no' }),
      }),
    )
    const fn = buildKeywordTriggerFn({ registry })
    const out = await fn('any message')
    expect(out).toEqual([])
  })

  it('projects an activated skill into the ActiveSkill shape', async () => {
    const registry = new SkillRegistry()
    registry.register(
      makeSkill({
        id: 'git-helper',
        name: 'Git Helper',
        description: 'Helps with git operations',
        shouldActivate: async () => ({ active: true, score: 0.75, reason: 'keyword match' }),
      }),
    )
    const fn = buildKeywordTriggerFn({ registry })
    const out = await fn('commit my git changes')
    expect(out).toHaveLength(1)
    const skill = out[0] as ActiveSkill
    expect(skill.id).toBe('git-helper')
    expect(skill.name).toBe('Git Helper')
    expect(skill.description).toBe('Helps with git operations')
    expect(skill.score).toBe(0.75)
  })

  it('clamps a misbehaving skill that returns score > 1', async () => {
    // A future skill implementation could in theory violate
    // the [0, 1] contract documented in `SkillActivationSchema`.
    // The adapter must not blow up the agent loop; it clamps
    // to 1 and moves on. This matches the "no surprise aborts"
    // design commitment in the adapter's header comment.
    const registry = new SkillRegistry()
    registry.register(
      makeSkill({
        id: 'over-eager',
        shouldActivate: async () => ({ active: true, score: 1.5, reason: 'too much' }),
      }),
    )
    const fn = buildKeywordTriggerFn({ registry })
    const out = await fn('hi')
    expect(out[0]?.score).toBe(1)
  })

  it('clamps a misbehaving skill that returns score < 0', async () => {
    const registry = new SkillRegistry()
    registry.register(
      makeSkill({
        id: 'under-eager',
        shouldActivate: async () => ({ active: true, score: -0.25, reason: 'negative vibes' }),
      }),
    )
    const fn = buildKeywordTriggerFn({ registry })
    const out = await fn('hi')
    expect(out[0]?.score).toBe(0)
  })

  it('returns multiple activated skills, one per matching skill', async () => {
    const registry = new SkillRegistry()
    registry.register(
      makeSkill({
        id: 'a',
        shouldActivate: async () => ({ active: true, score: 0.9, reason: 'match' }),
      }),
    )
    registry.register(
      makeSkill({
        id: 'b',
        shouldActivate: async () => ({ active: true, score: 0.4, reason: 'weak match' }),
      }),
    )
    const fn = buildKeywordTriggerFn({ registry })
    const out = await fn('something')
    expect(out.map((s) => s.id).sort()).toEqual(['a', 'b'])
  })

  it('swallows registry errors and returns an empty list', async () => {
    // A misbehaving skill throws inside `shouldActivate`. The
    // adapter must catch it; failing to activate a skill must
    // never take down the agent loop (see the adapter header
    // for the full rationale).
    const registry = new SkillRegistry()
    registry.register(
      makeSkill({
        id: 'crashy',
        shouldActivate: async () => {
          throw new Error('boom')
        },
      }),
    )
    const fn = buildKeywordTriggerFn({ registry })
    const out = await fn('hi')
    expect(out).toEqual([])
  })

  it('uses the cwd option when provided', async () => {
    let receivedCwd: string | undefined
    const registry = new SkillRegistry()
    registry.register(
      makeSkill({
        id: 'cwd-spy',
        shouldActivate: async (ctx) => {
          receivedCwd = ctx.cwd
          return { active: true, score: 0.5, reason: 'match' } satisfies SkillActivation
        },
      }),
    )
    const fn = buildKeywordTriggerFn({ registry, cwd: '/tmp/lumen-test' })
    await fn('hi')
    expect(receivedCwd).toBe('/tmp/lumen-test')
  })

  it('defaults cwd to process.cwd() when omitted', async () => {
    let receivedCwd: string | undefined
    const registry = new SkillRegistry()
    registry.register(
      makeSkill({
        id: 'cwd-default-spy',
        shouldActivate: async (ctx) => {
          receivedCwd = ctx.cwd
          return { active: true, score: 0.5, reason: 'match' } satisfies SkillActivation
        },
      }),
    )
    const fn = buildKeywordTriggerFn({ registry })
    await fn('hi')
    expect(receivedCwd).toBe(process.cwd())
  })
})
