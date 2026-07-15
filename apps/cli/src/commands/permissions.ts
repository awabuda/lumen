/** P22.3 + P22.6.2 — `lumen permissions show` and `lumen permissions preset` commands. */

import {
  loadPermissionPolicyWithSources,
  parsePermissionPolicy,
} from '../permissions-loader.js'
import { ConfigError } from '@lumen/core'
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
  let policy
  let sources
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
    lines.push(`allowOverrides: true (imports may override root denies)`)
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
