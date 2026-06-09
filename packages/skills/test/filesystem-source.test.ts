/** Tests for filesystem skill discovery. */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultSkillsPath, FilesystemSkillSource, findSkillFiles } from '../src/index.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-skills-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
  delete process.env.LUMEN_SKILLS_PATH
})

const writeSkill = async (relativeDir: string, name: string): Promise<string> => {
  const dir = path.join(tmpDir, relativeDir)
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, 'SKILL.md')
  await fs.writeFile(
    file,
    `---\nname: ${name}\nkeywords: [${name.toLowerCase()}]\n---\n# ${name}\n\n${name} body\n`,
    'utf8',
  )
  return file
}

describe('findSkillFiles', () => {
  it('finds SKILL.md files recursively and sorts them', async () => {
    const b = await writeSkill('b', 'Bravo')
    const a = await writeSkill('a', 'Alpha')
    const files = await findSkillFiles(tmpDir)
    expect(files).toEqual([a, b].sort((x, y) => x.localeCompare(y)))
  })

  it('returns empty list for missing roots', async () => {
    const files = await findSkillFiles(path.join(tmpDir, 'missing'))
    expect(files).toEqual([])
  })

  it('honors maxDepth', async () => {
    await writeSkill('a/b/c', 'Deep')
    expect(await findSkillFiles(tmpDir, 1)).toEqual([])
    expect(await findSkillFiles(tmpDir, 4)).toHaveLength(1)
  })
})

describe('FilesystemSkillSource', () => {
  it('loads MarkdownSkill instances from disk', async () => {
    const file = await writeSkill('typescript', 'TypeScript')
    const source = new FilesystemSkillSource({ rootDir: tmpDir })
    const skills = await source.discover({ cwd: tmpDir })
    expect(skills).toHaveLength(1)
    expect(skills[0]?.id).toBe('typescript')
    expect(skills[0]?.describe().sourcePath).toBe(file)
  })

  it('returns empty list when root is missing', async () => {
    const source = new FilesystemSkillSource({ rootDir: path.join(tmpDir, 'missing') })
    expect(await source.discover()).toEqual([])
  })

  it('propagates parser errors with source discovery context intact', async () => {
    const dir = path.join(tmpDir, 'bad')
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'SKILL.md'), 'not frontmatter', 'utf8')
    const source = new FilesystemSkillSource({ rootDir: tmpDir })
    await expect(source.discover()).rejects.toThrow(/must start/)
  })
})

describe('defaultSkillsPath', () => {
  it('uses env override', () => {
    process.env.LUMEN_SKILLS_PATH = '/tmp/custom-skills'
    expect(defaultSkillsPath()).toBe('/tmp/custom-skills')
  })

  it('defaults to ~/.lumen/skills', () => {
    expect(defaultSkillsPath()).toBe(path.join(os.homedir(), '.lumen', 'skills'))
  })
})
