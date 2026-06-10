/**
 * `lumen config` — inspect and validate the merged Lumen config.
 *
 * Sub-commands:
 *   - `show`  (default): pretty-print the resolved config as JSON.
 *   - `path`:  print the config file path that was actually loaded
 *     (or explain that no file was found and defaults were used).
 *   - `validate`: load the config and report any schema errors
 *     without printing the whole tree.
 *
 * Secrets are redacted everywhere they would otherwise land in
 * stdout. The redaction is intentionally narrow: we only hide keys
 * that match `apiKey` / `api_key` / `Authorization` / `Bearer ` /
 * `token` / `password`. We do **not** redact arbitrary `env` blocks
 * or MCP server `env` payloads because the user can list them via
 * `lumen doctor` already; this command stays focused on `lumen`'s
 * own config shape.
 */

import { loadCliConfig } from '../composition.js'

const SECRET_KEY_RE = /(api_?key|authorization|token|password)/i
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^sk-[A-Za-z0-9_-]{6,}/,
  /^ghp_[A-Za-z0-9]{6,}/,
  /^xoxb-[A-Za-z0-9-]{6,}/,
  /^Bearer\s+[A-Za-z0-9._-]{6,}/i,
]

const looksLikeSecretKey = (key: string): boolean => SECRET_KEY_RE.test(key)
const looksLikeSecretValue = (value: unknown): boolean => {
  if (typeof value !== 'string') return false
  return SECRET_VALUE_PATTERNS.some((re) => re.test(value))
}

const redact = (value: unknown, key?: string): unknown => {
  if (key !== undefined && looksLikeSecretKey(key)) return '[REDACTED]'
  if (typeof value === 'string' && looksLikeSecretValue(value)) return '[REDACTED]'
  if (Array.isArray(value)) return value.map((v) => redact(v))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redact(v, k)
    }
    return out
  }
  return value
}

export interface ConfigShowOptions {
  readonly configPath?: string
}
export interface ConfigPathOptions {
  readonly configPath?: string
}
export interface ConfigValidateOptions {
  readonly configPath?: string
}

/** `lumen config show` — pretty-print the resolved config with secrets redacted. */
export const configShowCommand = async (opts: ConfigShowOptions = {}): Promise<number> => {
  const config = await loadCliConfig(opts.configPath)
  const redacted = redact(config)
  process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`)
  return 0
}

/**
 * `lumen config path` — report the config file that was loaded, or
 * explain that no file was found and defaults were used.
 *
 * Implementation note: `loadConfig` does not currently expose the
 * resolved file path, so this command re-implements the lookup
 * sequence (XDG-style user config first, then project config) and
 * reports the first file that exists on disk. The behavior is a
 * *hint* — what matters is that the user can see where their
 * config is being read from.
 */
export const configPathCommand = async (opts: ConfigPathOptions = {}): Promise<number> => {
  if (opts.configPath) {
    process.stdout.write(`${opts.configPath}\n`)
    return 0
  }
  const candidates = await collectConfigCandidates()
  const found: string[] = []
  for (const path of candidates) {
    try {
      const { stat } = await import('node:fs/promises')
      const st = await stat(path)
      if (st.isFile()) found.push(path)
    } catch {
      // missing — skip
    }
  }
  if (found.length === 0) {
    process.stdout.write('(no config file found; built-in defaults in use)\n')
    process.stdout.write(`  searched: ${candidates.join(', ')}\n`)
    return 0
  }
  for (const p of found) process.stdout.write(`${p}\n`)
  return 0
}

/** `lumen config validate` — load and report schema validation status. */
export const configValidateCommand = async (opts: ConfigValidateOptions = {}): Promise<number> => {
  try {
    const config = await loadCliConfig(opts.configPath)
    process.stdout.write('OK\n')
    process.stdout.write(
      `  providers=${config.providers.length} models=${config.models.length} defaultModel=${config.defaultModel ?? '(none)'} mcp=${config.mcp.servers.length}\n`,
    )
    return 0
  } catch (err) {
    process.stderr.write(`FAIL: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }
}

const collectConfigCandidates = async (): Promise<string[]> => {
  const { homedir } = await import('node:os')
  const { join } = await import('node:path')
  const home = homedir()
  return [
    join(home, '.lumen', 'config.yaml'),
    join(home, '.lumen', 'config.yml'),
    join(home, '.lumen', 'config.json'),
    join(process.cwd(), '.lumen', 'config.yaml'),
    join(process.cwd(), '.lumen', 'config.yml'),
    join(process.cwd(), '.lumen', 'config.json'),
  ]
}
