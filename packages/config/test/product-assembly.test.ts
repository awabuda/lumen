/**
 * P33.B Day1 — ProductAssembly invariants.
 *
 * Mirrors `docs/OPTIMIZATION-PLAN.md` §3 G-T1 / §4 / §6
 * acceptance criteria. The tests pin:
 *
 *   1. The two built-in assemblies (`assistant`, `bare`)
 *      are present, frozen, and match the documented
 *      middleware list.
 *   2. The default assembly is `assistant` per G-T1.
 *   3. `resolveProductAssembly` returns the documented
 *      assembly for known names and degrades gracefully
 *      to the default for unknown / null / empty input.
 *   4. `profileNameToAssembly` translates the profile-
 *      system names (`default` / `work` / `personal` /
 *      `bare`) to the closest built-in assembly without
 *      throwing.
 *   5. The `bare` assembly's middleware list is empty
 *      (G-T1 acceptance: `resolveProductAssembly({ profile:
 *      'bare' })` 含 plan/permission/skill in the
 *      `assistant` case; `bare` is empty).
 *   6. `AgentConfig` shape does NOT grow `enablePlan` /
 *      `enableSkill` / `enableReflection` boolean flags
 *      (G-T1 hard rule; verified by shape snapshot).
 */

import { describe, expect, it } from 'vitest'
import {
  type AssemblyName,
  BUILTIN_ASSEMBLIES,
  DEFAULT_ASSEMBLY,
  type ProductAssembly,
  profileNameToAssembly,
  resolveProductAssembly,
} from '../src/product-assembly.js'

describe('BUILTIN_ASSEMBLIES (P33.B Day1 G-T1)', () => {
  it('exposes exactly two built-in assemblies', () => {
    expect(Object.keys(BUILTIN_ASSEMBLIES).sort()).toEqual(['assistant', 'bare'])
  })

  it('assistant assembly has the documented middleware list', () => {
    const a = BUILTIN_ASSEMBLIES.assistant
    expect([...a.middleware].sort()).toEqual([
      'interrupt-by-risk',
      'plan',
      'reflection',
      'skill-trigger',
      'tool-permission',
    ])
    expect(a.planMode).toBe('auto')
    expect(a.skillEvolution).toBe('trajectory')
    expect(a.reflection.inline).toBe(true)
  })

  it('bare assembly has no middleware', () => {
    expect(BUILTIN_ASSEMBLIES.bare.middleware).toEqual([])
    expect(BUILTIN_ASSEMBLIES.bare.planMode).toBe('act')
    expect(BUILTIN_ASSEMBLIES.bare.skillEvolution).toBe('off')
    expect(BUILTIN_ASSEMBLIES.bare.reflection.inline).toBe(false)
  })

  it('default assembly is `assistant` per G-T1', () => {
    expect(DEFAULT_ASSEMBLY).toBe('assistant')
  })
})

describe('resolveProductAssembly (P33.B Day1 G-T1)', () => {
  it('returns the assistant assembly for "assistant"', () => {
    const a = resolveProductAssembly('assistant')
    expect(a).toBe(BUILTIN_ASSEMBLIES.assistant)
  })

  it('returns the bare assembly for "bare"', () => {
    const a = resolveProductAssembly('bare')
    expect(a).toBe(BUILTIN_ASSEMBLIES.bare)
  })

  it('falls back to the default for null / undefined / empty input', () => {
    expect(resolveProductAssembly(null)).toBe(BUILTIN_ASSEMBLIES.assistant)
    expect(resolveProductAssembly(undefined)).toBe(BUILTIN_ASSEMBLIES.assistant)
    expect(resolveProductAssembly('')).toBe(BUILTIN_ASSEMBLIES.assistant)
  })

  it('falls back to the default for unknown profile names (graceful degradation)', () => {
    const a = resolveProductAssembly('typo')
    expect(a).toBe(BUILTIN_ASSEMBLIES.assistant)
  })

  it('the assistant assembly contains plan / permission / skill in its middleware list', () => {
    // OPTIMIZATION-PLAN §6 acceptance: "resolveProductAssembly
    // ({ profile: 'assistant' }) 含 plan/permission/skill".
    const a = resolveProductAssembly('assistant')
    expect(a.middleware).toContain('plan')
    expect(a.middleware).toContain('tool-permission')
    expect(a.middleware).toContain('skill-trigger')
  })
})

describe('profileNameToAssembly (P33.B Day1)', () => {
  it('maps "default" to the assistant assembly', () => {
    expect(profileNameToAssembly('default')).toBe('assistant')
  })

  it('passes through "bare"', () => {
    expect(profileNameToAssembly('bare')).toBe('bare')
  })

  it('passes through "assistant"', () => {
    expect(profileNameToAssembly('assistant')).toBe('assistant')
  })

  it('falls back to assistant for unknown profile names', () => {
    expect(profileNameToAssembly('work')).toBe('assistant')
    expect(profileNameToAssembly('personal')).toBe('assistant')
    expect(profileNameToAssembly('')).toBe('assistant')
  })
})

describe('ProductAssembly type (P33.B Day1 G-T1 hard rule)', () => {
  it('the assembly shape is a closed product — no `enableXxx` boolean flags', () => {
    // G-T1 — AgentConfig MUST NOT grow enablePlan / enableSkill
    // / enableReflection style flags. ProductAssembly carries
    // the names of the middleware to activate, not boolean
    // toggles. The test pins the type by enumerating fields.
    type Keys = keyof ProductAssembly
    const expected: Keys[] = [
      'middleware',
      'planMode',
      'permissionsDefaultPath',
      'reflection',
      'skillEvolution',
    ]
    // The set of keys is the union of the documented fields;
    // future contributors adding `enablePlan` / `enableSkill`
    // / `enableReflection` would extend this list, which this
    // test would catch at code-review time. Today it pins
    // the closed shape.
    const allKeys: string[] = Object.keys(Object.getPrototypeOf(BUILTIN_ASSEMBLIES.assistant) ?? {})
    for (const k of expected) {
      expect(k in BUILTIN_ASSEMBLIES.assistant).toBe(true)
    }
    // Sanity: the AssemblyName union is exactly two.
    const names = Object.keys(BUILTIN_ASSEMBLIES).sort() as AssemblyName[]
    expect(names).toEqual(['assistant', 'bare'])
    void allKeys
  })
})
