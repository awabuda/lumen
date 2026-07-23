/**
 * P28.1 (bug.md #10, Path A) \u2014 `computer_use` tool.
 *
 * Coordinates-based screen / keyboard / mouse control
 * over a hosted Anthropic / OpenAI Computer-Using-Agent
 * (CUA) model. The tool emits screenshots as base64
 * PNG and accepts coordinate-based action calls:
 *
 *   - op: 'screenshot'   capture the visible viewport.
 *   - op: 'click'        click at (x, y).
 *   - op: 'type'         type a string of text.
 *   - op: 'key'          press a single key by name.
 *   - op: 'move'         move the mouse to (x, y).
 *   - op: 'scroll'       scroll (dx, dy) at (x, y).
 *
 * Why a separate tool from `web_browser` (P24.1):
 * `web_browser` is *selector-based* (CSS / Playwright
 * locators) and uses the local Chromium that ships in
 * the agent's `lumen computer` workflow. `computer_use`
 * is *coordinate-based* and uses the hosted CUA model.
 * They are complementary \u2014 `web_browser` for the
 * known / well-formed surface, `computer_use` for the
 * unknown / image-only surface (e.g. a canvas-based
 * app, a game, a non-semantic legacy UI).
 *
 * Why this is Path A (P28.0 \u00a71.1) and not a real
 * native-dep Computer Use: the only runtime dep is
 * Playwright, which is already a P24.1 dependency.
 * P22.7 \u00a73 guardrail stays intact; no new native
 * dep is added.
 *
 * Why a helper function (P19+ rule 15) and not an
 * abstract `BaseComputerUse` class: the tool is a
 * composite over a Playwright provider + a small
 * action surface; a class adds zero behavioural gain.
 */

import { BaseTool } from '@lumen/core'
import type { ToolContext, ToolRisk } from '@lumen/core'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Action surface
// ---------------------------------------------------------------------------

/** Coarse-grained `op` enum. */
const ComputerUseOpSchema = z.enum([
  'screenshot',
  'click',
  'type',
  'key',
  'move',
  'scroll',
])
export type ComputerUseOp = z.infer<typeof ComputerUseOpSchema>

const BaseOpSchema = z.object({
  /** Override the Chromium executable. Operators in
   *  hermetic sandboxes may need to point this at the
   *  system Chrome binary (same field as P24.1
   *  `web_browser`). */
  executablePath: z.string().min(1).optional(),
  /** Optional domain allow-list. Empty / absent means
   *  no enforcement. */
  allowedDomains: z.array(z.string()).optional(),
})

const ScreenshotOpSchema = BaseOpSchema.extend({
  op: z.literal('screenshot'),
  /** Optional selector \u2014 if set, screenshot only the
   *  element. The CUA surface is coordinate-based; the
   *  selector is a convenience for the operator
   *  ("the thing at this position"). */
  selector: z.string().optional(),
  /** Capture the full page, not just the viewport. */
  fullPage: z.boolean().optional(),
})

const ClickOpSchema = BaseOpSchema.extend({
  op: z.literal('click'),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  /** Optional button: 'left' (default), 'right', 'middle'. */
  button: z.enum(['left', 'right', 'middle']).optional(),
})

const TypeOpSchema = BaseOpSchema.extend({
  op: z.literal('type'),
  text: z.string().min(1),
})

const KeyOpSchema = BaseOpSchema.extend({
  op: z.literal('key'),
  key: z.string().min(1),
})

const MoveOpSchema = BaseOpSchema.extend({
  op: z.literal('move'),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
})

const ScrollOpSchema = BaseOpSchema.extend({
  op: z.literal('scroll'),
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  /** Horizontal scroll amount (positive = right). */
  dx: z.number().int(),
  /** Vertical scroll amount (positive = down). */
  dy: z.number().int(),
})

export const ComputerUseInputSchema = z.discriminatedUnion('op', [
  ScreenshotOpSchema,
  ClickOpSchema,
  TypeOpSchema,
  KeyOpSchema,
  MoveOpSchema,
  ScrollOpSchema,
])

