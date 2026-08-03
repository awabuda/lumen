/**
 * P31.3 — Project + optional context-file loaders invariant
 * tests. Pure functions; tests drive them through a fake
 * {@link FsReader} so they never touch the real filesystem.
 */

import { describe, expect, it } from 'vitest'
import {
  type FsReader,
  loadOptionalContextFiles,
  loadProjectContext,
} from '../src/agent/system-prompt-loaders.js'

const memoFs = (map: Map<string, string | null>, gitRoot: string | null): FsReader => ({
  findGitRoot: () => gitRoot,
  read: (p: string) => map.get(p) ?? null,
  resolve: (...parts: ReadonlyArray<string>) => parts.join('/'),
})

describe('loadProjectContext (P31.3)', () => {
  it('returns undefined when cwd has no AGENTS/CLAUDE', () => {
    const fs = memoFs(new Map(), null)
    expect(loadProjectContext({ cwd: '/repo', fs })).toBeUndefined()
  })

  it('reads AGENTS.md from the git root when one exists', () => {
    const map = new Map<string, string | null>()
    map.set('/repo/AGENTS.md', 'AGENTS body.')
    const fs = memoFs(map, '/repo')
    expect(loadProjectContext({ cwd: '/repo', fs })).toBe('AGENTS body.')
  })

  it('falls back to CLAUDE.md when AGENTS.md is absent at the git root', () => {
    const map = new Map<string, string | null>()
    map.set('/repo/CLAUDE.md', 'CLAUDE body.')
    const fs = memoFs(map, '/repo')
    expect(loadProjectContext({ cwd: '/repo', fs })).toBe('CLAUDE body.')
  })

  it('prefers AGENTS.md when both AGENTS.md and CLAUDE.md exist', () => {
    const map = new Map<string, string | null>()
    map.set('/repo/AGENTS.md', 'AGENTS wins')
    map.set('/repo/CLAUDE.md', 'CLAUDE loses')
    const fs = memoFs(map, '/repo')
    expect(loadProjectContext({ cwd: '/repo', fs })).toBe('AGENTS wins')
  })

  it('returns undefined when the git root has no AGENTS/CLAUDE (off by default)', () => {
    const map = new Map<string, string | null>()
    // Project file at the cwd, but findGitRoot returns null →
    // loader has nothing to read.
    map.set('/repo/CLAUDE.md', 'CLAUDE body.')
    const fs = memoFs(map, null)
    expect(loadProjectContext({ cwd: '/repo', fs })).toBeUndefined()
  })

  it('opts in to ~/.lumen/ fallback when allowHomeFallback is true', () => {
    const map = new Map<string, string | null>()
    map.set('/home/user/.lumen/AGENTS.md', 'HOME AGENTS')
    const fs = memoFs(map, null)
    const prevHome = process.env.HOME
    process.env.HOME = '/home/user'
    try {
      const out = loadProjectContext({
        cwd: '/repo',
        fs,
        allowHomeFallback: true,
      })
      expect(out).toBe('HOME AGENTS')
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
    }
  })

  it('case-insensitive: lowercase agents.md matches when AGENTS.md is absent', () => {
    const map = new Map<string, string | null>()
    map.set('/repo/agents.md', 'lowercase body')
    const fs = memoFs(map, '/repo')
    expect(loadProjectContext({ cwd: '/repo', fs })).toBe('lowercase body')
  })
})

describe('loadOptionalContextFiles (P31.3)', () => {
  it('returns undefined when nothing is requested or present', () => {
    const fs = memoFs(new Map(), null)
    expect(loadOptionalContextFiles({ cwd: '/repo', fs })).toBeUndefined()
  })

  it('reads SOUL/IDENTITY/USER in the order requested (P2)', () => {
    const map = new Map<string, string | null>()
    map.set('/repo/IDENTITY.md', 'IDENTITY body')
    map.set('/repo/SOUL.md', 'SOUL body')
    const fs = memoFs(map, null)
    const out = loadOptionalContextFiles({
      cwd: '/repo',
      fs,
      personas: ['SOUL', 'IDENTITY'],
    })
    expect(out?.persona).toContain('# SOUL')
    expect(out?.persona).toContain('SOUL body')
    expect(out?.persona).toContain('# IDENTITY')
    expect(out?.persona).toContain('IDENTITY body')
    // USER was not requested and not present — must not appear.
    expect(out?.persona).not.toContain('USER')
  })

  it('skips a persona file that does not exist (no error, no leading text)', () => {
    const map = new Map<string, string | null>()
    map.set('/repo/SOUL.md', 'SOUL body only')
    const fs = memoFs(map, null)
    const out = loadOptionalContextFiles({
      cwd: '/repo',
      fs,
      personas: ['SOUL', 'IDENTITY'],
    })
    expect(out?.persona).toContain('SOUL body only')
    expect(out?.persona).not.toContain('IDENTITY')
  })

  it('reads BOOTSTRAP.md when bootstrap is true (B1)', () => {
    const map = new Map<string, string | null>()
    map.set('/repo/BOOTSTRAP.md', 'Bootstrap body')
    const fs = memoFs(map, null)
    const out = loadOptionalContextFiles({
      cwd: '/repo',
      fs,
      bootstrap: true,
    })
    expect(out?.bootstrap).toBe('Bootstrap body')
  })

  it('reads MEMORY.md when memorySnapshot is true (M1)', () => {
    const map = new Map<string, string | null>()
    map.set('/repo/MEMORY.md', 'Long-term memory snapshot.')
    const fs = memoFs(map, null)
    const out = loadOptionalContextFiles({
      cwd: '/repo',
      fs,
      memorySnapshot: true,
    })
    expect(out?.memorySnapshot).toBe('Long-term memory snapshot.')
  })

  it('skips a layer that has no file present (returns result with the others populated)', () => {
    const map = new Map<string, string | null>()
    map.set('/repo/BOOTSTRAP.md', 'Bootstrap only')
    const fs = memoFs(map, null)
    const out = loadOptionalContextFiles({
      cwd: '/repo',
      fs,
      personas: ['SOUL'],
      bootstrap: true,
      memorySnapshot: true,
    })
    expect(out?.bootstrap).toBe('Bootstrap only')
    expect(out?.persona).toBeUndefined()
    expect(out?.memorySnapshot).toBeUndefined()
  })
})
