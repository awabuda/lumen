import { describe, expect, it } from 'vitest'
import { loadConfig } from './loader.js'

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
