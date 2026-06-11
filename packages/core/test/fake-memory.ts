/**
 * A fake in-memory memory store. For tests only.
 */
import type {
  MemoryQuery,
  MemoryRecord,
  MemorySearchResult,
  SessionMessage,
  SessionRecord,
} from '../src/memory/index.js'
import { BaseMemoryStore } from '../src/memory/index.js'

export class FakeMemoryStore extends BaseMemoryStore {
  public readonly id = 'fake'
  public readonly records = new Map<string, MemoryRecord>()
  public readonly sessions = new Map<string, SessionRecord>()
  public readonly messages: SessionMessage[] = []
  private nextMessageId = 1

  public async init(): Promise<void> {
    /* no-op */
  }
  public async dispose(): Promise<void> {
    /* no-op */
  }

  public async put(record: Omit<MemoryRecord, 'createdAt' | 'updatedAt'>): Promise<MemoryRecord> {
    const now = Date.now()
    const full: MemoryRecord = { ...record, createdAt: now, updatedAt: now }
    this.records.set(full.id, full)
    return full
  }

  public async get(id: string): Promise<MemoryRecord | undefined> {
    return this.records.get(id)
  }

  public async delete(id: string): Promise<boolean> {
    return this.records.delete(id)
  }

  public async search(query: MemoryQuery): Promise<ReadonlyArray<MemorySearchResult>> {
    const all = [...this.records.values()]
    const filtered = all.filter((r) => {
      if (query.kind && r.kind !== query.kind) return false
      if (query.text && !r.content.includes(query.text)) return false
      if (query.minTrust !== undefined && r.trust < query.minTrust) return false
      if (query.tags && !query.tags.every((t) => r.tags.includes(t))) return false
      return true
    })
    return filtered.slice(0, query.limit ?? 20).map((record) => ({ record, score: 1.0 }))
  }

  public async createSession(
    record: Omit<SessionRecord, 'createdAt' | 'updatedAt'>,
  ): Promise<SessionRecord> {
    const now = Date.now()
    const full: SessionRecord = { ...record, createdAt: now, updatedAt: now }
    this.sessions.set(full.id, full)
    return full
  }

  public async getSession(id: string): Promise<SessionRecord | undefined> {
    return this.sessions.get(id)
  }

  public async listSessions(limit?: number): Promise<ReadonlyArray<SessionRecord>> {
    const all = [...this.sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)
    return typeof limit === 'number' ? all.slice(0, limit) : all
  }

  public async appendMessage(message: Omit<SessionMessage, 'id' | 'createdAt'>): Promise<SessionMessage> {
    const full: SessionMessage = {
      ...message,
      id: this.nextMessageId++,
      createdAt: Date.now(),
    }
    this.messages.push(full)
    return full
  }

  public async getSessionMessages(
    sessionId: string,
    options?: { limit?: number; before?: number },
  ): Promise<ReadonlyArray<SessionMessage>> {
    let msgs = this.messages.filter((m) => m.sessionId === sessionId)
    if (options?.before !== undefined) {
      msgs = msgs.filter((m) => m.id < options.before!)
    }
    if (options?.limit !== undefined) {
      msgs = msgs.slice(-options.limit)
    }
    return msgs
  }

  public async deleteSession(id: string): Promise<boolean> {
    if (!this.sessions.delete(id)) return false
    // Cascade: drop every message attached to the deleted
    // session. We rebuild `messages` rather than mutating in
    // place so the test's `expect(messages).toEqual([])`
    // assertion matches the public contract.
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]?.sessionId === id) this.messages.splice(i, 1)
    }
    return true
  }

  public async prune(_olderThanMs: number): Promise<number> {
    return 0
  }
}
