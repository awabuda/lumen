/**
 * Detect when a native addon was compiled against a Node ABI
 * that does not match the current process.
 *
 * `better-sqlite3` ships a prebuilt `.node` binary for one
 * specific Node ABI. When the developer machine's Node version
 * drifts (upgrade, nvm switch, Docker layer swap), the binary
 * no longer loads. Symptom paths the user actually sees:
 *
 *   - Constructing any of `SqliteStore`, `SqliteCheckpointStore`,
 *     `SqliteLoopsStore` throws an opaque error.
 *   - Requiring `better-sqlite3` directly throws the
 *     `NODE_MODULE_VERSION X / Y` mismatch.
 *
 * Both surface here as `AbiProbe.ok === false`, so the doctor
 * has one uniform remediation line. Fix: `pnpm rebuild:native`
 * or `pnpm install` (P15 whitelists the binary's install
 * script so the prebuild is re-downloaded on every install).
 *
 * Detection prefers runtime probing over parsing Mach-O / ELF
 * ABI tags because Node's error message format is part of its
 * public contract across all three platforms.
 *
 * better-sqlite3 is not a direct dependency of this CLI
 * package — it is pulled in transitively through
 * `@lumen/memory`, so its types are not visible to the
 * apps/cli TS program. We resolve it via `createRequire`.
 */

import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'

/**
 * Build a `require` whose resolution algorithm can see the
 * monorepo root's `node_modules`. `createRequire(import.meta.url)`
 * anchors to the file's own directory, which works for the
 * source tree (`apps/cli/src/native-abi.ts` → walks up to
 * `node_modules/.pnpm/...`) but produces a flat "Cannot find
 * module" once the source is compiled to `dist/`, because the
 * compiled file lives in `apps/cli/dist/` and pnpm hoists
 * `better-sqlite3` only into the root. Walking one directory up
 * here gives the require a search path that already includes
 * the root `node_modules`.
 */
const resolveFromMonorepoRoot = (): string => {
  // When the source file is `apps/cli/src/native-abi.ts`, the
  // file URL resolves to `…/apps/cli/src/`. Walking up three
  // directories lands at the workspace root regardless of
  // whether we are running the source via tsx/ts-node or the
  // compiled `apps/cli/dist/native-abi.js` (which adds one
  // extra level).
  let dir = new URL('.', import.meta.url)
  for (let i = 0; i < 4; i++) {
    dir = new URL('..', dir)
    try {
      const candidate = `${dir.pathname.replace(/\/$/, '')}/package.json`
      if (fs.existsSync(candidate)) {
        // Stop climbing once we hit a directory containing
        // package.json — that is the workspace root (apps/cli
        // also has package.json but it does not declare
        // better-sqlite3, so this fallback keeps searching).
        if (
          fs.existsSync(`${dir.pathname.replace(/\/$/, '')}/node_modules/.pnpm/better-sqlite3`) ||
          fs.existsSync(`${dir.pathname.replace(/\/$/, '')}/node_modules/better-sqlite3`)
        ) {
          return dir.pathname.replace(/\/$/, '')
        }
      }
    } catch {
      // ignore — try the next level
    }
  }
  return path.resolve()
}

const monorepoRoot = resolveFromMonorepoRoot()
const localRequire = createRequire(`${monorepoRoot}/package.json`)

/**
 * Resolve the on-disk path to the better-sqlite3 native binary.
 * We anchor the require to this source file so the helper works
 * regardless of `process.cwd()`.
 *
 * Strategy: prefer `require.resolve('better-sqlite3')` (fast
 * path; pnpm symlinks give us the package entry point), then
 * fall back to a `node_modules` walk that recognises pnpm's
 * `.pnpm/<name>@<version>/node_modules/<name>/build/Release/`
 * layout.
 */
export const resolveBetterSqlite3Binary = (): string | undefined => {
  let entry: string | undefined
  try {
    entry = localRequire.resolve('better-sqlite3')
  } catch {
    entry = undefined
  }
  if (entry !== undefined) {
    const pkgRoot = path.dirname(path.dirname(entry))
    const candidate = path.join(pkgRoot, 'build', 'Release', 'better_sqlite3.node')
    if (fs.existsSync(candidate)) return candidate
  }
  const seen = new Set<string>()
  const stack = [path.resolve('node_modules')]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    if (seen.has(dir)) continue
    seen.add(dir)
    let entries: string[] = []
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const entryName of entries) {
      const full = path.join(dir, entryName)
      let stat: fs.Stats | undefined
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (entryName === 'better-sqlite3') {
          const candidate = path.join(full, 'build', 'Release', 'better_sqlite3.node')
          if (fs.existsSync(candidate)) return candidate
        }
        stack.push(full)
      }
    }
  }
  return undefined
}

