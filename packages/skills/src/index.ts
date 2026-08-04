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
  expandFromContext,
  expandInstructions,
  expandTemplate,
} from './expansion.js'
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

// P34.2 (Phase B.2) — skill auto-evolution. The evolver
// inspects a completed agent run and writes a new SKILL.md
// when the run was non-trivial (≥3 tool calls). The
// `BaseEvolver` contract is exported so the CLI bridge
// can pick `HeuristicEvolver` (no LLM) or `LLMEvolver`
// (asks the model for the body).
export {
  BaseEvolver,
  HeuristicEvolver,
  LLMEvolver,
  type ChatMessage as EvolverChatMessage,
  type EvolutionResult,
} from './evolver.js'
