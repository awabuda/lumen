/**
 * P28.1 (bug.md #10 Path A) \u2014 `computer_use` tool tests.
 *
 * Pins the data-layer surface. Tests use an in-memory
 * fake provider (no real Playwright launch). The live
 * Playwright provider is exercised by a separate
 * LUMEN_BROWSER_E2E-gated test (mirroring the P24.1
 * pattern).
 */

import { describe, expect, it } from 'vitest'

import {
  ComputerUseInputSchema,
  ComputerUseTool,
  PlaywrightComputerUseProvider,
  type ComputerUseProvider,
} from '../src/computer-use/index.js'

// ---------------------------------------------------------------------------
// In-memory fake
// ---------------------------------------------------------------------------

interface FakeCall {
  readonly method: string
  readonly args: unknown[]
}

const makeFakeProvider = (): {
  provider: ComputerUseProvider
  calls: FakeCall[]
  setNextScreenshot: (data: string, width: number, height: number) => void
} => {
  const calls: FakeCall[] = []
  let nextShot = { data: 'AAAA', width: 800, height: 600 }
  const provider: ComputerUseProvider = {
    async launch(args) {
      calls.push({ method: 'launch', args: [args] })
    },
    async close() {
      calls.push({ method: 'close', args: [] })
    },
    async screenshot(opts) {
      calls.push({ method: 'screenshot', args: [opts] })
      return nextShot
    },
    async click(opts) {
      calls.push({ method: 'click', args: [opts] })
    },
    async type(text) {
      calls.push({ method: 'type', args: [text] })
    },
    async press(key) {
      calls.push({ method: 'press', args: [key] })
    },
    async move(opts) {
      calls.push({ method: 'move', args: [opts] })
    },
    async scroll(opts) {
      calls.push({ method: 'scroll', args: [opts] })
    },
  }
  return {
    provider,
    calls,
    setNextScreenshot: (data, width, height) => {
      nextShot = { data, width, height }
    },
  }
}

const ctx = (): {
  cwd: string
  signal: AbortSignal
  sessionId: string
} => ({ cwd: '/tmp', signal: new AbortController().signal, sessionId: 's' })

// ---------------------------------------------------------------------------
// Schema tests
// ---------------------------------------------------------------------------

