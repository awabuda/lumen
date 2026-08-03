/**
 * P31.2 — Layered prompt sections + PromptAssembler invariant
 * tests. Mirrors design doc §1.2 / §1.7 / §1.10.
 */

import { describe, expect, it } from 'vitest'
import {
  buildSystemPrompt,
  collectStableSections,
  DEFAULT_BUDGET,
  DEFAULT_GUIDANCE_TEXT,
  KERNEL_TEXT,
  renderSkillsIndex,
  renderStableText,
  summarize,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
  truncateSection,
  type ProfileLayers,
  type SectionContext,
} from '../src/agent/system-prompt-sections.js'

const baseRuntime = {
  sessionId: 'ses_test_001',
  cwd: '/repo',
  model: 'gpt-4o-mini',
  capturedAtIso: '2026-08-03T19:00:00Z',
} as const

const baseProfile: ProfileLayers = {}

const makeCtx = (overrides: Partial<SectionContext> = {}): SectionContext => ({
  profile: baseProfile,
  runtime: baseRuntime,
  ...overrides,
})

describe('layered system prompt sections (P31.2)', () => {
  describe('R1 — ToolRegistry schemas never reach the assembled prompt', () => {
    it('kernel + guidance prose carry no JSON schema markers', () => {
      const text = buildSystemPrompt(makeCtx())
      for (const marker of ['"parameters":', '"input_schema":', '"type":"function"', '"required":[]']) {
        expect(text).not.toContain(marker)
      }
    })

    it('memorySnapshot prose is included verbatim but stays prose-only', () => {
      const text = buildSystemPrompt(
        makeCtx({
          profile: { ...baseProfile, memorySnapshot: true },
          memorySnapshotText: 'Long-term note: user prefers minimal-change PRs.',
        }),
      )
      expect(text).toContain('Long-term note: user prefers minimal-change PRs.')
      expect(text).not.toContain('"parameters":')
    })
  })

  describe('profile gating — P2 / B1 / G2 / M1 only render when enabled', () => {
    it('omits persona, bootstrap, skills index, memory snapshot when profile has them off', () => {
      const text = buildSystemPrompt(
        makeCtx({
          projectText: 'P1 body',
          // even if these strings are present in ctx, profile off => omitted
          personaText: 'PERSONA PROSE',
          bootstrapText: 'BOOTSTRAP PROSE',
          skillsIndexText: '- skill:project-analyzer: project facts',
          memorySnapshotText: 'MEM PROSE',
        }),
      )
      expect(text).toContain('P1 body')
      expect(text).not.toContain('PERSONA PROSE')
      expect(text).not.toContain('BOOTSTRAP PROSE')
      expect(text).not.toContain('skill:project-analyzer')
      expect(text).not.toContain('MEM PROSE')
    })

    it('renders persona / bootstrap / skillsIndex / memorySnapshot when profile enables each', () => {
      const text = buildSystemPrompt(
        makeCtx({
          profile: {
            persona: true,
            bootstrap: true,
            skillsIndex: true,
            memorySnapshot: true,
          },
          personaText: 'PERSONA PROSE',
          bootstrapText: 'BOOTSTRAP PROSE',
          skillsIndexText: renderSkillsIndex(
            [
              { name: 'skill:lint', description: 'lint the project' },
              { name: 'skill:format', description: 'format the project' },
            ],
            DEFAULT_BUDGET.skillsIndex,
          ),
          memorySnapshotText: 'MEM PROSE',
        }),
      )
      expect(text).toContain('PERSONA PROSE')
      expect(text).toContain('BOOTSTRAP PROSE')
      expect(text).toContain('skill:lint')
      expect(text).toContain('MEM PROSE')
    })
  })

  describe('kernel identity override', () => {
    it('replaces the default KERNEL identity line when provided, keeps safety contract', () => {
      const ctx = makeCtx({
        kernelIdentityOverride: 'You are Lumen the Robot.',
      })
      const text = buildSystemPrompt(ctx)
      expect(text).toContain('You are Lumen the Robot.')
      expect(text).toContain('Workspace boundary')
    })

    it('falls back to default kernel text when override is empty / undefined', () => {
      const emptyOverride = buildSystemPrompt(makeCtx({ kernelIdentityOverride: '' }))
      expect(emptyOverride).toContain(KERNEL_TEXT.split('\n')[0]!)
      const noOverride = buildSystemPrompt(makeCtx())
      expect(noOverride).toBe(emptyOverride)
    })
  })

  describe('guidance default — design doc §1.2 + §1.10', () => {
    it('falls back to the bundled template when guidanceText is absent', () => {
      const text = buildSystemPrompt(makeCtx())
      // We split DEFAULT_GUIDANCE_TEXT into lines and probe one
      // distinctive phrase rather than coupling to the exact
      // string.
      expect(text).toContain('lowest-privilege tool')
    })

    it('uses caller-provided guidanceText when present (override)', () => {
      const text = buildSystemPrompt(
        makeCtx({ guidanceText: 'PROVIDED GUIDANCE' }),
      )
      expect(text).toContain('PROVIDED GUIDANCE')
      expect(text).not.toContain(DEFAULT_GUIDANCE_TEXT.split('\n')[0]!)
    })
  })

  describe('project section — P1', () => {
    it('skips project when projectText is empty (P31.3 will fill it from AGENTS.md)', () => {
      const text = buildSystemPrompt(makeCtx())
      expect(text).not.toContain('## project')
    })

    it('renders project when projectText is non-empty', () => {
      const text = buildSystemPrompt(makeCtx({ projectText: 'AGENTS body.' }))
      expect(text).toContain('## project\nAGENTS body')
    })
  })

  describe('runtime block — D1 required', () => {
    it('always renders even with minimal inputs', () => {
      const text = buildSystemPrompt(makeCtx())
      expect(text).toContain('session_id: ses_test_001')
      expect(text).toContain('cwd: /repo')
    })

    it('contains the cache boundary marker exactly once', () => {
      const text = buildSystemPrompt(makeCtx())
      expect(text.split(SYSTEM_PROMPT_CACHE_BOUNDARY).length - 1).toBe(1)
    })
  })

  describe('middleware dynamic chunks — D2 turn-inject', () => {
    it('routes provided chunks through appendDynamic into the suffix', () => {
      const text = buildSystemPrompt(
        makeCtx({ middlewareDynamicChunks: ['plan: step 2 of 5'] }),
      )
      const prefixEnd = text.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY)
      const planIdx = text.indexOf('plan: step 2 of 5')
      expect(planIdx).toBeGreaterThan(prefixEnd)
    })

    it('keeps the prefix byte-stable when middleware dynamic chunks change', () => {
      const baseline = buildSystemPrompt(makeCtx())
      const altered = buildSystemPrompt(
        makeCtx({ middlewareDynamicChunks: ['plan: step 3 of 5', 'skill:lint'] }),
      )
      const baselinePrefix = baseline.slice(0, baseline.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY))
      const alteredPrefix = altered.slice(0, altered.indexOf(SYSTEM_PROMPT_CACHE_BOUNDARY))
      expect(alteredPrefix).toBe(baselinePrefix)
    })
  })

  describe('truncateSection — explicit budget caps', () => {
    it('emits the …[truncated] marker when text exceeds the cap', () => {
      const out = truncateSection('a'.repeat(100), 30)
      // 30 chars + '\n' (1) + '…[truncated]' (12 chars) = 43 chars
      expect(out.length).toBe(43)
      expect(out).toContain('…[truncated]')
    })

    it('passes text through when length is within the cap', () => {
      expect(truncateSection('hello', 100)).toBe('hello')
    })
  })

  describe('renderSkillsIndex — overflow path', () => {
    it('falls back to a name-only list when full index exceeds the cap', () => {
      const skills = Array.from({ length: 50 }, (_, i) => ({
        name: `skill:${i.toString().padStart(3, '0')}`,
        description: `very long description for skill ${i} that will surely blow past the cap`,
      }))
      const out = renderSkillsIndex(skills, 2_000)
      expect(out.length).toBeLessThanOrEqual(2_500)
      expect(out).toContain('skill:000')
      // No descriptions survived (full-index overflowed cap).
      expect(out).not.toContain('very long description')
    })
  })

  describe('R2/R3 — runtime + middleware chunks live only in the dynamic suffix', () => {
    it('runtime fields never appear in the prefix', () => {
      const text = buildSystemPrompt(makeCtx())
      const [prefix] = text.split(SYSTEM_PROMPT_CACHE_BOUNDARY)
      expect(prefix).not.toContain('session_id')
      expect(prefix).not.toContain('captured_at:')
      expect(prefix).not.toContain('cwd: /repo')
      expect(prefix).not.toContain('git status')
    })

    it('middleware chunks never appear in the prefix', () => {
      const text = buildSystemPrompt(
        makeCtx({ middlewareDynamicChunks: ['Active skill: skill:lint'] }),
      )
      const [prefix] = text.split(SYSTEM_PROMPT_CACHE_BOUNDARY)
      expect(prefix).not.toContain('Active skill')
    })
  })

  describe('collectStableSections — pure helper used by future P31.5 tests', () => {
    it('returns K0 + G1 when nothing else is enabled', () => {
      const sections = collectStableSections(makeCtx())
      const ids = sections.map((s) => s.id)
      expect(ids).toContain('kernel')
      expect(ids).toContain('guidance')
      expect(ids).not.toContain('persona')
      expect(ids).not.toContain('bootstrap')
      expect(ids).not.toContain('skillsIndex')
      expect(ids).not.toContain('memorySnapshot')
    })

    it('renders each section text exactly once', () => {
      const sections = renderStableText(
        [
          { id: 'kernel', text: 'K' },
          { id: 'guidance', text: 'G' },
        ],
        {},
      )
      expect(sections.match(/## kernel/g)?.length ?? 0).toBe(1)
      expect(sections.match(/## guidance/g)?.length ?? 0).toBe(1)
    })
  })

  describe('summarize — observability', () => {
    it('reports stable and dynamic char counts', () => {
      const text = buildSystemPrompt(
        makeCtx({ middlewareDynamicChunks: ['D2 chunk 1', 'D2 chunk 2'] }),
      )
      const counters = summarize(text)
      expect(counters.stableChars).toBeGreaterThan(0)
      expect(counters.dynamicChars).toBeGreaterThan(0)
    })
  })
})
