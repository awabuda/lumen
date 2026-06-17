/**
 * Web search tools.
 *
 * Two tools ship here:
 *   - {@link WebSearchTool} — return top N search results.
 *   - {@link WebFetchTool} — fetch a URL and return text content.
 *
 * Both delegate to pluggable backends:
 *   - {@link DuckDuckGoSearchProvider} — no API key, default.
 *   - {@link InMemorySearchProvider} — for tests.
 *
 * The CLI / Web / Desktop layers register whichever provider
 * they want at composition time. The tools themselves are
 * pure data + Zod schemas, with the provider injected.
 */

import { BaseTool, type ToolContext, ToolError, type ToolRisk, ValidationError } from '@lumen/core'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Backend abstraction
// ---------------------------------------------------------------------------

/** A single search result. */
export const SearchResultSchema = z.object({
  /** Title of the result. */
  title: z.string(),
  /** URL. */
  url: z.string().url(),
  /** Snippet / abstract. */
  snippet: z.string(),
})
export type SearchResult = z.infer<typeof SearchResultSchema>

/** A search provider — the contract every backend fulfills. */
export abstract class BaseSearchProvider {
  public abstract readonly id: string

  /**
   * Search the web and return up to `limit` results.
   * Throws on transport failure (Rule 7).
   */
  public abstract search(query: string, limit: number): Promise<ReadonlyArray<SearchResult>>

  /**
   * Fetch a URL and return its visible text. Throws on
   * transport failure.
   */
  public abstract fetch(url: string, maxBytes: number): Promise<string>
}

// ---------------------------------------------------------------------------
// DuckDuckGo provider — free, no API key
// ---------------------------------------------------------------------------

/** A minimal fetch implementation. */
type FetchFn = (
  url: string,
  opts?: { redirect?: 'follow' | 'error' | 'manual' },
) => Promise<{
  ok: boolean
  status: number
  /** Optional Content-Length, if the fetch impl exposes it. */
  headers?: { get(name: string): string | null }
  text(): Promise<string>
  /**
   * Optional streaming body. When exposed, we use it so the size
   * cap is a real abort (not a post-buffer check). If absent, we
   * fall back to `text()` and accept that a 1 GiB body will
   * OOM the process — operators should supply a streaming fetch.
   */
  body?: ReadableStream<Uint8Array> | null
}>

/** Options for {@link DuckDuckGoSearchProvider}. */
export const DuckDuckGoSearchProviderOptionsSchema = z.object({
  /** The fetch implementation. Defaults to global fetch. */
  fetch: z.custom<FetchFn>((v) => typeof v === 'function'),
  /** User-Agent header. */
  userAgent: z.string().default('lumen-web/0.1'),
})

export type DuckDuckGoSearchProviderOptions = z.input<typeof DuckDuckGoSearchProviderOptionsSchema>

/**
 * Free web search using DuckDuckGo's HTML endpoint.
 * Parses the result page with regex (good enough for
 * agent-grade search; not for production SEO scraping).
 */
export class DuckDuckGoSearchProvider extends BaseSearchProvider {
  public readonly id = 'duckduckgo'
  private readonly doFetch: FetchFn
  private readonly userAgent: string

  public constructor(options: DuckDuckGoSearchProviderOptions) {
    super()
    const parsed = DuckDuckGoSearchProviderOptionsSchema.parse(options)
    this.doFetch = parsed.fetch
    this.userAgent = parsed.userAgent
  }

