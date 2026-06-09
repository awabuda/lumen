/**
 * Contract tests for BaseSkill, SkillRegistry, and MarkdownSkill.
 *
 * These tests exercise the public API surface and should work with any
 * BaseSkill subclass — they are not MarkdownSkill-specific.
 */

import { describe, expect, it } from 'vitest'
import {
  BaseSkill,
  type SkillActivation,
  type SkillApplication,
  type SkillContext,
  type SkillTrigger,
  SkillContextSchema,
  globLikeMatch,
} from '../src/index.js'
import { SkillRegistry } from '../src/registry.js'

// ---------------------------------------------------------------------------
// Minimal concrete subclass for contract testing
// ---------------------------------------------------------------------------

class StubSkill extends BaseSkill {
  public readonly id: string
  public readonly name: string
  public readonly description: string
  public override readonly version = '1.0.0'
  public readonly triggers: ReadonlyArray<SkillTrigger>
  private readonly instructions: string[]

  public constructor(opts: {
    id?: string
    name?: string
    triggers?: SkillTrigger[]
    instructions?: string[]
  } = {}) {
    super()
    this.id = opts.id ?? 'stub'
    this.name = opts.name ?? 'Stub Skill'
    this.description = 'A stub for testing'
    this.triggers = opts.triggers ?? [{ kind: 'keyword', value: 'test', weight: 0.8 }]
    this.instructions = opts.instructions ?? ['stub instruction']
  }

  public override async apply(_ctx: SkillContext): Promise<SkillApplication> {
    return { id: this.id, instructions: this.instructions }
  }
}

const defaultCtx: SkillContext = { cwd: '/tmp', prompt: 'test something' }

// ---------------------------------------------------------------------------
// BaseSkill contract
// ---------------------------------------------------------------------------

describe('BaseSkill contract', () => {
  it('shouldActivate returns active=true when keyword matches prompt', async () => {
    const skill = new StubSkill({ triggers: [{ kind: 'keyword', value: 'deploy', weight: 0.8 }] })
    const result = await skill.shouldActivate({ cwd: '/tmp', prompt: 'how do I deploy this?' })
    expect(result.active).toBe(true)
    expect(result.score).toBeGreaterThan(0)
    expect(result.reason).toContain('keyword')
  })

  it('shouldActivate returns active=false when no trigger matches', async () => {
    const skill = new StubSkill({ triggers: [{ kind: 'keyword', value: 'kubernetes', weight: 0.8 }] })
    const result = await skill.shouldActivate({ cwd: '/tmp', prompt: 'hello world' })
    expect(result.active).toBe(false)
  })

  it('always trigger always activates', async () => {
    const skill = new StubSkill({ triggers: [{ kind: 'always', value: '*', weight: 0.15 }] })
    const result = await skill.shouldActivate({ cwd: '/tmp' })
    expect(result.active).toBe(true)
    expect(result.score).toBe(0.15)
  })

  it('glob trigger matches pathHints', async () => {
    const skill = new StubSkill({ triggers: [{ kind: 'glob', value: '*.tsx', weight: 0.6 }] })
    const result = await skill.shouldActivate({ cwd: '/tmp', pathHints: ['App.tsx'] })
    expect(result.active).toBe(true)
  })

  it('describe returns a valid descriptor', () => {
    const skill = new StubSkill()
    const desc = skill.describe()
    expect(desc.id).toBe('stub')
    expect(desc.name).toBe('Stub Skill')
    expect(desc.version).toBe('1.0.0')
    expect(desc.triggers).toHaveLength(1)
  })

  it('apply returns instructions', async () => {
    const skill = new StubSkill({ instructions: ['do the thing'] })
    const app = await skill.apply(defaultCtx)
    expect(app.id).toBe('stub')
    expect(app.instructions).toEqual(['do the thing'])
  })
})

// ---------------------------------------------------------------------------
// SkillRegistry contract
// ---------------------------------------------------------------------------

