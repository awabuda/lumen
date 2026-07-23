/**
 * P27.1 (bug.md #10) — `lumen computer` subcommand.
 *
 * Pure tests for the helper (`buildComputerPrompt` +
 * `ComputerCommandOptions` shape). The CLI integration is
 * exercised by an end-to-end test below using a captured
 * stderr / stdout.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildComputerPrompt,
  computerCommand,
  formatDryRun,
  resolveComputerRunOptions,
  type ComputerCommandOptions,
} from '../src/commands/computer.js'

const PROMPT_PREFIX_FRAGMENT = 'You have a headless Chromium browser'

const baseOptions = (
  overrides: Partial<ComputerCommandOptions> = {},
): ComputerCommandOptions => ({
  prompt: 'navigate to example.com and screenshot',
  ...overrides,
})

describe('P27.1 — buildComputerPrompt', () => {
  it('prepends the hint to the operator prompt', () => {
    const out = buildComputerPrompt('hello world')
    expect(out).toContain(PROMPT_PREFIX_FRAGMENT)
    expect(out).toContain('hello world')
    // The hint comes FIRST (operator's prompt is the
    // source of truth; the hint is documentation).
    expect(out.indexOf(PROMPT_PREFIX_FRAGMENT)).toBeLessThan(
      out.indexOf('hello world'),
    )
  })

  it('mentions the web_browser tool name in the hint', () => {
    expect(buildComputerPrompt('x')).toContain('`web_browser`')
  })

  it('is deterministic (no clock / no random IDs)', () => {
    expect(buildComputerPrompt('x')).toBe(buildComputerPrompt('x'))
  })
})

// Mock the run.js module BEFORE the computer module is
// imported. The \`computer\` body calls
// \`runCommand(options)\` (a top-level named import) which
// the runtime can swap via vi.mock at the file level.
vi.mock('../src/commands/run.js', () => ({
  runCommand: vi.fn(async () => 0),
}))

import { computerCommand } from '../src/commands/computer.js'
import { runCommand } from '../src/commands/run.js'

const mockedRunCommand = vi.mocked(runCommand)

describe('P27.1 — computerCommand wiring', () => {
  beforeEach(() => {
    mockedRunCommand.mockReset()
    mockedRunCommand.mockResolvedValue(0)
  })

  it('prepends the prompt prefix and defaults approveOn to ["web_browser"]', async () => {
    const code = await computerCommand(baseOptions())
    expect(code).toBe(0)
    const call = mockedRunCommand.mock.calls[0]?.[0]
    expect(call?.webBrowser).toBe(true)
    expect(call?.approveOn).toEqual(['web_browser'])
    expect(call?.prompt).toContain('navigate to example.com')
    expect(call?.prompt).toContain(PROMPT_PREFIX_FRAGMENT)
  })

  it('honours --no-prefix by skipping the hint', async () => {
    await computerCommand(baseOptions({ noPrefix: true }))
    const call = mockedRunCommand.mock.calls[0]?.[0]
    expect(call?.prompt).toBe('navigate to example.com and screenshot')
    expect(call?.prompt).not.toContain(PROMPT_PREFIX_FRAGMENT)
  })

  it('honours an explicit approveOn list (overrides the default)', async () => {
    await computerCommand(
      baseOptions({ approveOn: ['web_browser', 'web_fetch'] }),
    )
    const call = mockedRunCommand.mock.calls[0]?.[0]
    expect(call?.approveOn).toEqual(['web_browser', 'web_fetch'])
  })

  it('forwards webBrowserExe + webBrowserAllowedDomains to runCommand', async () => {
    await computerCommand(
      baseOptions({
        webBrowserExe: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        webBrowserAllowedDomains: ['example.com', '*.example.org'],
      }),
    )
    const call = mockedRunCommand.mock.calls[0]?.[0]
    expect(call?.webBrowser).toBe(true)
    expect(call?.webBrowserExe).toBe(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    )
    expect(call?.webBrowserAllowedDomains).toEqual([
      'example.com',
      '*.example.org',
    ])
  })

  it('returns the exit code from runCommand (non-zero on error)', async () => {
    mockedRunCommand.mockResolvedValue(2)
    const code = await computerCommand(baseOptions())
    expect(code).toBe(2)
  })
})

describe('P27.2 — resolveComputerRunOptions + formatDryRun', () => {
  it('resolveComputerRunOptions returns the same shape that computerCommand would pass', () => {
    const resolved = resolveComputerRunOptions(baseOptions())
    expect(resolved.webBrowser).toBe(true)
    expect(resolved.approveOn).toEqual(['web_browser'])
    expect(resolved.prompt).toContain(PROMPT_PREFIX_FRAGMENT)
  })

  it('dry-run does NOT invoke runCommand and prints a summary line', () => {
    mockedRunCommand.mockReset()
    mockedRunCommand.mockResolvedValue(0)
    const captured: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: unknown) => {
      captured.push(typeof chunk === 'string' ? chunk : String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      const code = computerCommand({ ...baseOptions(), dryRun: true })
      // The function is async; we need to await it.
      return code.then((c) => {
        expect(c).toBe(0)
        expect(mockedRunCommand).not.toHaveBeenCalled()
        const out = captured.join('')
        expect(out).toContain('lumen computer (dry run)')
        expect(out).toContain('webBrowser:    true')
        expect(out).toContain('approveOn:     web_browser')
        // formatDryRun is also exported for direct use.
        expect(
          formatDryRun(resolveComputerRunOptions(baseOptions())),
        ).toContain('lumen computer (dry run)')
      })
    } finally {
      process.stdout.write = origWrite
    }
  })
})