/**
 * P23.12 — `ProjectAnalyzer`.
 *
 * bug.md #70 was a real gap: the agent loop had no way to
 * bootstrap a CLAUDE.md-style factsheet for a new project.
 * The TUI now exposes `/init` as a slash command (registered
 * in `slash-commands.ts`); this file is the analyzer that
 * does the actual walking.
 *
 * Scope:
 *   - Detect the package manager from `package.json` /
 *     `pyproject.toml` / `Cargo.toml` / `go.mod`. Priority:
 *     pnpm → bun → npm → yarn (whichever file ships first).
 *   - Detect a few well-known top-level directories
 *     (`src/`, `test/`, `tests/`, `docs/`, `scripts/`,
 *     `examples/`, `.github/`).
 *   - Read the test / build / lint commands from
 *     `package.json` scripts (only). Operators whose project
 *     does not ship a `package.json` get an `[init]` notice
 *     directing them to `lumen init` (the permissions
 *     starter) instead.
 *
 * Non-goals for P23.12:
 *   - No cross-language analyzer (Python only files get a
 *     notice; the analyzer reads package.json, not pyproject.toml,
 *     because lumen itself is a TS repo and the goal is to ship
 *     "good enough for the lumen use case").
 *   - No remote / npm-registry lookups.
 *   - No synthesis of a CLAUDE.md (that path crosses the
 *     LLM boundary; we'd inflate the agent.run cost surface
 *     in the user's project just to write a markdown file).
 *
 * The output is a compact factsheet (Markdown) the TUI
 * renders in the chat log; operators can `cp` it into
 * `CLAUDE.md` manually. A P24 follow-up will add an LLM
 * rewrite pass + auto-write capability.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/** Top-level directory name → human label. */
interface TopLevelDir {
  readonly name: string
  readonly purpose: string
}

const COMMON_DIRS: ReadonlyArray<TopLevelDir> = [
  { name: 'src', purpose: 'source code' },
  { name: 'test', purpose: 'test code' },
  { name: 'tests', purpose: 'test code (alt)' },
  { name: 'docs', purpose: 'documentation' },
  { name: 'scripts', purpose: 'utility scripts' },
  { name: 'examples', purpose: 'usage examples' },
  { name: 'bench', purpose: 'benchmarks' },
  { name: 'benchmark', purpose: 'benchmarks (alt)' },
  { name: 'examples', purpose: 'usage examples' },
  { name: '.github', purpose: 'CI + issue templates' },
]

interface PackageJsonScripts {
  readonly test: string | undefined
  readonly build: string | undefined
  readonly lint: string | undefined
  readonly typecheck: string | undefined
}

/** Read `package.json` (returning only the scripts we care about). */
const readPackageJsonScripts = (root: string): PackageJsonScripts | undefined => {
  const path_ = path.join(root, 'package.json')
  if (!fs.existsSync(path_)) return undefined
  // We bound the read: a 10 MiB package.json is a misconfig.
  const stat = fs.statSync(path_)
  if (stat.size > 10 * 1024 * 1024) return undefined
  let raw: string
  try {
    raw = fs.readFileSync(path_, 'utf8')
  } catch {
    return undefined
  }
  let parsed: { scripts?: Record<string, string> }
  try {
    parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
  } catch {
    return undefined
  }
  const scripts = parsed.scripts ?? {}
  return {
    test: scripts.test,
    build: scripts.build,
    lint: scripts.lint,
    typecheck: scripts.typecheck ?? scripts.tsc,
  }
}

/** Detect the package manager — `pnpm`/`bun`/`npm`/`yarn`. */
const detectPackageManager = (
  root: string,
): { readonly manager: 'pnpm' | 'bun' | 'npm' | 'yarn'; readonly source: string } | undefined => {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml')))
    return { manager: 'pnpm', source: 'pnpm-lock.yaml' }
  if (fs.existsSync(path.join(root, 'bun.lockb'))) return { manager: 'bun', source: 'bun.lockb' }
  if (fs.existsSync(path.join(root, 'package-lock.json')))
    return { manager: 'npm', source: 'package-lock.json' }
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return { manager: 'yarn', source: 'yarn.lock' }
  return undefined
}