export interface AbiProbe {
  readonly binaryPath: string | undefined
  readonly ok: boolean
  readonly runningAbi: number
  readonly error?: string
}

interface BetterSqlite3Instance {
  close: () => void
}

interface BetterSqlite3Module {
  new (path: string): BetterSqlite3Instance
}

let cachedCtor: BetterSqlite3Module | undefined | Error

const loadBetterSqlite3Ctor = (): BetterSqlite3Module | undefined => {
  if (cachedCtor === undefined) {
    try {
      cachedCtor = localRequire('better-sqlite3') as BetterSqlite3Module
    } catch (err) {
      cachedCtor = err instanceof Error ? err : new Error(String(err))
    }
  }
  if (cachedCtor instanceof Error) return undefined
  return cachedCtor
}

/**
 * Probe better-sqlite3 by opening an in-memory database. The
 * throw branch captures both ABI drift and other load errors
 * (missing binary, ENOENT, ...); callers can disambiguate via
 * `extractNodeModuleVersionMismatch`.
 */
export const probeBetterSqlite3Abi = (): AbiProbe => {
  // `@types/node` types `process.versions.modules` as `string`
  // (see apps/cli/node_modules/@types/node/process.d.ts:233), but
  // the runtime value is always a positive integer — convert
  // once at the top so the rest of the function sees a number.
  const runningAbi = Number.parseInt(process.versions.modules, 10)
  const binaryPath = resolveBetterSqlite3Binary()
  const ctor = loadBetterSqlite3Ctor()
  if (ctor === undefined) {
    const cached = cachedCtor
    const errMsg =
      cached instanceof Error
        ? cached.message
        : 'better-sqlite3 package not resolvable from this process'
    const probe: AbiProbe = {
      binaryPath,
      ok: false,
      runningAbi: runningAbi,
      error: errMsg,
    }
    return probe
  }
  try {
    const db = new ctor(':memory:')
    db.close()
    const probe: AbiProbe = {
      binaryPath,
      ok: true,
      runningAbi: runningAbi,
    }
    return probe
  } catch (err) {
    const probe: AbiProbe = {
      binaryPath,
      ok: false,
      runningAbi: runningAbi,
      error: err instanceof Error ? err.message : String(err),
    }
    return probe
  }
}

/**
 * Pure helper — extract the two ABI numbers from a Node
 * `NODE_MODULE_VERSION X / Y` mismatch error. Returns
 * undefined when the message does not match the shape.
 */
export const extractNodeModuleVersionMismatch = (
  message: string,
): { readonly compiled: number; readonly running: number } | undefined => {
  const match = /NODE_MODULE_VERSION\s+(\d+)[\s\S]*?NODE_MODULE_VERSION\s+(\d+)/s.exec(message)
  if (match?.[1] !== undefined && match[2] !== undefined) {
    const compiled = Number.parseInt(match[1], 10)
    const running = Number.parseInt(match[2], 10)
    if (Number.isInteger(compiled) && Number.isInteger(running)) {
      return { compiled, running }
    }
  }
  return undefined
}

/**
 * One-line remediation hint. Pure function so the test suite
 * can assert the wording without depending on environment
 * state.
 */
export const formatRemediation = (runningAbi: number): string => {
  return `better-sqlite3 was compiled against a different Node ABI than the one currently running (process.versions.modules=${runningAbi}). Run \`pnpm rebuild:native\` (or \`pnpm install\`) to re-fetch / re-build the matching prebuild, then retry.`
}

/**
 * Format the doctor output line for a probe. Kept here (not
 * inline in commands/doctor.ts) so the test suite can lock down
 * the wording without spinning up an Ink TUI just to read it.
 */
export const formatAbiDoctorMessage = (probe: AbiProbe): string => {
  if (probe.ok) {
    return `better-sqlite3 ABI matches current Node (modules=${probe.runningAbi})`
  }
  const mismatch =
    probe.error !== undefined ? extractNodeModuleVersionMismatch(probe.error) : undefined
  if (mismatch !== undefined) {
    return (
      `better-sqlite3 ABI drift: binary compiled for NODE_MODULE_VERSION=${mismatch.compiled} ` +
      `but Node is running ${mismatch.running}. Run \`pnpm rebuild:native\`.`
    )
  }
  return `better-sqlite3 load failed: ${probe.error ?? '(no detail)'}`
}
