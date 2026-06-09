import { describe, expect, it } from 'vitest'
import { buildSafeMcpEnv } from '../src/index.js'

describe('buildSafeMcpEnv', () => {
  it('inherits only safe baseline env vars and explicit overrides', () => {
    const env = buildSafeMcpEnv(
      {
        PATH: '/usr/bin',
        HOME: '/tmp/home',
        XDG_CACHE_HOME: '/tmp/cache',
        OPENAI_API_KEY: 'secret',
        GITHUB_TOKEN: 'secret',
        NODE_OPTIONS: '--require bad',
      },
      { CUSTOM_ALLOWED: 'yes' },
    )

    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/tmp/home')
    expect(env.XDG_CACHE_HOME).toBe('/tmp/cache')
    expect(env.CUSTOM_ALLOWED).toBe('yes')
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
  })
})
