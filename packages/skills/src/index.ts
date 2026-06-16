/**
 * @lumen/skills — reusable operating knowledge for Lumen agents.
 *
 * The package provides the base contracts, registry, SKILL.md parser, and
 * filesystem discovery source. It deliberately does not import `@lumen/core`:
 * skills can be loaded and tested independently from the agent runtime.
 */

export {
  BaseSkill,
  BaseSkillSource,
  SkillActivationSchema,
  SkillApplicationSchema,
  SkillContextSchema,
  SkillDescriptorSchema,
  SkillLinkedFileSchema,
  SkillTriggerSchema,
  globLikeMatch,
  type SkillActivation,
  type SkillApplication,
  type SkillContext,
  type SkillDescriptor,
  type SkillLinkedFile,
  type SkillTrigger,
} from './base.js'

export { SkillRegistry, type ActivatedSkill } from './registry.js'
export {
  parseFrontmatter,
  parseSkillMarkdown,
  SkillFrontmatterSchema,
  ParsedSkillMarkdownSchema,
} from './parser.js'
export type { ParsedSkillMarkdown, SkillFrontmatter } from './parser.js'
export { SkillConfigError, SkillError, SkillParseError } from './errors.js'
export {
  MarkdownSkill,
  buildTriggers,
  slugify,
  type MarkdownSkillOptions,
} from './markdown-skill.js'
export {
  FilesystemSkillSource,
  defaultSkillsPath,
  findSkillFiles,
  type FilesystemSkillSourceOptions,
} from './filesystem-source.js'
