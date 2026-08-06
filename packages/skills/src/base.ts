/**
 * Public extension surface for `@lumen/skills`.
 *
 * A skill is not a tool. Tools are callable capabilities chosen by the
 * model; skills are reusable operating knowledge selected by the runtime and
 * injected as instructions, references, or future hooks.
 */

import { z } from 'zod'

/** Zod schema for a skill trigger. */
export const SkillTriggerSchema = z.object({
  /** Trigger kind. `keyword` matches prompt text; `glob` matches path hints; `always` always activates. */
  kind: z.enum(['keyword', 'glob', 'always']),
  /** Trigger value. `always` may use `*`. */
  value: z.string().min(1),
  /** Optional score contribution; higher skills activate first. */
  weight: z.number().min(0).max(1).optional(),
})
export type SkillTrigger = z.infer<typeof SkillTriggerSchema>

/** Zod schema for a skill activation context. */
export const SkillContextSchema = z.object({
  /** User prompt or task summary to match against. */
  prompt: z.string().optional(),
  /** Current working directory. */
  cwd: z.string().min(1),
  /** File paths or globs observed in the request. */
  pathHints: z.array(z.string()).optional(),
  /** Opaque metadata supplied by the composition root. */
  metadata: z.record(z.unknown()).optional(),
  /**
   * P52.a — positional arguments to substitute
   * into the skill's instruction templates.
   * Bug.md #67 follow-up: the pre-P52.a path
   * did not parameterise skill templates. The
   * operator could not call a skill with
   * positional args (e.g. `/code-review <branch>`).
   * P52.a accepts an array of args; the
   * SkillRegistry replaces each `${ARG[i]}` /
   * `${ARGUMENTS}` / `$ARG[0]` placeholder in
   * the skill's `instructions` text with the
   * corresponding element. Placeholders that
   * reference an out-of-range index are left
   * untouched (the operator should see the
   * raw `${ARG[1]}` in the output so they
   * can fix the invocation).
   */
  arguments: z.array(z.string()).optional(),
})
export type SkillContext = z.infer<typeof SkillContextSchema>

/** Zod schema for the result of activation scoring. */
export const SkillActivationSchema = z.object({
  /** Whether the skill should be applied. */
  active: z.boolean(),
  /** Activation score in [0, 1]. */
  score: z.number().min(0).max(1),
  /** Human-readable explanation for debugging. */
  reason: z.string(),
})
export type SkillActivation = z.infer<typeof SkillActivationSchema>

/** Zod schema for a linked file surfaced by a skill. */
export const SkillLinkedFileSchema = z.object({
  /** Relative file path from the skill root. */
  path: z.string().min(1),
  /** File role. */
  kind: z.enum(['reference', 'template', 'script', 'asset']),
})
export type SkillLinkedFile = z.infer<typeof SkillLinkedFileSchema>

/** Zod schema for the instruction payload a skill contributes. */
export const SkillApplicationSchema = z.object({
  /** Stable skill id. */
  id: z.string().min(1),
  /** Prompt fragments to inject into the agent system/developer context. */
  instructions: z.array(z.string()),
  /** Linked files that may be loaded on demand. */
  linkedFiles: z.array(SkillLinkedFileSchema).optional(),
})
export type SkillApplication = z.infer<typeof SkillApplicationSchema>

/** Zod schema for skill descriptors used by registries and CLIs. */
export const SkillDescriptorSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  version: z.string().min(1),
  triggers: z.array(SkillTriggerSchema),
  sourcePath: z.string().optional(),
})
export type SkillDescriptor = z.infer<typeof SkillDescriptorSchema>

/**
 * Abstract base for every skill implementation.
 *
 * Subclasses override `apply()` and may override `shouldActivate()` if the
 * default trigger scorer is not enough. The default scorer is intentionally
 * simple and deterministic so a skill can be tested in isolation.
 */
export abstract class BaseSkill {
  public abstract readonly id: string
  public abstract readonly name: string
  public abstract readonly description: string
  public readonly version: string = '0.1.0'
  public abstract readonly triggers: ReadonlyArray<SkillTrigger>
  public readonly sourcePath?: string

  /** Score whether this skill should activate for the given context. */
  public async shouldActivate(ctx: SkillContext): Promise<SkillActivation> {
    const parsed = SkillContextSchema.parse(ctx)
    return this.scoreTriggers(parsed)
  }

  /** Apply the skill and return the instructions it contributes. */
  public abstract apply(ctx: SkillContext): Promise<SkillApplication>

  /** Descriptor used by registries and the CLI. */
  public describe(): SkillDescriptor {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      version: this.version,
      triggers: [...this.triggers],
      sourcePath: this.sourcePath,
    }
  }

  /** Default trigger scorer; subclasses can override `shouldActivate` for richer semantics. */
  protected scoreTriggers(ctx: SkillContext): SkillActivation {
    const prompt = (ctx.prompt ?? '').toLowerCase()
    const pathHints = ctx.pathHints ?? []
    let best: SkillActivation = { active: false, score: 0, reason: 'no trigger matched' }

    for (const trigger of this.triggers) {
      if (trigger.kind === 'always') {
        const score = trigger.weight ?? 0.2
        if (score > best.score) best = { active: true, score, reason: 'always trigger matched' }
      }
      if (trigger.kind === 'keyword') {
        const needle = trigger.value.toLowerCase()
        if (prompt.includes(needle)) {
          const score = trigger.weight ?? 0.7
          if (score > best.score)
            best = { active: true, score, reason: `keyword matched: ${trigger.value}` }
        }
      }
      if (trigger.kind === 'glob') {
        const matched = pathHints.some((hint) => globLikeMatch(trigger.value, hint))
        if (matched) {
          const score = trigger.weight ?? 0.6
          if (score > best.score)
            best = { active: true, score, reason: `path matched: ${trigger.value}` }
        }
      }
    }

    return best
  }
}

/**
 * Abstract source for skill discovery.
 *
 * A source can be filesystem-backed, remote, generated from package metadata,
 * or anything else. The registry does not care — it only sees BaseSkill
 * instances.
 */
export abstract class BaseSkillSource {
  public abstract readonly id: string

  /** Discover all skills available from this source. */
  public abstract discover(ctx?: SkillContext): Promise<BaseSkill[]>
}

/** Minimal glob matcher used for skill path triggers.
 *
 * P23.10 (fix #36, partial) — when the pattern contains
 * `*` segments, use a partial match (no `^` / `$` anchors)
 * so `'*foo*'` matches `'myfoobar'`. When the pattern has
 * no `*`, the full-match anchors are preserved (a literal
 * path trigger should not match a substring). The bug was
 * that all patterns were anchored, so `'foo*'` could not
 * match `'foobar/baz'`.
 */
export const globLikeMatch = (pattern: string, value: string): boolean => {
  if (pattern === '*') return true
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  // P23.10 (fix #36) — anchor only when there are no `*`
  // segments (i.e. the pattern is a literal). With `*`
  // segments, the match is a substring search.
  const regex = pattern.includes('*') ? new RegExp(escaped) : new RegExp(`^${escaped}$`)
  return regex.test(value)
}
