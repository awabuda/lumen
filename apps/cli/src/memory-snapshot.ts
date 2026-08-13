/**
 * P62 — `loadMemorySnapshot()` at the composition root.
 *
 * Reads `~/.lumen/MEMORY.md` + `USER.md` from disk, runs the
 * 4-pattern threat scan on each entry, and returns a frozen
 * `MemorySnapshot` object the memory-inject middleware closes
 * over (see `packages/core/src/agent/middleware/memory-inject.ts`).
 *
 * Why this lives in `apps/cli` (not `@lumen/memory` or
 * `@lumen/core`):
 *   - `apps/cli` is the **composition root** (per
 *     `apps/cli/src/composition.ts` line 8-17: "ONE place that
 *     knows about concrete implementations"). fs reads live at
 *     the composition root; `@lumen/memory` and `@lumen/core`
 *     stay storage-agnostic / pure.
 *   - `markdown-bridge.ts` (P34.1) sets the precedent: "apps/cli
 *     owns the bridge lifecycle ... has no `node:fs` imports"
 *     (`packages/memory/src/markdown-bridge.ts:8-9`).
 *
 * Threat pattern scan (Hermes parity, minimal set):
 *   - `system_override`  — "ignore previous instructions", "you are now…"
 *   - `prompt_leak`      — "reveal your system prompt", "show your prompt"
 *   - `tool_inject`      — `curl … | sh`, `wget … | bash`
 *   - `secret_exfil`     — `cat ~/.ssh/id_rsa`, `printenv | curl`
 *
 * A hit replaces the entry in the snapshot with
 * `[BLOCKED: <file> entry contained pattern: <id>]` (Hermes
 * `MemoryStore._sanitize_entries_for_snapshot` parity,
 * `tools/memory_tool.py:185-244`). The original entry stays
 * in the markdown file unchanged so the user can see + remove
 * poisoned entries via their editor — silently dropping them
 * would hide the attack from the user.
 *
 * The scan is deterministic from disk bytes (no LLM, no
 * randomness), so the snapshot is stable for the entire
 * session. The byte-stable invariant feeds the prefix cache
 * (P31.1 + Hermes comment line 195-197 "stable for the entire
 * session (prefix-cache invariant holds)").
 *
 * Full pattern library is deferred to P65; this module ships
 * the minimal 4-pattern set P62 needs to be useful.
 */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import type { MemorySnapshot } from '@lumen/core'

const LUMEN_HOME = process.env['LUMEN_HOME'] ?? path.join(os.homedir(), '.lumen')
export const DEFAULT_MEMORY_MD_PATH = path.join(LUMEN_HOME, 'MEMORY.md')
export const DEFAULT_USER_MD_PATH = path.join(LUMEN_HOME, 'USER.md')

/**
 * The 4-pattern minimal set. Each pattern is a `RegExp` source
 * string (compiled once at module load) and a stable id used
 * in the `[BLOCKED:]` placeholder so the user can grep their
 * own markdown for what got blocked.
 */
export const MEMORY_THREAT_PATTERNS: ReadonlyArray<{
  readonly id: string
  readonly description: string
  readonly pattern: RegExp
}> = [
  {
    id: 'system_override',
    description: 'attempt to override system prompt instructions',
    pattern:
      /\b(ignore|disregard|forget)\b[^\n]{0,40}\b(previous|prior|all|above|earlier)\b[^\n]{0,40}\b(instruction|prompt|rule|directive)s?\b/i,
  },
  {
    id: 'prompt_leak',
    description: 'attempt to exfiltrate the system prompt',
    pattern:
      /\b(reveal|show|print|dump|leak|output)\b[^\n]{0,40}\b(your|the)\b[^\n]{0,20}\b(system\s+prompt|hidden\s+prompt|internal\s+instructions?)\b/i,
  },
  {
    id: 'tool_inject',
    description: 'attempt to inject a shell command via curl/wget pipe',
    pattern: /\b(curl|wget|fetch)\b[^\n|]{0,200}\|\s*(sh|bash|zsh|sudo)\b/i,
  },
  {
    id: 'secret_exfil',
    description: 'attempt to exfiltrate local secrets',
    pattern:
      /\b(cat|less|more|head|tail|printenv|env)\b[^\n]{0,40}(\.ssh\/id_[a-z]+|\.aws\/credentials|\.netrc|\.npmrc|\.env\b)/i,
  },
] as const

/**
 * Scan a single line / entry. Returns the entry unchanged, or
 * a `[BLOCKED: ...]` placeholder if any pattern matches.
 *
 * The placeholder includes the file label so the user can
 * grep `[BLOCKED: USER.md …]` to see what the scan caught.
 */
const scanEntry = (
  entry: string,
  fileLabel: 'MEMORY.md' | 'USER.md',
): string => {
  if (entry.length === 0) return entry
  const trimmed = entry.trim()
  if (trimmed.length === 0) return entry
  for (const { id, pattern } of MEMORY_THREAT_PATTERNS) {
    if (pattern.test(trimmed)) {
      return `[BLOCKED: ${fileLabel} entry contained pattern: ${id}. Removed from system prompt; original kept in ${fileLabel} for inspection.]`
    }
  }
  return entry
}

/**
 * Scan a full markdown body. Splits on the first newline so
 * headers are preserved (the threat scan targets **entries**,
 * not `#` headings). Each non-header line is scanned
 * independently. Empty lines pass through.
 */
const scanBody = (
  body: string,
  fileLabel: 'MEMORY.md' | 'USER.md',
): string => {
  if (body.length === 0) return body
  const lines = body.split('\n')
  const out: string[] = []
  for (const line of lines) {
    if (line.startsWith('#')) {
      out.push(line)
      continue
    }
    out.push(scanEntry(line, fileLabel))
  }
  return out.join('\n')
}

/**
 * Read a markdown file. Returns the raw body if the file
 * exists, empty string if absent. The empty-string sentinel
 * is what the middleware uses to decide whether to emit a
 * block at all (see `formatSnapshot` in memory-inject.ts).
 */
const readOptionalFile = async (filePath: string): Promise<string> => {
  try {
    return await fs.readFile(filePath, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return ''
    // For other errors (permission, EISDIR) we surface the
    // empty sentinel too — the snapshot is best-effort and
    // a corrupt read should not break the agent loop. The
    // user can see + fix the file via their editor.
    return ''
  }
}

/**
 * Load the frozen MEMORY.md + USER.md snapshot for the current
 * session. Pure read; no writes. Idempotent — calling twice
 * with the same disk bytes returns the same snapshot.
 */
export const loadMemorySnapshot = async (
  options: { memoryPath?: string; userPath?: string } = {},
): Promise<MemorySnapshot> => {
  const memoryPath = options.memoryPath ?? DEFAULT_MEMORY_MD_PATH
  const userPath = options.userPath ?? DEFAULT_USER_MD_PATH
  const [rawMemory, rawUser] = await Promise.all([
    readOptionalFile(memoryPath),
    readOptionalFile(userPath),
  ])
  return {
    memory: scanBody(rawMemory, 'MEMORY.md'),
    user: scanBody(rawUser, 'USER.md'),
  }
}