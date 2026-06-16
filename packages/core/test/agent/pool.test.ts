/**
 * Tests for {@link ProviderPool}.
 *
 * Provider stubs mimic the {@link BaseProvider} surface enough to
 * drive routing and failover logic without a real backend. They
 * run synchronously so tests stay fast.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  BaseProvider,
  ProviderError,
  type ChatRequest,
  type ChatResponse,
  type EmbedRequest,
  type EmbedResponse,
  type ProviderCapabilities,
  type StreamEvent,
  type StreamOptions,
} from '../../src/index.js'
import { AgentError } from '../../src/errors/index.js'
import {
  PoolExhaustedError,
  ProviderPool,
  type PooledProviderConfig,
  type RoutingStrategy,
} from '../../src/agent/pool.js'

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

const defaultCapabilities = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  streaming: false,
  embeddings: false,
  toolUse: false,
  vision: false,
  reasoning: false,
  promptCaching: false,
  structuredOutput: false,
  maxContextTokens: 4096,
  ...overrides,
})

interface StubBehavior {
  chat?: (req: ChatRequest) => Promise<ChatResponse>
  embed?: (req: EmbedRequest) => Promise<EmbedResponse>
  stream?: (req: ChatRequest) => AsyncGenerator<StreamEvent, void, void>
  capabilities: ProviderCapabilities
}

const makeStub = (id: string, behavior: StubBehavior): BaseProvider => {
  return new (class extends BaseProvider {
    public readonly id = id
    public readonly capabilities: ProviderCapabilities = behavior.capabilities
    public chat(req: ChatRequest): Promise<ChatResponse> {
      if (behavior.chat) return behavior.chat(req)
      return Promise.resolve({
        id: `${id}-${Math.random()}`,
        model: req.model,
        message: { role: 'assistant', content: `hi from ${this.id}`, toolCalls: [] },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      })
    }
    public embed(req: EmbedRequest): Promise<EmbedResponse> {
      if (behavior.embed) return behavior.embed(req)
      return Promise.resolve({ model: `${this.id}-embed`, vectors: [new Float32Array(2)] })
    }
    public async *stream(req: ChatRequest): AsyncGenerator<StreamEvent, void, void> {
      if (behavior.stream) {
        for await (const ev of behavior.stream(req)) yield ev
        return
      }
      yield { type: 'message_start', message: { role: 'assistant', content: '', toolCalls: [] } }
      yield { type: 'content_delta', delta: `stream-${this.id}` }
      yield {
        type: 'message_complete',
        message: { role: 'assistant', content: `stream-${this.id}`, toolCalls: [] },
      }
    }
  })()
}

const chatResponse = (id: string, content: string): ChatResponse => ({
  id: `${id}-1`,
  model: 'm',
  message: { role: 'assistant', content, toolCalls: [] },
  usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
})

const basicChat = (text: string): ChatRequest => ({
  messages: [{ role: 'user', content: text }],
  model: 'm',
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ProviderPool', () => {
  describe('construction & registration', () => {
    it('starts empty with all-false capabilities', () => {
      const p = new ProviderPool()
      expect(p.id).toBe('pool')
      expect(p.registered).toEqual([])
      expect(p.capabilities.streaming).toBe(false)
      expect(p.capabilities.embeddings).toBe(false)
      expect(p.capabilities.toolUse).toBe(false)
      expect(p.capabilities.maxContextTokens).toBe(0)
    })

    it('OR-merges capabilities across registered providers', () => {
      const a = makeStub('a', { capabilities: defaultCapabilities({ streaming: true }) })
      const b = makeStub('b', { capabilities: defaultCapabilities({ embeddings: true }) })
      const c = makeStub('c', {
        capabilities: defaultCapabilities({ toolUse: true, maxContextTokens: 32000 }),
      })
      const p = new ProviderPool({ providers: [{ provider: a }, { provider: b }, { provider: c }] })
      expect(p.capabilities.streaming).toBe(true)
      expect(p.capabilities.embeddings).toBe(true)
      expect(p.capabilities.toolUse).toBe(true)
      // Unrelated capabilities stay false.
      expect(p.capabilities.vision).toBe(false)
      // maxContextTokens = max() of all members.
      expect(p.capabilities.maxContextTokens).toBe(32000)
    })

    it('register() rejects duplicate ids', () => {
      const a = makeStub('a', { capabilities: defaultCapabilities() })
      const p = new ProviderPool().register({ provider: a })
      expect(() => p.register({ provider: a })).toThrow(/already registered/)
    })

    it('unregister() returns true when an id is removed, false otherwise', () => {
      const a = makeStub('a', { capabilities: defaultCapabilities() })
      const b = makeStub('b', { capabilities: defaultCapabilities() })
      const p = new ProviderPool({ providers: [{ provider: a }, { provider: b }] })
      expect(p.unregister('a')).toBe(true)
      expect(p.unregister('missing')).toBe(false)
      expect(p.registered.map((c) => c.provider.id)).toEqual(['b'])
    })
  })

  describe("strategy: 'round-robin'", () => {
    it('cycles through providers in registration order', async () => {
      const a = makeStub('a', { capabilities: defaultCapabilities(), chat: async () => chatResponse('a', 'A') })
      const b = makeStub('b', { capabilities: defaultCapabilities(), chat: async () => chatResponse('b', 'B') })
      const c = makeStub('c', { capabilities: defaultCapabilities(), chat: async () => chatResponse('c', 'C') })
      const p = new ProviderPool({ strategy: 'round-robin', providers: [{ provider: a }, { provider: b }, { provider: c }] })

      const responses = await Promise.all([
        p.chat(basicChat('1')),
        p.chat(basicChat('2')),
        p.chat(basicChat('3')),
        p.chat(basicChat('4')),
      ])
      // Use the assistant content's last char to identify which
      // provider served each call (round-robin cycles a, b, c, a).
      const ids = responses.map((r) => r.message.content.slice(-1))
      expect(ids).toEqual(['A', 'B', 'C', 'A'])
    })
  })

  describe("strategy: 'name'", () => {
    it('routes to the provider with the matching id', async () => {
      const a = makeStub('a', { capabilities: defaultCapabilities() })
      const b = makeStub('b', { capabilities: defaultCapabilities(), chat: async () => chatResponse('b', 'B') })
      const p = new ProviderPool({
        strategy: 'name',
        targetId: 'b',
        providers: [{ provider: a }, { provider: b }],
      })
      const r = await p.chat(basicChat('hi'))
      expect(r.message.content).toBe('B')
    })

    it('throws when targetId does not match any registered provider', async () => {
      const a = makeStub('a', { capabilities: defaultCapabilities() })
      const p = new ProviderPool({ strategy: 'name', targetId: 'missing', providers: [{ provider: a }] })
      await expect(p.chat(basicChat('x'))).rejects.toThrow(/No registered provider with id 'missing'/)
    })
  })

  describe("strategy: 'capability'", () => {
    it('picks a provider that has the required capability', async () => {
      const a = makeStub('a', { capabilities: defaultCapabilities() })
      const b = makeStub('b', {
        capabilities: defaultCapabilities({ streaming: true }),
        chat: async () => chatResponse('b', 'stream-capable'),
      })
      const p = new ProviderPool({
        strategy: 'capability',
        capability: 'streaming',
        providers: [{ provider: a }, { provider: b }],
      })
      const r = await p.chat(basicChat('hi'))
      expect(r.message.content).toBe('stream-capable')
    })

    it('throws when no provider has the capability', async () => {
      const a = makeStub('a', { capabilities: defaultCapabilities() })
      const p = new ProviderPool({
        strategy: 'capability',
        capability: 'vision',
        providers: [{ provider: a }],
      })
      await expect(p.chat(basicChat('x'))).rejects.toThrow(/No registered provider has capability 'vision'/)
    })
  })

  describe("strategy: 'weighted'", () => {
    it('picks providers with probabilities matching weights', async () => {
      const a = makeStub('a', { capabilities: defaultCapabilities(), chat: async () => chatResponse('a', 'A') })
      const b = makeStub('b', { capabilities: defaultCapabilities(), chat: async () => chatResponse('b', 'B') })
      // Deterministic PRNG: every draw is 0.5 — with weights 1:9
      // (total 10), r*10 = 5, minus a's weight 1 = 4 > 0 → always b.
      const random = (): number => 0.5
      const p = new ProviderPool({
        strategy: 'weighted',
        providers: [{ provider: a, weight: 1 }, { provider: b, weight: 9 }],
        random,
      })
      let aCount = 0
      let bCount = 0
      for (let i = 0; i < 100; i += 1) {
        const resp = await p.chat(basicChat('hi'))
        if (resp.message.content.endsWith('A')) aCount += 1
        else bCount += 1
      }
      expect(bCount).toBe(100)
      expect(aCount).toBe(0)
    })
  })

  describe('failover', () => {
    it('falls back to the next provider on ProviderError', async () => {
      const a = makeStub('a', {
        capabilities: defaultCapabilities(),
        chat: async () => {
          throw new ProviderError('boom', { providerId: 'a' })
        },
      })
      const b = makeStub('b', {
        capabilities: defaultCapabilities(),
        chat: async () => chatResponse('b', 'B-after-failover'),
      })
      const p = new ProviderPool({ providers: [{ provider: a }, { provider: b }] })
      const r = await p.chat(basicChat('hi'))
      expect(r.message.content).toBe('B-after-failover')
    })

    it('throws PoolExhaustedError when every provider fails', async () => {
      const a = makeStub('a', {
        capabilities: defaultCapabilities(),
        chat: async () => {
          throw new ProviderError('a down', { providerId: 'a' })
        },
      })
      const b = makeStub('b', {
        capabilities: defaultCapabilities(),
        chat: async () => {
          throw new ProviderError('b down', { providerId: 'b' })
        },
      })
      const p = new ProviderPool({ providers: [{ provider: a }, { provider: b }] })
      try {
        await p.chat(basicChat('hi'))
        throw new Error('expected throw')
      } catch (err) {
        expect(err).toBeInstanceOf(PoolExhaustedError)
        expect((err as PoolExhaustedError).attempts.map((a) => a.providerId)).toEqual(['a', 'b'])
      }
    })

    it('rethrows non-ProviderError immediately (no failover for programming errors)', async () => {
      const a = makeStub('a', {
        capabilities: defaultCapabilities(),
        chat: async () => {
          throw new Error('plain error — not a ProviderError')
        },
      })
      const b = makeStub('b', {
        capabilities: defaultCapabilities(),
        chat: async () => chatResponse('b', 'B'),
      })
      const p = new ProviderPool({ providers: [{ provider: a }, { provider: b }] })
      await expect(p.chat(basicChat('x'))).rejects.toThrow(/plain error/)
    })

    it('embed() also fails over', async () => {
      const a = makeStub('a', {
        capabilities: defaultCapabilities(),
        embed: async () => {
          throw new ProviderError('a cannot embed', { providerId: 'a' })
        },
      })
      const b = makeStub('b', {
        capabilities: defaultCapabilities(),
        embed: async () => ({ model: 'b-embed', vectors: [new Float32Array([0.5])] }),
      })
      const p = new ProviderPool({ providers: [{ provider: a }, { provider: b }] })
      const r = await p.embed({ input: ['hi'], model: 'b-embed' })
      expect(r.model).toBe('b-embed')
    })
  })

  describe('streaming', () => {
    it('streams from the picked provider, no failover once first event emitted', async () => {
      const a = makeStub('a', {
        capabilities: defaultCapabilities(),
        stream: (): AsyncGenerator<StreamEvent, void, void> =>
          (async function* (): AsyncGenerator<StreamEvent, void, void> {
            yield { type: 'message_start', message: { role: 'assistant', content: '', toolCalls: [] } }
            yield { type: 'content_delta', delta: 'hello' }
            yield {
              type: 'message_complete',
              message: { role: 'assistant', content: 'hello', toolCalls: [] },
            }
          })(),
      })
      const b = makeStub('b', { capabilities: defaultCapabilities() })
      const p = new ProviderPool({ providers: [{ provider: a }, { provider: b }] })
      const events: StreamEvent[] = []
      for await (const ev of p.stream(basicChat('hi'))) events.push(ev)
      expect(events.some((e) => e.type === 'content_delta')).toBe(true)
    })
    it('falls back when the first event is an error', async () => {
      const a = makeStub('a', {
        capabilities: defaultCapabilities(),
        // First call to .next() throws — the pool's stream() catches
        // and falls over to the next provider.
        stream: (): AsyncGenerator<StreamEvent, void, void> => {
          throw new ProviderError('a stream died', { providerId: 'a' })
        },
      })
      const b = makeStub('b', {
        capabilities: defaultCapabilities(),
        stream: (): AsyncGenerator<StreamEvent, void, void> =>
          (async function* (): AsyncGenerator<StreamEvent, void, void> {
            yield { type: 'message_start', message: { role: 'assistant', content: '', toolCalls: [] } }
            yield { type: 'content_delta', delta: 'b-fallback' }
            yield {
              type: 'message_complete',
              message: { role: 'assistant', content: 'b-fallback', toolCalls: [] },
            }
          })(),
      })
      const p = new ProviderPool({ providers: [{ provider: a }, { provider: b }] })
      const events: StreamEvent[] = []
      for await (const ev of p.stream(basicChat('hi'))) events.push(ev)
      const deltas = events.filter((e) => e.type === 'content_delta') as Array<{ type: 'content_delta'; delta: string }>
      expect(deltas.map((d) => d.delta).join('')).toBe('b-fallback')
    })

    it('throws PoolExhaustedError when every stream is empty', async () => {
      const empty = (): AsyncGenerator<StreamEvent, void, void> =>
        (async function* (): AsyncGenerator<StreamEvent, void, void> {
          // Empty: no events at all.
        })()
      const a = makeStub('a', { capabilities: defaultCapabilities(), stream: empty })
      const b = makeStub('b', { capabilities: defaultCapabilities(), stream: empty })
      const p = new ProviderPool({ providers: [{ provider: a }, { provider: b }] })
      const iter = p.stream(basicChat('hi'))
      await expect(iter.next()).rejects.toBeInstanceOf(PoolExhaustedError)
    })
  })

  describe('exhaustiveness', () => {
    it('PoolExhaustedError extends AgentError', () => {
      const err = new PoolExhaustedError([{ providerId: 'a', error: new Error('x') }])
      expect(err).toBeInstanceOf(AgentError)
      expect(err.name).toBe('PoolExhaustedError')
    })
  })

  describe('concurrency', () => {
    it('round-robin cursor is atomic under concurrent chat() calls', async () => {
      // Without the internal Mutex, two `chat` calls landing in
      // the same event-loop microtask can both read cursor=0 and
      // both dispatch to provider 'a'. With the Mutex, each call
      // gets a distinct provider and the union covers all three.
      const seen: string[] = []
      const a = makeStub('a', {
        capabilities: defaultCapabilities(),
        chat: async () => {
          seen.push('a')
          return chatResponse('a', 'A')
        },
      })
      const b = makeStub('b', {
        capabilities: defaultCapabilities(),
        chat: async () => {
          seen.push('b')
          return chatResponse('b', 'B')
        },
      })
      const c = makeStub('c', {
        capabilities: defaultCapabilities(),
        chat: async () => {
          seen.push('c')
          return chatResponse('c', 'C')
        },
      })
      const p = new ProviderPool({
        strategy: 'round-robin',
        providers: [{ provider: a }, { provider: b }, { provider: c }],
      })
      await Promise.all([p.chat(basicChat('x')), p.chat(basicChat('x')), p.chat(basicChat('x'))])
      // The exact order depends on microtask scheduling, but the
      // union MUST be all three providers — no duplicates, no
      // skips. A pre-mutex implementation can drop one or repeat
      // one here.
      expect(seen.sort()).toEqual(['a', 'b', 'c'])
    })

    it('50 concurrent chat() calls cycle round-robin with no provider skipped or repeated', async () => {
      // The classic cursor race: N concurrent calls, all racing
      // on the same cursor. With a Mutex, every call observes a
      // strictly increasing cursor and each provider is hit
      // exactly N/3 times.
      const counts: Record<string, number> = { a: 0, b: 0, c: 0 }
      const stubs = ['a', 'b', 'c'].map(
        (id) =>
          makeStub(id, {
            capabilities: defaultCapabilities(),
            chat: async () => {
              counts[id] = (counts[id] ?? 0) + 1
              return chatResponse(id, id.toUpperCase())
            },
          }),
      )
      const p = new ProviderPool({
        strategy: 'round-robin',
        providers: stubs.map((provider) => ({ provider })),
      })
      const N = 60 // divisible by 3
      await Promise.all(Array.from({ length: N }, () => p.chat(basicChat('x'))))
      expect(counts).toEqual({ a: N / 3, b: N / 3, c: N / 3 })
    })
  })
})
