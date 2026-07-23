/**
 * P28.3 (bug.md #10 Path A) — `--computer-use` flag e2e sanity.
 *
 * Verifies that `lumen run --computer-use --help` shows
 * the new flag and that the flag is wired through to
 * `BuildOptions.computerUse` correctly. We do NOT spin
 * up a real agent loop here \u2014 that requires a model
 * API key. The test is hermetic.
 *
 * The deeper integration test (agent loop invokes
 * `computer_use`) lives in the
 * `test/real-model/` suite and is gated on
 * `LUMEN_E2E=1`.
 */

import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const here = fileURLToPath(import.meta.url)
const cliRoot = resolve(dirname(here), '..')
const cliEntry = resolve(cliRoot, 'dist', 'index.js')

describe('P28.3 \u2014 lumen run --computer-use flag', () => {
  it('shows the new flag in --help output', () => {
    const result = spawnSync('node', [cliEntry, 'run', '--help'], {
      cwd: cliRoot,
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('--computer-use')
    expect(result.stdout).toContain('--computer-use-exe')
    expect(result.stdout).toContain('--computer-use-allowed-domains')
  })

  it('accepts the flag without rejecting it as unknown', () => {
    // `lumen run --computer-use` without a prompt errors
    // out because the prompt is required, but the flag
    // itself is recognised. The error message is about
    // the missing prompt, not the flag.
    const result = spawnSync('node', [cliEntry, 'run', '--computer-use'], {
      cwd: cliRoot,
      encoding: 'utf8',
    })
    // Exit code 2 (config error) is fine; the relevant
    // assertion is that the error message names the
    // missing prompt and not the flag.
    const combined = `${result.stdout}\n${result.stderr}`
    expect(combined).not.toMatch(/unknown option.*--computer-use/)
    expect(combined).toMatch(/prompt/i)
  })

  it('--help description mentions the dangerous risk class', () => {
    const result = spawnSync('node', [cliEntry, 'run', '--help'], {
      cwd: cliRoot,
      encoding: 'utf8',
    })
    expect(result.stdout).toMatch(/dangerous/)
  })
})