describe('SkillRegistry', () => {
  it('registers and retrieves a skill', () => {
    const reg = new SkillRegistry()
    const skill = new StubSkill({ id: 'a' })
    reg.register(skill)
    expect(reg.get('a')).toBe(skill)
    expect(reg.size).toBe(1)
  })

  it('throws on duplicate id', () => {
    const reg = new SkillRegistry()
    reg.register(new StubSkill({ id: 'dup' }))
    expect(() => reg.register(new StubSkill({ id: 'dup' }))).toThrow(/already registered/)
  })

  it('registerAll chains', () => {
    const reg = new SkillRegistry()
    reg.registerAll([new StubSkill({ id: 'x' }), new StubSkill({ id: 'y' })])
    expect(reg.size).toBe(2)
  })

  it('require throws on missing skill', () => {
    const reg = new SkillRegistry()
    expect(() => reg.require('nope')).toThrow(/not registered/)
  })

  it('activate returns matching skills sorted by score', async () => {
    const reg = new SkillRegistry()
    reg.register(
      new StubSkill({
        id: 'low',
        triggers: [{ kind: 'keyword', value: 'test', weight: 0.3 }],
      }),
    )
    reg.register(
      new StubSkill({
        id: 'high',
        triggers: [{ kind: 'keyword', value: 'test', weight: 0.9 }],
      }),
    )
    const activated = await reg.activate({ cwd: '/tmp', prompt: 'test' })
    expect(activated).toHaveLength(2)
    expect(activated[0]?.skill.id).toBe('high')
    expect(activated[1]?.skill.id).toBe('low')
  })

  it('applyActive returns instruction payloads for active skills', async () => {
    const reg = new SkillRegistry()
    reg.register(
      new StubSkill({
        id: 's1',
        triggers: [{ kind: 'keyword', value: 'deploy', weight: 0.8 }],
        instructions: ['deploy step 1'],
      }),
    )
    reg.register(
      new StubSkill({
        id: 's2',
        triggers: [{ kind: 'keyword', value: 'k8s', weight: 0.8 }],
        instructions: ['k8s step 1'],
      }),
    )
    const apps = await reg.applyActive({ cwd: '/tmp', prompt: 'deploy to k8s' })
    expect(apps).toHaveLength(2)
    const ids = apps.map((a) => a.id).sort()
    expect(ids).toEqual(['s1', 's2'])
  })

  it('list returns descriptors', () => {
    const reg = new SkillRegistry()
    reg.register(new StubSkill({ id: 'a', name: 'A' }))
    reg.register(new StubSkill({ id: 'b', name: 'B' }))
    const list = reg.list()
    expect(list).toHaveLength(2)
    expect(list.map((d) => d.id)).toEqual(['a', 'b'])
  })
})

// ---------------------------------------------------------------------------
// globLikeMatch helper
// ---------------------------------------------------------------------------

describe('globLikeMatch', () => {
  it('matches *', () => {
    expect(globLikeMatch('*', 'anything.ts')).toBe(true)
  })

  it('matches extension globs', () => {
    expect(globLikeMatch('*.tsx', 'App.tsx')).toBe(true)
    expect(globLikeMatch('*.tsx', 'App.ts')).toBe(false)
  })

  it('matches prefix globs', () => {
    expect(globLikeMatch('src/*', 'src/index.ts')).toBe(true)
    expect(globLikeMatch('src/*', 'lib/index.ts')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// SkillContextSchema validation
// ---------------------------------------------------------------------------

describe('SkillContextSchema', () => {
  it('accepts minimal valid context', () => {
    const result = SkillContextSchema.safeParse({ cwd: '/tmp' })
    expect(result.success).toBe(true)
  })

  it('rejects missing cwd', () => {
    const result = SkillContextSchema.safeParse({ prompt: 'hello' })
    expect(result.success).toBe(false)
  })
})
