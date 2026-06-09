/** Tests for `lumen skills` command handlers. */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSkillRegistry, skillsCatCommand, skillsListCommand } from '../src/commands/skills.js'

let tmpDir: string
let stdout = ''
let stderr = ''

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-cli-skills-test-'))
  stdout = ''
  stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const writeSkill = async (): Promise<void> => {
  const dir = path.join(tmpDir, 'typescript')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: TypeScript Expert\ndescription: Strict TS guidance\nversion: 2.0.0\nkeywords: [typescript]\n---\n# TypeScript Expert\n\nAvoid any.\n`,
    'utf8',
  )
}

describe('loadSkillRegistry', () => {
  it('loads skills from a root directory', async () => {
    await writeSkill()
    const registry = await loadSkillRegistry(tmpDir)
    expect(registry.size).toBe(1)
    expect(registry.list()[0]?.id).toBe('typescript-expert')
  })
})

describe('skillsListCommand', () => {
  it('prints empty state for missing root', async () => {
    const code = await skillsListCommand({ path: path.join(tmpDir, 'missing') })
    expect(code).toBe(0)
    expect(stdout).toContain('No skills found')
  })

  it('prints skill descriptors', async () => {
    await writeSkill()
    const code = await skillsListCommand({ path: tmpDir })
    expect(code).toBe(0)
    expect(stdout).toContain('typescript-expert')
    expect(stdout).toContain('Strict TS guidance')
    expect(stdout).toContain('SKILL.md')
  })

  it('prints activation score when prompt is supplied', async () => {
    await writeSkill()
    const code = await skillsListCommand({ path: tmpDir, prompt: 'help with TypeScript' })
    expect(code).toBe(0)
    expect(stdout).toContain('activation=')
    expect(stdout).toContain('keyword matched')
  })
})

describe('skillsCatCommand', () => {
  it('prints skill instructions by id', async () => {
    await writeSkill()
    const code = await skillsCatCommand({ path: tmpDir, id: 'typescript-expert' })
    expect(code).toBe(0)
    expect(stdout).toContain('Avoid any.')
  })

  it('prints skill instructions by name', async () => {
    await writeSkill()
    const code = await skillsCatCommand({ path: tmpDir, id: 'TypeScript Expert' })
    expect(code).toBe(0)
    expect(stdout).toContain('TypeScript Expert')
  })

  it('returns 1 when skill is missing', async () => {
    await writeSkill()
    const code = await skillsCatCommand({ path: tmpDir, id: 'missing' })
    expect(code).toBe(1)
    expect(stderr).toContain('Skill not found')
  })
})
