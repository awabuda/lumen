/**
 * Tests for {@link TerminalTool}.
 *
 * The `terminal` tool is a thin wrapper over {@link ShellSandbox},
 * so these tests focus on what the tool does *uniquely*:
 *
 *   - Argument validation (metacharacter refusal)
 *   - Mapping a sandbox refusal to a typed `refusal` field
 *   - Mapping a sandbox `ok` to the standard tool output
 *   - The pre-flight schema (cwd resolution, env shape)
 *
 * We inject a **fake sandbox** (a callable that records
 * requests) for most tests so the test is fast and deterministic.
 * One end-to-end test exercises a real `echo` to prove the
 * wiring through `DefaultSandbox` works.
 */

import * as os from 'node:os'
import * as path from 'node:path'
import type { ToolContext } from '@lumen/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShellSandbox, ShellSandboxOutcome } from '../src/shell/sandbox.js'
import { TerminalTool } from '../src/shell/terminal.js'

/** A minimal in-memory sandbox. Records every request. */
function makeFakeSandbox(respondWith: (cmd: readonly string[]) => ShellSandboxOutcome): {
  sandbox: ShellSandbox
  calls: Array<{ command: readonly string[]; cwd: string }>
} {
  const calls: Array<{ command: readonly string[]; cwd: string }> = []
  const sandbox: ShellSandbox = {
    async run(req) {
      calls.push({ command: req.command, cwd: req.cwd })
      return respondWith(req.command)
    },
  }
  return { sandbox, calls }
}

let tmpCwd: string
let ctx: ToolContext

