/** Tests for the logging contract. */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConsoleLogger, PinoLogger } from '../src/logging/index.js'

let stderr = ''

beforeEach(() => {
  stderr = ''
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk)
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ConsoleLogger', () => {
  it('writes info-level messages to stderr', () => {
    const logger = new ConsoleLogger()
    logger.info('hello')
    expect(stderr).toContain('[INFO]')
    expect(stderr).toContain('hello')
  })

  it('suppresses debug messages at default minLevel=info', () => {
    const logger = new ConsoleLogger()
    logger.debug('secret')
    expect(stderr).toBe('')
  })

  it('shows debug messages when minLevel=debug', () => {
    const logger = new ConsoleLogger({}, 'debug')
    logger.debug('visible')
    expect(stderr).toContain('[DEBUG]')
    expect(stderr).toContain('visible')
  })

  it('includes context as JSON', () => {
    const logger = new ConsoleLogger()
    logger.info('ctx', { foo: 42 })
    expect(stderr).toContain('"foo":42')
  })

  it('includes bindings in the prefix', () => {
    const logger = new ConsoleLogger({ component: 'agent' })
    logger.info('bound')
    expect(stderr).toContain('[component=agent]')
  })

  it('child inherits parent bindings', () => {
    const parent = new ConsoleLogger({ app: 'lumen' })
    const child = parent.child({ component: 'tools' })
    child.info('child msg')
    expect(stderr).toContain('[app=lumen')
    expect(stderr).toContain('component=tools')
  })

  it('warn and error levels work', () => {
    const logger = new ConsoleLogger({}, 'debug')
    logger.warn('careful')
    logger.error('boom')
    expect(stderr).toContain('[WARN]')
    expect(stderr).toContain('[ERROR]')
  })
})

describe('PinoLogger', () => {
  it('falls back with a warning when pino is not installed', async () => {
    const logger = new PinoLogger()
    await logger.init()
    // Should not throw; pino not installed so instance is null.
    // A one-time warning is emitted to stderr.
    logger.info('should not throw')
    expect(stderr).toContain('pino not installed')
  })

  it('child returns a PinoLogger', () => {
    const parent = new PinoLogger()
    const child = parent.child({ scope: 'test' })
    expect(child.id).toBe('pino')
  })
})
