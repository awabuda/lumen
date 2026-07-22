/**
 * Working memory — a fixed-size, in-memory ring buffer of recent
 * records the agent has been thinking about.
 *
 * Why a separate component from {@link BaseMemoryStore}:
 *   - BaseMemoryStore is *durable*: every record survives a
 *     process restart. That's overkill for "the last 50
 *     facts the agent has pulled into the current turn" and
 *     would inflate the system prompt if you dumped the
 *     whole corpus on every model call.
 *   - Working memory is *ephemeral*: it lives only for the
 *     lifetime of one agent run, and the agent loop can
 *     pull from it cheaply to assemble a focused context
 *     window.
 *
 * Design:
 *   - Append-only. Items are never mutated in place; the
 *     agent's reasoning is append-then-consider, not
 *     append-then-mutate.
 *   - Bounded by `capacity`. When the buffer fills, the
 *     oldest item is dropped (FIFO eviction).
 *   - Items are scored entries — every record has a `score`
 *     so the agent can sort by recency, relevance, or
 *     trust. The score is opaque to the working memory
 *     itself; it's set by whoever appends.
 *   - `recent(k)` returns the last `k` items in
 *     chronological order (oldest first), so the caller
 *     can drop them straight into a system prompt.
 */

import { ValidationError } from '../errors/index.js'
import type { MemoryRecord } from './index.js'

/**
 * One entry in working memory: a record plus a score and
 * a timestamp. The score is intentionally a `number`, not
 * a typed enum: the agent runtime is free to assign any
 * scalar (recency weight, FTS rank, embedding similarity,
 * trust, etc.) depending on the surface that put the
 * record there.
 */
export interface WorkingMemoryEntry {
  readonly record: MemoryRecord
  /** Opaque score set by the producer. Higher = more relevant. */
  readonly score: number
  /** Wall-clock time the entry was appended. */
  readonly appendedAt: number
}

/**
 * A pluggable, in-memory, bounded buffer of recent records.
 *
 * Two concrete implementations:
 *   - {@link RingBufferWorkingMemory} — pure JS, no
 *     dependencies, the default. Used by every Lumen agent
 *     unless a derived class overrides.
 *   - (future) A SQLite-backed variant for agents that
 *     want durable working memory across runs.
 *
 * The contract is intentionally tiny. The agent loop only
 * needs `append`, `recent`, `clear`, and a `size` getter.
 */
export abstract class BaseWorkingMemory {
  /** Stable identifier for the implementation. */
  public abstract readonly id: string

  /** Maximum number of entries the buffer holds. */
  public abstract readonly capacity: number

  /** Append an entry. When the buffer is full, the oldest
   * entry is evicted to make room. */
  public abstract append(record: MemoryRecord, score: number): void

  /**
   * The last `k` entries, oldest first. Returns at most
   * `k` entries; returns an empty array when the buffer
   * is empty.
   */
  public abstract recent(k?: number): ReadonlyArray<WorkingMemoryEntry>

  /** Number of entries currently in the buffer. */
  public abstract get size(): number

  /** Drop every entry. */
  public abstract clear(): void
}

/**
 * Default {@link BaseWorkingMemory} implementation: a pure
 * ring buffer. No dependencies, no async work, no I/O.
 *
 * Memory: `O(capacity)` regardless of how many appends
 * happen. We do *not* allow the buffer to grow past
 * `capacity`; the constructor asserts a positive value
 * so a misconfigured agent fails fast.
 */
export class RingBufferWorkingMemory extends BaseWorkingMemory {
  public readonly id = 'ring-buffer'
  public readonly capacity: number
  /**
   * Fixed-size circular storage. `head` is the index of the
   * next write slot; `count` is the number of entries currently
   * held (`0..capacity`). After `capacity` appends, every
   * write overwrites the oldest entry without any O(n) shift.
   *
   * P23.11 (fix #62) — replaces the pre-P23.11
   * `this.items.push(...) + this.items.shift()` which had an
   * O(n) shift on every eviction. The new shape is O(1) for
   * `append` and O(k) for `recent(k)` (slice of the live
   * window), instead of shifting on every append.
   */
  private readonly buffer: WorkingMemoryEntry[] = []
  private head = 0
  private count = 0

  public constructor(capacity = 50) {
    super()
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new ValidationError(
        `RingBufferWorkingMemory: capacity must be a positive integer, got ${capacity}`,
        { field: 'capacity', value: capacity },
      )
    }
    this.capacity = capacity
    // Pre-allocate the storage array. Slots are `undefined` until
    // they are filled. Iteration in `recent()` skips undefined slots
    // based on the `count` window.
    this.buffer.length = capacity
  }

  public append(record: MemoryRecord, score: number): void {
    this.buffer[this.head] = { record, score, appendedAt: Date.now() }
    this.head = (this.head + 1) % this.capacity
    if (this.count < this.capacity) this.count += 1
  }

  public recent(k?: number): ReadonlyArray<WorkingMemoryEntry> {
    if (this.count === 0) return []
    if (k === undefined || k >= this.count) {
      // Walk the live window in insertion order (oldest first).
      const start = this.count < this.capacity ? 0 : this.head
      const out: WorkingMemoryEntry[] = []
      for (let i = 0; i < this.count; i += 1) {
        const entry = this.buffer[(start + i) % this.capacity]
        if (entry !== undefined) out.push(entry)
      }
      return out
    }
    if (k <= 0) return []
    // Last `k` in insertion order. The oldest of the last k lives
    // at slot `(head - k) mod capacity` whenever the buffer is
    // non-empty: when `count < capacity`, `head` is the next free
    // slot, so the first append sits at index 0 and the last
    // append sits at `head - 1`. After capacity has been reached
    // the next free slot is also where the next overwrite lands,
    // and the oldest entry is exactly `(head - count) mod cap`.
    const start = (this.head - k + this.capacity) % this.capacity
    const out: WorkingMemoryEntry[] = []
    for (let i = 0; i < k; i += 1) {
      const entry = this.buffer[(start + i) % this.capacity]
      if (entry !== undefined) out.push(entry)
    }
    return out
  }

  public get size(): number {
    return this.count
  }

  public clear(): void {
    this.buffer.length = 0
    this.buffer.length = this.capacity
    this.head = 0
    this.count = 0
  }
}

/**
 * Render working-memory entries as a system-prompt fragment.
 *
 * This is a tiny pure helper so the agent loop does not
 * have to know about the working-memory data shape. The
 * output is deliberately compact: one entry per line,
 * `[score] content`. Operators can override the format by
 * passing a custom `format` function.
 */
export const renderWorkingMemory = (
  entries: ReadonlyArray<WorkingMemoryEntry>,
  format: (entry: WorkingMemoryEntry) => string = defaultFormat,
): string => {
  if (entries.length === 0) return ''
  return entries.map(format).join('\n')
}

const defaultFormat = (entry: WorkingMemoryEntry): string => {
  // Two decimals for the score keeps the prompt tight
  // while still distinguishing 0.91 from 0.83.
  const s = entry.score.toFixed(2)
  // The record's content may be arbitrarily long; we
  // truncate to keep the system prompt well under any
  // reasonable context budget. 240 chars is a safe default
  // for a model with a 16K context window and a system
  // prompt that has to leave room for the conversation.
  const preview =
    entry.record.content.length > 240
      ? `${entry.record.content.slice(0, 237)}...`
      : entry.record.content
  return `[${s}] ${preview}`
}
