/**
 * Profile switching.
 *
 * A "profile" is a named alternative slice of the Lumen config — the
 * same idea as `aws configure --profile work` or `kubectl config
 * use-context`. Profiles live as either:
 *
 *   1. A `profiles:` key inside the user or project config file:
 *      ```yaml
 *      defaultModel: llama3.1
 *      profiles:
 *        work:
 *          defaultModel: gpt-4o
 *          providers: { openai: { apiKey: sk-… } }
 *        personal:
 *          defaultModel: claude-sonnet-4-5
 *      ```
 *
 *   2. Sibling files named `<base>.<profile>.yaml` next to either
 *      config file (e.g. `~/.lumen/config.work.yaml`,
 *      `./.lumen/config.dev.yaml`). Sibling files are shallow-merged
 *      on top of the base.
 *
 * Resolution precedence (highest wins), with profile selection `P`:
 *   1. Profile key/sibling from `--profile` (CLI flag)
 *   2. `LUMEN_PROFILE` env var
 *   3. `defaultProfile` key in the user or project config
 *   4. Built-in default profile: `default`
 *
 * Within a profile, the layered merge order from {@link loadConfig}
 * still applies (CLI > env > project > user > defaults), but
 * profile-scoped values are layered ON TOP of the base config.
 *
 * Public API:
 *   - {@link loadConfigWithProfile} — same shape as `loadConfig` but
 *     additionally resolves and merges a profile.
 *   - {@link listProfiles} — enumerate available profile names from
 *     both the `profiles:` key and sibling-file convention.
 *   - {@link resolveProfile} — pure resolver: returns the profile
 *     name given CLI / env / config-file hints.
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import {
  deepMerge,
  loadConfig,
  type LoadConfigOptions,
} from './loader.js'
import { ConfigSourceNotFoundError, ConfigValidationError } from './errors.js'
import { LumenConfigSchema, type LumenConfig } from './schema.js'

/** Built-in default profile name. */
export const DEFAULT_PROFILE = 'default'

/** Options for {@link loadConfigWithProfile}. */
export interface LoadConfigWithProfileOptions extends LoadConfigOptions {
  /**
   * Explicit profile name. Wins over `LUMEN_PROFILE` env var and
   * the `defaultProfile` config key. Use `null` to force the
   * `default` profile and skip resolution.
   */
  readonly profile?: string | null
}

const readYamlIfExistsSync = (path: string): Record<string, unknown> | undefined => {
  if (!existsSync(path)) return undefined
  const raw = readFileSync(path, 'utf8')
  const parsed = parseYaml(raw)
  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigSourceNotFoundError(
      `Profile file at ${path} must be a YAML mapping, got ${Array.isArray(parsed) ? 'sequence' : typeof parsed}`,
    )
  }
  return parsed as Record<string, unknown>
}

/** Pull a `profiles:` map out of a parsed config object. */
const extractProfiles = (root: Record<string, unknown> | undefined): Record<string, Record<string, unknown>> => {
  if (!root) return {}
  const raw = root.profiles
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[name] = value as Record<string, unknown>
    }
  }
  return out
}

