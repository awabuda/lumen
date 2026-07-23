/**
 * P25.8 \u2014 Manifest-first config (bug.md #52).
 *
 * Pins the parser + the per-version default-model table.
 * The disk-read path is exercised by an integration test
 * below using a real temp-file.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_MODEL_PER_VERSION,
  PackageManifestLumenSchema,
  parseLumenManifest,
  readLumenManifestFromDisk,
  resolveDefaultModel,
} from '../src/manifest.js'

describe('P25.8 \u2014 PackageManifestLumenSchema', () => {
  it('accepts a minimal valid block', () => {
    const r = PackageManifestLumenSchema.safeParse({ defaultModel: 'gpt-4o' })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown field (strict)', () => {
    const r = PackageManifestLumenSchema.safeParse({ defaultModel: 'x', rogue: 'y' })
    expect(r.success).toBe(false)
  })

  it('rejects a non-string defaultModel', () => {
    const r = PackageManifestLumenSchema.safeParse({ defaultModel: 42 })
    expect(r.success).toBe(false)
  })
})

describe('P25.8 \u2014 parseLumenManifest', () => {
  it('returns the lumen block when present', () => {
    const raw = { name: 'x', version: '1.0.0', lumen: { defaultModel: 'gpt-4o' } }
    expect(parseLumenManifest(raw)).toEqual({ defaultModel: 'gpt-4o' })
  })

  it('returns undefined when the lumen block is absent', () => {
    expect(parseLumenManifest({ name: 'x', version: '1.0.0' })).toBeUndefined()
  })

  it('returns undefined on a malformed manifest', () => {
    expect(parseLumenManifest({ lumen: { defaultModel: 42 } })).toBeUndefined()
  })

  it('passes through unknown fields at the top level (passthrough)', () => {
    const raw = { name: 'x', version: '1.0.0', scripts: { test: 'vitest' }, lumen: {} }
    const r = parseLumenManifest(raw)
    expect(r).toEqual({})
  })
})

describe('P25.8 \u2014 readLumenManifestFromDisk', () => {
  it('reads a real package.json from a temp dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumen-manifest-'))
    try {
      const pkgPath = join(dir, 'package.json')
      writeFileSync(
        pkgPath,
        JSON.stringify({
          name: 'demo',
          version: '0.1.0',
          lumen: { defaultModel: 'gpt-4o', tag: 'dev' },
        }),
        'utf8',
      )
      const out = await readLumenManifestFromDisk(pkgPath)
      expect(out).toEqual({ defaultModel: 'gpt-4o', tag: 'dev' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns undefined on ENOENT', async () => {
    const out = await readLumenManifestFromDisk('/nonexistent-' + String(Date.now()))
    expect(out).toBeUndefined()
  })

  it('returns undefined on JSON parse error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumen-manifest-'))
    try {
      const pkgPath = join(dir, 'package.json')
      writeFileSync(pkgPath, '{ this is not json', 'utf8')
      expect(await readLumenManifestFromDisk(pkgPath)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('P25.8 \u2014 resolveDefaultModel', () => {
  it('prefers the manifest block over the version table', () => {
    expect(
      resolveDefaultModel({
        manifest: { defaultModel: 'gpt-4o' },
        lumenMajorVersion: 16,
      }),
    ).toBe('gpt-4o')
  })

  it('falls back to the per-version table', () => {
    expect(resolveDefaultModel({ lumenMajorVersion: 16 })).toBe(
      DEFAULT_MODEL_PER_VERSION[16],
    )
  })

  it('falls back to the hard-coded safety net', () => {
    // A version that is not in the table \u2014 e.g. 99.
    const out = resolveDefaultModel({ lumenMajorVersion: 99 })
    expect(typeof out).toBe('string')
    expect(out.length).toBeGreaterThan(0)
  })
})