/** Tests for `lumen config` command handlers. */

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configPathCommand,
  configShowCommand,
  configValidateCommand,
} from '../src/commands/config.js'

let tmpDir: string
let stdout = ''
let stderr = ''

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lumen-cli-config-test-'))
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
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(tmpDir, { recursive: true, force: true })
})

const writeJsonConfig = async (body: object): Promise<string> => {
  const lumenDir = path.join(tmpDir, '.lumen')
  await fs.mkdir(lumenDir, { recursive: true })
  const file = path.join(lumenDir, 'config.json')
  await fs.writeFile(file, JSON.stringify(body), 'utf8')
  return file
}

describe('configShowCommand', () => {
  it('prints a JSON dump of the resolved config', async () => {
    const file = await writeJsonConfig({
      defaultModel: 'gpt-4o-mini',
      models: [{ provider: 'openai', name: 'gpt-4o-mini' }],
    })
    const code = await configShowCommand({ configPath: file })
    expect(code).toBe(0)
    expect(stdout.trim().startsWith('{')).toBe(true)
    const parsed = JSON.parse(stdout)
    expect(parsed.defaultModel).toBe('gpt-4o-mini')
    expect(parsed.models[0].name).toBe('gpt-4o-mini')
  })

  it('redacts apiKey values in the dump', async () => {
    const file = await writeJsonConfig({
      providers: [{ id: 'openai', apiKey: `sk-${'a'.repeat(40)}` }],
    })
    const code = await configShowCommand({ configPath: file })
    expect(code).toBe(0)
    expect(stdout).not.toContain(`sk-${'a'.repeat(40)}`)
    expect(stdout).toContain('[REDACTED]')
  })

  it('redacts header keys that look like secrets', async () => {
    const file = await writeJsonConfig({
      providers: [
        {
          id: 'openai',
          headers: { Authorization: `Bearer ${'b'.repeat(60)}`, 'X-Trace': 'safe-value' },
        },
      ],
    })
    const code = await configShowCommand({ configPath: file })
    expect(code).toBe(0)
    const parsed = JSON.parse(stdout)
    const headers = parsed.providers[0].headers
    expect(headers.Authorization).toBe('[REDACTED]')
    expect(headers['X-Trace']).toBe('safe-value')
  })
})

describe('configPathCommand', () => {
  it('returns the explicit path when one is provided', async () => {
    const file = await writeJsonConfig({})
    const code = await configPathCommand({ configPath: file })
    expect(code).toBe(0)
    expect(stdout).toContain(file)
  })

  it('reports no config file found when no candidate exists', async () => {
    // tmpDir has no .lumen/config.* yet
    const code = await configPathCommand({})
    expect(code).toBe(0)
    expect(stdout).toContain('no config file found')
  })
})

describe('configValidateCommand', () => {
  it('returns 0 with OK summary on a valid config', async () => {
    const file = await writeJsonConfig({
      providers: [{ id: 'openai' }],
      models: [{ provider: 'openai', name: 'gpt-4o-mini' }],
    })
    const code = await configValidateCommand({ configPath: file })
    expect(code).toBe(0)
    expect(stdout).toContain('OK')
    expect(stdout).toContain('providers=1')
    expect(stdout).toContain('models=1')
  })

  it('returns 1 when the config has an unknown key (strict schema)', async () => {
    const file = await writeJsonConfig({
      providers: [{ id: 'openai' }],
      garbage: 'this is not allowed',
    })
    const code = await configValidateCommand({ configPath: file })
    expect(code).toBe(1)
    expect(stderr).toContain('FAIL')
  })
})
