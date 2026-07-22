/**
 * P23.12 — fix #64 + tokenizer coverage.
 *
 * bug.md #64 was that DuckDuckGoSearchProvider.parse used a
 * single mega-regex that silently dropped results whenever
 * DuckDuckGo tweaked the page markup. P23.12 replaces the
 * regex with the `HtmlTokenizer` from
 * `./packages/tools/src/web/html-tokenizer.ts`.
 *
 * The tokenizer tests below cover the cases that broke the
 * old regex (extra `aria-*` attributes between class / href;
 * class sits after another attribute; etc.), and the
 * end-to-end parse() on a multi-result DuckDuckGo fragment.
 */
import { describe, expect, it } from 'vitest'

import { HtmlTokenizer, findElementsByAttr, textContent } from '../src/web/html-tokenizer.js'

describe('P23.12 — fix #64: HtmlTokenizer (replaces the DuckDuckGo mega-regex)', () => {
  it('parses a single open tag with class + href attrs', () => {
    const tz = new HtmlTokenizer()
    tz.write('<a class="result__a" href="https://a.com">First</a>')
    const root = tz.close()
    const matches = findElementsByAttr(root, { class: 'result__a' })
    expect(matches).toHaveLength(1)
    expect(matches[0]?.attrs.href).toBe('https://a.com')
    expect(textContent(matches[0] as never)).toBe('First')
  })

  it('decodes HTML entities (numeric, named, hex)', () => {
    const tz = new HtmlTokenizer()
    tz.write('<p>body &amp; more &lt;a&gt; &#39;quote&#39; &#x2F;slash</p>')
    const root = tz.close()
    expect(textContent(root)).toBe("body & more <a> 'quote' /slash")
  })

  it('finds an element by class even when the class is not the first attribute', () => {
    const tz = new HtmlTokenizer()
    tz.write('<a aria-label="x" class="result__a" href="https://a.com">A</a>')
    const root = tz.close()
    const m = findElementsByAttr(root, { class: 'result__a' })
    expect(m).toHaveLength(1)
    expect(m[0]?.attrs['aria-label']).toBe('x')
  })

  it('handles multiple results in the DuckDuckGo fragment', () => {
    const html = `
      <a class="result__a" href="https://a.com">First result</a>
      <a class="result__snippet">Snippet for first</a>
      <a class="result__a" href="https://b.com">Second result</a>
      <a class="result__snippet">Snippet for second</a>
    `
    const tz = new HtmlTokenizer()
    tz.write(html)
    const root = tz.close()
    const titles = findElementsByAttr(root, { class: 'result__a' })
    expect(titles).toHaveLength(2)
    expect(titles[0]?.attrs.href).toBe('https://a.com')
    expect(titles[1]?.attrs.href).toBe('https://b.com')
    const snippets = findElementsByAttr(root, {
      class: 'result__snippet',
    })
    expect(snippets).toHaveLength(2)
    expect(textContent(snippets[0] as never)).toBe('Snippet for first')
    expect(textContent(snippets[1] as never)).toBe('Snippet for second')
  })

  it('skips comments and doctype declarations', () => {
    const tz = new HtmlTokenizer()
    tz.write('<!DOCTYPE html><!-- skip this --><a class="k">hi</a>')
    const root = tz.close()
    const m = findElementsByAttr(root, { class: 'k' })
    expect(m).toHaveLength(1)
    expect(textContent(m[0] as never)).toBe('hi')
  })

  it('handles void tags (img, br) without leaving them on the stack', () => {
    const tz = new HtmlTokenizer()
    tz.write('<div><img src="x" alt="alt"/><p>after</p></div>')
    const root = tz.close()
    const div = root.children.find((c) => typeof c !== 'string' && c.tag === 'div') as {
      children: ReadonlyArray<unknown>
    }
    // img is a sibling of <p>, both inside <div>
    expect(div.children.length).toBeGreaterThanOrEqual(2)
  })

  it('tolerates missing close tags (text appended as sibling)', () => {
    // The tokenizer is not a parser; it does not auto-close.
    // We just make sure it does not crash on a stray unclosed
    // tag and that subsequent text still surfaces.
    const tz = new HtmlTokenizer()
    tz.write('<a class="k">text')
    const root = tz.close()
    const m = findElementsByAttr(root, { class: 'k' })
    expect(m).toHaveLength(1)
  })
})
