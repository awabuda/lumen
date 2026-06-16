/**
 * Trajectory hook — automatically creates skills from
 * successful agent runs.
 *
 * After every agent run, this hook inspects the conversation
 * and decides whether a new skill should be created. It
 * delegates to a {@link BaseEvolver} and persists the
 * generated SKILL.md to a directory.
 *
 * This module does NOT import `@lumen/core` — skills can
 * be loaded independently. The hook interface is inlined.
 */

import type { BaseEvolver } from './evolver.js'
import type { SkillRegistry } from './registry.js'

/** Minimal hook interface — mirrors @lumen/core's Hook. */
export interface SkillHook {
  handle(event: SkillHookEvent, ctx: SkillHookContext): Promise<void>
}

export interface SkillHookEvent {
  readonly kind: string
  readonly messages?: ReadonlyArray<{
    readonly role: string
    readonly content: string
    readonly toolName?: string
  }>
}

export interface SkillHookContext {
  readonly log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void
    error: (msg: string, meta?: Record<string, unknown>) => void
  }
}

export interface TrajectoryHookOptions {
  /** The evolver to use for skill creation. */
  readonly evolver: BaseEvolver
  /** The skill registry to register new skills into. */
  readonly registry: SkillRegistry
  /** Directory to write SKILL.md files to. */
  readonly skillsDir: string
  /** Minimum number of messages before considering evolution. */
  readonly minMessages?: number
}

/**
 * A hook that creates skills from successful agent
 * trajectories. Registered in the hook registry so it fires
 * automatically after every run.
 */
export class TrajectoryHook implements SkillHook {
  private readonly evolver: BaseEvolver
  private readonly registry: SkillRegistry
  private readonly skillsDir: string
  private readonly minMessages: number

  public constructor(options: TrajectoryHookOptions) {
    this.evolver = options.evolver
    this.registry = options.registry
    this.skillsDir = options.skillsDir
    this.minMessages = options.minMessages ?? 4
  }

  public async handle(event: SkillHookEvent, ctx: SkillHookContext): Promise<void> {
    // Only fire after a run completes successfully.
    if (event.kind !== 'run:end') return
    if (!event.messages || event.messages.length < this.minMessages) return

    try {
      const result = await this.evolver.evolve(event.messages as any, this.registry, this.skillsDir)
      if (result.created) {
        ctx.log?.info('TrajectoryHook: created skill', {
          skillId: result.skill?.id,
          reason: result.reason,
        })
      }
    } catch (err) {
      ctx.log?.error('TrajectoryHook: evolution failed', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
}
