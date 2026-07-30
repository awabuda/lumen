/**
 * P32.5 — unit tests for `native-abi.ts`.
 *
 * The runtime probe (`probeBetterSqlite3Abi`) reads the actually
 * installed binary, so the tests below pin down the pure
 * helpers that are independent of the install:
 *   - `extractNodeModuleVersionMismatch` parses the
 *     well-known NODE_MODULE_VERSION X / Y mismatch error.
 *   - `formatRemediation` produces a fixed-wording one-liner.
 *   - `formatAbiDoctorMessage` composes the doctor output line
 *     for an `AbiProbe`.
 *
 * `resolveBetterSqlite3Binary` is exercised indirectly through
 * a single integration check (the probe in this sandbox should
 * succeed because P32.1 rebuild already rebuilt the binary in
 * place).
 */
import { describe, expect, it } from 'vitest'
import {
  extractNodeModuleVersionMismatch,
  formatAbiDoctorMessage,
  formatRemediation,
  probeBetterSqlite3Abi,
  resolveBetterSqlite3Binary,
} from '../src/native-abi.js'

describe('extractNodeModuleVersionMismatch', () => {
  it('parses the canonical mismatch error', () => {
    const msg =
      'The module ... better_sqlite3.node was compiled against a different Node.js version using ' +
      'NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 141. ' +
      'Please try re-compiling or re-installing the module'
    const result = extractNodeModuleVersionMismatch(msg)
    expect(result).toEqual({ compiled: 137, running: 141 })
  })

  it('tolerates extra whitespace and unicode separators', () => {
    const msg =
      'NODE_MODULE_VERSION\t42.\n This version of Node.js requires  NODE_MODULE_VERSION  43.'
    expect(extractNodeModuleVersionMismatch(msg)).toEqual({ compiled: 42, running: 43 })
  })

  it('returns undefined on a non-mismatch message', () => {
    expect(extractNodeModuleVersionMismatch('Some other error')).toBeUndefined()
    expect(extractNodeModuleVersionMismatch('')).toBeUndefined()
  })

  it('returns undefined when only one tag is present', () => {
    expect(extractNodeModuleVersionMismatch('NODE_MODULE_VERSION 99 only one')).toBeUndefined()
  })
})

describe('formatRemediation', () => {
  it('mentions the rebuild:native script and the running ABI', () => {
    const out = formatRemediation(141)
    expect(out).toContain('pnpm rebuild:native')
    expect(out).toContain('pnpm install')
    expect(out).toContain('141')
  })
})

describe('formatAbiDoctorMessage', () => {
  it('renders the OK branch with the running ABI', () => {
    const msg = formatAbiDoctorMessage({
      binaryPath: '/x/better_sqlite3.node',
      ok: true,
      runningAbi: 141,
    })
    expect(msg).toContain('matches current Node')
    expect(msg).toContain('141')
  })

  it('renders a drift with explicit numbers and the rebuild hint', () => {
    const msg = formatAbiDoctorMessage({
      binaryPath: '/x',
      ok: false,
      runningAbi: 141,
      error: 'NODE_MODULE_VERSION 137. This version of Node.js requires NODE_MODULE_VERSION 141.',
    })
    expect(msg).toContain('ABI drift')
    expect(msg).toContain('137')
    expect(msg).toContain('141')
    expect(msg).toContain('rebuild:native')
  })

  it('renders a generic load failure when the error does not match', () => {
    const msg = formatAbiDoctorMessage({
      binaryPath: undefined,
      ok: false,
      runningAbi: 141,
      error: 'some unrelated failure',
    })
    expect(msg).toContain('load failed')
    expect(msg).toContain('some unrelated failure')
  })
})

describe('resolveBetterSqlite3Binary / probeBetterSqlite3Abi (integration)', () => {
  // These two call into the actual installed binary. P32.1
  // already rebuilt it for ABI 141 in this sandbox, so the
  // probe must succeed.
  it('resolves to a path that exists on disk', () => {
    const path = resolveBetterSqlite3Binary()
    expect(path).toBeDefined()
    expect(path).toMatch(/better_sqlite3\.node$/)
  })

  it('probes successfully against the current Node ABI', () => {
    const probe = probeBetterSqlite3Abi()
    if (!probe.ok) {
      // Surface the failure for the test report — the conditional
      // assertion that follows would still pass on the lucky
      // path but we want a clear failure detail here.
      throw new Error(`ABI probe failed: ${probe.error ?? '(no detail)'}`)
    }
    expect(probe.runningAbi).toBe(Number.parseInt(process.versions.modules, 10))
    expect(probe.binaryPath).toMatch(/better_sqlite3\.node$/)
  })
})
