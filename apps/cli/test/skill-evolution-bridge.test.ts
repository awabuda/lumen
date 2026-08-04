/**
 * P34.2 (Phase B.2) — Skill auto-evolution tests.
 *
 * Verifies the composition-side bridge turns the
 * assistant assembly's `skillEvolution: 'trajectory'`
 * slot into a real afterRun hook that runs
 * `HeuristicEvolver.evolve` on the final message
 * history.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { HeuristicEvolver, SkillRegistry, defaultSkillsPath } from '@lumen/skills'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSkillEvolutionBridge } from '../src/skill-evolution-bridge.js'

let tmpRoot: string
let skillsDir: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-p34b2-'))
  skillsDir = path.join(tmpRoot, 'skills')
  await fs.mkdir(skillsDir, { recursive: true })
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

describe('createSkillEvolutionBridge — P34.2', () => {
  it('creates a SKILL.md when the run has ≥3 tool calls', async () => {
    const evolver = new HeuristicEvolver()
    const bridge = await createSkillEvolutionBridge({ skillsDir, evolver })
    const result = await bridge.afterRunHook({
      messages: [
        { role: 'user', content: 'Help me find every .ts file and summarise them' },
        { role: 'assistant', content: 'Let me search.' },
        { role: 'tool', content: 'r1' },
        { role: 'tool', content: 'r2' },
        { role: 'tool', content: 'r3' },
        { role: 'assistant', content: 'Here are the .ts files I found.' },
      ],
    })
    expect(result?.created).toBe(true)
    const entries = await fs.readdir(skillsDir)
    expect(entries.length).toBeGreaterThan(0)
    expect(entries[0]).toMatch(/^auto-/)
  })

  it('does not create a SKILL.md when the run has <3 tool calls', async () => {
    const evolver = new HeuristicEvolver()
    const bridge = await createSkillEvolutionBridge({ skillsDir, evolver })
    const result = await bridge.afterRunHook({
      messages: [
        { role: 'user', content: 'A very short task with no tool calls at all' },
        { role: 'assistant', content: 'Done.' },
      ],
    })
    expect(result?.created).toBe(false)
    const entries = await fs.readdir(skillsDir)
    expect(entries).toEqual([])
  })

  it('returns undefined on evolver failure (best-effort, never throws)', async () => {
    const brokenEvolver = new HeuristicEvolver()
    // Force a failure by pointing skillsDir at an
    // unwritable path. We monkey-patch by overriding
    // the evolver.evolve to throw.
    brokenEvolver.evolve = async () => {
      throw new Error('boom')
    }
    const bridge = await createSkillEvolutionBridge({ skillsDir, evolver: brokenEvolver })
    const result = await bridge.afterRunHook({
      messages: [
        { role: 'user', content: 'Help me find every .ts file and summarise them' },
        { role: 'tool', content: 'r1' },
        { role: 'tool', content: 'r2' },
        { role: 'tool', content: 'r3' },
      ],
    })
    expect(result).toBeUndefined()
  })

  it('uses the default skillsDir when no override is given', async () => {
    // Only run the default path check; do NOT write to
    // it. We just assert the bridge accepts the
    // constructor without an override.
    const evolver = new HeuristicEvolver()
    const bridge = await createSkillEvolutionBridge({ evolver })
    expect(bridge).toBeDefined()
    // Default path is the real ~/.lumen/skills; this
    // matches `defaultSkillsPath()` from @lumen/skills.
    expect(defaultSkillsPath()).toContain('.lumen/skills')
  })
})

// Touch the unused import so vitest does not flag it.
void SkillRegistry
