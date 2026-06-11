/**
 * `lumen update` — check for newer Lumen releases.
 *
 * The check is **offline-friendly**: it reads the version that
 * was compiled into the running CLI and compares it against the
 * latest tag on the local Git remote (if any). It does NOT
 * phone home to a registry — the user can do `pnpm update
 * @lumen/cli` themselves.
 *
 * Sub-commands:
 *   - `check`  (default): print current vs. latest version, plus
 *     a one-line recommendation.
 *   - `print-version`: just print the running version. Useful in
 *     scripts.
 *
 * If the repository is not a git checkout (e.g. someone ran
 * `npx @lumen/cli`), the "latest" side reports `(unknown)` and
 * the recommendation becomes "cannot check, not a git repo".
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface UpdateCheckOptions {
  /** Override the cwd used for the git remote lookup. */
  readonly cwd?: string
  /** Skip the "you are up to date" recommendation. */
  readonly quiet?: boolean
}

/** `lumen update check` (default). */
export const updateCheckCommand = async (opts: UpdateCheckOptions = {}): Promise<number> => {
  const cwd = opts.cwd ?? process.cwd()
  const current = process.env.npm_package_version ?? '0.0.0-dev'
  // When the CLI is run from `dist/`, npm_package_version is
  // not set, so we fall back to a stable marker. The
  // real version lives in apps/cli/package.json; we read it
  // lazily so `update` works without a full install.
  let resolvedCurrent = current
  if (current === '0.0.0-dev') {
    try {
      const { readFile } = await import('node:fs/promises')
      const pkgPath = new URL('../../package.json', import.meta.url).pathname
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { version?: string }
      if (pkg.version) resolvedCurrent = pkg.version
    } catch {
      // ignore — keep the dev marker
    }
  }

  let latest: string | undefined
  try {
    const { stdout } = await execFileAsync('git', ['describe', '--tags', '--abbrev=0'], { cwd })
    latest = stdout.trim() || undefined
  } catch {
    // No tags, no git, no .git/ — fine, the user gets `(unknown)`.
  }

  process.stdout.write(`Lumen update check\n\n`)
  process.stdout.write(`  current:  ${resolvedCurrent}\n`)
  process.stdout.write(`  latest:   ${latest ?? '(unknown — no git tags in cwd)'}\n`)

  if (!latest) {
    process.stdout.write('\n  Cannot compare; run from a Lumen checkout with at least one tag.\n')
    return 0
  }
  if (latest === resolvedCurrent) {
    if (!opts.quiet) process.stdout.write('\n  You are on the latest version.\n')
    return 0
  }
  process.stdout.write(`\n  A newer version is available. To upgrade:\n`)
  process.stdout.write(`    pnpm update @lumen/cli\n`)
  process.stdout.write(`  (or rebuild from source: pnpm --filter @lumen/cli build)\n`)
  return 1
}

/** `lumen update print-version`. */
export const updatePrintVersionCommand = async (): Promise<number> => {
  try {
    const { readFile } = await import('node:fs/promises')
    const pkgPath = new URL('../../package.json', import.meta.url).pathname
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { version?: string }
    process.stdout.write(`${pkg.version ?? '0.0.0-dev'}\n`)
  } catch {
    process.stdout.write('0.0.0-dev\n')
  }
  return 0
}
