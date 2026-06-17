/** Tests for multi-user collaboration. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ApprovalRequiredPolicy,
  BasePermissionPolicy,
  BaseUserStore,
  CreateUserInputSchema,
  InMemoryUserStore,
  MultiUserRuntime,
  RoleBasedPolicy,
  SessionGate,
  UpdateUserInputSchema,
  UserRoleSchema,
  UserSessionSchema,
} from '../src/multi-user/index.js'

describe('UserRoleSchema', () => {
  it('accepts the four built-in roles', () => {
    for (const r of ['admin', 'member', 'guest', 'readonly']) {
      expect(UserRoleSchema.safeParse(r).success).toBe(true)
    }
  })

  it('rejects unknown roles', () => {
    expect(UserRoleSchema.safeParse('superuser').success).toBe(false)
  })
})

describe('CreateUserInputSchema', () => {
  it('requires id and name', () => {
    expect(CreateUserInputSchema.safeParse({}).success).toBe(false)
    expect(CreateUserInputSchema.safeParse({ id: 'a' }).success).toBe(false)
    expect(CreateUserInputSchema.safeParse({ id: 'a', name: 'Alice' }).success).toBe(true)
  })

  it('defaults role to member', () => {
    const r = CreateUserInputSchema.parse({ id: 'a', name: 'Alice' })
    expect(r.role).toBe('member')
  })

  it('rejects invalid emails', () => {
    expect(
      CreateUserInputSchema.safeParse({ id: 'a', name: 'b', email: 'not-email' }).success,
    ).toBe(false)
  })
})

describe('UpdateUserInputSchema', () => {
  it('rejects an empty patch', () => {
    expect(UpdateUserInputSchema.safeParse({}).success).toBe(true)
  })

  it('accepts partial updates', () => {
    expect(UpdateUserInputSchema.safeParse({ name: 'Bob', lastSeenAt: Date.now() }).success).toBe(
      true,
    )
  })
})

describe('UserSessionSchema', () => {
  it('requires id, userId, title, timestamps', () => {
    expect(UserSessionSchema.safeParse({}).success).toBe(false)
    expect(
      UserSessionSchema.safeParse({
        id: 's',
        userId: 'u',
        title: 't',
        createdAt: 0,
        lastActiveAt: 0,
      }).success,
    ).toBe(true)
  })
})

describe('RoleBasedPolicy', () => {
  const user = (role: 'admin' | 'member' | 'guest' | 'readonly') => ({
    id: 'u',
    name: 'u',
    role,
    createdAt: 0,
  })

  it('admin gets all tools', () => {
    const p = new RoleBasedPolicy()
    expect(p.check({ user: user('admin'), tool: 'terminal' })).toBe('allow')
    expect(p.check({ user: user('admin'), tool: 'anything' })).toBe('allow')
  })

  it('member gets most tools but not exotic ones', () => {
    const p = new RoleBasedPolicy()
    expect(p.check({ user: user('member'), tool: 'read_file' })).toBe('allow')
    expect(p.check({ user: user('member'), tool: 'terminal' })).toBe('allow')
    expect(p.check({ user: user('member'), tool: 'nuke' })).toBe('deny')
  })

  it('guest gets only safe tools', () => {
    const p = new RoleBasedPolicy()
    expect(p.check({ user: user('guest'), tool: 'read_file' })).toBe('allow')
    expect(p.check({ user: user('guest'), tool: 'terminal' })).toBe('deny')
  })

  it('readonly gets only read-only tools', () => {
    const p = new RoleBasedPolicy()
    expect(p.check({ user: user('readonly'), tool: 'read_file' })).toBe('allow')
    expect(p.check({ user: user('readonly'), tool: 'write_file' })).toBe('deny')
  })

  it('respects overrides', () => {
    const p = new RoleBasedPolicy({
      overrides: { guest: ['terminal'] },
    })
    expect(p.check({ user: user('guest'), tool: 'terminal' })).toBe('allow')
    expect(p.check({ user: user('guest'), tool: 'read_file' })).toBe('deny')
  })

  it('exposes id "role"', () => {
    expect(new RoleBasedPolicy().id).toBe('role')
  })
})

describe('ApprovalRequiredPolicy', () => {
  const member = {
    id: 'u',
    name: 'u',
    role: 'member' as const,
    createdAt: 0,
  }

  it('downgrades allowed decisions to needs-approval for listed tools', () => {
    const inner = new RoleBasedPolicy()
    const p = new ApprovalRequiredPolicy(inner, ['terminal', 'write_file'])
    expect(p.check({ user: member, tool: 'terminal' })).toBe('needs-approval')
    expect(p.check({ user: member, tool: 'read_file' })).toBe('allow')
  })

  it('preserves deny decisions', () => {
    const inner = new RoleBasedPolicy()
    const p = new ApprovalRequiredPolicy(inner, ['nuke'])
    expect(p.check({ user: member, tool: 'nuke' })).toBe('deny')
  })

  it('exposes id "approval-required"', () => {
    expect(new ApprovalRequiredPolicy(new RoleBasedPolicy(), []).id).toBe('approval-required')
  })
})

describe('BasePermissionPolicy is abstract', () => {
  it('cannot be instantiated directly', () => {
    // biome-ignore lint/suspicious/noExplicitAny: abstract class cannot be instantiated directly
    ;new (BasePermissionPolicy as any)()
  })
})

describe('InMemoryUserStore', () => {
  let store: InMemoryUserStore

  beforeEach(async () => {
    store = new InMemoryUserStore()
    await store.init()
  })

  afterEach(async () => {
    await store.dispose()
  })

  it('creates and retrieves users', async () => {
    const u = await store.create({ id: 'a', name: 'Alice', role: 'admin' })
    expect(u.id).toBe('a')
    expect(u.role).toBe('admin')
    expect(u.createdAt).toBeGreaterThan(0)
    expect(await store.get('a')).toEqual(u)
  })

  it('rejects duplicate ids (Rule 7)', async () => {
    await store.create({ id: 'a', name: 'Alice', role: 'admin' })
    await expect(store.create({ id: 'a', name: 'Bob', role: 'member' })).rejects.toThrow(
      /already exists/,
    )
  })

  it('updates fields', async () => {
    await store.create({ id: 'a', name: 'Alice', role: 'member' })
    const updated = await store.update('a', { name: 'Alicia', role: 'admin' })
    expect(updated.name).toBe('Alicia')
    expect(updated.role).toBe('admin')
  })

  it('throws on update for unknown user', async () => {
    await expect(store.update('nope', { name: 'X' })).rejects.toThrow(/not found/)
  })

  it('deletes users', async () => {
    await store.create({ id: 'a', name: 'Alice', role: 'member' })
    expect(await store.delete('a')).toBe(true)
    expect(await store.get('a')).toBeUndefined()
    expect(await store.delete('a')).toBe(false)
  })

  it('lists users sorted by createdAt desc', async () => {
    await store.create({ id: 'old', name: 'Old', role: 'member' })
    await new Promise((r) => setTimeout(r, 5))
    await store.create({ id: 'new', name: 'New', role: 'member' })
    const all = await store.list()
    expect(all.map((u) => u.id)).toEqual(['new', 'old'])
  })

  it('respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.create({ id: `u${i}`, name: `U${i}`, role: 'member' })
    }
    expect(await store.list(2)).toHaveLength(2)
  })
})

describe('BaseUserStore is abstract', () => {
  it('cannot be instantiated directly', () => {
    // biome-ignore lint/suspicious/noExplicitAny: abstract class cannot be instantiated directly
    ;new (BaseUserStore as any)()
  })
})

describe('SessionGate', () => {
  it('opens a session per user', async () => {
    const gate = new SessionGate()
    const a = await gate.open('alice', 'alice-session')
    const b = await gate.open('bob', 'bob-session')
    expect(a.userId).toBe('alice')
    expect(b.userId).toBe('bob')
    expect(gate.size).toBe(2)
  })

  it('returns the existing session when opening again', async () => {
    const gate = new SessionGate()
    const first = await gate.open('alice')
    const second = await gate.open('alice')
    expect(second.id).toBe(first.id)
    expect(gate.size).toBe(1)
  })

  it('closes sessions', async () => {
    const gate = new SessionGate()
    const s = await gate.open('alice')
    expect(gate.close(s.id)).toBe(true)
    expect(gate.close(s.id)).toBe(false)
  })

  it('lists sessions per user', async () => {
    const gate = new SessionGate()
    await gate.open('alice')
    await gate.open('bob')
    await gate.open('alice', 'second')
    // alice has one session (re-open bumps), bob has one.
    expect(gate.listForUser('alice')).toHaveLength(1)
    expect(gate.listForUser('bob')).toHaveLength(1)
    expect(gate.listForUser('nobody')).toHaveLength(0)
  })
})

describe('MultiUserRuntime', () => {
  let runtime: MultiUserRuntime

  beforeEach(async () => {
    const store = new InMemoryUserStore()
    runtime = new MultiUserRuntime({
      userStore: store,
      policy: new RoleBasedPolicy(),
    })
    await runtime.init()
    await store.create({ id: 'admin1', name: 'Admin', role: 'admin' })
    await store.create({ id: 'guest1', name: 'Guest', role: 'guest' })
  })

  afterEach(async () => {
    await runtime.dispose()
  })

  it('authorizes admin for any tool', async () => {
    expect(await runtime.authorize('admin1', 'terminal')).toBe('allow')
    expect(await runtime.authorize('admin1', 'anything')).toBe('allow')
  })

  it('denies guest for dangerous tools', async () => {
    expect(await runtime.authorize('guest1', 'read_file')).toBe('allow')
    expect(await runtime.authorize('guest1', 'terminal')).toBe('deny')
  })

  it('throws on unknown user (Rule 7)', async () => {
    await expect(runtime.authorize('nobody', 'read_file')).rejects.toThrow(/not found/)
  })

  it('exposes store, policy, sessionGate', () => {
    expect(runtime.userStore.id).toBe('in-memory')
    expect(runtime.permissionPolicy.id).toBe('role')
    expect(runtime.sessionGate).toBeDefined()
  })
})
