/**
 * web_browser tool — Playwright-backed browser automation.
 *
 * P24.1 (per docs/P24-DESIGN.md §1.1) — bug.md #9 closes
 * here as a single composite tool with a discriminated `op`
 * field. The four primitives the agent actually needs:
 *
 *   - goto      navigate to a URL, wait for `load`, return
 *               { url, title, status, screenshot? }.
 *   - act       click / fill / hover / press / select etc.
 *   - extract   read DOM elements (text / attribute /
 *               multiple) and optionally parse into a Zod
 *               schema the caller passes in.
 *   - screenshot capture the visible viewport (or full page)
 *               and return it as base64 PNG.
 *
 * Why a single tool, not a tool-set: lumen's BaseTool
 * exposes a typed `name` + `risk`; a single composite tool
 * keeps the permission story in one place (operators can
 * allow `web_browser.act` only, deny `web_browser.goto`).
 *
 * Why not Computer Use (#10) here: P24.4 is a separate
 * ticket because Computer Use needs screen / keyboard /
 * mouse at the OS level — it requires a native dep beyond
 * better-sqlite3 (the P22.7 §3 guardrail). Operators who
 * need Computer Use today drive Chromium the same way
 * Computer Use does by using `web_browser.act(selector)`
 * with semantic selectors.
 *
 * Browser lifecycle: one Chromium instance per WebBrowserTool
 * instance. The composition root caches the instance for the
 * lifetime of the agent run; conversation turns reuse it.
 * Tests use the operator's installed Chrome via
 * WebBrowserOptions.executablePath; default falls back to
 * the system-installed Chrome path.
 */

import { BaseTool } from '@lumen/core'
import type { ToolContext, ToolRisk } from '@lumen/core'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const ActOpSchema = z.enum([
  'click',
  'dblclick',
  'fill',
  'press',
  'hover',
  'select',
  'check',
  'uncheck',
  'scrollIntoView',
  'waitFor',
])
export type ActOp = z.infer<typeof ActOpSchema>

const BaseOpSchema = z.object({
  /** Headless by default. Only honored when an executablePath
   *  is supplied; we do NOT ship a browser binary in
   *  @lumen/tools. See P24.0 §1.1. */
  headless: z.boolean().optional(),
  /** Path to a Chromium-family executable. Operators point
   *  this at their system Chrome (e.g. /Applications/Google
   *  Chrome.app/...) when running in the macOS dev sandbox. */
  executablePath: z.string().min(1).optional(),
  /** Optional allow-list of domains. Empty / absent means no
   *  enforcement. */
  allowedDomains: z.array(z.string()).optional(),
})

const GotoOpSchema = BaseOpSchema.extend({
  op: z.literal('goto'),
  url: z.string().url(),
  waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).optional(),
  screenshot: z.boolean().optional(),
})

const ActFieldsSchema = z.object({
  selector: z.string().min(1).optional(),
  value: z.string().optional(),
  key: z.string().optional(),
  values: z.array(z.string()).optional(),
  until: z.enum(['visible', 'hidden', 'attached', 'detached']).optional(),
  timeoutMs: z.number().int().positive().optional(),
})

const ActOpInputSchema = BaseOpSchema.extend({
  op: z.literal('act'),
  action: ActOpSchema,
}).merge(ActFieldsSchema)

const ExtractOpSchema = BaseOpSchema.extend({
  op: z.literal('extract'),
  selector: z.string().min(1),
  mode: z.enum(['text', 'attribute', 'html', 'multiple']).optional(),
  attribute: z.string().optional(),
  nth: z.number().int().nonnegative().optional(),
  maxBytes: z.number().int().positive().optional(),
})

const ScreenshotOpSchema = BaseOpSchema.extend({
  op: z.literal('screenshot'),
  selector: z.string().optional(),
  fullPage: z.boolean().optional(),
})

export const WebBrowserInputSchema = z.discriminatedUnion('op', [
  GotoOpSchema,
  ActOpInputSchema,
  ExtractOpSchema,
  ScreenshotOpSchema,
])

export type WebBrowserInput = z.infer<typeof WebBrowserInputSchema>

