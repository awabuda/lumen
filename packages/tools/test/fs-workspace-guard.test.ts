/**
 * P33.B Day2 — workspace-guard invariants.
 *
 * Mirrors `docs/OPTIMIZATION-PLAN.md` §2 D2 acceptance
 * criteria. The tests pin the boundary check + the
 * traversal-detection contract that FS tools depend on.
 */

import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError } from '@lumen/core'
import { isInsideRoot, resolveSafePath } from '../src/fs/workspace-guard.js'

const ROOT = path.resolve('/repo')

describe('isInsideRoot (P33.B Day2)', () => {
  it('returns true for the root itself', () => {
    expect(isInsideRoot(ROOT, ROOT)).toBe(true)
  })

  it('returns true for a strict descendant', () => {
    expect(isInsideRoot(path.join(ROOT, 'src'), ROOT)).toBe(true)
  })

  it('returns false for a path outside the root', () => {
    expect(isInsideRoot('/etc/passwd', ROOT)).toBe(false)
  })

  it('returns false for a path-traversal that shares a string prefix (no separator boundary)', () => {
    // /repo-evil shares the `/repo` prefix with /repo.
    // The boundary check must catch this.
    expect(isInsideRoot(path.resolve('/repo-evil'), ROOT)).toBe(false)
    expect(isInsideRoot(`${ROOT}evil`, ROOT)).toBe(false)
  })

  it('handles root paths without trailing separator', () => {
    expect(isInsideRoot(ROOT, ROOT)).toBe(true)
  })
})

describe('resolveSafePath (P33.B Day2)', () => {
  it('resolves a relative path against cwd and accepts it when inside the root', async () => {
    const out = await resolveSafePath('src/foo.ts', '/repo', ROOT)
    expect(out).toBe(path.join(ROOT, 'src/foo.ts'))
  })

  it('accepts an absolute path inside the root', async () => {
    const abs = path.join(ROOT, 'README.md')
    const out = await resolveSafePath(abs, '/anywhere', ROOT)
    expect(out).toBe(abs)
  })

  it('rejects `..` traversal with a typed ConfigError', async () => {
    await expect(
      resolveSafePath('../../etc/passwd', '/repo/sub', ROOT),
    ).rejects.toThrow(ConfigError)
  })

  it('rejects absolute paths outside the root', async () => {
    await expect(
      resolveSafePath('/etc/passwd', '/repo', ROOT),
    ).rejects.toThrow(ConfigError)
  })

  it('rejects paths whose resolved form shares a string prefix without separator boundary', async () => {
    // Symlink-style attack: /repo-evil/file.txt is
    // outside /repo even though /repo-evil starts with
    // /repo.
    await expect(
      resolveSafePath('/repo-evil/file.txt', '/repo', ROOT),
    ).rejects.toThrow(ConfigError)
  })

  it('error message names the path and the root so operators can act', async () => {
    let captured: unknown
    try {
      await resolveSafePath('../../etc/passwd', '/repo', ROOT)
    } catch (err) {
      captured = err
    }
    expect(captured).toBeInstanceOf(ConfigError)
    const e = captured as ConfigError
    expect(e.message).toContain('Workspace-guard')
    expect(e.message).toContain('/repo')
  })

  it('error field is `path` so the tool error handler can attribute the failure', async () => {
    try {
      await resolveSafePath('/etc/passwd', '/repo', ROOT)
      expect.fail('should have thrown')
    } catch (err) {
      const e = err as ConfigError & { field?: string }
      expect(e.field).toBe('path')
    }
  })

  it('default mode (resolveSymlinks off) is a string-only check; does not touch the filesystem', async () => {
    // Pass a non-existent file path inside the root; the
    // string-only check accepts it (the file may not
    // exist yet for write / patch).
    const out = await resolveSafePath(
      'never-created.ts',
      '/repo',
      ROOT,
    )
    expect(out).toBe(path.join(ROOT, 'never-created.ts'))
  })


describe('P33.B Day2 — ReadFileTool enforces the guard at the tool layer', () => {
  it('throws ConfigError when the resolved path escapes ctx.workspaceRoot', async () => {
    // Use the system ReadFileTool — confirm the tool layer
    // calls `resolveSafePath` rather than the bare
    // `path.resolve` it had pre-Day2.
    const { ReadFileTool } = await import('../src/fs/read-file.js')
    const tool = new ReadFileTool()
    let captured: unknown
    try {
      await tool.call(
        { path: '/etc/passwd' },
        {
          cwd: '/repo',
          workspaceRoot: '/repo',
          signal: new AbortController().signal,
          sessionId: 'test',
        },
      )
    } catch (err) {
      captured = err
    }
    // The tool wraps any inner error in a typed ToolError;
    // we sniff the wrapped message to confirm the path-guard
    // fired.
    const message = (captured as { message?: string })?.message ?? ''
    expect(message).toMatch(/Workspace-guard|workspaceRoot/)
  })
})
})
