/**
 * Tests for the meta tools (date, env, whoami).
 */
import { describe, expect, it } from 'vitest'
import { DateTool } from '../src/meta/date.js'
import { EnvTool } from '../src/meta/env.js'
import { WhoamiTool } from '../src/meta/whoami.js'
import type { ToolContext } from '@lumen/core'

const ctx: ToolContext = {
  cwd: '/tmp',
  signal: new AbortController().signal,
  sessionId: 'test',
  log: undefined,
}

describe('DateTool', () => {
  it('returns an ISO timestamp and epoch', async () => {
    const tool = new DateTool()
    const output = (await tool.call({}, ctx)) as {
      iso: string
      epochMs: number
      utc: string
      timezone: string
    }
    expect(output.iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(output.epochMs).toBeGreaterThan(1_700_000_000_000)
    expect(output.utc).toMatch(/GMT$/)
    expect(output.timezone.length).toBeGreaterThan(0)
  })

  it('has the expected descriptor', () => {
    const d = new DateTool().describe()
    expect(d.name).toBe('date')
    expect(d.risk).toBe('safe')
    expect(d.description.length).toBeGreaterThan(10)
  })
})

describe('EnvTool', () => {
  it('returns null for an unset variable', async () => {
    const tool = new EnvTool()
    const output = (await tool.call({ name: 'LUMEN_DOES_NOT_EXIST_42' }, ctx)) as {
      name: string
      value: string | null
      redacted: boolean
    }
    expect(output.value).toBeNull()
    expect(output.redacted).toBe(false)
  })

  it('returns the value of a set variable', async () => {
    process.env.LUMEN_TEST_VAR = 'hello'
    try {
      const tool = new EnvTool()
      const output = (await tool.call({ name: 'LUMEN_TEST_VAR' }, ctx)) as {
        name: string
        value: string | null
        redacted: boolean
      }
      expect(output.value).toBe('hello')
      expect(output.redacted).toBe(false)
    } finally {
      delete process.env.LUMEN_TEST_VAR
    }
  })

  it('redacts secret-looking variable names', async () => {
    process.env.LUMEN_API_KEY = 'sk-secret-123'
    try {
      const tool = new EnvTool()
      const output = (await tool.call({ name: 'LUMEN_API_KEY' }, ctx)) as {
        name: string
        value: string | null
        redacted: boolean
      }
      expect(output.value).toBe('[REDACTED]')
      expect(output.redacted).toBe(true)
    } finally {
      delete process.env.LUMEN_API_KEY
    }
  })

  it('has the expected descriptor', () => {
    const d = new EnvTool().describe()
    expect(d.name).toBe('env')
    expect(d.risk).toBe('safe')
  })
})

describe('WhoamiTool', () => {
  it('returns the current user and host info', async () => {
    const tool = new WhoamiTool()
    const output = (await tool.call({}, ctx)) as {
      username: string
      hostname: string
      platform: string
      arch: string
      nodeVersion: string
      cwd: string
      home: string
    }
    expect(output.username.length).toBeGreaterThan(0)
    expect(output.hostname.length).toBeGreaterThan(0)
    expect(output.platform).toBe('darwin')
    expect(output.arch).toBe('arm64')
    expect(output.nodeVersion).toMatch(/^v\d+/)
    expect(output.cwd).toBe('/tmp')
    expect(output.home.length).toBeGreaterThan(0)
  })

  it('has the expected descriptor', () => {
    const d = new WhoamiTool().describe()
    expect(d.name).toBe('whoami')
    expect(d.risk).toBe('safe')
  })
})
