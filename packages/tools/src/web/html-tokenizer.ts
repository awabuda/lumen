/**
 * Tiny streaming HTML tokenizer + DOM-light builder.
 *
 * Pre-P23.12 bug.md #64 — DuckDuckGo HTML was scraped with a
 * single mega-regex (`/...class="result__a".../g`). The regex
 * silently dropped rows when DuckDuckGo tweaked the page
 * markup (e.g. added a wrapper `<div>`, an `aria-` attribute,
 * or a CSS class on the inner `<a>`). The `parse()` step is
 * also the narrow point that buried any structural mistake.
 *
 * P23.12 (fix #64) replaces the regex with a real tokenizer
 * that walks the HTML in tag / text / attribute chunks and
 * lets us locate elements by tag + attribute filters. The
 * tokenizer is **deliberately small**: it covers only the
 * subset we need (well-formed-ish HTML with the same quirks
 * DDG ships). It is not a parser, it does not handle
 * `<script>` content as raw text correctly, and it does not
 * implement the HTML5 spec — but for DDG's narrow result
 * blocks it is more robust than regex and lighter than
 * linkedom (no extra runtime dep).
 *
 * Scope:
 *   - tags: open / close / void
 *   - attributes: name = "value" | 'value' | unquoted | boolean
 *   - text nodes: anything outside tags (decoded entities below)
 *   - comments: `<!-- ... -->` skipped (treated as one token)
 *   - doctype / CDATA / processing instructions: skipped
 *
 * Decoded entities: &amp; &lt; &gt; &quot; &#39; &nbsp; &apos;
 * plus numeric `&#NNN;` and hex `&#xHHHH;`.
 *
 * What it intentionally does NOT do:
 *   - form / table / scripting / foreign content model
 *   - error recovery (`<p><b></p>` does not auto-close)
 *   - character references beyond the named + numeric set above
 *
 * If a real consumer needs spec-compliant parsing, swap in
 * linkedom via a downstream package; the rest of the tool still
 * works with {@link parseSearchResults} consuming the same
 * shape.
 */

/** Mutable element node produced by the tokenizer (children array can grow). */
export interface HtmlElementMutable {
  readonly tag: string
  readonly attrs: Record<string, string>
  readonly children: Array<HtmlElementMutable | string>
}

/** Public read-only view for consumers. */
export interface HtmlElement {
  readonly tag: string
  readonly attrs: Readonly<Record<string, string>>
  readonly children: ReadonlyArray<HtmlElement | string>
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
}

const decodeEntity = (raw: string): string => {
  if (raw.startsWith('#')) {
    const code =
      raw[1] === 'x' || raw[1] === 'X'
        ? Number.parseInt(raw.slice(2), 16)
        : Number.parseInt(raw.slice(1), 10)
    if (Number.isFinite(code) && code > 0) {
      try {
        return String.fromCodePoint(code)
      } catch {
        return '\ufffd'
      }
    }
    return `&${raw};`
  }
  return NAMED_ENTITIES[raw] ?? `&${raw};`
}

const decodeEntities = (s: string): string =>
  s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]*);/g, (match) =>
    decodeEntity(match.slice(1, -1)),
  )

const VOID_TAGS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])

const isWhitespace = (ch: string | undefined): boolean =>
  ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === '\f'

const upperEq = (a: string, b: string): boolean =>
  a.length === b.length && a.toUpperCase() === b.toUpperCase()

/**
 * Tokenize HTML into a tree of elements + text fragments.
 * Streaming input is supported via the chunk parameter; the
 * tokenizer resumes from the last position across calls.
 */
export class HtmlTokenizer {
  private src = ''
  private pos = 0
  private stack: HtmlElementMutable[] = []
  private root: HtmlElementMutable = { tag: '#root', attrs: {}, children: [] }

  /** Feed a chunk of HTML and return the elements created. */
  public write(chunk: string): ReadonlyArray<HtmlElement | string> {
    if (chunk.length === 0) return []
    this.src = chunk
    this.pos = 0
    while (this.pos < this.src.length) {
      const c = this.src[this.pos]
      if (c === '<') {
        if (this.tryConsumeTag()) continue
        // Not a recognizable tag; emit '<' as text on the
        // current parent and skip.
        this.appendText('<')
        this.pos += 1
      } else {
        const next = this.src.indexOf('<', this.pos)
        const text = next === -1 ? this.src.slice(this.pos) : this.src.slice(this.pos, next)
        this.pos = next === -1 ? this.src.length : next
        if (text.length > 0) this.appendText(decodeEntities(text))
      }
    }
    return []
  }

  /** Append a decoded text fragment to the current parent (or root). */
  private appendText(text: string): void {
    const parent = this.stack[this.stack.length - 1] ?? this.root
    parent.children.push(text)
  }

  /** Finalise the tokenizer and return the root element. */
  public close(): HtmlElement {
    return this.root
  }

