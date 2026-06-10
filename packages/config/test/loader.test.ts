import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/loader.js'

describe('loadConfig', () => {
  it('returns built-in defaults when no sources are available', async () => {
    const cfg = await loadConfig({ skipUserConfig: true, skipProjectConfig: true, cwd: '/' })
    expect(cfg.agent.maxIterations).toBe(50)
    expect(cfg.logging.level).toBe('info')
    expect(cfg.tools.defaultTimeoutMs).toBe(30_000)
  })

  it('respects CLI override precedence over env', async () => {
    process.env.LUMEN_LOGGING__LEVEL = 'debug'
    try {
      const cfg = await loadConfig({
        skipUserConfig: true,
        skipProjectConfig: true,
        cliOverrides: { logging: { level: 'warn' } },
        cwd: '/',
      })
      expect(cfg.logging.level).toBe('warn')
    } finally {
      delete process.env.LUMEN_LOGGING__LEVEL
    }
  })

  it('maps underscore env names to camelCase config keys', async () => {
    process.env.LUMEN_DEFAULT_MODEL = 'gpt-4o-mini'
    try {
      const cfg = await loadConfig({ skipUserConfig: true, skipProjectConfig: true, cwd: '/' })
      expect(cfg.defaultModel).toBe('gpt-4o-mini')
    } finally {
      delete process.env.LUMEN_DEFAULT_MODEL
    }
  })

  it('ignores runtime-only env vars consumed by the CLI composition root', async () => {
    process.env.LUMEN_API_KEY = 'test-key'
    process.env.LUMEN_BASE_URL = 'http://localhost:9999/v1'
    process.env.LUMEN_MODEL = 'gpt-4o-mini'
    process.env.LUMEN_MEMORY_PATH = ':memory:'
    process.env.LUMEN_SKILLS_PATH = '/tmp/lumen-skills'
    try {
      const cfg = await loadConfig({ skipUserConfig: true, skipProjectConfig: true, cwd: '/' })
      expect(cfg.agent.maxIterations).toBe(50)
    } finally {
      delete process.env.LUMEN_API_KEY
      delete process.env.LUMEN_BASE_URL
      delete process.env.LUMEN_MODEL
      delete process.env.LUMEN_MEMORY_PATH
      delete process.env.LUMEN_SKILLS_PATH
    }
  })

  it('rejects unknown keys (strict mode)', async () => {
    await expect(
      loadConfig({
        skipUserConfig: true,
        skipProjectConfig: true,
        cliOverrides: { unknownKey: 123 },
        cwd: '/',
      }),
    ).rejects.toThrow()
  })
})