describe('P28.1 \u2014 ComputerUseInputSchema', () => {
  it('rejects a non-positive coordinate', () => {
    const r = ComputerUseInputSchema.safeParse({ op: 'click', x: -1, y: 0 })
    expect(r.success).toBe(false)
  })

  it('rejects a non-string key for op="key"', () => {
    const r = ComputerUseInputSchema.safeParse({ op: 'key', key: 42 })
    expect(r.success).toBe(false)
  })

  it('rejects a missing x / y on op="scroll"', () => {
    const r = ComputerUseInputSchema.safeParse({
      op: 'scroll',
      dx: 0,
      dy: 100,
    })
    expect(r.success).toBe(false)
  })

  it('accepts a full screenshot op', () => {
    const r = ComputerUseInputSchema.safeParse({
      op: 'screenshot',
      fullPage: true,
    })
    expect(r.success).toBe(true)
  })

  it('rejects an unknown op', () => {
    const r = ComputerUseInputSchema.safeParse({
      op: 'teleport',
      x: 0,
      y: 0,
    })
    expect(r.success).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Tool behaviour tests (fake provider)
// ---------------------------------------------------------------------------

describe('P28.1 \u2014 ComputerUseTool (with fake provider)', () => {
  it('screenshot returns the base64 data + viewport size', async () => {
    const { provider, calls, setNextScreenshot } = makeFakeProvider()
    setNextScreenshot('BASE64BYTES', 1920, 1080)
    const tool = new ComputerUseTool({ provider })
    const out = await tool.call({ op: 'screenshot' }, ctx())
    expect(out.op).toBe('screenshot')
    expect(out.screenshot).toBe('BASE64BYTES')
    expect(out.width).toBe(1920)
    expect(out.height).toBe(1080)
    expect(typeof out.durationMs).toBe('number')
    expect(calls.find((c) => c.method === 'screenshot')).toBeDefined()
  })

  it('click routes (x, y) to provider.click with the right shape', async () => {
    const { provider, calls } = makeFakeProvider()
    const tool = new ComputerUseTool({ provider })
    await tool.call({ op: 'click', x: 100, y: 200 }, ctx())
    const click = calls.find((c) => c.method === 'click')
    expect(click).toBeDefined()
    const args = click?.args[0] as { x: number; y: number; button?: string }
    expect(args.x).toBe(100)
    expect(args.y).toBe(200)
  })

  it('click honours the optional button field', async () => {
    const { provider, calls } = makeFakeProvider()
    const tool = new ComputerUseTool({ provider })
    await tool.call(
      { op: 'click', x: 0, y: 0, button: 'right' },
      ctx(),
    )
    const click = calls.find((c) => c.method === 'click')
    const args = click?.args[0] as { button?: string }
    expect(args.button).toBe('right')
  })

  it('type routes the text payload to provider.type', async () => {
    const { provider, calls } = makeFakeProvider()
    const tool = new ComputerUseTool({ provider })
    await tool.call({ op: 'type', text: 'hello world' }, ctx())
    const type = calls.find((c) => c.method === 'type')
    expect(type?.args[0]).toBe('hello world')
  })

  it('key routes the key name to provider.press', async () => {
    const { provider, calls } = makeFakeProvider()
    const tool = new ComputerUseTool({ provider })
    await tool.call({ op: 'key', key: 'Enter' }, ctx())
    const press = calls.find((c) => c.method === 'press')
    expect(press?.args[0]).toBe('Enter')
  })

  it('scroll calls provider.scroll with the right (x, y, dx, dy) shape', async () => {
    const { provider, calls } = makeFakeProvider()
    const tool = new ComputerUseTool({ provider })
    await tool.call(
      { op: 'scroll', x: 100, y: 100, dx: 0, dy: 200 },
      ctx(),
    )
    const scroll = calls.find((c) => c.method === 'scroll')
    const args = scroll?.args[0] as { x: number; y: number; dx: number; dy: number }
    expect(args.x).toBe(100)
    expect(args.y).toBe(100)
    expect(args.dx).toBe(0)
    expect(args.dy).toBe(200)
  })
})

// ---------------------------------------------------------------------------
// Provider factory shape (mirrors the P24.1 pattern).
// ---------------------------------------------------------------------------

describe('P28.1 \u2014 PlaywrightComputerUseProvider (factory shape)', () => {
  it('returns a ComputerUseProvider implementing all 7 methods', () => {
    const p = PlaywrightComputerUseProvider()
    expect(typeof p.launch).toBe('function')
    expect(typeof p.close).toBe('function')
    expect(typeof p.screenshot).toBe('function')
    expect(typeof p.click).toBe('function')
    expect(typeof p.type).toBe('function')
    expect(typeof p.press).toBe('function')
    expect(typeof p.move).toBe('function')
    expect(typeof p.scroll).toBe('function')
  })

  // Live launch is gated on LUMEN_BROWSER_E2E=1 + a
  // Chromium executable on disk. Default off so CI stays
  // hermetic. Mirrors the P24.1 web_browser test pattern.
  it.skipIf(!process.env['LUMEN_BROWSER_E2E'])(
    'live launch + screenshot when LUMEN_BROWSER_E2E=1',
    async () => {
      const p = PlaywrightComputerUseProvider()
      try {
        await p.launch({})
        const shot = await p.screenshot({})
        expect(shot.width).toBeGreaterThan(0)
        expect(shot.height).toBeGreaterThan(0)
      } finally {
        await p.close()
      }
    },
    30_000,
  )
})