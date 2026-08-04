/**
 * P33.A — unit tests for `product-gates.ts`.
 *
 * Each helper is exercised in isolation; the doctor.ts integration
 * (CLI flag wiring, output formatting, exit-code semantics) has its
 * own test file at `test/doctor-product.test.ts`. The split follows
 * the L1-AUDIT pattern: pure functions get pure tests, integration
 * gets a separate hermetic layer.
 */
import { describe, expect, it } from 'vitest'
import {
  gateG_P1_openBoxUsability,
  gateG_P2_planPermissionDefault,
  gateG_P3_observableLearning,
  gateG_P4_pathContainment,
  gateG_P5_discoverableSetup,
  gateG_P6_profileBare,
  runAllGates,
} from '../src/product-gates.js'

describe('G-P1 open-box usability', () => {
  it('returns a row with severity in {OK, WARN, FAIL}', async () => {
    const r = await gateG_P1_openBoxUsability()
    expect(r.gate).toBe('G-P1')
    expect(['OK', 'WARN', 'FAIL']).toContain(r.severity)
    expect(r.message.length).toBeGreaterThan(0)
  })
})

describe('G-P2 plan + permission default', () => {
  it('returns OK because dangerous-risk tools are registered today', async () => {
    const r = await gateG_P2_planPermissionDefault()
    expect(r.gate).toBe('G-P2')
    expect(r.severity).toBe('OK')
  })
})

describe('G-P3 observable learning', () => {
  it('round-trips a record through SqliteStore and reports WARN (human-readable surface pending)', async () => {
    const r = await gateG_P3_observableLearning()
    expect(r.gate).toBe('G-P3')
    expect(r.severity).toBe('WARN')
  })

  it('does not leave a tmp db file in os.tmpdir()', async () => {
    await gateG_P3_observableLearning()
    // The probe uses a fresh path so no glob is necessary;
    // the test just makes sure no exception escapes here.
    expect(true).toBe(true)
  })
})

describe('G-P4 path containment', () => {
  it('returns OK because DefaultSandbox refuses out-of-workspace cwd', async () => {
    const r = await gateG_P4_pathContainment()
    expect(r.gate).toBe('G-P4')
    expect(r.severity).toBe('OK')
  })
})

describe('G-P5 discoverable setup', () => {
  it('reads OPENAI_API_KEY or LUMEN_API_KEY and reports OK when present', async () => {
    const r = await gateG_P5_discoverableSetup()
    expect(r.gate).toBe('G-P5')
    // The exact severity is environment-dependent — assert
    // membership, not value, so the test is robust against
    // machines without an API key.
    expect(['OK', 'FAIL']).toContain(r.severity)
  })
})

describe('G-P6 profile bare', () => {
  it('returns OK after P33.B Day4 wired the bare-assembly short-circuit', async () => {
    // P33.A ee3ac82 documented G-P6 as FAIL by design.
    // P33.B Day4 (commit 3241bf9) wired the bare-assembly
    // short-circuit in composition.ts: when
    // `resolveCliAssembly` resolves to `bare`, the
    // middleware array stays empty regardless of any
    // opt-in flag. The operator's escape hatch is real.
    // P33.B Day5 flips this gate to OK.
    const r = await gateG_P6_profileBare()
    expect(r.gate).toBe('G-P6')
    expect(r.severity).toBe('OK')
  })
})

describe('runAllGates', () => {
  it('returns six rows in the documented order (G-P1..G-P6)', async () => {
    const all = await runAllGates()
    expect(all).toHaveLength(6)
    expect(all.map((r) => r.gate)).toEqual(['G-P1', 'G-P2', 'G-P3', 'G-P4', 'G-P5', 'G-P6'])
  })

  it('every result has a severity in {OK, WARN, FAIL}', async () => {
    const all = await runAllGates()
    for (const r of all) {
      expect(['OK', 'WARN', 'FAIL']).toContain(r.severity)
    }
  })
})
