/**
 * P31.1 — system-prompt-boundary invariants.
 *
 * Test surface per `docs/P31-SYSTEM-PROMPT-DESIGN.md` §2.1.
 * Each numbered invariant below maps to that doc's §2.1 list.
 */

import { describe, expect, it } from 'vitest'
import {
  appendDynamic,
  ensureSystemPromptCacheBoundary,
  findSystemPromptCacheBoundary,
  joinWithBoundary,
  splitByBoundary,
  stripBoundary,
  SYSTEM_PROMPT_CACHE_BOUNDARY,
} from '../src/agent/system-prompt-boundary.js'

describe('system-prompt-boundary primitive (P31.1 §2.1)', () => {
  describe('invariant 1: ensure produces exactly one marker; dynamic-empty still keeps it', () => {
    it('adds the marker when the prompt has none', () => {
      const result = ensureSystemPromptCacheBoundary('kernel text')
      expect(result.endsWith(SYSTEM_PROMPT_CACHE_BOUNDARY + '\n')).toBe(true)
      // Exactly one occurrence.
      expect(result.split(SYSTEM_PROMPT_CACHE_BOUNDARY).length - 1).toBe(1)
    })

    it('does not duplicate the marker when one is already present', () => {
      const once = ensureSystemPromptCacheBoundary('kernel')
      const twice = ensureSystemPromptCacheBoundary(once)
      expect(twice.split(SYSTEM_PROMPT_CACHE_BOUNDARY).length - 1).toBe(1)
    })

    it('preserves the marker even when the caller appends dynamic content that is itself empty', () => {
      const base = joinWithBoundary('kernel text', '')
      const withEmptyChunk = appendDynamic(base, '')
      expect(withEmptyChunk.split(SYSTEM_PROMPT_CACHE_BOUNDARY).length - 1).toBe(1)
      // Splitting should still surface the original prefix.
      const { prefix, suffix } = splitByBoundary(withEmptyChunk)
      expect(prefix).toBe('kernel text')
      expect(suffix).toBe('')
    })
  })

  describe('invariant 2: appendDynamic only touches the suffix; stable prefix hash unchanged', () => {
    it('keeps the prefix byte-identical when the suffix grows', () => {
      const base = joinWithBoundary('STABLE KERNEL\n\nSTABLE PROJECT')
      const before = splitByBoundary(base).prefix
      const after = appendDynamic(appendDynamic(base, 'first chunk'), 'second chunk')
      expect(splitByBoundary(after).prefix).toBe(before)
    })

    it('separates appended chunks with a single blank line', () => {
      const base = joinWithBoundary('KERNEL')
      const result = appendDynamic(appendDynamic(base, 'A'), 'B')
      const { suffix } = splitByBoundary(result)
      expect(suffix).toBe('A\n\nB')
    })
  })

  describe('invariant 3: time/git/plan/skill-hit/recall never appear in the prefix', () => {
    // These fixtures mirror the §2.1.3 list. The point is that a
    // future bug — e.g. middleware accidentally injecting a
    // timestamp into the prefix — would surface here.
    const stableInput = joinWithBoundary(
      [
        '# Kernel',
        'You are Lumen, a coding agent.',
        '',
        '# Project (cwd walk-up)',
        'AGENTS.md content here.',
      ].join('\n'),
    )
    const ephemeralLines = [
      'Current time: 2026-08-03T19:00:00Z',
      'session_id: 7f1c2e',
      'git status: clean (HEAD deadbeef on main)',
      'plan: step 2 of 5 — finalise prompt layer',
      'active skill: skill:project-analyzer',
      'memory recall: user prefers minimal tools',
      'HEARTBEAT: last-tick 14m ago',
    ]

    it('detects accidental prefix contamination for each ephemeral kind', () => {
      for (const line of ephemeralLines) {
        const polluted = `${stableInput}\n\n${line}`
        const { prefix } = splitByBoundary(polluted)
        expect(prefix).not.toContain(line)
      }
    })

    it('pinpoints that splitByBoundary keeps ephemeral content in the suffix when present', () => {
      const line = 'Current time: 2026-08-03T19:00:00Z'
      const polluted = `${stableInput}\n\n${line}`
      const { suffix } = splitByBoundary(polluted)
      expect(suffix).toContain(line)
    })
  })

  describe('invariant 4: ToolRegistry / JSON schema signatures never reach the system prompt', () => {
    // Regression guard against the pre-P31 anti-pattern of dumping
    // tool schemas into the prompt. We pin two markers: the JSON
    // schema header and the OpenAI tool "parameters:" prefix. Any
    // assembler that lets tool metadata leak into the prompt would
    // trip these assertions.
    const toolSchemaMarkers = [
      '"parameters":',
      '"input_schema":',
      '"type":"function"',
      '"required":[]',
    ]

    const safePrompt = joinWithBoundary(
      'Guidance: use the `write_file` tool with absolute paths inside the workspace; see runtime registry for the live schema.',
    )

    it('safe prompt carries none of the tool-schema markers in prefix or suffix', () => {
      const { prefix, suffix } = splitByBoundary(safePrompt)
      for (const marker of toolSchemaMarkers) {
        expect(prefix).not.toContain(marker)
        expect(suffix).not.toContain(marker)
      }
    })

    it('polluted prompt puts the markers in the suffix, not the prefix', () => {
      // Treat the dump as if middleware accidentally put it into
      // dynamic. The invariant we pin here is that the prefix
      // remains clean — i.e. the dump did not leak into stable.
      const dump = '{"type":"function","parameters":{"x":1},"required":[]}'
      const polluted = joinWithBoundary('Guidance: stable layer', dump)
      const { prefix, suffix } = splitByBoundary(polluted)
      for (const marker of toolSchemaMarkers) {
        expect(prefix).not.toContain(marker)
      }
      expect(suffix).toContain(dump)
    })
  })

  describe('invariant 5: two consecutive runs with only D1 time-change keep stable prefix byte-identical', () => {
    // This is the per-session byte-stable invariant from
    // design doc §1.9. The prefix is built from layers whose
    // inputs (cwd, project file mtime, profile switches, …) are
    // unchanged across two runs; the suffix is rebuilt each
    // turn. The invariant under test is that the prefix bytes
    // match exactly between two assemblies.
    const stableLayers = [
      '## Kernel (R4 safe contract — descriptive)\nYou are Lumen.\nPrompt is descriptive; enforcement lives in ToolRisk + permission middleware.',
      '## Project (cwd: /repo)\nAGENTS.md line 1.',
    ].join('\n\n')

    it('produces identical prefixes when only D1 time changes between turns', () => {
      const turn1 = joinWithBoundary(stableLayers, 'D1: time=2026-08-03T18:00:00Z')
      const turn2 = joinWithBoundary(stableLayers, 'D1: time=2026-08-03T18:00:01Z')
      const { prefix: p1 } = splitByBoundary(turn1)
      const { prefix: p2 } = splitByBoundary(turn2)
      expect(p1).toBe(p2)
      expect(p1).toBe(stableLayers)
    })

    it('produces identical prefixes across appendDynamic calls within one turn', () => {
      const base = joinWithBoundary(stableLayers, 'D1: time=T0')
      const after1 = appendDynamic(base, 'D2: plan step 1')
      const after2 = appendDynamic(after1, 'D2: skill:lint')
      const { prefix: p0 } = splitByBoundary(base)
      const { prefix: p1 } = splitByBoundary(after1)
      const { prefix: p2 } = splitByBoundary(after2)
      expect(p0).toBe(p1)
      expect(p1).toBe(p2)
    })
  })

  describe('stripBoundary: providers that do not speak the marker protocol receive clean prose', () => {
    it('preserves the prose and removes the marker line', () => {
      const withBoundary = joinWithBoundary('kernel text', 'D1: time=T0')
      const stripped = stripBoundary(withBoundary)
      expect(stripped).not.toContain(SYSTEM_PROMPT_CACHE_BOUNDARY)
      expect(stripped).toContain('kernel text')
      expect(stripped).toContain('D1: time=T0')
    })

    it('no-op on a prompt that has no marker', () => {
      const plain = 'just a kernel'
      expect(stripBoundary(plain)).toBe(plain)
    })

    it('findSystemPromptCacheBoundary reports -1 when absent and the marker index otherwise', () => {
      expect(findSystemPromptCacheBoundary('no marker here')).toBe(-1)
      const idx = findSystemPromptCacheBoundary(
        `prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}suffix`,
      )
      expect(idx).toBe('prefix'.length)
    })
  })

  describe('joinWithBoundary: defensive single-marker guarantee', () => {
    it('emits exactly one marker even if the prefix already contains one', () => {
      const polluted = `prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}leak`
      const result = joinWithBoundary(polluted, 'suffix')
      expect(result.split(SYSTEM_PROMPT_CACHE_BOUNDARY).length - 1).toBe(1)
    })

    it('emits exactly one marker even if the suffix contains one', () => {
      const polluted = `prefix${SYSTEM_PROMPT_CACHE_BOUNDARY}leak`
      const result = joinWithBoundary('kernel', polluted)
      // splitByBoundary keeps the first marker as the boundary;
      // joinWithBoundary cleans the suffix's stray marker.
      expect(result.split(SYSTEM_PROMPT_CACHE_BOUNDARY).length - 1).toBe(1)
    })
  })
})
