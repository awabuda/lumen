/** Tests for the web search + fetch tools. */

import { describe, expect, it } from 'vitest'
import {
  DuckDuckGoSearchProvider,
  InMemorySearchProvider,
  WebFetchTool,
  WebSearchTool,
  createWebTools,
} from '../src/web/index.js'

const mockFetch =
  (responses: Record<string, { ok: boolean; status: number; body: string }>) => (url: string) => {
    const entry = responses[url]
    if (!entry) {
      return Promise.resolve({
        ok: false,
        status: 404,
        text: async () => 'not found',
      })
    }
    return Promise.resolve({
      ok: entry.ok,
      status: entry.status,
      text: async () => entry.body,
    })
  }

describe('InMemorySearchProvider', () => {
  it('searches by title or snippet match', async () => {
    const provider = new InMemorySearchProvider({
      corpus: [
        { title: 'React docs', url: 'https://react.dev', snippet: 'Learn React' },
        { title: 'Vue docs', url: 'https://vuejs.org', snippet: 'Learn Vue' },
        { title: 'Other', url: 'https://example.com', snippet: 'no match' },
      ],
    })
    const results = await provider.search('react', 5)
    expect(results).toHaveLength(1)
    expect(results[0]?.title).toBe('React docs')
  })

  it('respects the limit', async () => {
    const provider = new InMemorySearchProvider({
      corpus: [
        { title: 'A', url: 'https://a', snippet: 'common' },
        { title: 'B', url: 'https://b', snippet: 'common' },
        { title: 'C', url: 'https://c', snippet: 'common' },
      ],
    })
    expect(await provider.search('common', 2)).toHaveLength(2)
  })

  it('returns empty array when nothing matches', async () => {
    const provider = new InMemorySearchProvider({
      corpus: [{ title: 'X', url: 'https://x', snippet: 'y' }],
    })
    expect(await provider.search('zzz', 5)).toEqual([])
  })

  it('fetch returns mapped content', async () => {
    const provider = new InMemorySearchProvider({
      corpus: [],
      fetchMap: { 'https://a': '<p>hello</p>' },
    })
    const text = await provider.fetch('https://a', 1000)
    expect(text).toBe('<p>hello</p>')
  })

  it('fetch throws on unknown URL (Rule 7)', async () => {
    const provider = new InMemorySearchProvider({ corpus: [] })
    await expect(provider.fetch('https://nope', 1000)).rejects.toThrow(/Unknown URL/)
  })

  it('exposes id "in-memory"', () => {
    expect(new InMemorySearchProvider({ corpus: [] }).id).toBe('in-memory')
  })
})

describe('DuckDuckGoSearchProvider', () => {
  it('parses result blocks from DDG HTML', async () => {
    const html = `
      <a class="result__a" href="https://a.com">First result</a>
      <a class="result__snippet">Snippet for first</a>
      <a class="result__a" href="https://b.com">Second result</a>
      <a class="result__snippet">Snippet for second</a>
    `
    const provider = new DuckDuckGoSearchProvider({
      fetch: mockFetch({
        'https://html.duckduckgo.com/html/?q=test': {
          ok: true,
          status: 200,
          body: html,
        },
      }),
    })
    const results = await provider.search('test', 10)
    expect(results).toHaveLength(2)
    expect(results[0]?.url).toBe('https://a.com')
    expect(results[0]?.title).toBe('First result')
    expect(results[1]?.url).toBe('https://b.com')
  })

  it('respects the limit', async () => {
    const html = `
      <a class="result__a" href="https://a.com">A</a>
      <a class="result__snippet">sa</a>
      <a class="result__a" href="https://b.com">B</a>
      <a class="result__snippet">sb</a>
      <a class="result__a" href="https://c.com">C</a>
      <a class="result__snippet">sc</a>
    `
    const provider = new DuckDuckGoSearchProvider({
      fetch: mockFetch({
        'https://html.duckduckgo.com/html/?q=x': { ok: true, status: 200, body: html },
      }),
    })
    expect(await provider.search('x', 2)).toHaveLength(2)
  })

  it('throws on transport error (Rule 7)', async () => {
    const provider = new DuckDuckGoSearchProvider({
      fetch: mockFetch({}),
    })
    await expect(provider.search('x', 5)).rejects.toThrow(/returned 404/)
  })

  it('throws when fetch fails on direct URL', async () => {
    const provider = new DuckDuckGoSearchProvider({
      fetch: async (url) => ({
        ok: false,
        status: 500,
        text: async () => '',
      }),
    })
    await expect(provider.fetch('https://x', 1000)).rejects.toThrow(/500/)
  })

  it('strips HTML on fetch', async () => {
    const provider = new DuckDuckGoSearchProvider({
      fetch: async () => ({
        ok: true,
        status: 200,
        text: async () => '<html><body><h1>Title</h1><p>body &amp; more</p></body></html>',
      }),
    })
    const text = await provider.fetch('https://x', 1000)
    expect(text).toContain('Title')
    expect(text).toContain('body & more')
  })

  it('exposes id "duckduckgo"', () => {
    const provider = new DuckDuckGoSearchProvider({
      fetch: async () => ({ ok: true, status: 200, text: async () => '' }),
    })
    expect(provider.id).toBe('duckduckgo')
  })
})