beforeEach(() => {
  tmpCwd = os.tmpdir()
  ctx = { cwd: tmpCwd, signal: new AbortController().signal, sessionId: 'test' }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TerminalTool', () => {
  it('forwards a valid argv to the sandbox and returns its outcome', async () => {
    const { sandbox, calls } = makeFakeSandbox(() => ({
      kind: 'ok',
      result: {
        exitCode: 0,
        signal: null,
        stdout: 'hello',
        stderr: '',
        durationMs: 5,
        truncated: false,
      },
    }))
    const tool = new TerminalTool({
      strategy: 'custom',
      env: {},
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      factories: { custom: () => sandbox },
    })
    // Inject the fake by re-constructing via a config that uses
    // a factory returning the fake. The TerminalTool's constructor
    // resolves the sandbox once, so we use a per-test config.
    void tool
    const toolWithFake = new TerminalTool({
      strategy: 'custom',
      env: {},
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      factories: { custom: () => sandbox },
    })
    const out = (await toolWithFake.call({ command: ['echo', 'hi'] }, ctx)) as {
      exitCode: number | null
      stdout: string
      refusal: unknown
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toEqual(['echo', 'hi'])
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toBe('hello')
    expect(out.refusal).toBeNull()
  })

  it('refuses shell metacharacters in argv[0] with policy-violation', async () => {
    const { sandbox } = makeFakeSandbox(() => ({
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
    const tool = new TerminalTool({
      strategy: 'custom',
      env: {},
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      factories: { custom: () => sandbox },
    })
    const out = (await tool.call({ command: ['echo`whoami`', 'hi'] }, ctx)) as {
      refusal: { reason: string; message: string } | null
    }
    expect(out.refusal).not.toBeNull()
    expect(out.refusal?.reason).toBe('policy-violation')
    expect(out.refusal?.message).toMatch(/metacharacter/i)
  })

  it('maps a sandbox refusal to the typed `refusal` field', async () => {
    const { sandbox } = makeFakeSandbox(() => ({
      kind: 'refused',
      reason: 'policy-disabled',
      message: 'shell disabled',
    }))
    const tool = new TerminalTool({
      strategy: 'custom',
      env: {},
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      factories: { custom: () => sandbox },
    })
    const out = (await tool.call({ command: ['ls'] }, ctx)) as {
      exitCode: number | null
      refusal: { reason: string; message: string } | null
    }
    expect(out.exitCode).toBeNull()
    expect(out.refusal?.reason).toBe('policy-disabled')
    expect(out.refusal?.message).toBe('shell disabled')
  })

  it('resolves a relative cwd against ctx.cwd', async () => {
    const { sandbox, calls } = makeFakeSandbox(() => ({
      kind: 'ok',
      result: {
        exitCode: 0,
        signal: null,
        stdout: '',
        stderr: '',
        durationMs: 1,
        truncated: false,
      },
    }))
    const tool = new TerminalTool({
      strategy: 'custom',
      env: {},
      timeoutMs: 30_000,
      maxOutputBytes: 1024,
      factories: { custom: () => sandbox },
    })
    await tool.call({ command: ['pwd'], cwd: 'subdir' }, ctx)
    expect(calls[0]?.cwd).toBe(path.resolve(tmpCwd, 'subdir'))
  })

  it('runs a real command end-to-end through DefaultSandbox', async () => {
    // No injection — use the shipped default strategy. Set the
    // workspace boundary to the test tmpdir so the path-traversal
    // check (P9.3) allows the call's `ctx.cwd`.
    const tool = new TerminalTool({ workspaceDir: tmpCwd })
    const out = (await tool.call({ command: ['echo', 'lumen'] }, ctx)) as {
      exitCode: number | null
      stdout: string
      refusal: unknown
    }
    expect(out.refusal).toBeNull()
    expect(out.exitCode).toBe(0)
    expect(out.stdout.trim()).toBe('lumen')
  })

  it('exposes a `dangerous` risk classification so the approval gate can hook it', () => {
    const tool = new TerminalTool()
    expect(tool.risk).toBe('dangerous')
  })
})

describe('DefaultSandbox path-traversal defence (P9.3)', () => {
  it('refuses request.cwd that escapes workspaceDir', async () => {
    const tool = new TerminalTool({ workspaceDir: tmpCwd })
    const out = (await tool.call({ command: ['pwd'], cwd: '/etc' }, ctx)) as {
      refusal: { reason: string; message: string } | null
    }
    expect(out.refusal).not.toBeNull()
    expect(out.refusal?.message).toMatch(/outside workspaceDir/)
  })

  it('refuses request.cwd that uses .. to escape workspaceDir', async () => {
    const tool = new TerminalTool({ workspaceDir: tmpCwd })
    const out = (await tool.call({ command: ['pwd'], cwd: `${tmpCwd}/../../../etc` }, ctx)) as {
      refusal: { reason: string; message: string } | null
    }
    expect(out.refusal).not.toBeNull()
    expect(out.refusal?.message).toMatch(/outside workspaceDir/)
  })

  it('allows request.cwd equal to workspaceDir', async () => {
    const tool = new TerminalTool({ workspaceDir: tmpCwd })
    const out = (await tool.call({ command: ['pwd'] }, ctx)) as {
      refusal: unknown
      stdout: string
    }
    expect(out.refusal).toBeNull()
    // `pwd` returns the canonical (symlink-resolved) path. On macOS
    // `/tmp` resolves to `/private/tmp`; we compare via realpath
    // to avoid coupling the test to the OS.
    expect(require('node:fs').realpathSync(out.stdout.trim())).toBe(
      require('node:fs').realpathSync(tmpCwd),
    )
  })

  it('allows request.cwd a strict descendant of workspaceDir', async () => {
    const subdir = path.resolve(tmpCwd, 'subdir')
    require('node:fs').mkdirSync(subdir, { recursive: true })
    const tool = new TerminalTool({ workspaceDir: tmpCwd })
    const out = (await tool.call({ command: ['pwd'], cwd: subdir }, ctx)) as {
      refusal: unknown
      stdout: string
    }
    expect(out.refusal).toBeNull()
    expect(out.stdout.trim()).toBe(require('node:fs').realpathSync(subdir))
  })
})
