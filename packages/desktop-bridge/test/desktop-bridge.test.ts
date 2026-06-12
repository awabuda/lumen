/** Tests for @lumen/desktop-bridge. */

import { describe, expect, it } from 'vitest'
import {
  BaseDesktopAdapter,
  MockDesktopAdapter,
  NotificationRequestSchema,
  SystemStatusSchema,
  TauriDesktopAdapter,
  ToolInvokeRequestSchema,
  ToolInvokeResponseSchema,
  type SystemStatus,
} from '../src/index.js'

describe('SystemStatusSchema', () => {
  it('accepts a valid status', () => {
    expect(
      SystemStatusSchema.safeParse({ os: 'macos', online: true }).success,
    ).toBe(true)
  })

  it('rejects unknown OS values', () => {
    expect(
      SystemStatusSchema.safeParse({ os: 'plan9', online: true }).success,
    ).toBe(false)
  })

  it('rejects negative disk space', () => {
    expect(
      SystemStatusSchema.safeParse({ os: 'linux', online: true, diskFreeMb: -1 })
        .success,
    ).toBe(false)
  })
})

describe('ToolInvokeRequestSchema', () => {
  it('requires a name', () => {
    expect(ToolInvokeRequestSchema.safeParse({ input: {} }).success).toBe(false)
    expect(ToolInvokeRequestSchema.safeParse({ name: 'x', input: {} }).success).toBe(true)
  })
})

describe('ToolInvokeResponseSchema', () => {
  it('requires success and durationMs', () => {
    expect(
      ToolInvokeResponseSchema.safeParse({ success: true, durationMs: 100 }).success,
    ).toBe(true)
  })

  it('rejects negative duration', () => {
    expect(
      ToolInvokeResponseSchema.safeParse({ success: true, durationMs: -1 }).success,
    ).toBe(false)
  })
})

describe('NotificationRequestSchema', () => {
  it('requires title and body', () => {
    expect(NotificationRequestSchema.safeParse({}).success).toBe(false)
    expect(
      NotificationRequestSchema.safeParse({ title: 't', body: 'b' }).success,
    ).toBe(true)
  })
})

describe('BaseDesktopAdapter is abstract', () => {
  it('cannot be instantiated directly', () => {
    // @ts-expect-error — abstract class
    new (BaseDesktopAdapter as any)()
  })
})

describe('MockDesktopAdapter', () => {
  it('returns default status', async () => {
    const adapter = new MockDesktopAdapter()
    const status = await adapter.getSystemStatus()
    expect(status.os).toBe('macos')
    expect(status.online).toBe(true)
  })

  it('returns custom status', async () => {
    const status: SystemStatus = { os: 'linux', online: false }
    const adapter = new MockDesktopAdapter({ status })
    expect(await adapter.getSystemStatus()).toEqual(status)
  })

  it('records notify calls', async () => {
    const adapter = new MockDesktopAdapter()
    await adapter.notify({ title: 't', body: 'b' })
    expect(adapter.notificationCount).toBe(1)
  })

  it('returns pre-programmed tool response', async () => {
    const adapter = new MockDesktopAdapter({
      toolResponses: { read_file: { contents: 'hello' } },
    })
    const res = await adapter.invokeTool({ name: 'read_file', input: { path: '/x' } })
    expect(res.success).toBe(true)
    expect(res.output).toEqual({ contents: 'hello' })
    expect(adapter.invocationCount).toBe(1)
  })

  it('echoes input for unrecognised tools', async () => {
    const adapter = new MockDesktopAdapter()
    const res = await adapter.invokeTool({ name: 'unknown', input: { a: 1 } })
    expect(res.output).toEqual({ echo: { a: 1 } })
  })

  it('captures errors as failed responses (no swallow)', async () => {
    const adapter = new MockDesktopAdapter({ error: new Error('boom') })
    const res = await adapter.invokeTool({ name: 'x', input: {} })
    expect(res.success).toBe(false)
    expect(res.error).toBe('boom')
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('exposes id "mock" and isProduction=false', () => {
    const adapter = new MockDesktopAdapter()
    expect(adapter.id).toBe('mock')
    expect(adapter.isProduction).toBe(false)
  })

  it('subscribe returns a no-op unsubscribe', () => {
    const adapter = new MockDesktopAdapter()
    const unsub = adapter.subscribe(() => {})
    expect(typeof unsub).toBe('function')
    expect(() => unsub()).not.toThrow()
  })

  it('setStatus updates subsequent getSystemStatus', async () => {
    const adapter = new MockDesktopAdapter()
    adapter.setStatus({ os: 'windows', online: false })
    expect((await adapter.getSystemStatus()).os).toBe('windows')
  })
})

describe('TauriDesktopAdapter', () => {
  const makeInvoke = (impl: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>) => ({
    invoke: impl,
  })

  it('exposes id "tauri" and isProduction=true', () => {
    const adapter = new TauriDesktopAdapter({
      invoke: makeInvoke(async () => undefined),
    })
    expect(adapter.id).toBe('tauri')
    expect(adapter.isProduction).toBe(true)
  })

  it('getSystemStatus calls the right command and parses the response', async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
    const adapter = new TauriDesktopAdapter({
      invoke: makeInvoke(async (cmd, args) => {
        calls.push({ cmd, ...(args ? { args } : {}) })
        return { os: 'macos', online: true, diskFreeMb: 100 }
      }),
    })
    const status = await adapter.getSystemStatus()
    expect(status.os).toBe('macos')
    expect(status.diskFreeMb).toBe(100)
    expect(calls[0]?.cmd).toBe('lumen_system_status')
  })

  it('notify validates the request and calls lumen_notify', async () => {
    const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = []
    const adapter = new TauriDesktopAdapter({
      invoke: makeInvoke(async (cmd, args) => {
        calls.push({ cmd, ...(args ? { args } : {}) })
        return undefined
      }),
    })
    await adapter.notify({ title: 'hi', body: 'world' })
    expect(calls[0]?.cmd).toBe('lumen_notify')
    expect(calls[0]?.args?.request).toEqual({ title: 'hi', body: 'world' })
  })

  it('rejects an invalid notify payload before invoking', async () => {
    const adapter = new TauriDesktopAdapter({
      invoke: makeInvoke(async () => undefined),
    })
    // @ts-expect-error — testing bad payload
    await expect(adapter.notify({})).rejects.toThrow()
  })

  it('invokeTool success path returns success + output', async () => {
    const adapter = new TauriDesktopAdapter({
      invoke: makeInvoke(async () => ({ ok: 1 })),
    })
    const res = await adapter.invokeTool({ name: 'ping', input: { x: 1 } })
    expect(res.success).toBe(true)
    expect(res.output).toEqual({ ok: 1 })
    expect(res.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('invokeTool failure path captures the error', async () => {
    const adapter = new TauriDesktopAdapter({
      invoke: makeInvoke(async () => {
        throw new Error('rust-panic')
      }),
    })
    const res = await adapter.invokeTool({ name: 'x', input: {} })
    expect(res.success).toBe(false)
    expect(res.error).toBe('rust-panic')
  })

  it('validates invoke options at construction time', () => {
    expect(
      () =>
        // @ts-expect-error — testing missing invoke
        new TauriDesktopAdapter({}),
    ).toThrow()
  })
})