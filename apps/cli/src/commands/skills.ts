/**
 * `lumen skills` — inspect locally installed Lumen skills.
 *
 * This command is intentionally read-only. It discovers SKILL.md files from
 * the configured root, lists descriptors, and can print a single skill body.
 */

import { FilesystemSkillSource, SkillRegistry, defaultSkillsPath } from '@lumen/skills'

/** Options for `lumen skills list`. */
export interface SkillsListOptions {
  /** Override the skill root directory. Defaults to `LUMEN_SKILLS_PATH` or `~/.lumen/skills`. */
  readonly path?: string
  /** Optional prompt used to show activation score. */
  readonly prompt?: string
}

/** Options for `lumen skills cat`. */
export interface SkillsCatOptions {
  /** Skill id or name. */
  readonly id: string
  /** Override the skill root directory. Defaults to `LUMEN_SKILLS_PATH` or `~/.lumen/skills`. */
  readonly path?: string
}

/** Discover skills from disk and return a populated registry. */
export const loadSkillRegistry = async (rootDir = defaultSkillsPath()): Promise<SkillRegistry> => {
  const source = new FilesystemSkillSource({ rootDir })
  const skills = await source.discover({ cwd: process.cwd() })
  const registry = new SkillRegistry()
  registry.registerAll(skills)
  return registry
}

/** List skill descriptors and optional activation scores. */
export const skillsListCommand = async (opts: SkillsListOptions = {}): Promise<number> => {
  const rootDir = opts.path ?? defaultSkillsPath()
  const registry = await loadSkillRegistry(rootDir)
  const descriptors = registry.list()

  process.stdout.write(`Lumen skills (${rootDir})\n\n`)
  if (descriptors.length === 0) {
    process.stdout.write('  No skills found.\n')
    return 0
  }

  let activations = new Map<string, string>()
  if (opts.prompt) {
    const active = await registry.activate({ cwd: process.cwd(), prompt: opts.prompt })
    activations = new Map(
      active.map((item) => [
        item.skill.id,
        `${item.activation.score.toFixed(2)} ${item.activation.reason}`,
      ]),
    )
  }

  for (const desc of descriptors) {
    const activation = activations.get(desc.id)
    const suffix = activation ? `  activation=${activation}` : ''
    process.stdout.write(`  ${desc.id}  v${desc.version}  ${desc.name}${suffix}\n`)
    if (desc.description) process.stdout.write(`    ${desc.description}\n`)
    if (desc.sourcePath) process.stdout.write(`    ${desc.sourcePath}\n`)
  }
  return 0
}

/** Print one skill's instruction body. */
export const skillsCatCommand = async (opts: SkillsCatOptions): Promise<number> => {
  const rootDir = opts.path ?? defaultSkillsPath()
  const registry = await loadSkillRegistry(rootDir)
  const descriptors = registry.list()
  const match = descriptors.find((desc) => desc.id === opts.id || desc.name === opts.id)
  if (!match) {
    process.stderr.write(`Skill not found: ${opts.id}\n`)
    return 1
  }

  const skill = registry.require(match.id)
  const applied = await skill.apply({ cwd: process.cwd() })
  process.stdout.write(applied.instructions.join('\n\n'))
  process.stdout.write('\n')
  return 0
}
