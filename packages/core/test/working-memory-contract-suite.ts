/**
 * Contract tests for {@link BaseWorkingMemory}.
 *
 * The exact same suite is run against every concrete working-memory
 * implementation. If you add a new backend, call
 * `runWorkingMemoryContractTests(label, factory)` from your test
 * file and you get the structural contract for free.
 *
 * **What this suite pins down:**
 *   - The buffer is bounded by `capacity` and the oldest
 *     entry is evicted when the buffer is full.
 *   - `recent(k)` returns the last `k` entries in
 *     chronological (insertion) order, oldest first.
 *   - `recent(undefined)` returns every entry; `recent(0)`
 *     returns an empty array.
 *   - `size` reflects the current entry count.
 *   - `clear` empties the buffer and resets `size` to 0.
 *   - `append` is monotonic in time: every appended entry's
 *     `appendedAt` is >= the previous one.
 *   - The default `renderWorkingMemory` helper produces a
 *     non-empty, multi-line string for a non-empty buffer
 *     and an empty string for an empty buffer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BaseWorkingMemory, MemoryRecord, WorkingMemoryEntry } from '../src/index.js'
import { renderWorkingMemory } from '../src/index.js'

const sampleRecord = (id: string, content = 'sample content'): MemoryRecord => ({
  id,
  kind: 'fact',
  content,
  trust: 0.5,
  tags: [],
  createdAt: 0,
  updatedAt: 0,
})

export function runWorkingMemoryContractTests(
  label: string,
  factory: () => Promise<BaseWorkingMemory> | BaseWorkingMemory,
): void {
  describe(`[contract] ${label}`, () => {
    let wm: BaseWorkingMemory

    beforeEach(async () => {
      wm = await factory()
    })

    afterEach(() => {
      wm.clear()
    })

    it('exposes a non-empty id', () => {
      expect(typeof wm.id).toBe('string')
      expect(wm.id.length).toBeGreaterThan(0)
    })

    it('exposes a positive integer capacity', () => {
      expect(Number.isInteger(wm.capacity)).toBe(true)
      expect(wm.capacity).toBeGreaterThan(0)
    })

    it('starts empty', () => {
      expect(wm.size).toBe(0)
      expect(wm.recent()).toEqual([])
    })

    it('append grows the buffer', () => {
      wm.append(sampleRecord('a'), 0.5)
      expect(wm.size).toBe(1)
      wm.append(sampleRecord('b'), 0.6)
      expect(wm.size).toBe(2)
    })

    it('recent(k) returns the last k entries oldest-first', () => {
      wm.append(sampleRecord('a'), 0.1)
      wm.append(sampleRecord('b'), 0.2)
      wm.append(sampleRecord('c'), 0.3)
      const last2 = wm.recent(2)
      expect(last2.map((e) => e.record.id)).toEqual(['b', 'c'])
    })

    it('recent(undefined) returns every entry', () => {
      wm.append(sampleRecord('a'), 0.1)
      wm.append(sampleRecord('b'), 0.2)
      const all = wm.recent()
      expect(all).toHaveLength(2)
    })

    it('recent(0) returns an empty array', () => {
      wm.append(sampleRecord('a'), 0.1)
      expect(wm.recent(0)).toEqual([])
    })

    it('evicts the oldest entry when the buffer overflows', () => {
      // We assume capacity > 1 in the default factory. If
      // a derived class uses capacity=1 we skip the check.
      if (wm.capacity < 2) return
      for (let i = 0; i < wm.capacity + 1; i += 1) {
        wm.append(sampleRecord(`r${i}`), i / 100)
      }
      expect(wm.size).toBe(wm.capacity)
      // The very first entry (r0) must have been evicted.
      const ids = wm.recent().map((e: WorkingMemoryEntry) => e.record.id)
      expect(ids).not.toContain('r0')
    })

    it('appendedAt is monotonically non-decreasing', async () => {
      wm.append(sampleRecord('a'), 0.1)
      await new Promise((r) => setTimeout(r, 2))
      wm.append(sampleRecord('b'), 0.2)
      const entries = wm.recent()
      expect(entries[0]?.appendedAt).toBeLessThanOrEqual(entries[1]?.appendedAt ?? 0)
    })

    it('clear empties the buffer and resets size', () => {
      wm.append(sampleRecord('a'), 0.1)
      wm.append(sampleRecord('b'), 0.2)
      wm.clear()
      expect(wm.size).toBe(0)
      expect(wm.recent()).toEqual([])
    })

    it('renderWorkingMemory produces a non-empty multi-line string for a non-empty buffer', () => {
      wm.append(sampleRecord('a', 'alpha'), 0.1)
      wm.append(sampleRecord('b', 'beta'), 0.2)
      const text = renderWorkingMemory(wm.recent())
      expect(text.length).toBeGreaterThan(0)
      expect(text.split('\n').length).toBe(2)
      expect(text).toContain('alpha')
      expect(text).toContain('beta')
    })

    it('renderWorkingMemory returns an empty string for an empty buffer', () => {
      expect(renderWorkingMemory(wm.recent())).toBe('')
    })

    it('renderWorkingMemory respects a custom format function', () => {
      wm.append(sampleRecord('a', 'alpha'), 0.1)
      const text = renderWorkingMemory(wm.recent(), (e) => `>> ${e.record.id} <<`)
      expect(text).toBe('>> a <<')
    })
  })
}
