/**
 * Tests for the `gh` GitHub CLI tool.
 *
 * Strategy: mock `node:child_process.spawn` at the module level
 * so the GhTool's dynamic `await import('node:child_process')`
 * inside `execute()` returns our fake child process.
 */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { GhTool } from '../src/github/gh.js'
import type { ToolContext } from '@lumen/core'
import { EventEmitter } from 'node:events'

const ctx: ToolContext = {
  cwd: '/tmp',
  signal: new AbortController().signal,
  sessionId: 'test',
  log: undefined,
}

const fakeChild = (stdout: string, exitCode = 0, stderr = '') => {
  const child = new EventEmitter()
  const stdoutEE = new EventEmitter()
  const stderrEE = new EventEmitter()
  const stdin = { write: vi.fn(), end: vi.fn() }
  const kill = vi.fn()
  setTimeout(() => {
    if (stdout) stdoutEE.emit('data', Buffer.from(stdout))
    if (stderr) stderrEE.emit('data', Buffer.from(stderr))
    child.emit('exit', exitCode)
  }, 1)
  return Object.assign(child, { stdout: stdoutEE, stderr: stderrEE, stdin, kill })
}

let currentChild: ReturnType<typeof fakeChild> | undefined

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => currentChild ?? fakeChild('')),
}))

describe('GhTool', () => {
  afterEach(() => {
    vi.clearAllMocks()
    currentChild = undefined
  })

  it('has the expected descriptor', () => {
    const d = new GhTool().describe()
    expect(d.name).toBe('gh')
    expect(d.risk).toBe('approval-required')
    expect(d.description.length).toBeGreaterThan(10)
  })

  it('pr_list spawns gh with --json and parses the output', async () => {
    currentChild = fakeChild(JSON.stringify([{ number: 1, title: 'fix', state: 'open' }]))
    const tool = new GhTool()
    const output = await tool.call({ op: 'pr_list', limit: 5 }, ctx) as { data: { result: unknown[] } }
    expect(output.data.result).toEqual([{ number: 1, title: 'fix', state: 'open' }])
  })

  it('pr_create extracts the URL from stdout', async () => {
    currentChild = fakeChild('https://github.com/org/repo/pull/42\n')
    const tool = new GhTool()
    const output = await tool.call(
      { op: 'pr_create', title: 'feat', body: 'desc' },
      ctx,
    ) as { data: { url: string } }
    expect(output.data.url).toBe('https://github.com/org/repo/pull/42')
  })

  it('pr_view spawns gh with --json', async () => {
    currentChild = fakeChild(JSON.stringify({ number: 3, title: 'view me' }))
    const tool = new GhTool()
    const output = await tool.call({ op: 'pr_view', number: 3 }, ctx) as { data: { result: { title: string } } }
    expect(output.data.result.title).toBe('view me')
  })

  it('issue_create extracts the URL from stdout', async () => {
    currentChild = fakeChild('https://github.com/org/repo/issues/7\n')
    const tool = new GhTool()
    const output = await tool.call(
      { op: 'issue_create', title: 'bug' },
      ctx,
    ) as { data: { url: string } }
    expect(output.data.url).toBe('https://github.com/org/repo/issues/7')
  })

  it('issue_list spawns gh with --json', async () => {
    currentChild = fakeChild(JSON.stringify([{ number: 5, title: 'bug', state: 'open' }]))
    const tool = new GhTool()
    const output = await tool.call({ op: 'issue_list' }, ctx) as { data: { result: unknown[] } }
    expect(output.data.result).toEqual([{ number: 5, title: 'bug', state: 'open' }])
  })

  it('pr_status spawns gh with --json', async () => {
    currentChild = fakeChild(JSON.stringify({ currentBranch: 'main' }))
    const tool = new GhTool()
    const output = await tool.call({ op: 'pr_status' }, ctx) as { data: { result: { currentBranch: string } } }
    expect(output.data.result.currentBranch).toBe('main')
  })

  it('reports spawn failure as exitCode 127', async () => {
    const child = new EventEmitter()
    const stdoutEE = new EventEmitter()
    const stderrEE = new EventEmitter()
    const stdin = { write: vi.fn(), end: vi.fn() }
    const kill = vi.fn()
    // Only emit 'error', never 'exit', so the GhTool's error handler wins.
    setTimeout(() => child.emit('error', new Error('ENOENT')), 1)
    currentChild = Object.assign(child, { stdout: stdoutEE, stderr: stderrEE, stdin, kill })
    const tool = new GhTool()
    const output = await tool.call({ op: 'pr_list' }, ctx) as { exitCode: number }
    expect(output.exitCode).toBe(127)
  })
})
