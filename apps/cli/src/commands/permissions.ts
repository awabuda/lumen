/** P22.3 — `lumen permissions show` prints the resolved policy. */

import { parsePermissionPolicy } from '../permissions-loader.js'
import { defaultPermissionsPath } from './init.js'

/** Options for {@link permissionsShowCommand}. */
export interface PermissionsShowOptions {
  /** Path to a YAML permission file. Defaults to `defaultPermissionsPath()`. */
  path?: string
  /** Emit JSON instead of the human-readable form. */
  json?: boolean
}

/** Run `lumen permissions show`. Returns 0 on success, 1 on read/parse error. */
export const permissionsShowCommand = async (
  options: PermissionsShowOptions = {},
): Promise<number> => {
  const file = options.path ?? defaultPermissionsPath()
  let text: string
  try {
    const fs = await import('node:fs/promises')
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      process.stderr.write(
        `lumen permissions show: no policy file at ${file}\nhint: run \`lumen init\` to write a starter file.\n`,
      )
      return 1
    }
    throw err
  }
  const policy = parsePermissionPolicy(text)
  if (options.json === true) {
    process.stdout.write(`${JSON.stringify(policy, null, 2)}\n`)
    return 0
  }
  const lines: string[] = []
  lines.push(`policy: ${file}`)
  lines.push(`version: ${String(policy.version)}`)
  lines.push(`default: ${policy.default}`)
  lines.push('rules:')
  for (const rule of policy.rules) {
    lines.push(`  - ${rule.name}`)
    lines.push(`    tools: [${rule.tools.join(', ')}]`)
    lines.push(`    decision: ${rule.decision}`)
    if (rule.when?.argMatches) {
      const pairs = Object.entries(rule.when.argMatches)
        .map(([k, v]) => `${k} ~ ${v}`)
        .join(', ')
      lines.push(`    when.argMatches: ${pairs}`)
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}