describe('WebSearchTool', () => {
  it('returns search results', async () => {
    const provider = new InMemorySearchProvider({
      corpus: [{ title: 'Foo', url: 'https://foo.com', snippet: 'foo snippet' }],
    })
    const tool = new WebSearchTool(provider)
    expect(tool.name).toBe('web_search')
    expect(tool.risk).toBe('safe')
    const out = (await tool.execute({ query: 'foo' }, {
      signal: new AbortController().signal,
      cwd: '/tmp',
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    } as never)) as { results: Array<{ title: string }> }
    expect(out.results).toHaveLength(1)
    expect(out.results[0]?.title).toBe('Foo')
  })

  it('rejects empty query', async () => {
    const tool = new WebSearchTool(new InMemorySearchProvider({ corpus: [] }))
    await expect(
      tool.execute({ query: '' }, {
        signal: new AbortController().signal,
        cwd: '/tmp',
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      } as never),
    ).rejects.toThrow()
  })

  it('applies default limit of 5', async () => {
    const provider = new InMemorySearchProvider({
      corpus: [
        { title: 'A', url: 'https://a', snippet: 'common' },
        { title: 'B', url: 'https://b', snippet: 'common' },
        { title: 'C', url: 'https://c', snippet: 'common' },
        { title: 'D', url: 'https://d', snippet: 'common' },
        { title: 'E', url: 'https://e', snippet: 'common' },
        { title: 'F', url: 'https://f', snippet: 'common' },
      ],
    })
    const tool = new WebSearchTool(provider)
    const out = (await tool.execute({ query: 'common' }, {
      signal: new AbortController().signal,
      cwd: '/tmp',
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    } as never)) as { results: unknown[] }
    expect(out.results).toHaveLength(5)
  })
})

describe('WebFetchTool', () => {
  it('returns the fetched text', async () => {
    const provider = new InMemorySearchProvider({
      corpus: [],
      fetchMap: { 'https://a': 'hello world' },
    })
    const tool = new WebFetchTool(provider)
    const out = (await tool.execute({ url: 'https://a' }, {
      signal: new AbortController().signal,
      cwd: '/tmp',
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    } as never)) as { text: string; truncated: boolean }
    expect(out.text).toBe('hello world')
    expect(out.truncated).toBe(false)
  })

  it('truncates when text exceeds maxBytes', async () => {
    // P23.9 (fix #41) — the InMemorySearchProvider stub
    // returns the full mapped string regardless of maxBytes
    // (that's the contract the test fixture offers). With the
    // previous double-truncate, WebFetchTool.execute() did
    // `text.slice(0, maxBytes)`, so the resulting `text` field
    // was capped but `truncated` was a misleading `false` when
    // the input was already at the boundary. The post-fix
    // contract is: the provider's `text` is preserved as-is,
    // and `truncated` reports whether the original exceeded
    // maxBytes.
    const provider = new InMemorySearchProvider({
      corpus: [],
      fetchMap: { 'https://a': 'x'.repeat(200) },
    })
    const tool = new WebFetchTool(provider)
    const out = (await tool.execute({ url: 'https://a', maxBytes: 50 }, {
      signal: new AbortController().signal,
      cwd: '/tmp',
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    } as never)) as { text: string; truncated: boolean }
    expect(out.text).toHaveLength(200)
    expect(out.truncated).toBe(true)
  })

  it('rejects invalid URL', async () => {
    const tool = new WebFetchTool(new InMemorySearchProvider({ corpus: [] }))
    await expect(
      tool.execute({ url: 'not-a-url' }, {
        signal: new AbortController().signal,
        cwd: '/tmp',
        log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      } as never),
    ).rejects.toThrow()
  })
})

describe('createWebTools', () => {
  it('returns both tools bound to the provider', () => {
    const provider = new InMemorySearchProvider({ corpus: [] })
    const [search, fetch] = createWebTools({ provider })
    expect(search).toBeInstanceOf(WebSearchTool)
    expect(fetch).toBeInstanceOf(WebFetchTool)
    expect((search as unknown as { provider: unknown }).provider).toBe(provider)
    expect((fetch as unknown as { provider: unknown }).provider).toBe(provider)
  })
})

describe('DuckDuckGoSearchProvider size cap (P9.3)', () => {
  function makeStreamingFetch(
    chunks: ReadonlyArray<Uint8Array>,
    declaredLength?: number,
  ): import('../src/web/index.js').default extends never ? never : typeof fetch {
    return (async () => ({
      ok: true,
      status: 200,
      headers: declaredLength
        ? {
            get: (n: string) =>
              n.toLowerCase() === 'content-length' ? String(declaredLength) : null,
          }
        : undefined,
      text: async () => {
        const decoder = new TextDecoder()
        return chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode()
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(c)
          controller.close()
        },
      }),
    })) as unknown as typeof fetch
  }

  it('throws when streaming body exceeds the cap', async () => {
    const big = new Uint8Array(2_000).fill(65) // 2 KiB of 'A'
    const provider = new DuckDuckGoSearchProvider({
      fetch: makeStreamingFetch([big], undefined),
    })
    await expect(provider.fetch('https://example.test', 1_000)).rejects.toThrow(
      /exceeded 1000 bytes/,
    )
  })

  it('returns the body when streaming body is under the cap', async () => {
    const small = new Uint8Array(100).fill(66) // 100 B of 'B'
    const provider = new DuckDuckGoSearchProvider({
      fetch: makeStreamingFetch([small], undefined),
    })
    const text = await provider.fetch('https://example.test', 10_000)
    expect(text).toBe('B'.repeat(100))
  })

  it('throws when Content-Length exceeds the cap', async () => {
    const provider = new DuckDuckGoSearchProvider({
      fetch: makeStreamingFetch([new Uint8Array(10)], 5_000_000),
    })
    await expect(provider.fetch('https://example.test', 1_000)).rejects.toThrow(/Content-Length/)
  })
})
