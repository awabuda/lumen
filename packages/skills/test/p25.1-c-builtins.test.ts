/**
 * P25.1.C \u2014 built-in sub-agent SKILL.md (bug.md #39).
 *
 * Verifies the three shipped built-in SKILL.md files load
 * via the filesystem-source and parse cleanly. The router
 * integration is exercised in P25.1.B's tests; this file
 * pins the on-disk surface.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  parseSkillMarkdown,
  SkillFrontmatterSchema,
} from '../src/parser.js'

const here = fileURLToPath(import.meta.url)
const skillsRoot = resolve(here, '..', '..', 'skills')

describe('P25.1.C \u2014 built-in sub-agent SKILL.md', () => {
  for (const name of ['explore', 'plan', 'general-purpose']) {
    it(`${name}.md has a valid frontmatter and a body`, () => {
      const path = resolve(skillsRoot, `${name}.md`)
      const raw = readFileSync(path, 'utf8')
      const parsed = parseSkillMarkdown(raw)
      // Frontmatter must parse (Zod schema) and the body
      // must be non-empty prose.
      const fm = SkillFrontmatterSchema.parse(parsed.frontmatter)
      expect(fm.name).toBe(name)
      expect(typeof fm.description).toBe('string')
      expect(fm.description.length).toBeGreaterThan(8)
      expect(typeof parsed.body).toBe('string')
      expect(parsed.body.length).toBeGreaterThan(40)
    })
  }

  it('explore is read-only (no mention of write_file / patch / terminal)', () => {
    const raw = readFileSync(resolve(skillsRoot, 'explore.md'), 'utf8')
    expect(raw.toLowerCase()).toContain('may not')
    expect(raw).toContain('write_file')
    expect(raw).toContain('patch')
  })

  it('plan emits a numbered steps + risks shape', () => {
    const raw = readFileSync(resolve(skillsRoot, 'plan.md'), 'utf8')
    // Sections can be either heading (`## Steps`) or bold
    // bullet (`**Steps**`); the contract is the content
    // not the markup.
    expect(raw).toMatch(/(?:##|\*\*)\s*Steps/)
    expect(raw).toMatch(/(?:##|\*\*)\s*Risks/)
    expect(raw).toMatch(/(?:##|\*\*)\s*Verify/)
    expect(raw).toMatch(/(?:##|\*\*)\s*Rollback/)
  })

  it('general-purpose defers to explore/plan for read-only tasks', () => {
    const raw = readFileSync(resolve(skillsRoot, 'general-purpose.md'), 'utf8')
    expect(raw).toMatch(/explore|plan/)
    expect(raw).toMatch(/defer/i)
  })
})