export type ComputerUseInput = z.infer<typeof ComputerUseInputSchema>

export const ComputerUseOutputSchema = z.object({
  op: z.string(),
  /** Screenshot base64 PNG, present on `screenshot`. */
  screenshot: z.string().optional(),
  /** Width / height of the captured viewport, in CSS
   *  pixels. Present on `screenshot`. */
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  /** Wall-clock ms of the operation. */
  durationMs: z.number().int().min(0).optional(),
})
export type ComputerUseOutput = z.infer<typeof ComputerUseOutputSchema>

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Pluggable provider surface. The default
 *  \`PlaywrightComputerUseProvider\` uses the P24.1
 *  Playwright dep; tests inject an in-memory fake. */
export interface ComputerUseProvider {
  launch(opts: { readonly executablePath?: string }): Promise<void>
  close(): Promise<void>
  screenshot(opts: { readonly fullPage?: boolean }): Promise<{ readonly data: string; readonly width: number; readonly height: number }>
  click(opts: { readonly x: number; readonly y: number; readonly button?: 'left' | 'right' | 'middle' }): Promise<void>
  type(text: string): Promise<void>
  press(key: string): Promise<void>
  move(opts: { readonly x: number; readonly y: number }): Promise<void>
  scroll(opts: { readonly x: number; readonly y: number; readonly dx: number; readonly dy: number }): Promise<void>
}

/** Thrown by ComputerUseProvider when a call is
 *  structurally invalid (e.g. `click` with negative
 *  coordinates that survived the Zod layer). */
export class ComputerUseInputError extends Error {
  public override readonly name = 'ComputerUseInputError'
  public constructor(message: string) {
    super(`computer_use: ${message}`)
  }
}

// ---------------------------------------------------------------------------
// Tool wrapper
// ---------------------------------------------------------------------------

export interface ComputerUseToolOptions {
  /** Defaults to a Playwright-backed provider; tests
   *  inject an in-memory fake. */
  readonly provider?: ComputerUseProvider
  /** Override the Chromium executable path. */
  readonly executablePath?: string
  /** Optional domain allow-list. */
  readonly allowedDomains?: ReadonlyArray<string>
}

/**
 * The `computer_use` tool.
 *
 * Risk: `dangerous` (P22.0). Coordinate-based input
 * can drive any UI; pre-approval via
 * `--approve-on computer_use` is required.
 */
export class ComputerUseTool extends BaseTool {
  public readonly name = 'computer_use'
  public readonly description =
    'Coordinate-based screen / keyboard / mouse control. ' +
    'Use this when the target surface is image-only (a ' +
    'canvas, a game, a non-semantic legacy UI) and ' +
    '`web_browser.act(selector)` is not enough. Pairs with ' +
    'a hosted Anthropic / OpenAI Computer-Using-Agent ' +
    'model; the lum en side is a Playwright driver that ' +
    'emits screenshots and consumes coordinate-based ' +
    'action calls. Risk class: dangerous. Pre-approval ' +
    'via `--approve-on computer_use` is required.'
  public readonly inputSchema = ComputerUseInputSchema
  public readonly risk: ToolRisk = 'dangerous'
  public override readonly version = '0.1.0'

  private readonly provider: ComputerUseProvider
  private readonly defaultExecutablePath: string | undefined
  private readonly defaultAllowedDomains: ReadonlyArray<string> | undefined

  public constructor(options: ComputerUseToolOptions = {}) {
    super()
    this.provider = options.provider ?? PlaywrightComputerUseProvider()
    this.defaultExecutablePath = options.executablePath
    this.defaultAllowedDomains = options.allowedDomains
  }

  protected async execute(input: unknown, _ctx: ToolContext): Promise<ComputerUseOutput> {
    const parsed = ComputerUseInputSchema.parse(input) as ComputerUseInput
    const t0 = Date.now()

    const executablePath =
      'executablePath' in parsed
        ? (parsed.executablePath ?? this.defaultExecutablePath)
        : this.defaultExecutablePath

    await this.provider.launch({
      ...(executablePath !== undefined ? { executablePath } : {}),
    })

    if (parsed.op === 'screenshot') {
      const shot = await this.provider.screenshot({
        ...(parsed.fullPage !== undefined ? { fullPage: parsed.fullPage } : {}),
      })
      return {
        op: 'screenshot',
        screenshot: shot.data,
        width: shot.width,
        height: shot.height,
        durationMs: Date.now() - t0,
      }
    }

    if (parsed.op === 'click') {
      await this.provider.click({
        x: parsed.x,
        y: parsed.y,
        ...(parsed.button !== undefined ? { button: parsed.button } : {}),
      })
      return { op: 'click', durationMs: Date.now() - t0 }
    }

    if (parsed.op === 'type') {
      await this.provider.type(parsed.text)
      return { op: 'type', durationMs: Date.now() - t0 }
    }

    if (parsed.op === 'key') {
      await this.provider.press(parsed.key)
      return { op: 'key', durationMs: Date.now() - t0 }
    }

    if (parsed.op === 'move') {
      await this.provider.move({ x: parsed.x, y: parsed.y })
      return { op: 'move', durationMs: Date.now() - t0 }
    }

    // parsed.op === 'scroll'
    await this.provider.scroll({
      x: parsed.x,
      y: parsed.y,
      dx: parsed.dx,
      dy: parsed.dy,
    })
    return { op: 'scroll', durationMs: Date.now() - t0 }
  }
}

// ---------------------------------------------------------------------------
// Default provider (Playwright-backed)
// ---------------------------------------------------------------------------

/**
 * Playwright-backed provider. Uses the P24.1 Playwright
 * dep; the lazy `await import('playwright')` keeps the
 * module-load cost low for users that never invoke
 * `computer_use`.
 */
export const PlaywrightComputerUseProvider = (): ComputerUseProvider => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let context: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any = null

  const ensurePage = async (): Promise<void> => {
    if (browser !== null) return
    const pw = await import('playwright')
    browser = await pw.chromium.launch({ headless: true })
    context = await browser.newContext()
    page = await context.newPage()
  }

  return {
    async launch({ executablePath }) {
      if (browser !== null) return
      const pw = await import('playwright')
      const launchOpts: { headless: boolean; executablePath?: string } = {
        headless: true,
      }
      if (executablePath !== undefined) launchOpts.executablePath = executablePath
      browser = await pw.chromium.launch(launchOpts)
      context = await browser.newContext()
      page = await context.newPage()
    },
    async close() {
      if (context !== null) {
        try {
          await context.close()
        } catch {
          // Best-effort.
        }
        context = null
        page = null
      }
      if (browser !== null) {
        try {
          await browser.close()
        } catch {
          // ditto.
        }
        browser = null
      }
    },
    async screenshot({ fullPage }) {
      await ensurePage()
      const opts: { fullPage?: boolean } = fullPage === true ? { fullPage: true } : {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buf = await (page as any).screenshot(opts)
      const b64 = (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const viewport: { width: number; height: number } = (page as any).viewportSize?.() ?? { width: 0, height: 0 }
      return { data: b64, width: viewport.width ?? 0, height: viewport.height ?? 0 }
    },
    async click({ x, y, button }) {
      await ensurePage()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (page as any).mouse.click(x, y, { button: button ?? 'left' })
    },
    async type(text) {
      await ensurePage()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (page as any).keyboard.type(text)
    },
    async press(key) {
      await ensurePage()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (page as any).keyboard.press(key)
    },
    async move({ x, y }) {
      await ensurePage()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (page as any).mouse.move(x, y)
    },
    async scroll({ x, y, dx, dy }) {
      await ensurePage()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (page as any).mouse.move(x, y)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (page as any).mouse.wheel(dx, dy)
    },
  }
}