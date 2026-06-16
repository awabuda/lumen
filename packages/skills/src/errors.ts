/**
 * Skill package error types.
 *
 * Mirrors the convention from `@lumen/core/errors` — every public
 * failure is a typed subclass so callers can `instanceof`-discriminate.
 * These errors extend `Error` directly (not `AgentError`) because the
 * skills package is leaf-level and does not import from `@lumen/core`
 * to avoid pulling in the whole agent runtime as a dep.
 */

export class SkillError extends Error {
  public override readonly cause?: unknown

  constructor(message: string, init: { cause?: unknown } = {}) {
    super(message, init)
    this.name = 'SkillError'
    this.cause = init.cause
  }
}

/** Registration / lookup of a skill failed (duplicate, missing, etc). */
export class SkillConfigError extends SkillError {
  public readonly skillId?: string

  constructor(message: string, init: { skillId?: string; cause?: unknown } = {}) {
    super(message, { cause: init.cause })
    this.name = 'SkillConfigError'
    this.skillId = init.skillId
  }
}

/** SKILL.md frontmatter or body failed to parse. */
export class SkillParseError extends SkillError {
  public readonly path?: string

  constructor(message: string, init: { path?: string; cause?: unknown } = {}) {
    super(message, { cause: init.cause })
    this.name = 'SkillParseError'
    this.path = init.path
  }
}