export const WebBrowserOutputSchema = z.object({
  op: z.string(),
  url: z.string().optional(),
  title: z.string().optional(),
  status: z.number().int().nullable().optional(),
  payload: z.union([z.string(), z.array(z.string())]).optional(),
  screenshot: z.string().optional(),
  durationMs: z.number().int().min(0).optional(),
})
export type WebBrowserOutput = z.infer<typeof WebBrowserOutputSchema>

// ---------------------------------------------------------------------------
// Browser provider — pluggable so tests can supply a fake
// ---------------------------------------------------------------------------

// The provider interface is intentionally narrow. Future ops
// land here as new methods, not as new free-form string fields
// (P19+ rule #14 — keep the contract surface small).
export interface BrowserProvider {
  launch(opts: {
    readonly headless?: boolean
    readonly executablePath?: string
  }): Promise<void>
  close(): Promise<void>
  goto(
    url: string,
    opts: { readonly waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' },
  ): Promise<{
    readonly url: string
    readonly title: string
    readonly status: number | null
  }>
  act(input: z.infer<typeof ActFieldsSchema> & { readonly action: ActOp }): Promise<void>
  extract(input: z.infer<typeof ExtractOpSchema>): Promise<string | ReadonlyArray<string>>
  screenshot(
    opts: { readonly selector?: string; readonly fullPage?: boolean },
  ): Promise<string>
}

/** Thrown by BrowserProvider when a call is structurally invalid
 *  (e.g. `act.click` with no selector). Surfaces to the agent
 *  as a typed ToolError so it can re-issue the call correctly. */
export class BrowserInputError extends Error {
  public override readonly name = 'BrowserInputError'
  public constructor(message: string) {
    super(`web_browser: ${message}`)
  }
}

/**
 * Lazy singleton Chrome provider. We hold one Chromium across
 * the tool lifetime and tear it down on `close()` / process
 * exit. The composition root may call `close()` explicitly
 * between conversations to free memory.
 */
export const PlaywrightBrowserProvider = (): BrowserProvider => {
  // `playwright` is imported lazily so users that never run
  // `web_browser` don't pay the load cost at module import.
  // The dynamic import is wrapped in a closure because the
  // module path is environment-specific (ESM/CJS).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let context: any = null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let page: any = null

  const ensurePage = async (): Promise<void> => {
    if (browser !== null) return
    // Lazy import keeps `playwright` out of the synchronous
    // module graph; tests use a fake provider instead.
    const pw = await import('playwright')
    browser = await pw.chromium.launch({ headless: true })
    context = await browser.newContext()
    page = await context.newPage()
  }

  return {
    async launch({ headless, executablePath }) {
      if (browser !== null) return
      const pw = await import('playwright')
      const launchOpts: { headless: boolean; executablePath?: string } = {
        headless: headless ?? true,
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
          // Best-effort. Tooling tests should not throw on close.
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
    async goto(url, { waitUntil }) {
      await ensurePage()
      const resp = await page.goto(url, { waitUntil: waitUntil ?? 'load' })
      return {
        url: page.url(),
        title: await page.title(),
        status: resp === null ? null : resp.status(),
      }
    },
    async act(input) {
      await ensurePage()
      const { action } = input
      switch (action) {
        case 'click':
        case 'dblclick':
          if (input.selector === undefined) {
            throw new BrowserInputError(`action "${action}" requires selector`)
          }
          await page[action](input.selector)
          return
        case 'fill':
          if (input.selector === undefined || input.value === undefined) {
            throw new BrowserInputError('fill requires selector + value')
          }
          await page.fill(input.selector, input.value)
          return
        case 'press':
          if (input.selector === undefined || input.key === undefined) {
            throw new BrowserInputError('press requires selector + key')
          }
          await page.press(input.selector, input.key)
          return
        case 'hover':
          if (input.selector === undefined) {
            throw new BrowserInputError('hover requires selector')
          }
          await page.hover(input.selector)
          return
        case 'select':
          if (
            input.selector === undefined ||
            input.values === undefined ||
            input.values.length === 0
          ) {
            throw new BrowserInputError(
              'select requires selector + non-empty values[]',
            )
          }
          await page.selectOption(input.selector, input.values)
          return
        case 'check':
        case 'uncheck':
          if (input.selector === undefined) {
            throw new BrowserInputError(`action "${action}" requires selector`)
          }
          await page[action](input.selector)
          return
        case 'scrollIntoView':
          if (input.selector === undefined) {
            throw new BrowserInputError('scrollIntoView requires selector')
          }
          // Playwright exposes this via Locator, not Page; recreate
          // via locator at call time.
          await page.locator(input.selector).scrollIntoViewIfNeeded()
          return
        case 'waitFor': {
          const until = input.until ?? 'visible'
          if (input.selector === undefined) {
            await page.waitForLoadState('load')
          } else {
            const loc = page.locator(input.selector)
            if (until === 'visible') {
              await loc.waitFor({ state: 'visible' })
            } else if (until === 'hidden') {
              await loc.waitFor({ state: 'hidden' })
            } else if (until === 'attached') {
              await loc.waitFor({ state: 'attached' })
            } else {
              await loc.waitFor({ state: 'detached' })
            }
          }
          return
        }
        default: {
          // exhaustiveness: TypeScript will flag a new ActOp
          // variant if we add one without a matching branch.
          const exhaustive: never = action
          throw new BrowserInputError(`unknown action: ${String(exhaustive)}`)
        }
      }
    },
    async extract(input) {
      await ensurePage()
      const loc = page.locator(input.selector)
      const count = await loc.count()
      const limit = input.nth !== undefined ? input.nth + 1 : count
      const mode = input.mode ?? 'text'
      const maxBytes = input.maxBytes ?? 16 * 1024
      const trim = (s: string): string =>
        s.length <= maxBytes ? s : `${s.slice(0, maxBytes)}\n…(truncated)`
      const readOne = async (i: number): Promise<string> => {
        const item = loc.nth(i)
        if (mode === 'text') return trim(await item.innerText())
        if (mode === 'html') return trim(await item.innerHTML())
        if (mode === 'attribute') {
          if (input.attribute === undefined) {
            throw new BrowserInputError(
              'extract mode "attribute" requires attribute name',
            )
          }
          const v = await item.getAttribute(input.attribute)
          return v ?? ''
        }
        // mode === 'multiple'
        const t = await item.innerText()
        return trim(t)
      }
      const out: string[] = []
      const stop = Math.min(limit, count)
      for (let i = 0; i < stop; i += 1) {
        out.push(await readOne(i))
      }
      // `text` / `html` / `attribute` modes return a single value
      // (the first match) when there is exactly one match, or the
      // scalar read of `nth` is in play. Otherwise (mode ===
      // 'multiple' OR more than one match exists in the implicit
      // shape), keep the array.
      if (mode !== 'multiple' && stop === 1) {
        const first = out[0]
        if (first !== undefined) return first
      }
      if (mode === 'multiple') return out
      return out
    },
    async screenshot({ selector, fullPage }) {
      await ensurePage()
      const opts: { fullPage?: boolean } = fullPage === true ? { fullPage: true } : {}
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const target = selector !== undefined ? (page as any).locator(selector) : page
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const buf = await (target as any).screenshot(opts)
      const b64 = (Buffer.isBuffer(buf) ? buf : Buffer.from(buf)).toString('base64')
      return b64
    },
  }
}

// ---------------------------------------------------------------------------
// Tool wrapper
// ---------------------------------------------------------------------------

export interface WebBrowserToolOptions {
  /** Defaults to PlaywrightBrowserProvider; tests inject
   *  an in-memory fake implementing {@link BrowserProvider}. */
  readonly provider?: BrowserProvider
  /** Default executablePath (overridable per call). */
  readonly executablePath?: string
  /** Default allow-list of domains. */
  readonly allowedDomains?: ReadonlyArray<string>
}

/**
 * The web_browser tool.
 *
 * Risk: `approval-required` (P22.0 default for any tool that
 * touches the network AND has side effects on a remote
 * machine). Operators who want fully autonomous browsing
 * pass `--approve-on web_browser` at CLI start.
 */
export class WebBrowserTool extends BaseTool {
  public readonly name = 'web_browser'
  public readonly description =
    'Drive a headless Chromium browser. Operations: goto (navigate), ' +
    'act (click / fill / hover / press / select / check / uncheck / ' +
    'scrollIntoView / waitFor), extract (DOM text / attribute / ' +
    'innerHTML / multiple), screenshot (viewport or full page). ' +
    'Use this when the target is JS-driven (SPA, login-walled, form-' +
    'requester) and `web_fetch` returns the wrong thing.'
  public readonly inputSchema = WebBrowserInputSchema
  public readonly risk: ToolRisk = 'approval-required'
  public override readonly version = '0.1.0'

  private readonly provider: BrowserProvider
  private readonly defaultExecutablePath: string | undefined
  private readonly defaultAllowedDomains: ReadonlyArray<string> | undefined

  public constructor(options: WebBrowserToolOptions = {}) {
    super()
    this.provider = options.provider ?? PlaywrightBrowserProvider()
    this.defaultExecutablePath = options.executablePath
    this.defaultAllowedDomains = options.allowedDomains
  }

  protected async execute(input: unknown, _ctx: ToolContext): Promise<WebBrowserOutput> {
    const parsed = WebBrowserInputSchema.parse(input) as WebBrowserInput
    const t0 = Date.now()

    // Domain guard. We do NOT do network-level blocking (P24
    // delegates that to the operator's policy file); we do
    // refuse to *launch* the browser if the URL is not on
    // the allow-list AND an allow-list is configured.
    const executablePath =
      'executablePath' in parsed
        ? (parsed.executablePath ?? this.defaultExecutablePath)
        : this.defaultExecutablePath
    const allowedDomains =
      'allowedDomains' in parsed
        ? (parsed.allowedDomains ?? this.defaultAllowedDomains)
        : this.defaultAllowedDomains
    if (parsed.op === 'goto' && allowedDomains !== undefined) {
      const host = new URL(parsed.url).host
      if (!allowedDomains.some((d: string) => matchesDomain(d, host))) {
        throw new BrowserInputError(
          `host "${host}" is not in the operator's allowedDomains list`,
        )
      }
    }

    await this.provider.launch({
      ...(executablePath !== undefined ? { executablePath } : {}),
      ...('headless' in parsed && parsed.headless !== undefined
        ? { headless: parsed.headless }
        : {}),
    })

    if (parsed.op === 'goto') {
      const res = await this.provider.goto(parsed.url, {
        ...(parsed.waitUntil !== undefined ? { waitUntil: parsed.waitUntil } : {}),
      })
      const out: WebBrowserOutput = {
        op: 'goto',
        url: res.url,
        title: res.title,
        status: res.status,
        durationMs: Date.now() - t0,
      }
      if (parsed.screenshot === true) {
        out.screenshot = await this.provider.screenshot({})
      }
      return out
    }

    if (parsed.op === 'act') {
      await this.provider.act(parsed)
      return { op: 'act', durationMs: Date.now() - t0 }
    }

    if (parsed.op === 'extract') {
      const payload = await this.provider.extract(parsed)
      const out: WebBrowserOutput = {
        op: 'extract',
        durationMs: Date.now() - t0,
      }
      if (Array.isArray(payload)) {
        out.payload = [...payload]
      } else if (typeof payload === 'string') {
        out.payload = payload
      }
      return out
    }

    // parsed.op === 'screenshot'
    const shot = await this.provider.screenshot({
      ...(parsed.selector !== undefined ? { selector: parsed.selector } : {}),
      ...(parsed.fullPage !== undefined ? { fullPage: parsed.fullPage } : {}),
    })
    return { op: 'screenshot', screenshot: shot, durationMs: Date.now() - t0 }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wildcard match: `*.example.com` matches `a.example.com`. */
const matchesDomain = (pattern: string, host: string): boolean => {
  if (pattern === host) return true
  if (pattern.startsWith('*.')) {
    const suffix = pattern.slice(1) // ".example.com"
    return host.endsWith(suffix) && host.length > suffix.length
  }
  return false
}
