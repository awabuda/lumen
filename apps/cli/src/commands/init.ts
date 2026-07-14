/** P22.3 — `lumen init` writes a starter `~/.lumen/permissions.yaml`. */

import * as fs from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Default path of the permissions file. */
export const defaultPermissionsPath = (): string =>
  process.env.LUMEN_PERMISSIONS_PATH ?? join(homedir(), '.lumen', 'permissions.yaml')

/** Starter policy text. The starter keeps `default: ask` so the
 *  operator must explicitly opt into `allow` for a tool to be
 *  freely dispatched; this matches the P22 design doc §4.4. */
export const starterPermissionPolicy = (): string => `# Lumen tool permission policy (P22).
#
# This file is the static, deterministic rule list for the
# tool-permission middleware. It is the outermost gate in the
# composition chain; the interrupt middleware (P20.1) sits behind
# it for the \`ask\` decisions.
#
# Three decisions per rule:
#   allow — short-circuits; the call dispatches
#   deny  — throws a typed AbortError; the P20.4.2 catch path
#           auto-saves a checkpoint
#   ask   — falls through to the interrupt middleware
#
# Edit the rules below to fit your workflow. The starter ships
# with read-only tools allowed by default and write/exec tools
# explicitly denied — a "least privilege" baseline you can relax
# after reading docs/PERMISSIONS.md.

version: 1
default: ask

rules:
  - name: allow-read-file
    tools: [read_file]
    decision: allow

  - name: allow-list-dir
    tools: [list_dir]
    decision: allow

  - name: allow-search
    tools: [search_files]
    decision: allow

  - name: deny-terminal
    tools: [terminal]
    decision: deny
    # P22 follow-up: ask the host when the operator uncomments the
    # 'ask-on-miss' rule below and removes the deny rule.
`

/** Options for {@link initCommand}. */
export interface InitCommandOptions {
  /** Override the destination path (default: ~/.lumen/permissions.yaml). */
  path?: string
  /** Overwrite an existing file. */
  force?: boolean
}

/** Run the `lumen init` command. Returns 0 on success, 2 on conflict. */
export const initCommand = async (options: InitCommandOptions = {}): Promise<number> => {
  const dest = resolve(options.path ?? defaultPermissionsPath())
  let exists = false
  try {
    await fs.access(dest)
    exists = true
  } catch {
    exists = false
  }
  if (exists && options.force !== true) {
    process.stderr.write(
      `lumen init: file already exists at ${dest}\nre-run with --force to overwrite.\n`,
    )
    return 2
  }
  await fs.mkdir(resolve(dest, '..'), { recursive: true })
  await fs.writeFile(dest, starterPermissionPolicy(), 'utf8')
  process.stdout.write(`wrote ${dest}\n`)
  return 0
}