/** List the well-known top-level directories that exist in `root`. */
const detectTopLevelDirs = (root: string): ReadonlyArray<TopLevelDir> => {
  const out: TopLevelDir[] = []
  for (const d of COMMON_DIRS) {
    if (
      fs.existsSync(path.join(root, d.name)) &&
      fs.statSync(path.join(root, d.name)).isDirectory()
    ) {
      out.push(d)
    }
  }
  return out
}

/** Render the factsheet as Markdown. */
export const renderProjectFactsheet = (root: string): string => {
  const cwd = path.resolve(root)
  const pkg = detectPackageManager(cwd)
  const scripts = readPackageJsonScripts(cwd)
  const dirs = detectTopLevelDirs(cwd)

  const lines: string[] = []
  lines.push(`# ${path.basename(cwd) || 'project'} factsheet`)
  lines.push('')
  lines.push(`> Path: \`${cwd}\``)
  lines.push('')
  if (pkg) {
    lines.push('## Package manager')
    lines.push(`- **${pkg.manager}** (detected from \`${pkg.source}\`)`)
    lines.push('')
  } else {
    lines.push('## Package manager')
    lines.push(
      '- none detected (no pnpm / bun / npm / yarn lockfile). Operators can run `lumen init` (writes a starter `~/.lumen/permissions.yaml`) and edit `package.json#scripts` themselves.',
    )
    lines.push('')
  }
  if (scripts !== undefined) {
    lines.push('## Commands (from package.json#scripts)')
    lines.push('| cmd | script |')
    lines.push('| --- | ------ |')
    if (scripts.test !== undefined) lines.push(`| test | \`${scripts.test}\` |`)
    if (scripts.build !== undefined) lines.push(`| build | \`${scripts.build}\` |`)
    if (scripts.lint !== undefined) lines.push(`| lint | \`${scripts.lint}\` |`)
    if (scripts.typecheck !== undefined) lines.push(`| typecheck | \`${scripts.typecheck}\` |`)
    lines.push('')
  }
  lines.push('## Top-level directories')
  if (dirs.length === 0) {
    lines.push('- none of the common directories present')
  } else {
    for (const d of dirs) {
      lines.push(`- \`${d.name}/\` — ${d.purpose}`)
    }
  }
  lines.push('')
  lines.push('## Notes')
  lines.push(
    '- This factsheet is generated by `ProjectAnalyzer` (P23.12). Operators should review + commit a CLAUDE.md (or similar agent context file) that combines this skeleton with project-specific guidance.',
  )
  return lines.join('\n')
}

export interface ProjectAnalyzerResult {
  readonly factsheet: string
  readonly detected: {
    readonly packageManager: ReturnType<typeof detectPackageManager>
    readonly scripts: ReturnType<typeof readPackageJsonScripts>
    readonly topLevelDirs: ReadonlyArray<TopLevelDir>
  }
}

/** Top-level entry: build the factsheet for `root`. */
export const analyzeProject = (root: string): ProjectAnalyzerResult => ({
  factsheet: renderProjectFactsheet(root),
  detected: {
    packageManager: detectPackageManager(path.resolve(root)),
    scripts: readPackageJsonScripts(path.resolve(root)),
    topLevelDirs: detectTopLevelDirs(path.resolve(root)),
  },
})

/**
 * Default analyze entry point used by the TUI's `/init`
 * slash command. We resolve the project's cwd from
 * `process.cwd()` so the user-typed `/init` applies to the
 * directory the TUI was launched from.
 */
export const analyzeCurrentProject = (): ProjectAnalyzerResult => analyzeProject(process.cwd())