  public async search(query: string, limit: number): Promise<ReadonlyArray<SearchResult>> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    const res = await this.doFetch(url, { redirect: 'follow' })
    if (!res.ok) {
      throw new ToolError(`DuckDuckGo returned ${res.status}`, { toolName: 'web_duckduckgo' })
    }
    // Cap the response body at 1 MiB. DuckDuckGo HTML pages are
    // ~50–200 KiB; anything bigger is a misconfigured server or a
    // response that's been weaponised into an OOM vector.
    const html = await this.readCapped(res, 1024 * 1024)
    return this.parse(html, limit)
  }

  public async fetch(targetUrl: string, maxBytes: number): Promise<string> {
    const res = await this.doFetch(targetUrl, { redirect: 'follow' })
    if (!res.ok) {
      throw new ToolError(`Fetch ${targetUrl} returned ${res.status}`, { toolName: 'web_fetch' })
    }
    // Apply the caller-requested cap at read time so a 1 GiB body
    // never reaches our process memory. The caller can still
    // downsample with `text.slice(...)` for display.
    const html = await this.readCapped(res, maxBytes)
    return htmlToText(html)
  }

  /**
   * Read the response body up to `maxBytes`, refusing to read
   * beyond. Returns the partial body. Throws `ToolError` if the
   * underlying stream reports a Content-Length over the cap, or
   * if the body grows past the cap while we're reading.
   *
   * Uses streaming when the fetch impl exposes `body`; falls
   * back to `text()` with a post-read cap otherwise. The fallback
   * is best-effort: a fetch impl that only exposes `text()` can
   * still OOM on a 1 GiB body. Operators running in untrusted
   * environments should use `undici` (which exposes streams).
   */
  private async readCapped(
    res: {
      headers?: { get(name: string): string | null }
      text(): Promise<string>
      body?: ReadableStream<Uint8Array> | null
    },
    maxBytes: number,
  ): Promise<string> {
    // Pre-flight: Content-Length, if advertised, is honoured.
    const declared = Number(res.headers?.get('content-length') ?? 0)
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new ToolError(
        `web_fetch: Content-Length ${declared} exceeds cap ${maxBytes}. Refusing to download.`,
        { toolName: 'web_fetch' },
      )
    }
    // Streaming path. We accumulate chunks up to the cap; if the
    // body grows past, we abort. The caller sees a ToolError.
    if (res.body && typeof (res.body as { getReader?: unknown }).getReader === 'function') {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      const parts: string[] = []
      let total = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          total += value.byteLength
          if (total > maxBytes) {
            await reader.cancel()
            throw new ToolError(
              `web_fetch: response exceeded ${maxBytes} bytes while streaming (saw ${total}). Refusing to allocate further.`,
              { toolName: 'web_fetch' },
            )
          }
          parts.push(decoder.decode(value, { stream: true }))
        }
      }
      parts.push(decoder.decode())
      return parts.join('')
    }
    // Fallback path. Awaits the full body then checks the cap;
    // a malicious server that lies about Content-Length can still
    // OOM us here. We log a warning via the tool's error path.
    const text = await res.text()
    if (text.length > maxBytes) {
      throw new ToolError(
        `web_fetch response exceeded ${maxBytes} bytes (got ${text.length}). Lower maxBytes or supply a streaming fetch implementation.`,
        { toolName: 'web_fetch' },
      )
    }
    return text
  }

  /** Extract result blocks from DDG HTML. */
  private parse(html: string, limit: number): ReadonlyArray<SearchResult> {
    const results: SearchResult[] = []
    // Each result is in <a class="result__a" href="...">title</a>
    // followed by <a class="result__snippet">snippet</a>.
    const blockRe =
      /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    let m: RegExpExecArray | null
    // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration idiom
    while ((m = blockRe.exec(html)) !== null && results.length < limit) {
      const url = decodeHtml(m[1] ?? '')
      const title = decodeHtml(stripTags(m[2] ?? ''))
      const snippet = decodeHtml(stripTags(m[3] ?? ''))
      if (url && title) {
        const parsed = SearchResultSchema.safeParse({ title, url, snippet })
        if (parsed.success) results.push(parsed.data)
      }
    }
    return results
  }
}

/** Strip HTML tags. */
const stripTags = (s: string): string => s.replace(/<[^>]+>/g, '').trim()

/** Decode common HTML entities. */
const decodeHtml = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')

/** Convert HTML to plain text. Minimal — no parser dependency. */
const htmlToText = (html: string): string => {
  // Drop scripts and styles first.
  const noScript = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
  // Convert <br>, <p>, <li> to newlines.
  const withBreaks = noScript
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<li[^>]*>/gi, '  - ')
  return decodeHtml(stripTags(withBreaks))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ---------------------------------------------------------------------------
// InMemorySearchProvider — for tests
// ---------------------------------------------------------------------------

/** Options for {@link InMemorySearchProvider}. */
export interface InMemorySearchProviderOptions {
  readonly corpus: ReadonlyArray<SearchResult>
  readonly fetchMap?: Readonly<Record<string, string>>
}

/** Test double for {@link BaseSearchProvider}. */
export class InMemorySearchProvider extends BaseSearchProvider {
  public readonly id = 'in-memory'
  private readonly corpus: ReadonlyArray<SearchResult>
  private readonly fetchMap: Readonly<Record<string, string>>

