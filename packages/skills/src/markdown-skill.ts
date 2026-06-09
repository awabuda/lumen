/**
 * Markdown-backed skill implementation.
 *
 * `MarkdownSkill` is the runtime representation of a `SKILL.md` file. It is
 * independently runnable: construct it with parsed frontmatter + body, then
 * call `shouldActivate()` / `apply()` in a unit test without touching disk.
 */

import { BaseSkill, type SkillApplication, type SkillContext, type SkillTrigger } from './base.js'
import type { SkillFrontmatter } from './parser.js'

/** Constructor options for {@link MarkdownSkill}. */
export interface MarkdownSkillOptions {
  /** Parsed frontmatter. */
  readonly frontmatter: SkillFrontmatter
  /** Markdown body. */
  readonly body: string
  /** Optional source file path for diagnostics and CLI output. */
  readonly sourcePath?: string
}

/** A `SKILL.md` file loaded as a Lumen skill. */
export class MarkdownSkill extends BaseSkill {
  public readonly id: string
  public readonly name: string
  public readonly description: string
  public override readonly version: string
  public override readonly sourcePath?: string
  public readonly triggers: ReadonlyArray<SkillTrigger>
  private readonly body: string

  public constructor(options: MarkdownSkillOptions) {
    super()
    this.id = slugify(options.frontmatter.name)
    this.name = options.frontmatter.name
    this.description = options.frontmatter.description ?? firstParagraph(options.body)
    this.version = options.frontmatter.version ?? '0.1.0'
    this.sourcePath = options.sourcePath
    this.body = options.body.trim()
    this.triggers = buildTriggers(options.frontmatter)
  }

  /** Return the markdown body as an instruction fragment. */
  public override async apply(_ctx: SkillContext): Promise<SkillApplication> {
    return {
      id: this.id,
      instructions: [this.body],
      linkedFiles: [],
    }
  }
}

/** Convert frontmatter keywords/triggers into canonical trigger objects. */
export const buildTriggers = (frontmatter: SkillFrontmatter): SkillTrigger[] => {
  const out: SkillTrigger[] = []
  for (const keyword of frontmatter.keywords ?? []) {
    out.push({ kind: 'keyword', value: keyword, weight: 0.75 })
  }
  for (const trigger of frontmatter.triggers ?? []) {
    if (trigger.startsWith('path:')) {
      out.push({ kind: 'glob', value: trigger.slice('path:'.length).trim(), weight: 0.65 })
    } else if (trigger === 'always') {
      out.push({ kind: 'always', value: '*', weight: 0.2 })
    } else {
      out.push({ kind: 'keyword', value: trigger, weight: 0.7 })
    }
  }
  if (out.length === 0) {
    out.push({ kind: 'keyword', value: frontmatter.name, weight: 0.6 })
  }
  return out
}

/** Stable slug used as the skill id. */
export const slugify = (value: string): string => {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const firstParagraph = (body: string): string => {
  const paragraph = body
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0)
  return paragraph ?? ''
}
