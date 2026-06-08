/**
 * `search_files` — regex content search across a directory tree.
 *
 * Strategy:
 *   1. Try to invoke `rg --json` (ripgrep). If the binary is on PATH
 *      and the call succeeds, parse its JSON-line output.
 *   2. Otherwise, fall back to a pure-Node recursive walk that
 *      applies the same regex to each line of each matching file.
 *
 * The fallback is not a full replacement for ripgrep (no `.gitignore`
 * awareness, no binary-file skip beyond extension, no parallelism
 * tuning) but it produces identical results for the shapes this tool
 * documents and is correct for the common case.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { BaseTool, type ToolContext, type ToolDescriptor } from '@lumen/core'

/** Zod schema for the tool's input. */
export const SearchFilesInputSchema = z.object({
  /** Regular expression source (ECMAScript syntax). */
  pattern: z.string().min(1),
  /** Directory to search in, resolved against `ctx.cwd` if relative. */
  path: z.string().min(1),
  /** Glob to filter files. Defaults to `*` (match every file). */
  glob: z.string().optional(),
  /** Cap on the number of matches returned. Defaults to 100. */
  maxResults: z.number().int().min(1).optional(),
})
export type SearchFilesInput = z.infer<typeof SearchFilesInputSchema>

/** One match in a search result. */
export interface SearchMatch {
  /** Absolute path of the file containing the match. */
  file: string
  /** 1-indexed line number of the match. */
  line: number
  /** The matched line, with trailing newline stripped. */
  content: string
}

/** Zod schema for the tool's output. */
export const SearchFilesOutputSchema = z.object({
  matches: z.array(
    z.object({
      file: z.string(),
      line: z.number().int().min(1),
      content: z.string(),
    }),
  ),
})
export type SearchFilesOutput = z.infer<typeof SearchFilesOutputSchema>

/** Default cap if `maxResults` is not provided. */
const DEFAULT_MAX_RESULTS = 100

/** Tool: regex content search across a directory tree. */
export class SearchFilesTool extends BaseTool {
  public readonly name = 'search_files'
  public readonly description =
    'Search file contents using a regular expression. Uses ripgrep (rg --json) if available, ' +
    'falls back to a built-in recursive walk otherwise. Glob filter limits which files are searched. ' +
    'Returns up to maxResults matches (default 100) with file, line number, and line content.'
  public readonly inputSchema: z.ZodType<unknown> = SearchFilesInputSchema
  public readonly risk = 'safe' as const
  public override readonly version = '0.1.0'

  protected async execute(input: unknown, ctx: ToolContext): Promise<SearchFilesOutput> {
    const { pattern, path: userPath, glob, maxResults } = input as SearchFilesInput
    const absPath = path.resolve(ctx.cwd, userPath)
    const cap = maxResults ?? DEFAULT_MAX_RESULTS
    const fileGlob = glob ?? '*'

    // Validate the regex up front so a bad pattern produces a clear
    // error before we spawn a subprocess.
    try {
      new RegExp(pattern, 'g')
    } catch (err) {
      throw new Error(`search_files: invalid regex pattern: ${(err as Error).message}`)
    }

    const rgMatches = await tryRipgrep(absPath, fileGlob, pattern, cap, ctx.signal)
    if (rgMatches !== null) {
      return { matches: rgMatches }
    }
    const fallback = await nodeWalk(absPath, fileGlob, pattern, cap, ctx.signal)
    return { matches: fallback }
  }

  public override describe(): ToolDescriptor {
    return { ...super.describe(), version: this.version }
  }
}

// -----------------------------------------------------------------------------
// ripgrep backend
// -----------------------------------------------------------------------------

/**
 * Try to run ripgrep and return its matches. Returns null if ripgrep is
 * not available (binary not found, non-zero exit before matches), so
 * the caller can fall back to the pure-Node implementation.
 */
