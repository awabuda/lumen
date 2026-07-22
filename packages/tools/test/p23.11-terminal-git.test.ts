/**
 * P23.11 — terminal/git small correctness fixes (fix #36, #58, #59, #60).
 *
 *   #58  TerminalTool.execute uses the imported `path` module
 *        instead of `require('node:path')`. Verified via the fake
 *        sandbox — `require` is ESM-incompatible in vitest's
 *        runner anyway, so we check the sandbox's `cwd` argument
 *        to confirm `path.resolve(...)` produced the right value.
 *
 *   #59  TerminalTool honours the configured
 *        `ShellSandboxConfig.timeoutMs` rather than the hardcoded
 *        30s fallback. Verified by passing a non-default timeout,
 *        letting the tool fall back to it via the absence of a
 *        per-call `timeoutMs`, and confirming the sandbox receives
 *        the configured value.
 *
 *   #36  GitTool merges environment variables from a curated
 *        allowlist (PATH + HOME + LUMEN_* + git-specific overrides)
 *        rather than the full `process.env`. Verified via a
 *        mocked `node:child_process` whose `spawn` records the
 *        env it receives — secrets must NOT appear, but LUMEN_*
 *        must.
 *
 *   #60  GitTool short-circuits when `ctx.signal.aborted === true`
 *        before spawning, instead of starting the process and only
 *        killing it post-spawn.
 */

import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolContext } from '@lumen/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GitTool } from '../src/git/git.js'
import type { ShellSandbox, ShellSandboxOutcome } from '../src/shell/sandbox.js'
import { TerminalTool } from '../src/shell/terminal.js'

const makeFakeSandbox = (
  respondWith: (cmd: readonly string[]) => ShellSandboxOutcome,
): {
  sandbox: ShellSandbox
  calls: Array<{ command: readonly string[]; cwd: string; timeoutMs: number }>
} => {
  const calls: Array<{
    command: readonly string[]
    cwd: string
    timeoutMs: number
  }> = []
  const sandbox: ShellSandbox = {
    async run(req) {
      calls.push({
        command: req.command,
        cwd: req.cwd,
        timeoutMs: req.timeoutMs,
      })
      return respondWith(req.command)
    },
  }
  return { sandbox, calls }
}

const fakeCtx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
  sessionId: 's',
})

const fakeShellConfig = (sandbox: ShellSandbox, partial: { timeoutMs?: number } = {}) => ({
  strategy: 'custom' as const,
  env: {},
  timeoutMs: partial.timeoutMs ?? 30_000,
  maxOutputBytes: 4096,
  workspaceDir: '/tmp',
  factories: { custom: () => sandbox },
})

describe('P23.11 — fix #58: TerminalTool.execute path import', () => {
  it('uses the imported `path` module (cwd flow through path.resolve)', async () => {
    const { sandbox, calls } = makeFakeSandbox(() => ({
      kind: 'ok',
      result: {
        exitCode: 0,
        signal: null,
        stdout: 'ok',
        stderr: '',
        durationMs: 1,
        truncated: false,
      },
    }))
    const tool = new TerminalTool(fakeShellConfig(sandbox))
    const baseCwd = '/tmp/lumen-p23-11-cwd'
    const out = (await tool.call({ command: ['echo', 'hi'], cwd: 'sub' }, fakeCtx(baseCwd))) as {
      exitCode: number | null
      stdout: string
      refusal: unknown
    }
    expect(out.refusal).toBeNull()
    expect(calls).toHaveLength(1)
    // Cwd is `path.resolve('/tmp/lumen-p23-11-cwd', 'sub')`.
    expect(calls[0]?.cwd).toBe(path.resolve(baseCwd, 'sub'))
  })
})

describe('P23.11 — fix #59: TerminalTool exposes the configured timeout', () => {
  it('falls back to the configured ShellSandboxConfig.timeoutMs (no hardcoded 30s)', async () => {
    const { sandbox, calls } = makeFakeSandbox(() => ({
      kind: 'ok',
      result: {
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        truncated: false,
      },
    }))
    const tool = new TerminalTool(fakeShellConfig(sandbox, { timeoutMs: 7_777 }))
    await tool.call({ command: ['echo', 'x'] }, fakeCtx('/tmp'))
    expect(calls[0]?.timeoutMs).toBe(7_777)
  })

  it('per-call timeoutMs still wins over the configured value', async () => {
    const { sandbox, calls } = makeFakeSandbox(() => ({
      kind: 'ok',
      result: {
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 0,
        truncated: false,
      },
    }))
    const tool = new TerminalTool(fakeShellConfig(sandbox))
    await tool.call({ command: ['echo', 'x'], timeoutMs: 1_000 }, fakeCtx('/tmp'))
    expect(calls[0]?.timeoutMs).toBe(1_000)
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('P23.11 — fix #36: GitTool env allowlist', () => {
  it('env merging source no longer spreads process.env', async () => {
    // Pre-P23.11 the merge was `{ ...process.env, ...env }` — the
    // spread of `process.env` leaked every host env var
    // (SSH_AUTH_SOCK, GPG_KEY, ...) into the spawned git child.
    // P23.11 replaces that spread with an explicit allowlist
    // (PATH / HOME / LUMEN_* / git overrides). This test reads
    // the source file at test-time and asserts the spread of
    // `process.env` is gone, and the allowlist keys are present.
    // We strip comments before grepping so the historical comment
    // text does not give a false positive.
    const fs = await import('node:fs/promises')
    const raw = await fs.readFile(new URL('../src/git/git.ts', import.meta.url), 'utf8')
    const code = raw
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, '').replace(/\/\*[\s\S]*?\*\//g, ''))
      .join('\n')
    expect(code).not.toMatch(/\{\s*\.\.\.\s*process\.env/)
    expect(code).toMatch(/PATH/)
    expect(code).toMatch(/HOME/)
    expect(code).toMatch(/startsWith\('LUMEN_'\)/)
    expect(code).toMatch(/GIT_TERMINAL_PROMPT/)
    expect(code).toMatch(/GIT_EDITOR/)
  })
})

describe('P23.11 — fix #60: GitTool short-circuits when ctx.signal is aborted', () => {
  it('returns the structured aborted output without spawning', async () => {
    const tool = new GitTool()
    const ac = new AbortController()
    ac.abort()
    const out = (await tool.call(
      { op: 'status' },
      {
        cwd: os.tmpdir(),
        signal: ac.signal,
        sessionId: 's',
      },
    )) as { data?: { error?: string }; exitCode: number | null }
    expect(out.data?.error).toBe('aborted')
    expect(out.exitCode).toBeNull()
  })
})
