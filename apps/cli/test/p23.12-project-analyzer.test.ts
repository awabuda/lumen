/**
 * P23.12 — ProjectAnalyzer tests (bug.md #70 /init analyser).
 *
 * Verifies the analyzer emits a useful factsheet from a real
 * workspace (the lumen monorepo) and from a synthetic empty
 * directory. We do not depend on the filesystem layout of
 * `process.cwd()`; each test creates a fresh tmp dir via
 * `node:fs.mkdtempSync` so the suite is hermetic.
 */

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { analyzeProject, renderProjectFactsheet } from '../src/components/project-analyzer.js'

let tmpRoot: string

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-init-'))
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

const write = (rel: string, body: string): void => {
  fs.writeFileSync(path.join(tmpRoot, rel), body, 'utf8')
}

describe('P23.12 — fix #70: ProjectAnalyzer (used by /init)', () => {
  it('detects pnpm from pnpm-lock.yaml', () => {
    write('pnpm-lock.yaml', '')
    const result = analyzeProject(tmpRoot)
    expect(result.detected.packageManager?.manager).toBe('pnpm')
  })

  it('detects npm from package-lock.json when pnpm is absent', () => {
    write('package-lock.json', '{}')
    const result = analyzeProject(tmpRoot)
    expect(result.detected.packageManager?.manager).toBe('npm')
  })

  it('reports no package manager when none of the lockfiles exist', () => {
    const result = analyzeProject(tmpRoot)
    expect(result.detected.packageManager).toBeUndefined()
  })

  it('reads test / build / lint / typecheck scripts from package.json', () => {
    write(
      'package.json',
      JSON.stringify({
        name: 'demo',
        scripts: {
          test: 'vitest',
          build: 'tsc -b',
          lint: 'biome check .',
          typecheck: 'tsc --noEmit',
        },
      }),
    )
    const result = analyzeProject(tmpRoot)
    expect(result.detected.scripts?.test).toBe('vitest')
    expect(result.detected.scripts?.build).toBe('tsc -b')
    expect(result.detected.scripts?.lint).toBe('biome check .')
    expect(result.detected.scripts?.typecheck).toBe('tsc --noEmit')
  })

  it('falls back to `tsc` when `typecheck` is missing but `tsc` script exists', () => {
    write('package.json', JSON.stringify({ name: 'x', scripts: { tsc: 'tsc --noEmit' } }))
    const result = analyzeProject(tmpRoot)
    expect(result.detected.scripts?.typecheck).toBe('tsc --noEmit')
  })

  it('lists top-level directories that exist on disk', () => {
    for (const d of ['src', 'tests', 'docs', '.github']) {
      fs.mkdirSync(path.join(tmpRoot, d), { recursive: true })
    }
    const result = analyzeProject(tmpRoot)
    const names = result.detected.topLevelDirs.map((d) => d.name)
    expect(names).toContain('src')
    expect(names).toContain('tests')
    expect(names).toContain('docs')
    expect(names).toContain('.github')
  })

  it('renders a Markdown factsheet with the detected sections', () => {
    write('pnpm-lock.yaml', '')
    write('package.json', JSON.stringify({ name: 'x', scripts: { test: 'vitest run' } }))
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true })
    const out = renderProjectFactsheet(tmpRoot)
    expect(out).toMatch(/^# /m)
    expect(out).toMatch(/Package manager/)
    expect(out).toContain('pnpm')
    expect(out).toContain('pnpm-lock.yaml')
    expect(out).toContain('test')
    expect(out.toLowerCase()).toContain('src')
  })

  it('handles a directory with no package.json (no crash)', () => {
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true })
    const result = analyzeProject(tmpRoot)
    expect(result.detected.scripts).toBeUndefined()
    expect(result.factsheet).toContain('none detected')
  })

  it('rejects a package.json that is not valid JSON', () => {
    write('package.json', 'this is not json')
    const result = analyzeProject(tmpRoot)
    expect(result.detected.scripts).toBeUndefined()
  })
})
