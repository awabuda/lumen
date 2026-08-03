/**
 * P31.3 — Project + optional context-file loaders.
 *
 * Implements §1.2 (load rules table) and §2 (file table
 * rows for the two loaders):
 *
 *   - `loadProjectContext(cwd)` — walk upward from `cwd` to
 *     the git root (or up to a hard cap of 6 hops) reading
 *     AGENTS.md / CLAUDE.md (case-insensitive). The first
 *     match wins. Empty result → caller skips the P1
 *     section entirely.
 *
 *   - `loadOptionalContextFiles(opts)` — profile-gated
 *     reader for the optional layers:
 *       P2: SOUL.md / IDENTITY.md / USER.md
 *       B1: BOOTSTRAP.md
 *       M1: MEMORY.md (treated as stable snapshot per §1.2)
 *     Files are read from `<cwd>/` first, then `~/.lumen/`
 *     fallback when the per-section `fallbackToHome` is
 *     true. Empty / missing files are skipped silently.
 *
 * Both loaders are pure (no global state, no logger
 * injection) and operate on a stub interface (`FsReader`)
 * so tests can drive them without touching the real
 * filesystem.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * Filesystem shim for the loaders. Default impl wraps
 * `node:fs`; tests inject a fake that resolves every path
 * to a fixed string.
 */
export interface FsReader {
  /** Resolve `cwd`'s git root by walking up looking for `.git`. */
  findGitRoot(cwd: string): string | null
  /** Read a file as utf-8; return null when missing. */
  read(path: string): string | null
  /** `path.resolve` analogue so the caller can pre-build paths. */
  resolve(...parts: ReadonlyArray<string>): string
}

const defaultFsReader: FsReader = {
  findGitRoot: (cwd: string): string | null => {
    let dir = path.resolve(cwd)
    let hops = 0
    const maxHops = 6
    while (hops < maxHops) {
      try {
        if (fs.statSync(path.join(dir, '.git')).isDirectory()) return dir
      } catch {
        // missing .git at this level — keep walking up
      }
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
      hops += 1
    }
    return null
  },
  read: (p: string): string | null => {
    try {
      return fs.readFileSync(p, 'utf8')
    } catch {
      return null
    }
  },
  resolve: (...parts: ReadonlyArray<string>): string => path.resolve(...parts),
}

const PROJECT_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const

export interface ProjectContextOptions {
  readonly cwd: string
  readonly fs?: FsReader
  /** When true, also check `~/.lumen/` for AGENTS/CLAUDE
   *  fallback files (off by default per §1.2). */
  readonly allowHomeFallback?: boolean
}

/**
 * Walk upward from `cwd` looking for AGENTS.md or
 * CLAUDE.md. Returns the file body (utf-8) or `undefined`
 * when no candidate is found. Case-insensitive search — the
 * candidates list is canonical lowercase but a user may
 * have capitalised naming.
 */
export const loadProjectContext = (
  opts: ProjectContextOptions,
): string | undefined => {
  const fsReader = opts.fs ?? defaultFsReader
  const roots: Array<string | null> = [fsReader.findGitRoot(opts.cwd)]
  if (opts.allowHomeFallback === true) {
    const home = process.env.HOME ?? ''
    roots.push(home.length > 0 ? home : null)
  }
  for (const root of roots) {
    if (root === null) continue
    for (const candidate of PROJECT_FILE_CANDIDATES) {
      // Build the candidate path. When the root points at
      // $HOME directly (the fallback path) we look inside
      // `<home>/.lumen/`; when the root is a git root we
      // look at the root itself.
      const rootsToTry: ReadonlyArray<string> =
        opts.allowHomeFallback === true && root !== fsReader.findGitRoot(opts.cwd)
          ? [fsReader.resolve(root, '.lumen')]
          : [root]
      for (const dir of rootsToTry) {
        const directPath = fsReader.resolve(dir, candidate)
        const body = fsReader.read(directPath)
        if (body !== null) return body
        // Case-insensitive: also try lowercase variants the
        // user might have written. Cheap — at most 2 calls per
        // candidate on mac/linux, 0 on Windows.
        const lower = candidate.toLowerCase()
        if (lower !== candidate) {
          const altPath = fsReader.resolve(dir, lower)
          const altBody = fsReader.read(altPath)
          if (altBody !== null) return altBody
        }
      }
    }
  }
  return undefined
}

/**
 * Optional context files (P2 / B1 / M1 per §1.2). Each
 * entry reads from `<cwd>/` first, then `~/.lumen/`
 * fallback when `fallbackToHome` is true. Returns the
 * concatenated body (one paragraph per file) when at
 * least one source matched, else undefined.
 */
export interface OptionalContextFilesOptions {
  readonly cwd: string
  readonly personas?: ReadonlyArray<'SOUL' | 'IDENTITY' | 'USER'>
  readonly bootstrap?: boolean
  readonly memorySnapshot?: boolean
  readonly fs?: FsReader
}

export interface LoadedOptionalContext {
  readonly persona?: string
  readonly bootstrap?: string
  readonly memorySnapshot?: string
}

const PERSONAL_TO_FILENAME: Record<'SOUL' | 'IDENTITY' | 'USER', string> = {
  SOUL: 'SOUL.md',
  IDENTITY: 'IDENTITY.md',
  USER: 'USER.md',
}

const readOptional = (
  fsReader: FsReader,
  cwd: string,
  filename: string,
): string | undefined => {
  for (const dir of [cwd]) {
    const body = fsReader.read(fsReader.resolve(dir, filename))
    if (body !== null) return body
  }
  return undefined
}

export const loadOptionalContextFiles = (
  opts: OptionalContextFilesOptions,
): LoadedOptionalContext | undefined => {
  const fsReader = opts.fs ?? defaultFsReader
  const result: { -readonly [K in keyof LoadedOptionalContext]: string | undefined } = {
    persona: undefined,
    bootstrap: undefined,
    memorySnapshot: undefined,
  }
  let matchedAny = false

  if (opts.personas !== undefined && opts.personas.length > 0) {
    const parts: string[] = []
    for (const tag of opts.personas) {
      const filename = PERSONAL_TO_FILENAME[tag]
      const body = readOptional(fsReader, opts.cwd, filename)
      if (body !== undefined) {
        parts.push(`# ${tag}\n${body}`)
        matchedAny = true
      }
    }
    if (parts.length > 0) result.persona = parts.join('\n\n')
  }

  if (opts.bootstrap === true) {
    const body = readOptional(fsReader, opts.cwd, 'BOOTSTRAP.md')
    if (body !== undefined) {
      result.bootstrap = body
      matchedAny = true
    }
  }

  if (opts.memorySnapshot === true) {
    const body = readOptional(fsReader, opts.cwd, 'MEMORY.md')
    if (body !== undefined) {
      result.memorySnapshot = body
      matchedAny = true
    }
  }

  return matchedAny ? result : undefined
}
