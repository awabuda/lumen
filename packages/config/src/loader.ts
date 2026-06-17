/**
 * Configuration loader.
 *
 * Strategy: build a layered dict, lowest priority first, and shallow-merge
 * higher-priority on top. Object values are deep-merged with a hand-rolled
 * merger that respects arrays as atomic values (i.e. arrays are replaced, not
 * concatenated — that matches what users expect from YAML configs).
 *
 * Public API: {@link loadConfig}.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { ZodIssue } from 'zod'
import { ConfigSourceNotFoundError, ConfigValidationError } from './errors.js'
import { type LumenConfig, LumenConfigSchema } from './schema.js'

export interface LoadConfigOptions {
  /** Path to a project config file. Overrides the default lookup. */
  projectPath?: string
  /** Path to a user config file. Overrides the default. */
  userPath?: string
  /** CLI flag overrides, applied with the highest precedence. */
  cliOverrides?: Record<string, unknown>
  /** Environment variable prefix. Defaults to `LUMEN_`. */
  envPrefix?: string
  /** Working directory for default project lookup. */
  cwd?: string
  /** Skip loading the user config (useful in tests). */
  skipUserConfig?: boolean
  /** Skip loading the project config. */
  skipProjectConfig?: boolean
}

const DEFAULT_PROJECT_LOCATIONS = ['.lumen/config.yaml', '.lumen/config.yml', 'lumen.config.yaml']

const DEFAULT_USER_PATH = join(homedir(), '.lumen', 'config.yaml')

/** Deep merge plain objects. Arrays and other non-plain values are replaced. */
export const deepMerge = (
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...base }
  for (const key of Object.keys(override)) {
    const overrideVal = override[key]
    const baseVal = result[key]
    if (
      overrideVal !== null &&
      typeof overrideVal === 'object' &&
      !Array.isArray(overrideVal) &&
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal)
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      )
    } else {
      result[key] = overrideVal
    }
  }
  return result
}

const readYamlIfExists = async (path: string): Promise<Record<string, unknown> | undefined> => {
  if (!existsSync(path)) return undefined
  const raw = await readFile(path, 'utf8')
  const parsed = parseYaml(raw)
  if (parsed === null || parsed === undefined) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigSourceNotFoundError(
      `Config file at ${path} must be a YAML mapping, got ${Array.isArray(parsed) ? 'sequence' : typeof parsed}`,
    )
  }
  return parsed as Record<string, unknown>
}

const RUNTIME_ENV_KEYS = new Set(['API_KEY', 'BASE_URL', 'MODEL', 'MEMORY_PATH', 'SKILLS_PATH'])

const envSegmentToConfigKey = (segment: string): string => {
  const parts = segment
    .toLowerCase()
    .split('_')
    .filter((part) => part.length > 0)
  const [head, ...tail] = parts
  if (!head) return ''
  return [head, ...tail.map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)].join('')
}

const readEnv = (prefix: string): Record<string, unknown> => {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith(prefix)) continue
    const rawPath = key.slice(prefix.length)
    if (RUNTIME_ENV_KEYS.has(rawPath)) continue
    const path = rawPath.split('__').map(envSegmentToConfigKey).filter(Boolean)
    if (path.length === 0) continue
    // Very small env-shape interpreter:
    //   LUMEN_LOGGING__LEVEL=debug  -> { logging: { level: 'debug' } }
    //   LUMEN_DEFAULT_MODEL=foo     -> { defaultModel: 'foo' }
    // Runtime-only env vars such as LUMEN_API_KEY are consumed by the
    // CLI composition root, not by the strict config schema.
    let cursor: Record<string, unknown> = out
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i]!
      const next = cursor[seg]
      if (next === null || typeof next !== 'object' || Array.isArray(next)) {
        const fresh: Record<string, unknown> = {}
        cursor[seg] = fresh
        cursor = fresh
      } else {
        cursor = next as Record<string, unknown>
      }
    }
    cursor[path[path.length - 1]!] = value
  }
  return out
}

const resolveProjectPath = (cwd: string, override?: string): string | undefined => {
  if (override) return override
  for (const candidate of DEFAULT_PROJECT_LOCATIONS) {
    const full = join(cwd, candidate)
    if (existsSync(full)) return full
  }
  return undefined
}

export const loadConfig = async (options: LoadConfigOptions = {}): Promise<LumenConfig> => {
  const cwd = options.cwd ?? process.cwd()
  const envPrefix = options.envPrefix ?? 'LUMEN_'

  const userPath = options.skipUserConfig ? undefined : (options.userPath ?? DEFAULT_USER_PATH)
  const projectPath = options.skipProjectConfig
    ? undefined
    : resolveProjectPath(cwd, options.projectPath)

  const layers: Array<{ name: string; value: Record<string, unknown> | undefined }> = [
    {
      name: 'built-in defaults',
      value: LumenConfigSchema.parse({}) as unknown as Record<string, unknown>,
    },
    {
      name: `user config (${userPath ?? 'skipped'})`,
      value: userPath ? await readYamlIfExists(userPath) : undefined,
    },
    {
      name: `project config (${projectPath ?? 'skipped'})`,
      value: projectPath ? await readYamlIfExists(projectPath) : undefined,
    },
    { name: `env (${envPrefix}*)`, value: readEnv(envPrefix) },
    { name: 'CLI overrides', value: options.cliOverrides },
  ]

  let merged: Record<string, unknown> = {}
  for (const layer of layers) {
    if (!layer.value) continue
    merged = deepMerge(merged, layer.value)
  }

  const result = LumenConfigSchema.safeParse(merged)
  if (!result.success) {
    throw new ConfigValidationError(
      'Configuration failed validation',
      result.error.issues.map((i: ZodIssue) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
      { cause: result.error },
    )
  }
  return result.data
}
