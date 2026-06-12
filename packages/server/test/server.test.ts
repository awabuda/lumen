/** Tests for @lumen/server. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BaseServerAdapter,
  CreateServerOptionsSchema,
  NodeHttpAdapter,
  RunRegistry,
  RunRequestSchema,
  createNodeServer,
} from '../src/index.js'

describe('RunRequestSchema', () => {
  it('requires userMessage', () => {
    expect(RunRequestSchema.safeParse({}).success).toBe(false)
  })

  it('accepts minimal request', () => {
    expect(RunRequestSchema.safeParse({ userMessage: 'hi' }).success).toBe(true)
  })

  it('accepts full request with session and maxIterations', () => {
    expect(
      RunRequestSchema.safeParse({
        userMessage: 'hi',
        sessionId: 's1',
        maxIterations: 5,
      }).success,
    ).toBe(true)
  })

  it('rejects non-positive maxIterations', () => {
    expect(
      RunRequestSchema.safeParse({ userMessage: 'x', maxIterations: 0 }).success,
    ).toBe(false)
  })
})

describe('CreateServerOptionsSchema', () => {
  it('requires agentFactory function', () => {
    expect(CreateServerOptionsSchema.safeParse({}).success).toBe(false)
    expect(
      CreateServerOptionsSchema.safeParse({ agentFactory: 'not fn' }).success,
    ).toBe(false)
    expect(
      CreateServerOptionsSchema.safeParse({ agentFactory: () => ({}) }).success,
    ).toBe(true)
  })

  it('defaults port to 0', () => {
    const r = CreateServerOptionsSchema.parse({ agentFactory: () => ({}) })
    expect(r.port).toBe(0)
  })
})

describe('RunRegistry', () => {
  it('registers and retrieves runs', () => {
    const reg = new RunRegistry()
    const fakeAgent = {} as never
    const abort = new AbortController()
    const id = reg.register(fakeAgent, abort)
    expect(reg.size).toBe(1)
    expect(reg.get(id)?.id).toBe(id)
  })

  it('finishes runs', () => {
    const reg = new RunRegistry()
    const id = reg.register({} as never, new AbortController())
    reg.finish(id)
    expect(reg.size).toBe(0)
    expect(reg.get(id)).toBeUndefined()
  })

  it('cancels runs', () => {
    const reg = new RunRegistry()
    const abort = new AbortController()
    const id = reg.register({} as never, abort)
    expect(reg.cancel(id)).toBe(true)
    expect(abort.signal.aborted).toBe(true)
    // After cancel, the run is still tracked but should not
    // be cancellable again — calling abort() is idempotent.
    expect(reg.cancel(id)).toBe(true)
    // After finish, the run is gone.
    reg.finish(id)
    expect(reg.cancel(id)).toBe(false)
  })

  it('lists ids', () => {
    const reg = new RunRegistry()
    const a = reg.register({} as never, new AbortController())
    const b = reg.register({} as never, new AbortController())
    expect(reg.ids()).toEqual(expect.arrayContaining([a, b]))
  })
})

describe('BaseServerAdapter is abstract', () => {
  it('cannot be instantiated directly', () => {
    // @ts-expect-error — abstract class
    new (BaseServerAdapter as any)()
  })
})

describe('NodeHttpAdapter', () => {
  let adapter: NodeHttpAdapter

  afterEach(async () => {
    if (adapter?.isRunning) await adapter.stop()
  })

  it('starts and stops on a random port', async () => {
    adapter = new NodeHttpAdapter()
    await adapter.start()
    expect(adapter.isRunning).toBe(true)
    expect(adapter.port).toBeGreaterThan(0)
  })

  it('id is "node-http"', () => {
    adapter = new NodeHttpAdapter()
    expect(adapter.id).toBe('node-http')
  })

  it('responds to GET /v1/health', async () => {
    adapter = new NodeHttpAdapter()
    await adapter.start()
    const res = await fetch(`http://127.0.0.1:${adapter.port}/v1/health`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { status: string; runs: number }
    expect(body.status).toBe('ok')
    expect(body.runs).toBe(0)
  })

  it('returns 404 for unknown paths', async () => {
    adapter = new NodeHttpAdapter()
    await adapter.start()
    const res = await fetch(`http://127.0.0.1:${adapter.port}/v1/nope`)
    expect(res.status).toBe(404)
  })

  it('returns 400 on invalid POST body', async () => {
    adapter = new NodeHttpAdapter()
    await adapter.start()
    const res = await fetch(`http://127.0.0.1:${adapter.port}/v1/agent/run`, {
      method: 'POST',
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('returns 501 on POST /v1/agent/run without factory', async () => {
    adapter = new NodeHttpAdapter()
    await adapter.start()
    const res = await fetch(`http://127.0.0.1:${adapter.port}/v1/agent/run`, {
      method: 'POST',
      body: JSON.stringify({ userMessage: 'hi' }),
    })
    expect(res.status).toBe(501)
  })

  it('cancel returns 404 for unknown run id', async () => {
    adapter = new NodeHttpAdapter()
    await adapter.start()
    const res = await fetch(
      `http://127.0.0.1:${adapter.port}/v1/agent/run-fake/cancel`,
      { method: 'POST' },
    )
    expect(res.status).toBe(404)
  })
})

describe('createNodeServer', () => {
  let server: ReturnType<typeof createNodeServer>

  afterEach(async () => {
    if (server?.adapter.isRunning) await server.stop()
  })

  it('returns an adapter, start, and stop', () => {
    server = createNodeServer({ agentFactory: () => ({}) as never })
    expect(server.adapter).toBeDefined()
    expect(typeof server.start).toBe('function')
    expect(typeof server.stop).toBe('function')
  })

  it('starts and is reachable', async () => {
    server = createNodeServer({ agentFactory: () => ({}) as never })
    await server.start()
    expect(server.adapter.isRunning).toBe(true)
    const res = await fetch(`http://127.0.0.1:${server.adapter.port}/v1/health`)
    expect(res.status).toBe(200)
  })

  it('runs the agent factory and returns the result', async () => {
    // Build a fake agent that returns a deterministic result.
    const fakeAgent = {
      async run(opts: { userMessage: string; sessionId?: string }) {
        return {
          sessionId: opts.sessionId ?? 'gen',
          finalMessage: { role: 'assistant', content: `echo: ${opts.userMessage}`, toolCalls: [] },
          iterations: 1,
          messages: [],
        }
      },
    }
    server = createNodeServer({ agentFactory: () => fakeAgent as never })
    await server.start()
    const res = await fetch(
      `http://127.0.0.1:${server.adapter.port}/v1/agent/run`,
      {
        method: 'POST',
        body: JSON.stringify({ userMessage: 'hello' }),
      },
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as { finalMessage: { content: string } }
    expect(body.finalMessage.content).toBe('echo: hello')
  })

  it('returns 400 on invalid request body', async () => {
    server = createNodeServer({ agentFactory: () => ({}) as never })
    await server.start()
    const res = await fetch(
      `http://127.0.0.1:${server.adapter.port}/v1/agent/run`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    )
    expect(res.status).toBe(400)
  })

  it('returns 500 when the agent throws', async () => {
    server = createNodeServer({
      agentFactory: () => ({
        async run() {
          throw new Error('agent-boom')
        },
      }) as never,
    })
    await server.start()
    const res = await fetch(
      `http://127.0.0.1:${server.adapter.port}/v1/agent/run`,
      {
        method: 'POST',
        body: JSON.stringify({ userMessage: 'fail' }),
      },
    )
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('agent-boom')
  })
})