async function tryRipgrep(
  root: string,
  glob: string,
  pattern: string,
  cap: number,
  signal: AbortSignal,
): Promise<SearchMatch[] | null> {
  return new Promise<SearchMatch[] | null>((resolve) => {
    let resolved = false
    const finish = (v: SearchMatch[] | null): void => {
      if (resolved) return
      resolved = true
      resolve(v)
    }
    let proc: ChildProcess
    try {
      proc = spawn('rg', ['--json', '--no-heading', '-g', glob, pattern, root], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      finish(null)
      return
    }
    if (proc.stdout === null || proc.stderr === null) {
      finish(null)
      return
    }
    let buf = ''
    const matches: SearchMatch[] = []
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      if (matches.length >= cap) return
      buf += chunk
      let nl = buf.indexOf('\n')
      while (nl !== -1) {
        const line = buf.slice(0, nl)
        buf = buf.slice(nl + 1)
        const ok = parseRgLine(line, cap, matches)
        if (!ok) {
          finish(null)
          return
        }
        if (matches.length >= cap) break
        nl = buf.indexOf('\n')
      }
    })
    proc.stderr.on('data', () => {
      // rg writes benign progress to stderr; ignore.
    })
    proc.on('error', () => finish(null))
    proc.on('close', (code: number | null) => {
      // rg exit codes: 0 = matches, 1 = no matches, 2 = error.
      if (code === 0 || code === 1) {
        finish(matches)
      } else {
        finish(null)
      }
    })
    if (signal.aborted) {
      proc.kill()
      finish([])
    }
  })
}

/**
 * Parse a single line of `rg --json` output. Returns true on success
 * (whether or not a match was appended), false on parse error.
 */
function parseRgLine(line: string, cap: number, out: SearchMatch[]): boolean {
  if (line.length === 0) return true
  let obj: unknown
  try {
    obj = JSON.parse(line)
  } catch {
    return false
  }
  if (typeof obj !== 'object' || obj === null) return false
  const t = (obj as { type?: unknown }).type
  if (t !== 'match') return true
  const data = (obj as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return false
  const d = data as {
    path?: { text?: unknown }
    lines?: { text?: unknown }
    line_number?: unknown
  }
  if (typeof d.path?.text !== 'string') return false
  if (typeof d.lines?.text !== 'string') return false
  if (typeof d.line_number !== 'number') return false
  out.push({
    file: d.path.text,
    line: d.line_number,
    content: d.lines.text.replace(/\r?\n$/, ''),
  })
  if (out.length >= cap) return true
  return true
}

// -----------------------------------------------------------------------------
// Pure-Node fallback
// -----------------------------------------------------------------------------

/**
 * Recursive walk that applies the regex to each line of every file
 * matching `glob`. Cap-aware — stops descending once `cap` matches
 * have been collected.
 */
async function nodeWalk(
  root: string,
  glob: string,
  pattern: string,
  cap: number,
  signal: AbortSignal,
): Promise<SearchMatch[]> {
  const matches: SearchMatch[] = []
  const matcher = makeGlobMatcher(glob)
  await walkDir(root, root, matcher, pattern, cap, matches, signal)
  return matches
}

async function walkDir(
  root: string,
  current: string,
  matcher: (name: string) => boolean,
  pattern: string,
  cap: number,
  out: SearchMatch[],
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new Error('aborted')
  if (out.length >= cap) return
  const stat = await fs.lstat(current)
  if (stat.isFile()) {
    if (matcher(path.basename(current))) {
      await scanFile(current, pattern, cap, out, signal)
    }
    return
  }
  if (!stat.isDirectory()) return
  const dirents = await fs.readdir(current, { withFileTypes: true })
  for (const d of dirents) {
    if (out.length >= cap) return
    if (signal.aborted) throw new Error('aborted')
    const child = path.join(current, d.name)
    if (d.isDirectory()) {
      await walkDir(root, child, matcher, pattern, cap, out, signal)
    } else if (d.isFile()) {
      if (!matcher(d.name)) continue
      await scanFile(child, pattern, cap, out, signal)
    }
  }
}

async function scanFile(
  absPath: string,
  pattern: string,
  cap: number,
  out: SearchMatch[],
  signal: AbortSignal,
): Promise<void> {
  let content: string
  try {
    content = await fs.readFile(absPath, 'utf8')
  } catch {
    return // skip unreadable files
  }
  if (signal.aborted) throw new Error('aborted')
  // Use a fresh, non-global RegExp per line so we don't carry state
  // across splits; .test() on a non-global regex is allocation-free.
  const r = new RegExp(pattern)
  const lines = content.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (out.length >= cap) return
    const line = lines[i] as string
    if (r.test(line)) {
      out.push({ file: absPath, line: i + 1, content: line })
    }
  }
}

/**
 * Build a function that tests file names against a single-segment glob
 * (no path separators). Supports `*` and `?` only; this is enough for
 * the common case `*.ts`, `*.json`, etc.
 */
function makeGlobMatcher(glob: string): (name: string) => boolean {
  if (glob === '*') return () => true
  // Escape regex metacharacters except * and ?, then convert those.
  const re = new RegExp(
    '^' +
      glob
        .split('')
        .map((c) => {
          if (c === '*') return '.*'
          if (c === '?') return '.'
          return c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        })
        .join('') +
      '$',
  )
  return (name: string) => re.test(name)
}
