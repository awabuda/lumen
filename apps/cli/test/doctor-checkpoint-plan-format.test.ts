/**
 * P37.b + P37.c + P37.d — three P+ slices in one test file.
 */

import { describe, expect, it } from 'vitest'
import { checkpointShowCommand } from '../src/commands/checkpoint.js'
import { doctorCommand } from '../src/commands/doctor.js'
import { planListCommand } from '../src/commands/plan.js'

const capture = (): { writes: string[]; stderr: string[]; restore: () => void } => {
  const writes: string[] = []
  const stderr: string[] = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    writes.push(typeof chunk === 'string' ? chunk : chunk.toString())
    return true
  }) as typeof process.stdout.write
  const originalErr = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr.push(typeof chunk === 'string' ? chunk : chunk.toString())
    return true
  }) as typeof process.stderr.write
  return {
    writes,
    stderr,
    restore: () => {
      process.stdout.write = originalWrite
      process.stderr.write = originalErr
    },
  }
}

describe('P37.b — checkpoint show --format json', () => {
  it('returns 1 + stderr when the checkpoint id is missing', async () => {
    const cap = capture()
    try {
      const code = await checkpointShowCommand({ id: 'does-not-exist' })
      expect(code).toBe(1)
      expect(cap.stderr.join('')).toMatch(/no checkpoint with id "does-not-exist"/)
    } finally {
      cap.restore()
    }
  })
})

describe('P37.c — plan list --format json', () => {
  it('emits [] when no plans exist', async () => {
    const cap = capture()
    try {
      const code = await planListCommand({
        file: '/tmp/lumen-p37-c-empty-plans.json',
        format: 'json',
      })
      expect(code).toBe(0)
      expect(cap.writes.join('').trim()).toBe('[]')
    } finally {
      cap.restore()
    }
  })
})

describe('P37.d — doctor --no-api-key', () => {
  it('skips the API-key check when noApiKey is true and the key is missing', async () => {
    // We cannot test the full doctor surface without a
    // real env, so we only assert the SKIP row path fires
    // — the rest of the report is covered by pre-p37
    // tests. We invoke doctorCommand with noApiKey + a
    // missing key path and look for the SKIP tag.
    const savedKey = process.env.OPENAI_API_KEY
    const savedLumen = process.env.LUMEN_API_KEY
    // biome-ignore lint/performance/noDelete: per
    // Lumen rule 15, env-var reset MUST be , not
    //  (Node coerces undefined to the
    // string "undefined" at runtime).
    delete process.env.OPENAI_API_KEY
    // biome-ignore lint/performance/noDelete: same as
    // the OPENAI_API_KEY reset above.
    delete process.env.LUMEN_API_KEY
    const cap = capture()
    try {
      const code = await doctorCommand({ noApiKey: true, format: 'json' })
      // The JSON path returns 0 if no FAIL rows.
      expect(code === 0 || code === 1).toBe(true)
      const parsed = JSON.parse(cap.writes.join('')) as Array<{
        section: string
        severity: string
      }>
      const apiKeyRow = parsed.find((r) => r.section === 'api-key')
      // The SKIP row is reported under the existing
      // api-key section with severity 'WARN' (the
      // human path emits "[SKIP]"; the JSON path
      // maps the skip to WARN so the existing
      // severity vocabulary still applies).
      expect(apiKeyRow?.severity).toBe('WARN')
    } finally {
      if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey
      if (savedLumen !== undefined) process.env.LUMEN_API_KEY = savedLumen
      cap.restore()
    }
  })
})
