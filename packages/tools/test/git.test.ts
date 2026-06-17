/**
 * Tests for {@link GitTool}.
 *
 * The git tool is **read-mostly** with one writer (`commit`).
 * We test the readers against a real on-disk git repo we
 * build in a tmp dir, and the writer against the same repo.
 *
 * We do NOT test `commit` against a fake: that would let
 * regressions in the `argvFor` path slip through. A real
 * `git commit` is cheap (a few ms) and the test is hermetic
 * because we set `GIT_AUTHOR_*` and `GIT_COMMITTER_*` to
 * fixed values, and we use a per-test worktree.
 */

import { execSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolContext } from '@lumen/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitTool } from '../src/git/git.js'

let workdir: string
let ctx: ToolContext

beforeEach(async () => {
  workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-git-'))
  // `git init` + an initial commit so HEAD exists.
  execSync('git init -q -b main', { cwd: workdir })
  execSync('git config user.email test@example.com', { cwd: workdir })
  execSync('git config user.name "Test User"', { cwd: workdir })
  execSync('git config commit.gpgsign false', { cwd: workdir })
  await fs.writeFile(path.join(workdir, 'README.md'), '# Test\n')
  execSync('git add README.md', { cwd: workdir })
  execSync('git commit -q -m "initial"', { cwd: workdir })
  ctx = { cwd: workdir, signal: new AbortController().signal, sessionId: 'test' }
})

afterEach(async () => {
  await fs.rm(workdir, { recursive: true, force: true })
})

describe('GitTool', () => {
  it('status: returns an empty file list on a clean tree', async () => {
    const tool = new GitTool()
    const out = (await tool.call({ op: 'status' }, ctx)) as {
      op: string
      data: { branch: Record<string, string>; files: unknown[] }
      exitCode: number | null
    }
    expect(out.op).toBe('status')
    expect(out.exitCode).toBe(0)
    expect(out.data.files).toEqual([])
    expect(out.data.branch.head).toBe('main')
  })

  it('status: detects an unstaged modification', async () => {
    await fs.writeFile(path.join(workdir, 'README.md'), '# Changed\n')
    const tool = new GitTool()
    const out = (await tool.call({ op: 'status' }, ctx)) as {
      data: { files: Array<{ kind: string; path: string; xy: string }> }
    }
    expect(out.data.files).toHaveLength(1)
    const f = out.data.files[0]!
    expect(f.kind).toBe('staged')
    expect(f.path).toBe('README.md')
    expect(f.xy[0]).toBe('.') // unstaged but tracked
  })

  it('log: returns commits in reverse-chronological order', async () => {
    const tool = new GitTool()
    const out = (await tool.call({ op: 'log', maxCount: 5 }, ctx)) as {
      data: { commits: Array<{ sha: string; subject: string }> }
    }
    expect(out.data.commits.length).toBeGreaterThanOrEqual(1)
    expect(out.data.commits[0]?.subject).toBe('initial')
    expect(out.data.commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/)
  })

  it('branch: returns the current branch', async () => {
    const tool = new GitTool()
    const out = (await tool.call({ op: 'branch' }, ctx)) as {
      data: { branches: Array<{ name: string; current: boolean }> }
    }
    const main = out.data.branches.find((b) => b.name === 'main')
    expect(main).toBeDefined()
    expect(main?.current).toBe(true)
  })

  it('commit: stages all tracked changes and creates a checkpoint', async () => {
    await fs.writeFile(path.join(workdir, 'README.md'), '# v2\n')
    const tool = new GitTool()
    const out = (await tool.call(
      { op: 'commit', message: 'update readme', stageAll: true },
      ctx,
    )) as { data: { committed: boolean; truncated?: boolean }; exitCode: number | null }
    expect(out.data.committed).toBe(true)
    expect(out.exitCode).toBe(0)
    // Verify on disk: HEAD should now be a new commit.
    const head = execSync('git log -1 --pretty=%s', { cwd: workdir, encoding: 'utf8' }).trim()
    expect(head).toBe('update readme')
  })

  it('refuses to commit without a message', async () => {
    const tool = new GitTool()
    // The Zod refine rejects this before we even spawn git.
    await expect(tool.call({ op: 'commit' }, ctx)).rejects.toThrow()
  })

  it('exposes `approval-required` risk classification', () => {
    const tool = new GitTool()
    expect(tool.risk).toBe('approval-required')
  })
})