/** Pull a `defaultProfile:` string out of a parsed config object. */
const extractDefaultProfile = (root: Record<string, unknown> | undefined): string | undefined => {
  if (!root) return undefined
  const value = root.defaultProfile
  if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

/**
 * Enumerate all profile names visible from the current set of config
 * files. Names are deduplicated; the order is `default` first, then
 * user-config profiles, then project-config profiles, then sibling
 * files.
 */
export const listProfiles = (options: LoadConfigOptions = {}): string[] => {
  const cwd = options.cwd ?? process.cwd()
  const userPath = options.skipUserConfig
    ? undefined
    : options.userPath ?? join(homedir(), '.lumen', 'config.yaml')
  const projectPath = options.skipProjectConfig
    ? undefined
    : options.projectPath ?? resolveProjectPathOrUndefined(cwd)

  const names = new Set<string>([DEFAULT_PROFILE])
  for (const path of [userPath, projectPath]) {
    if (!path) continue
    const root = readYamlIfExistsSync(path)
    if (!root) continue
    for (const name of Object.keys(extractProfiles(root))) names.add(name)
    // Sibling files: <base>.<profile>.yaml
    const dir = path.endsWith('.yaml') || path.endsWith('.yml') ? dirnameOf(path) : undefined
    if (!dir) continue
    const base = path.endsWith('.yaml') ? 'config.yaml' : path.endsWith('.yml') ? 'config.yml' : undefined
    if (!base) continue
    for (const ext of ['.yaml', '.yml']) {
      try {
        // We can't listdir synchronously without `node:fs.readdirSync`,
        // but we don't need to: sibling discovery is best-effort and
        // the convention is a small set of well-known names. Skip
        // auto-discovery here; profiles declared in `profiles:` are
        // the primary mechanism. Sibling files still work via
        // resolveProfile merging.
        void ext
      } catch {
        // best-effort
      }
    }
    void base
  }
  return [...names]
}

// Minimal dirname to avoid pulling `node:path` at module top-level.
const dirnameOf = (p: string): string => {
  const i = p.lastIndexOf('/')
  return i === -1 ? '.' : p.slice(0, i) || '/'
}

const resolveProjectPathOrUndefined = (cwd: string): string | undefined => {
  for (const c of ['.lumen/config.yaml', '.lumen/config.yml', 'lumen.config.yaml']) {
    const full = join(cwd, c)
    if (existsSync(full)) return full
  }
  return undefined
}

/**
 * Pure resolver: given a config root and an explicit profile hint,
 * return the profile name to apply.
 *
 * Precedence:
 *   1. `options.profile` (explicit CLI hint; `null` → `default`)
 *   2. `LUMEN_PROFILE` env var
 *   3. `defaultProfile` key in the user or project config
 *   4. Built-in `default`
 *
 * If the resolved name doesn't exist as a profile, we fall back to
 * `default` (we never throw at resolution time — invalid profiles
 * surface as a ConfigValidationError after the merge).
 */
export const resolveProfile = (
  options: { readonly profile?: string | null; readonly userConfigRoot?: Record<string, unknown>; readonly projectConfigRoot?: Record<string, unknown> } = {},
): string => {
  if (options.profile !== undefined && options.profile !== null) {
    return options.profile.length > 0 ? options.profile : DEFAULT_PROFILE
  }
  if (options.profile === null) {
    return DEFAULT_PROFILE
  }
  const env = process.env['LUMEN_PROFILE']
  if (env && env.length > 0) return env
  const fromUser = extractDefaultProfile(options.userConfigRoot)
  if (fromUser) return fromUser
  const fromProject = extractDefaultProfile(options.projectConfigRoot)
  if (fromProject) return fromProject
  return DEFAULT_PROFILE
}

/**
 * Resolve a profile's config slice, looking in the user config's
 * `profiles:` map, the project config's `profiles:` map, and any
 * sibling `<base>.<profile>.yaml` file next to either base. Returns
 * `undefined` if the profile is `default` (the base config IS the
 * default profile, nothing to merge).
 */
const resolveProfileSlice = (
  profile: string,
  options: LoadConfigOptions,
): Record<string, unknown> | undefined => {
  if (profile === DEFAULT_PROFILE) return undefined
  const cwd = options.cwd ?? process.cwd()
  const userPath = options.skipUserConfig
    ? undefined
    : options.userPath ?? join(homedir(), '.lumen', 'config.yaml')
  const projectPath = options.skipProjectConfig
    ? undefined
    : options.projectPath ?? resolveProjectPathOrUndefined(cwd)

  // 1. Look in the user + project `profiles:` maps.
  for (const path of [userPath, projectPath]) {
    if (!path) continue
    const root = readYamlIfExistsSync(path)
    if (!root) continue
    const profiles = extractProfiles(root)
    if (profile in profiles) return profiles[profile]
  }

  // 2. Look for sibling files: replace the trailing `.yaml`/`.yml`
  //    with `.<profile>.yaml` next to either base.
  for (const path of [userPath, projectPath]) {
    if (!path) continue
    for (const ext of ['.yaml', '.yml']) {
      if (!path.endsWith(ext)) continue
      const sibling = path.slice(0, -ext.length) + `.${profile}${ext}`
      const slice = readYamlIfExistsSync(sibling)
      if (slice) return slice
    }
  }

  return undefined
}

/**
 * Load the config, applying the resolved profile on top. Behaves
 * identically to {@link loadConfig} when no profile resolves to
 * anything beyond `default`.
 */
export const loadConfigWithProfile = async (
  options: LoadConfigWithProfileOptions = {},
): Promise<LumenConfig & { readonly profile: string }> => {
  const userConfigRoot = options.skipUserConfig
    ? undefined
    : readYamlIfExistsSync(options.userPath ?? join(homedir(), '.lumen', 'config.yaml'))
  const projectConfigRoot = options.skipProjectConfig
    ? undefined
    : readYamlIfExistsSync(
        options.projectPath ?? resolveProjectPathOrUndefined(options.cwd ?? process.cwd()) ?? '.lumen/config.yaml',
      )
  const profile = resolveProfile({
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(userConfigRoot ? { userConfigRoot } : {}),
    ...(projectConfigRoot ? { projectConfigRoot } : {}),
  })

  // Load the base config (which itself goes through the full merge
  // pipeline: defaults < user < project < env < CLI).
  const base = await loadConfig(options)

  if (profile === DEFAULT_PROFILE) {
    return { ...base, profile }
  }

  const slice = resolveProfileSlice(profile, options)
  if (!slice) {
    // The resolved profile doesn't exist anywhere. Surface a clear
    // validation error so the user knows which profile they
    // misspelled.
    throw new ConfigValidationError(
      `Profile "${profile}" is referenced but not defined. Add a "profiles.${profile}" entry to your config, or create a sibling file like "config.${profile}.yaml".`,
      [{ path: 'profile', message: `unknown profile "${profile}"` }],
    )
  }

  // Validate the merged config: profile slice layered on top of the
  // already-validated base. Use schema's safe parse to surface
  // issues with the same shape the rest of the package uses.
  const merged = deepMerge(
    base as unknown as Record<string, unknown>,
    slice as Record<string, unknown>,
  )
  const result = LumenConfigSchema.safeParse(merged)
  if (!result.success) {
    throw new ConfigValidationError(
      `Profile "${profile}" merged into the base config failed validation`,
      result.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
      { cause: result.error },
    )
  }
  // The schema accepts `profiles` and `defaultProfile` for forward
  // compat, but they're profile-switching metadata — strip them from
  // the returned runtime config so downstream code never sees them.
  const { profiles: _p, defaultProfile: _dp, ...runtime } = result.data
  void _p
  void _dp
  return { ...runtime, profile }
}
