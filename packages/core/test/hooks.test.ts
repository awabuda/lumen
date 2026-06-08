import { describe, expect, it } from 'vitest'
import { HookRegistry } from '../src/hooks/index.js'
import type { HookEvent } from '../src/hooks/index.js'

describe('HookRegistry', () => {
  it('dispatches events to all registered hooks in order', async () => {
    const reg = new HookRegistry()
    const order: string[] = []
    reg.register(() => {
      order.push('a')
    })
    reg.register(() => {
      order.push('b')
    })
    reg.register(() => {
      order.push('c')
    })
    const event: HookEvent = { kind: 'run:start', sessionId: 's', userMessage: 'x' }
    await reg.dispatch(event, { sessionId: 's', iteration: 0, startedAt: 0 })
    expect(order).toEqual(['a', 'b', 'c'])
  })

  it('isolates hook failures so the run survives', async () => {
    const reg = new HookRegistry()
    let ran = false
    reg.register(() => {
      throw new Error('boom')
    })
    reg.register(() => {
      ran = true
    })
    // Suppress console.error from the registry's catch
    const originalErr = console.error
    console.error = () => undefined
    try {
      await reg.dispatch(
        { kind: 'run:start', sessionId: 's', userMessage: 'x' },
        { sessionId: 's', iteration: 0, startedAt: 0 },
      )
    } finally {
      console.error = originalErr
    }
    expect(ran).toBe(true)
  })

  it('unregister removes a hook', async () => {
    const reg = new HookRegistry()
    let count = 0
    const unregister = reg.register(() => {
      count += 1
    })
    await reg.dispatch(
      { kind: 'run:start', sessionId: 's', userMessage: 'x' },
      { sessionId: 's', iteration: 0, startedAt: 0 },
    )
    expect(count).toBe(1)
    unregister()
    await reg.dispatch(
      { kind: 'run:start', sessionId: 's', userMessage: 'x' },
      { sessionId: 's', iteration: 0, startedAt: 0 },
    )
    expect(count).toBe(1)
  })
})
