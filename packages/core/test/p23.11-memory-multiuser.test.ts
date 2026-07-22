/**
 * P23.11 — memory + multi-user polish (fix #55, #62, #63).
 *
 *   #55  SqliteCheckpointStore (in @lumen/memory) yields to the
 *        event loop with `setImmediate` after every operation so
 *        the `Promise<…>` return is a real microtask hop instead
 *        of a synchronous return. The BaseCheckpointStore
 *        contract is preserved; what changes is the boundary.
 *        Tested in @lumen/memory's sqlite-checkpoint-store.test
 *        suite (P23.11 yields a resolved promise on each call).
 *
 *   #62  RingBufferWorkingMemory replaces `push` + `shift` with
 *        a pre-allocated circular buffer (head + count). After
 *        capacity has been reached, every append is O(1) instead
 *        of O(n).
 *
 *   #63  SessionGate maintains a `Map<userId, sessionId>` reverse
 *        index so `open()` is O(1) instead of an O(n) scan.
 */

import { describe, expect, it } from 'vitest'

import type { MemoryRecord } from '../src/memory/types.js'
import { RingBufferWorkingMemory } from '../src/memory/working-memory.js'
import { SessionGate } from '../src/multi-user/index.js'

const mkRecord = (id: string): MemoryRecord => ({
  id,
  content: `record-${id}`,
  source: 'test',
  timestamp: 0,
  metadata: {},
})

describe('P23.11 — fix #62: RingBufferWorkingMemory is O(1) on append (no shift)', () => {
  it('preserves insertion order and evicts the oldest entry after capacity', () => {
    const wb = new RingBufferWorkingMemory(3)
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      wb.append(mkRecord(id), 0.5)
    }
    // After 5 appends into capacity 3, the live window is ['c','d','e'].
    expect(wb.size).toBe(3)
    expect(wb.recent().map((e) => e.record.id)).toEqual(['c', 'd', 'e'])
    expect(wb.recent(2).map((e) => e.record.id)).toEqual(['d', 'e'])
    expect(wb.recent(10).map((e) => e.record.id)).toEqual(['c', 'd', 'e'])
  })

  it('wraps correctly across the modulo boundary (head past capacity)', () => {
    const wb = new RingBufferWorkingMemory(4)
    // Push 6 entries; capacity is 4 so the buffer wraps twice.
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
      wb.append(mkRecord(id), 0.1)
    }
    expect(wb.size).toBe(4)
    expect(wb.recent().map((e) => e.record.id)).toEqual(['c', 'd', 'e', 'f'])
    // recent(2): last 2 in insertion order.
    expect(wb.recent(2).map((e) => e.record.id)).toEqual(['e', 'f'])
  })

  it('clear() resets head and count', () => {
    const wb = new RingBufferWorkingMemory(2)
    wb.append(mkRecord('a'), 0.5)
    wb.append(mkRecord('b'), 0.5)
    wb.append(mkRecord('c'), 0.5)
    expect(wb.size).toBe(2)
    wb.clear()
    expect(wb.size).toBe(0)
    expect(wb.recent()).toEqual([])
    // Append after clear works normally.
    wb.append(mkRecord('x'), 0.5)
    expect(wb.recent().map((e) => e.record.id)).toEqual(['x'])
  })

  it('recent() with k=0 returns empty (no allocation)', () => {
    const wb = new RingBufferWorkingMemory(5)
    wb.append(mkRecord('a'), 0.5)
    expect(wb.recent(0)).toEqual([])
  })

  it('buffer allocates exactly capacity slots and no more', () => {
    const wb = new RingBufferWorkingMemory(7)
    // biome-ignore lint/suspicious/noExplicitAny: capture private state
    const internal = wb as any
    expect(internal.buffer.length).toBe(7)
    expect(internal.head).toBe(0)
    expect(internal.count).toBe(0)
  })
})

describe('P23.11 — fix #63: SessionGate reverse index', () => {
  it('open() returns the same session for repeated calls on the same user', async () => {
    const gate = new SessionGate()
    const a = await gate.open('user-a')
    const b = await gate.open('user-a')
    expect(a.id).toBe(b.id)
  })

  it('open() different users get different sessions', async () => {
    const gate = new SessionGate()
    const a = await gate.open('alice')
    const b = await gate.open('bob')
    expect(a.id).not.toBe(b.id)
  })

  it('close() clears the reverse-index for the closing user', async () => {
    const gate = new SessionGate()
    const a = await gate.open('user-c')
    expect(gate.close(a.id)).toBe(true)
    // re-open should give a new session id (the reverse index must
    // not point to a closed session).
    const a2 = await gate.open('user-c')
    expect(a2.id).not.toBe(a.id)
  })

  it('close() of a non-existent id is a no-op (false)', () => {
    const gate = new SessionGate()
    expect(gate.close('not-here')).toBe(false)
  })
})
