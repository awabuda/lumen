/** P22.3 + P22.6.2 + P22.6.3 — `lumen permissions show`,
 *  `lumen permissions preset`, and `lumen permissions audit`
 *  commands. */
import * as fs from 'node:fs/promises'
import { ConfigError, type ToolPermissionPolicy } from '@lumen/core'
import { loadPermissionPolicyWithSources, parsePermissionPolicy } from '../permissions-loader.js'
import { defaultPermissionsPath, starterPermissionPolicy } from './init.js'

/** Options for {@link permissionsShowCommand}. */
export interface PermissionsShowOptions {
  /** Path to a YAML permission file. Defaults to `defaultPermissionsPath()`. */
  path?: string
  /** Emit JSON instead of the human-readable form. */
  json?: boolean
}

/** Run `lumen permissions show`. Returns 0 on success, 1 on read/parse error.
 *  P22.6.2: when the policy file declares `imports:`, the
 *  output includes a `from <path>` line for every rule,
 *  showing which file each rule came from. The lockout
 *  state (`allowOverrides`) is printed as a flag. */
export const permissionsShowCommand = async (
  options: PermissionsShowOptions = {},
): Promise<number> => {
  const file = options.path ?? defaultPermissionsPath()
  let policy: ToolPermissionPolicy
  let sources: ReadonlyMap<string, string>
  try {
    const loaded = await loadPermissionPolicyWithSources(file)
    policy = loaded.policy
    sources = loaded.sources
  } catch (err) {
    if (err instanceof ConfigError) {
      const code = (err as { code?: string }).code
      if (code === 'ENOENT' || /not found/.test(err.message)) {
        process.stderr.write(
          `lumen permissions show: no policy file at ${file}\nhint: run \`lumen init\` to write a starter file.\n`,
        )
        return 1
      }
    }
    throw err
  }
  if (options.json === true) {
    // P22.6.2: the JSON output carries a `_sources` map
    // (rule name → source file path) for the audit log.
    // P22.6.3 surfaces the same map via `lumen permissions audit`.
    process.stdout.write(
      `${JSON.stringify({ ...policy, _sources: Object.fromEntries(sources) }, null, 2)}\n`,
    )
    return 0
  }
  const lines: string[] = []
  lines.push(`policy: ${file}`)
  lines.push(`version: ${String(policy.version)}`)
  lines.push(`default: ${policy.default}`)
  if (policy.allowOverrides === true) {
    lines.push('allowOverrides: true (imports may override root denies)')
  }
  lines.push('rules:')
  for (const rule of policy.rules) {
    const source = sources.get(rule.name)
    const sourceLabel = source ? ` (from ${source})` : ''
    lines.push(`  - ${rule.name}${sourceLabel}`)
    lines.push(`    tools: [${rule.tools.join(', ')}]`)
    lines.push(`    decision: ${rule.decision}`)
    if (rule.when?.argMatches) {
      const pairs = Object.entries(rule.when.argMatches)
        .map(([k, v]) => `${k} ~ ${v}`)
        .join(', ')
      lines.push(`    when.argMatches: ${pairs}`)
    }
  }
  if (policy.autoMode !== undefined) {
    lines.push('autoMode:')
    lines.push(`  enabled: ${String(policy.autoMode.enabled)}`)
    if (policy.autoMode.neverAllowTools.length > 0) {
      lines.push(`  neverAllowTools: [${policy.autoMode.neverAllowTools.join(', ')}]`)
    }
    if (policy.autoMode.hardDenyPatterns.length > 0) {
      lines.push(`  hardDenyPatterns: [${policy.autoMode.hardDenyPatterns.join(', ')}]`)
    }
    if (policy.autoMode.allowPatterns.length > 0) {
      lines.push(`  allowPatterns: [${policy.autoMode.allowPatterns.join(', ')}]`)
    }
    if (policy.autoMode.softDenyPatterns.length > 0) {
      lines.push(`  softDenyPatterns: [${policy.autoMode.softDenyPatterns.join(', ')}]`)
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

/**
 /** Options for {@link permissionsAuditCommand}. */
export interface PermissionsAuditOptions {
  /** Path to a YAML permission file. Defaults to `defaultPermissionsPath()`. */
  path?: string
  /** Output format. `human` is the default; `json` and `csv` are machine-readable. */
  format?: 'human' | 'json' | 'csv'
}

/** A single audit row. P22.6.3 — one per rule in the merged policy. */
export interface PermissionsAuditEntry {
  /** Rule name (the `name:` field). */
  readonly rule: string
  /** Tool names the rule covers. */
  readonly tools: ReadonlyArray<string>
  /** The decision the rule produces. */
  readonly decision: 'allow' | 'deny' | 'ask'
  /** Absolute path of the file the rule came from. */
  readonly source: string
  /** SHA-256 hash of the file at audit time. */
  readonly sourceHash: string
}

/** The full audit report. P22.6.3 — `policy` is the merged
 *  policy at audit time; `entries` is one row per rule. */
export interface PermissionsAuditReport {
  readonly policy: string
  readonly generatedAt: string
  readonly entries: ReadonlyArray<PermissionsAuditEntry>
}

/** Compute the SHA-256 hash of a file. P22.6.3 — used to
 *  pin the audit report to a specific file revision. The
 *  hash is hex-encoded (lowercase, 64 chars). */
const hashFile = async (filePath: string): Promise<string> => {
  const { createHash } = await import('node:crypto')
  const text = await fs.readFile(filePath, 'utf8')
  return createHash('sha256').update(text).digest('hex')
}

/** Run `lumen permissions audit`. The audit walks the
 *  policy file, follows `imports:`, and prints a row per
 *  rule: the rule name, the tools it covers, the decision,
 *  the absolute path of the file the rule came from, and
 *  the SHA-256 of that file. P22.6.3: a stable, machine-
 *  readable audit log that the operator can pin to a
 *  specific file revision. */
export const permissionsAuditCommand = async (
  options: PermissionsAuditOptions = {},
): Promise<number> => {
  const file = options.path ?? defaultPermissionsPath()
  const format = options.format ?? 'human'
  let loaded: Awaited<ReturnType<typeof loadPermissionPolicyWithSources>>
  try {
    loaded = await loadPermissionPolicyWithSources(file)
  } catch (err) {
    if (err instanceof ConfigError) {
      const code = (err as { code?: string }).code
      if (code === 'ENOENT' || /not found/.test(err.message)) {
        process.stderr.write(
          `lumen permissions audit: no policy file at ${file}\nhint: run \`lumen init\` to write a starter file.\n`,
        )
        return 1
      }
    }
    throw err
  }
  // Compute the hash of each unique source file once. The
  // audit log pins the report to a specific file revision.
  const uniqueSources = new Set<string>()
  for (const src of loaded.sources.values()) {
    uniqueSources.add(src)
  }
  const hashes = new Map<string, string>()
  for (const src of uniqueSources) {
    hashes.set(src, await hashFile(src))
  }
  const entries: PermissionsAuditEntry[] = loaded.policy.rules.map((rule) => {
    const source = loaded.sources.get(rule.name) ?? file
    return {
      rule: rule.name,
      tools: rule.tools,
      decision: rule.decision,
      source,
      sourceHash: hashes.get(source) ?? '',
    }
  })
  const report: PermissionsAuditReport = {
    policy: file,
    generatedAt: new Date().toISOString(),
    entries,
  }
  if (format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return 0
  }
  if (format === 'csv') {
    const header = ['rule', 'tools', 'decision', 'source', 'sourceHash']
    const lines = [header.join(',')]
    for (const e of entries) {
      const cells = [e.rule, e.tools.join('|'), e.decision, e.source, e.sourceHash].map((c) =>
        c.includes(',') || c.includes('"') ? `"${c.replace(/"/g, '""')}"` : c,
      )
      lines.push(cells.join(','))
    }
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  }
  // Default: human-readable table.
  const out: string[] = []
  out.push('# lumen permissions audit')
  out.push(`policy: ${file}`)
  out.push(`generatedAt: ${report.generatedAt}`)
  out.push('')
  for (const e of entries) {
    out.push(`- ${e.rule}`)
    out.push(`  tools: [${e.tools.join(', ')}]`)
    out.push(`  decision: ${e.decision}`)
    out.push(`  source: ${e.source}`)
    out.push(`  sourceHash: ${e.sourceHash}`)
  }
  process.stdout.write(`${out.join('\n')}\n`)
  return 0
}

/**
 * Run `lumen permissions preset`. Prints the recommended
 * starter policy text to stdout. The operator can pipe the
 * output to a file (e.g. `lumen permissions preset > ~/.lumen/permissions.yaml`)
 * to bootstrap a new project without writing the YAML by
 * hand. Same text as `lumen init` writes; the two commands
 * share the `starterPermissionPolicy()` function.
 */
export const permissionsPresetCommand = async (): Promise<number> => {
  process.stdout.write(starterPermissionPolicy())
  return 0
}