  private tryConsumeTag(): boolean {
    // Comments
    if (this.src.startsWith('<!--', this.pos)) {
      const end = this.src.indexOf('-->', this.pos + 4)
      this.pos = end === -1 ? this.src.length : end + 3
      return true
    }
    // Doctype / CDATA / processing instructions are skipped.
    if (this.src.startsWith('<!', this.pos) || this.src.startsWith('<?', this.pos)) {
      const close = this.src.indexOf('>', this.pos)
      this.pos = close === -1 ? this.src.length : close + 1
      return true
    }
    // Open or close tag
    let cursor = this.pos + 1
    if (cursor >= this.src.length) return false
    const isClose = this.src[cursor] === '/'
    if (isClose) cursor += 1
    // Tag name
    const nameStart = cursor
    while (
      cursor < this.src.length &&
      !isWhitespace(this.src[cursor]) &&
      this.src[cursor] !== '/' &&
      this.src[cursor] !== '>'
    ) {
      cursor += 1
    }
    if (cursor === nameStart) return false
    const rawName = this.src.slice(nameStart, cursor)
    const tag = rawName.toLowerCase()
    // Attributes
    const attrs: Record<string, string> = {}
    while (cursor < this.src.length && this.src[cursor] !== '>') {
      while (cursor < this.src.length && isWhitespace(this.src[cursor])) {
        cursor += 1
      }
      if (cursor >= this.src.length || this.src[cursor] === '>' || this.src[cursor] === '/') break
      // attr name
      const aStart = cursor
      while (
        cursor < this.src.length &&
        !isWhitespace(this.src[cursor]) &&
        this.src[cursor] !== '=' &&
        this.src[cursor] !== '>' &&
        this.src[cursor] !== '/'
      ) {
        cursor += 1
      }
      if (cursor === aStart) {
        cursor += 1
        continue
      }
      const attrName = this.src.slice(aStart, cursor).toLowerCase()
      let attrValue = ''
      // Skip whitespace
      while (cursor < this.src.length && isWhitespace(this.src[cursor])) cursor += 1
      if (this.src[cursor] === '=') {
        cursor += 1
        while (cursor < this.src.length && isWhitespace(this.src[cursor])) cursor += 1
        const q = this.src[cursor]
        if (q === '"' || q === "'") {
          cursor += 1
          const vStart = cursor
          while (cursor < this.src.length && this.src[cursor] !== q) cursor += 1
          attrValue = decodeEntities(this.src.slice(vStart, cursor))
          if (cursor < this.src.length) cursor += 1
        } else {
          const vStart = cursor
          while (
            cursor < this.src.length &&
            !isWhitespace(this.src[cursor]) &&
            this.src[cursor] !== '>' &&
            this.src[cursor] !== '/'
          ) {
            cursor += 1
          }
          attrValue = decodeEntities(this.src.slice(vStart, cursor))
        }
      }
      attrs[attrName] = attrValue
    }
    // Self-closing
    let selfClose = false
    if (this.src[cursor] === '/') {
      selfClose = true
      cursor += 1
    }
    if (this.src[cursor] !== '>') return false
    cursor += 1
    this.pos = cursor
    if (isClose) {
      // pop matching element off the stack (or root for stray)
      for (let i = this.stack.length - 1; i >= 0; i -= 1) {
        if (upperEq(this.stack[i]!.tag, tag)) {
          this.stack.length = i
          break
        }
      }
      return true
    }
    const element: HtmlElementMutable = { tag, attrs, children: [] }
    if (selfClose || VOID_TAGS.has(tag)) {
      this.parent().children.push(element)
    } else {
      this.parent().children.push(element)
      this.stack.push(element)
    }
    return true
  }

  private parent(): HtmlElementMutable {
    return this.stack[this.stack.length - 1] ?? this.root
  }
}

/**
 * Find every element whose attributes contain every key/value
 * pair in `match`. Performs depth-first traversal. Returns the
 * matching elements in document order.
 */
export const findElementsByAttr = (
  root: HtmlElement,
  match: Readonly<Record<string, string>>,
): ReadonlyArray<HtmlElement> => {
  const out: HtmlElement[] = []
  const visit = (node: HtmlElement): void => {
    let ok = true
    for (const [k, v] of Object.entries(match)) {
      if (node.attrs[k] !== v) {
        ok = false
        break
      }
    }
    if (ok) out.push(node)
    for (const child of node.children) {
      if (typeof child === 'string') continue
      visit(child as HtmlElement)
    }
  }
  visit(root)
  return out
}

/** Concatenate every text-fragment child (recursively) of an element. */
export const textContent = (el: HtmlElement): string => {
  const parts: string[] = []
  const visit = (node: HtmlElement): void => {
    for (const child of node.children) {
      if (typeof child === 'string') parts.push(child)
      else visit(child as HtmlElement)
    }
  }
  visit(el)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}
