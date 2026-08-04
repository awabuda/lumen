/**
 * P33.B Day1 — ProductAssembly + profile schema.
 *
 * Mirrors `docs/OPTIMIZATION-PLAN.md` §3 G-T1 / §4 / §5.
 * A "ProductAssembly" is a named bundle of middleware
 * configuration: the assembly name (e.g. `assistant`,
 * `bare`) is the value the operator sets via
 * `defaultProfile` in their `~/.lumen/config.yaml`; the
 * composition root resolves the assembly to a concrete
 * middleware list and feeds it to `createAgent`.
 *
 * This module is *pure data + a pure resolver* — no core
 * dependency. The composition root in `apps/cli/src/
 * composition.ts` is the only call site that knows how
 * to translate the abstract `middleware` name list into
 * actual `create*Middleware` factories.
 *
 * Public API:
 *   - {@link BUILTIN_ASSEMBLIES} — the read-only record of
 *     built-in assemblies (`assistant` / `bare`).
 *   - {@link AssemblyName} — the union of the keys of
 *     `BUILTIN_ASSEMBLIES`.
 *   - {@link resolveProductAssembly} — pure resolver:
 *     returns the assembly for a given profile name
 *     (falls back to `assistant` for unknown names so
 *     the surface degrades gracefully).
 *
 * Per design doc §3 G-T1, `AgentConfig` MUST NOT gain
 * `enablePlan` / `enableSkill` / `enableReflection` style
 * boolean flags. Operators opt into the assembly via
 * `defaultProfile` in the config file or `LUMEN_PROFILE`
 * in the env; that is the *only* sanctioned surface.
 */

import { DEFAULT_PROFILE } from './profile.js'

/**
 * The list of middleware that the `assistant` assembly
 * activates. The composition root maps each name to a
 * `create*Middleware` factory; this module does not
 * know about `@lumen/core` so the names are typed as
 * `string` here and matched against the factory map at
 * the call site.
 */
export type AssemblyMiddlewareName =
  | 'tool-permission'
  | 'plan'
  | 'interrupt-by-risk'
  | 'skill-trigger'
  | 'reflection'

/**
 * Built-in assembly shape. `planMode` is the value
 * passed to `createPlanMiddleware` (per assembly); the
 * `permissions` / `reflection` / `skillEvolution` fields
 * are forward-looking — they document the contract but
 * only `planMode` is consumed by the composition root
 * today (P33.B Day1 scope; Day3+ add the others).
 */
export interface ProductAssembly {
  readonly middleware: ReadonlyArray<AssemblyMiddlewareName>
  readonly planMode: 'auto' | 'plan' | 'act'
  readonly permissionsDefaultPath?: string
  readonly reflection: { readonly inline: boolean; readonly runEnd?: 'rule' | 'off' }
  readonly skillEvolution: 'off' | 'reserved' | 'trajectory'
}

/** Built-in assemblies. The record is `as const` so
 * `AssemblyName` collapses to a string-literal union. */
export const BUILTIN_ASSEMBLIES = {
  /**
   * The default "assistant" assembly. Plan + permission
   * + skill-trigger + reflection all active out of the
   * box. Operators who want a leaner agent pass
   * `--profile bare` or set `defaultProfile: bare` in
   * their config.
   */
  assistant: {
    middleware: [
      'tool-permission',
      'plan',
      'interrupt-by-risk',
      'skill-trigger',
      'reflection',
    ] as const,
    planMode: 'auto' as const,
    permissionsDefaultPath: '~/.lumen/permissions.yaml',
    reflection: { inline: true, runEnd: 'rule' as const },
    skillEvolution: 'reserved' as const,
  },
  /**
   * The "bare" assembly. No middleware. The composition
   * root constructs a bare `Agent` with only the
   * Provider / ToolRegistry the operator configured.
   * Useful for sub-agents and for operators debugging
   * the agent loop in isolation.
   */
  bare: {
    middleware: [] as const,
    skillEvolution: 'off' as const,
    reflection: { inline: false } as const,
    planMode: 'act' as const,
  },
} as const satisfies Record<string, ProductAssembly>

/** Union of the keys of {@link BUILTIN_ASSEMBLIES}. */
export type AssemblyName = keyof typeof BUILTIN_ASSEMBLIES

/** Built-in default assembly name. Differs from
 * {@link DEFAULT_PROFILE} (the profile *system* default
 * is `default`; the product-assembly *system* default is
 * `assistant`). The composition root translates the
 * resolved profile name to a product-assembly name. */
export const DEFAULT_ASSEMBLY: AssemblyName = 'assistant'

/**
 * Pure resolver: return the assembly for a given profile
 * name. Unknown names fall back to the default
 * (`assistant`) so the surface degrades gracefully — the
 * operator gets a working agent even with a typo in
 * `defaultProfile`. The error surface for unknown
 * profiles is `loadConfigWithProfile` (which throws
 * `ConfigValidationError`); the composition root that
 * invokes this resolver runs after the profile
 * resolution step, so a typo'd profile that resolved
 * successfully falls through to `assistant` here.
 */
export const resolveProductAssembly = (profile: string | null | undefined): ProductAssembly => {
  if (profile === null || profile === undefined || profile.length === 0) {
    return BUILTIN_ASSEMBLIES[DEFAULT_ASSEMBLY]
  }
  const known = (BUILTIN_ASSEMBLIES as Record<string, ProductAssembly | undefined>)[profile]
  if (known !== undefined) return known
  // Unknown name: graceful degradation per design doc §3
  // G-T1 — the operator gets the default assembly; the
  // "you typo'd a profile" error was already raised at
  // profile resolution time.
  return BUILTIN_ASSEMBLIES[DEFAULT_ASSEMBLY]
}

/**
 * Map a profile-system name to the closest built-in
 * assembly. The profile system has its own naming
 * (`default` / `work` / `personal`); this helper maps
 * the canonical names to assembly shapes so the
 * operator can write `defaultProfile: assistant` in
 * their config and the composition root knows to use
 * the assistant assembly.
 *
 * Special cases:
 *   - `default` → `assistant` (per G-T1; the system
 *     default is the assistant assembly).
 *   - `bare` → `bare` (operator-opt-out).
 *   - anything else → `assistant` (graceful).
 */
export const profileNameToAssembly = (profile: string): AssemblyName => {
  if (profile === 'default' || profile === DEFAULT_PROFILE) {
    return DEFAULT_ASSEMBLY
  }
  if (profile === 'bare') {
    return 'bare'
  }
  return DEFAULT_ASSEMBLY
}
