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
  /**
   * P35.b — when set, only print the named top-level
   * section of the config (e.g. 'model', 'providers',
   * 'mcp', 'agent'). Unknown names print an empty
   * JSON object and exit 0 (CI-friendly).
   */
  readonly section?: string
  /**
   * P40.c — when true, print the full unredacted
   * config (apiKey / Authorization headers included).
   * Default `false` (pre-P40.c behaviour, secrets
   * always redacted). Off by default because the
   * operator may paste stdout into a bug report.
   * Hidden flag (--include-secrets) — the CLI option
   * is still exposed for debugging but is not
   * advertised in `lumen config show --help`.
   */
  readonly includeSecrets?: boolean
  /**
   * P40.c.b — output format. 'human' (default) is
   * the pre-P40.c single-JSON-object text; 'json'
   * (the same as human for show, but the explicit
   * flag is accepted for CI consumers that need to
   * override the default).
   */
  readonly format?: 'human' | 'json'
}
export interface ConfigGetOptions {
  readonly configPath?: string
  /**
   * P39.d — dotted path into the redacted config
   * (e.g. `defaultModel`, `agent.maxIterations`,
   * `mcp.servers[0].name`). Returns the value at
   * the path as a one-line JSON snippet. Unknown
   * paths print `null` and exit 0 (CI-friendly).
   */
  readonly path?: string
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
  // P40.c — `includeSecrets` skips the redact() pass so
  // operators can dump the full config for local
  // debugging. Default off (secrets always scrubbed).
  const view = (
    opts.includeSecrets === true ? config : (redact(config) as Record<string, unknown>)
  ) as Record<string, unknown>
  if (opts.section !== undefined) {
    const section = view[opts.section]
    process.stdout.write(`${JSON.stringify(section ?? {}, null, 2)}\n`)
    return 0
  }
  process.stdout.write(`${JSON.stringify(view, null, 2)}\n`)
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
/**
 * `lumen config get <dotted-path>` — P39.d. Read a single
 * value out of the resolved + redacted config. Useful for
 * `lumen config get defaultModel` style shell substitution.
 * Returns 0 with the value on stdout, or 0 with `null` if
 * the path does not exist (CI consumers can branch on the
 * value). Does NOT mutate the config.
 */
export const configGetCommand = async (opts: ConfigGetOptions = {}): Promise<number> => {
  if (opts.path === undefined || opts.path.length === 0) {
    process.stderr.write('lumen config get: missing <path> argument\n')
    return 2
  }
  const config = await loadCliConfig(opts.configPath)
  const redacted = redact(config) as Record<string, unknown>
  const value = lookupPath(redacted, opts.path)
  if (value === undefined) {
    process.stdout.write('null\n')
    return 0
  }
  process.stdout.write(`${JSON.stringify(value)}\n`)
  return 0
}

const lookupPath = (root: unknown, path: string): unknown => {
  // Dotted-path resolution. `a.b.c` walks the nested
  // object. `a[0]` indexes an array. Returns
  // `undefined` on any unresolved step (CI-friendly —
  // callers can branch on `null` without an error).
  const tokens = path.split(/[.[\]]+/).filter((t) => t.length > 0)
  let cur: unknown = root
  for (const t of tokens) {
    if (cur === null || cur === undefined) return undefined
    if (Array.isArray(cur)) {
      const i = Number.parseInt(t, 10)
      if (!Number.isInteger(i) || i < 0 || i >= cur.length) return undefined
      cur = cur[i]
    } else if (typeof cur === 'object') {
      const rec = cur as Record<string, unknown>
      if (!(t in rec)) return undefined
      cur = rec[t]
    } else {
      return undefined
    }
  }
  return cur
}

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