  public constructor(options: InMemorySearchProviderOptions) {
    super()
    this.corpus = options.corpus
    this.fetchMap = options.fetchMap ?? {}
  }

  public async search(query: string, limit: number): Promise<ReadonlyArray<SearchResult>> {
    const lower = query.toLowerCase()
    const scored = this.corpus.map((r) => {
      const inTitle = r.title.toLowerCase().includes(lower) ? 2 : 0
      const inSnippet = r.snippet.toLowerCase().includes(lower) ? 1 : 0
      return { r, score: inTitle + inSnippet }
    })
    scored.sort((a, b) => b.score - a.score)
    return scored
      .filter((s) => s.score > 0)
      .slice(0, limit)
      .map((s) => s.r)
  }

  public async fetch(url: string, _maxBytes: number): Promise<string> {
    if (!(url in this.fetchMap)) {
      throw new ValidationError(`Unknown URL: ${url}`, { field: 'url' })
    }
    return this.fetchMap[url] ?? ''
  }
}

// ---------------------------------------------------------------------------
// WebSearchTool
// ---------------------------------------------------------------------------

/** Zod schema for {@link WebSearchTool} input. */
export const WebSearchInputSchema = z.object({
  /** The search query. */
  query: z.string().min(1),
  /** Maximum number of results. Defaults to 5. */
  limit: z.number().int().positive().max(20).default(5),
})

/** Zod schema for {@link WebSearchTool} output. */
export const WebSearchOutputSchema = z.object({
  results: z.array(SearchResultSchema),
})

/** Searches the web and returns the top N results. */
export class WebSearchTool extends BaseTool {
  public readonly name = 'web_search'
  public readonly description =
    'Search the web for a query and return the top results. Each result has a title, URL, and snippet. Use this to find up-to-date information, documentation, or external references.'
  public readonly inputSchema: z.ZodType<unknown> = WebSearchInputSchema
  public readonly risk: ToolRisk = 'safe'
  public override readonly version = '0.1.0'

  private readonly provider: BaseSearchProvider

  public constructor(provider: BaseSearchProvider) {
    super()
    this.provider = provider
  }

  protected override async execute(input: unknown, _ctx: ToolContext): Promise<unknown> {
    const parsed = WebSearchInputSchema.parse(input)
    const results = await this.provider.search(parsed.query, parsed.limit)
    return WebSearchOutputSchema.parse({ results })
  }
}

// ---------------------------------------------------------------------------
// WebFetchTool
// ---------------------------------------------------------------------------

/** Zod schema for {@link WebFetchTool} input. */
export const WebFetchInputSchema = z.object({
  /** The URL to fetch. */
  url: z.string().url(),
  /** Maximum bytes to read. Defaults to 100_000. */
  maxBytes: z.number().int().positive().max(1_000_000).default(100_000),
})

/** Zod schema for {@link WebFetchTool} output. */
export const WebFetchOutputSchema = z.object({
  /** The fetched text. */
  text: z.string(),
  /** Truncated flag — true if maxBytes was hit. */
  truncated: z.boolean(),
})

/** Fetches a URL and returns the visible text. */
export class WebFetchTool extends BaseTool {
  public readonly name = 'web_fetch'
  public readonly description =
    'Fetch a URL and return its visible text content. Use this after web_search to read the full content of a result. The text is truncated if it exceeds maxBytes.'
  public readonly inputSchema: z.ZodType<unknown> = WebFetchInputSchema
  public readonly risk: ToolRisk = 'safe'
  public override readonly version = '0.1.0'

  private readonly provider: BaseSearchProvider

  public constructor(provider: BaseSearchProvider) {
    super()
    this.provider = provider
  }

  protected override async execute(input: unknown, _ctx: ToolContext): Promise<unknown> {
    const parsed = WebFetchInputSchema.parse(input)
    const text = await this.provider.fetch(parsed.url, parsed.maxBytes)
    return WebFetchOutputSchema.parse({
      text: text.slice(0, parsed.maxBytes),
      truncated: text.length > parsed.maxBytes,
    })
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Options for {@link createWebTools}. */
export interface CreateWebToolsOptions {
  readonly provider: BaseSearchProvider
}

/** Create the web tools bound to a provider. */
export const createWebTools = (options: CreateWebToolsOptions): [WebSearchTool, WebFetchTool] => [
  new WebSearchTool(options.provider),
  new WebFetchTool(options.provider),
]
