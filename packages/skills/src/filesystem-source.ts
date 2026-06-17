/**
 * Filesystem-backed skill discovery.
 *
 * A skill directory may contain one or more `SKILL.md` files. Each file is
 * parsed into a {@link MarkdownSkill}. Discovery is deterministic: paths are
 * sorted lexicographically before parsing.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { type BaseSkill, BaseSkillSource, type SkillContext } from './base.js'
import { MarkdownSkill } from './markdown-skill.js'
import { parseSkillMarkdown } from './parser.js'

/** Options for {@link FilesystemSkillSource}. */
export interface FilesystemSkillSourceOptions {
  /** Root directory to scan. */
  readonly rootDir: string
  /** Maximum directory depth below root. Defaults to 4. */
  readonly maxDepth?: number
}

/** Discover `SKILL.md` files from a directory tree. */
export class FilesystemSkillSource extends BaseSkillSource {
  public readonly id = 'filesystem'
  private readonly rootDir: string
  private readonly maxDepth: number

  public constructor(options: FilesystemSkillSourceOptions) {
    super()
    this.rootDir = options.rootDir
    this.maxDepth = options.maxDepth ?? 4
  }

  /** Load all skills found under the configured root. Missing roots return an empty list. */
  public override async discover(_ctx?: SkillContext): Promise<BaseSkill[]> {
    const files = await findSkillFiles(this.rootDir, this.maxDepth)
    const skills: BaseSkill[] = []
    for (const file of files) {
      const raw = await fs.readFile(file, 'utf8')
      const parsed = parseSkillMarkdown(raw)
      skills.push(new MarkdownSkill({ ...parsed, sourcePath: file }))
    }
    return skills
  }
}

/** Default Lumen skill directory (`~/.lumen/skills`, overridable by env). */
export const defaultSkillsPath = (): string => {
  const override = process.env.LUMEN_SKILLS_PATH
  if (override) return override
  return path.join(os.homedir(), '.lumen', 'skills')
}

/** Find `SKILL.md` files under a root directory. */
export const findSkillFiles = async (rootDir: string, maxDepth = 4): Promise<string[]> => {
  const root = path.resolve(rootDir)
  const out: string[] = []
  await walk(root, 0, maxDepth, out)
  return out.sort((a, b) => a.localeCompare(b))
}

const walk = async (dir: string, depth: number, maxDepth: number, out: string[]): Promise<void> => {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch (err) {
    const e = err as NodeJS.ErrnoException
    if (e.code === 'ENOENT') return
    throw err
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isFile() && entry.name === 'SKILL.md') out.push(fullPath)
    if (entry.isDirectory() && depth < maxDepth) {
      await walk(fullPath, depth + 1, maxDepth, out)
    }
  }
}
