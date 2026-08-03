/** Tests for `lumen model` command handlers. */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { modelListCommand, modelProvidersCommand, modelShowCommand } from '../src/commands/model.js'

let tmpDir: string
let savedHome: string | undefined
let savedCwd: string
let savedLumenEnv: Record<string, string | undefined>
let stdout = ''
let stderr = ''

const LUMEN_ENV_KEYS = Object.keys(process.env).filter((k) => k.startsWith('LUMEN_'))

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-cli-model-test-'))
  stdout = ''
  stderr = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  })
  // `loadConfig` merges three layers: `~/.lumen/config.*`,
  // `<cwd>/.lumen/*`, and every env var prefixed with `LUMEN_`.
  // Without isolation a developer's real `~/.lumen/config.yaml`
  // (or any project `.lumen/` near the test process) leaks
  // into the empty-state cases, and `LUMEN_API_KEY` /
  // `LUMEN_BASE_URL` on the developer shell produces a
  // "1 configured" default. Redirect HOME + cwd to `tmpDir`
  // and scrub the LUMEN_* env for the duration of each case;
  // restore on afterEach so concurrent test files
  // (e.g. config.test.ts) aren't perturbed.
  savedHome = process.env.HOME
  savedCwd = process.cwd()
  savedLumenEnv = {}
  for (const key of LUMEN_ENV_KEYS) {
    savedLumenEnv[key] = process.env[key]
    // biome-ignore lint/performance/noDelete: env-var cleanup — only correct way to unset
    delete process.env[key]
  }
  process.env.HOME = tmpDir
  process.chdir(tmpDir)
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (savedHome === undefined) {
    // biome-ignore lint/performance/noDelete: env-var cleanup — only correct way to unset
    delete process.env.HOME
  } else {
    process.env.HOME = savedHome
  }
  process.chdir(savedCwd)
  for (const key of LUMEN_ENV_KEYS) {
    const next = savedLumenEnv[key]
    if (next === undefined) {
      // biome-ignore lint/performance/noDelete: env-var cleanup — only correct way to unset
      delete process.env[key]
    } else {
      process.env[key] = next
    }
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const writeConfig = async (body: object): Promise<string> => {
  const lumenDir = path.join(tmpDir, '.lumen')
  await fs.mkdir(lumenDir, { recursive: true })
  const file = path.join(lumenDir, 'config.yaml')
  await fs.writeFile(file, JSON.stringify(body), 'utf8')
  return file
}

describe('modelListCommand', () => {
  it('prints empty state when no models are configured', async () => {
    const code = await modelListCommand({ configPath: path.join(tmpDir, '.lumen', 'config.yaml') })
    expect(code).toBe(0)
    expect(stdout).toContain('Lumen models')
    expect(stdout).toContain('No models configured')
  })

  it('prints each model with risk row', async () => {
    const file = await writeConfig({
      defaultModel: 'gpt-4o-mini',
      models: [
        { provider: 'openai', name: 'gpt-4o-mini', temperature: 0.2, maxTokens: 1024 },
        { provider: 'openai', name: 'gpt-4o', temperature: 0.7 },
      ],
    })
    const code = await modelListCommand({ configPath: file })
    expect(code).toBe(0)
    expect(stdout).toContain('default=gpt-4o-mini')
    expect(stdout).toContain('openai/gpt-4o-mini [default]')
    expect(stdout).toContain('openai/gpt-4o')
    expect(stdout).toContain('temperature: 0.2')
    expect(stdout).toContain('maxTokens:   1024')
  })
})

describe('modelShowCommand', () => {
  // The audit GAP-2 follow-up env-injects LUMEN_DEFAULT_MODEL
  // in test/setup.ts so buildAgent() doesn't throw. That has
  // the side-effect of making every config look like it has a
  // defaultModel. For these `default: yes/no` assertions we
  // need a hermetic env — strip the test-wide default and
  // restore it in afterEach.
  let savedDefaultModel: string | undefined
  beforeEach(() => {
    savedDefaultModel = process.env.LUMEN_DEFAULT_MODEL
    delete process.env.LUMEN_DEFAULT_MODEL
  })
  afterEach(() => {
    if (savedDefaultModel !== undefined) {
      process.env.LUMEN_DEFAULT_MODEL = savedDefaultModel
    }
  })

  it('prints full descriptor for a known model', async () => {
    const file = await writeConfig({
      models: [{ provider: 'openai', name: 'gpt-4o-mini', temperature: 0.3, maxTokens: 2048 }],
    })
    const code = await modelShowCommand({ configPath: file, name: 'gpt-4o-mini' })
    expect(code).toBe(0)
    expect(stdout).toContain('openai/gpt-4o-mini')
    expect(stdout).toContain('temperature: 0.3')
    expect(stdout).toContain('default:     no')
  })

  it('flags the default model', async () => {
    const file = await writeConfig({
      defaultModel: 'gpt-4o-mini',
      models: [{ provider: 'openai', name: 'gpt-4o-mini' }],
    })
    const code = await modelShowCommand({ configPath: file, name: 'gpt-4o-mini' })
    expect(code).toBe(0)
    expect(stdout).toContain('default:     yes')
  })

  it('returns 1 for missing model', async () => {
    const file = await writeConfig({ models: [{ provider: 'openai', name: 'gpt-4o-mini' }] })
    const code = await modelShowCommand({ configPath: file, name: 'missing' })
    expect(code).toBe(1)
    expect(stderr).toContain('Model not found')
  })
})

describe('modelProvidersCommand', () => {
  it('prints empty state when no providers are configured', async () => {
    const code = await modelProvidersCommand({
      configPath: path.join(tmpDir, '.lumen', 'config.yaml'),
    })
    expect(code).toBe(0)
    expect(stdout).toContain('No providers configured')
  })

  it('redacts apiKey to a length-only form', async () => {
    const file = await writeConfig({
      providers: [
        { id: 'openai', apiKey: `sk-proj-${'x'.repeat(48)}`, defaultModel: 'gpt-4o-mini' },
      ],
    })
    const code = await modelProvidersCommand({ configPath: file })
    expect(code).toBe(0)
    expect(stdout).toContain('openai')
    // Raw key must NOT leak
    expect(stdout).not.toContain('sk-proj-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
    // Must contain a redacted marker that mentions the length
    expect(stdout).toMatch(/redacted.*\d+ chars/)
  })

  it('marks unset apiKey explicitly', async () => {
    const file = await writeConfig({
      providers: [{ id: 'openai', baseUrl: 'https://example.com/v1' }],
    })
    const code = await modelProvidersCommand({ configPath: file })
    expect(code).toBe(0)
    expect(stdout).toContain('apiKey:     (unset)')
    expect(stdout).toContain('baseUrl:    https://example.com/v1')
  })
})
