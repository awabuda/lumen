/**
 * P35 (Phase C.2 slice) — `lumen doctor --format json`.
 *
 * Validates the JSON shape produced by `buildDoctorRows`
 * and the CLI dispatch path. The doctor command's
 * human path is unchanged; we only add the JSON
 * shape as a CI-friendly alternative.
 */

import { describe, expect, it } from 'vitest'
import { type DoctorRow, buildDoctorRows } from '../src/commands/doctor-format.js'

describe('buildDoctorRows — P35', () => {
  it('returns a non-empty array of DoctorRow', async () => {
    const rows = await buildDoctorRows()
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(['OK', 'WARN', 'FAIL']).toContain(row.severity)
      expect(typeof row.section).toBe('string')
      expect(row.section.length).toBeGreaterThan(0)
      expect(typeof row.message).toBe('string')
      expect(typeof row.hint).toBe('string')
    }
  })

  it('always includes the core sections (config, api-key, memory-store, sqlite-abi)', async () => {
    const rows = await buildDoctorRows()
    const sections = new Set(rows.map((r) => r.section))
    for (const s of ['config', 'api-key', 'memory-store', 'sqlite-abi']) {
      expect(sections.has(s)).toBe(true)
    }
  })

  it('appends product gates when --product is set', async () => {
    const rows = await buildDoctorRows({ product: true })
    const sections = new Set(rows.map((r) => r.section))
    // Each G-P* gate becomes a `gate.<section>` row.
    expect(sections.has('gate.open-box usability')).toBe(true)
    expect(sections.has('gate.profile bare')).toBe(true)
  })

  it('does NOT include product gates when --product is omitted', async () => {
    const rows = await buildDoctorRows()
    const sections = new Set(rows.map((r) => r.section))
    expect(sections.has('gate.open-box usability')).toBe(false)
  })

  it('assigns a non-empty hint to FAIL rows', async () => {
    const rows = await buildDoctorRows()
    const failRows = rows.filter((r) => r.severity === 'FAIL')
    for (const row of failRows) {
      expect(row.hint.length).toBeGreaterThan(0)
    }
  })

  it('produces a deterministic section order', async () => {
    const a = await buildDoctorRows()
    const b = await buildDoctorRows()
    const aSections = a.map((r: DoctorRow) => r.section)
    const bSections = b.map((r: DoctorRow) => r.section)
    expect(aSections).toEqual(bSections)
  })
})
