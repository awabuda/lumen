/**
 * Multi-user collaboration.
 *
 * In a multi-user deployment, several humans share one
 * Lumen instance. Each user has:
 *   - An identity (id, display name, role).
 *   - Their own sessions.
 *   - A permission policy that decides which tools they
 *     can invoke.
 *
 * This module provides the data structures, the
 * {@link BaseUserStore} contract, a permission policy
 * engine, and a per-user session gate that ties the rest
 * of the runtime together.
 *
 * Design constraints (from CLAUDE.md):
 *   - No global state, no singletons. Pass stores
 *     through constructors.
 *   - Inheritance > configuration. Tools that need
 *     per-user gating subclass {@link PermissionPolicy}.
 *   - Every public symbol is documented and validated
 *     via Zod.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** Built-in roles. Custom roles can be added via string. */
export const UserRoleSchema = z.enum(['admin', 'member', 'guest', 'readonly'])
export type UserRole = z.infer<typeof UserRoleSchema>

/** A registered user. */
export interface User {
  /** Stable identifier. */
  readonly id: string
  /** Display name shown in the UI. */
  readonly name: string
  /** Email (optional). */
  readonly email?: string
  /** Role — gates default permissions. */
  readonly role: UserRole
  /** When the user was created (epoch ms). */
  readonly createdAt: number
  /** When the user last logged in (epoch ms). */
  readonly lastSeenAt?: number
}

/** A permission decision. */
export type PermissionDecision = 'allow' | 'deny' | 'needs-approval'

/** Context passed to {@link PermissionPolicy.check}. */
export interface PermissionContext {
  /** The user requesting the action. */
  readonly user: User
  /** The tool name. */
  readonly tool: string
  /** Optional tool input. */
  readonly input?: unknown
  /** Session id for context. */
  readonly sessionId?: string
}

/** A permission policy. */
export abstract class BasePermissionPolicy {
  /** Stable identifier. */
  public abstract readonly id: string

  /**
   * Decide whether `ctx.user` can invoke `ctx.tool`.
   * Throws on configuration errors (Rule 7).
   */
  public abstract check(ctx: PermissionContext): PermissionDecision
}

// ---------------------------------------------------------------------------
// RoleBasedPolicy — default policy
// ---------------------------------------------------------------------------

/** Default permissions per role. */
const DEFAULT_ROLE_PERMISSIONS: Readonly<Record<UserRole, ReadonlySet<string>>> = {
  admin: new Set(['*']),
  member: new Set([
    'read_file',
    'write_file',
    'list_dir',
    'search_files',
    'patch',
    'terminal',
    'git',
    'gh',
  ]),
  guest: new Set(['read_file', 'list_dir', 'search_files']),
  readonly: new Set(['read_file', 'list_dir', 'search_files']),
}

/** Zod schema for {@link RoleBasedPolicyOptions}. */
export const RoleBasedPolicyOptionsSchema = z.object({
  /** Override the default role permission map. */
  overrides: z
    .record(z.array(z.string()))
    .optional(),
})

/** Options for {@link RoleBasedPolicy}. */
export type RoleBasedPolicyOptions = z.input<typeof RoleBasedPolicyOptionsSchema>

/**
 * The default policy: per-role allowlists. `admin` role
 * has `'*'` (all tools). Other roles use the default
 * {@link DEFAULT_ROLE_PERMISSIONS} map, optionally
 * overridden via constructor options.
 */
export class RoleBasedPolicy extends BasePermissionPolicy {
  public readonly id = 'role'
  private readonly map: Record<UserRole, ReadonlySet<string>>

  public constructor(options: RoleBasedPolicyOptions = {}) {
    super()
    RoleBasedPolicyOptionsSchema.parse(options)
    this.map = { ...DEFAULT_ROLE_PERMISSIONS }
    if (options.overrides) {
      for (const [role, tools] of Object.entries(options.overrides)) {
        this.map[role as UserRole] = new Set(tools)
      }
    }
  }

  public check(ctx: PermissionContext): PermissionDecision {
    const allowed = this.map[ctx.user.role]
    if (allowed.has('*')) return 'allow'
    if (allowed.has(ctx.tool)) return 'allow'
    return 'deny'
  }
}

/**
 * A policy that layers "needs approval" on top of another
 * policy. Useful when a tool is allowed for a role but
 * should require explicit user approval.
 */
export class ApprovalRequiredPolicy extends BasePermissionPolicy {
  public readonly id = 'approval-required'
  private readonly inner: BasePermissionPolicy
  private readonly approvalTools: ReadonlySet<string>

  public constructor(inner: BasePermissionPolicy, approvalTools: ReadonlyArray<string>) {
    super()
    this.inner = inner
    this.approvalTools = new Set(approvalTools)
  }

  public check(ctx: PermissionContext): PermissionDecision {
    const decision = this.inner.check(ctx)
    if (decision !== 'allow') return decision
    if (this.approvalTools.has(ctx.tool)) return 'needs-approval'
    return 'allow'
  }
}

// ---------------------------------------------------------------------------
// User store
// ---------------------------------------------------------------------------

/** The contract every user store fulfills. */
export abstract class BaseUserStore {
  /** Stable identifier. */
  public abstract readonly id: string

  /** Initialise the store (open connections, etc). */
  public abstract init(): Promise<void>
  /** Release resources. */
  public abstract dispose(): Promise<void>

  /** Create a new user. */
  public abstract create(input: Omit<User, 'createdAt'>): Promise<User>
  /** Get a user by id. */
  public abstract get(id: string): Promise<User | undefined>
  /** Update a user. */
  public abstract update(id: string, patch: Partial<Omit<User, 'id' | 'createdAt'>>): Promise<User>
  /** Delete a user. */
  public abstract delete(id: string): Promise<boolean>
  /** List users (most recent first). */
  public abstract list(limit?: number): Promise<ReadonlyArray<User>>
}

/** Zod schema for creating a user. */
export const CreateUserInputSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  email: z.string().email().optional(),
  role: UserRoleSchema.default('member'),
})

/** Zod schema for updating a user. */
export const UpdateUserInputSchema = z.object({
  name: z.string().min(1).optional(),
  email: z.string().email().optional(),
  role: UserRoleSchema.optional(),
  lastSeenAt: z.number().int().nonnegative().optional(),
})

// ---------------------------------------------------------------------------
// InMemoryUserStore
// ---------------------------------------------------------------------------

/** Options for {@link InMemoryUserStore}. */
export interface InMemoryUserStoreOptions {
  /** Default role for users without one. */
  readonly defaultRole?: UserRole
}

/** A simple in-memory user store. */
export class InMemoryUserStore extends BaseUserStore {
  public readonly id = 'in-memory'
  private readonly users: Map<string, User> = new Map()
  private readonly defaultRole: UserRole

  public constructor(options: InMemoryUserStoreOptions = {}) {
    super()
    this.defaultRole = options.defaultRole ?? 'member'
  }

  public async init(): Promise<void> {
    // no-op
  }

  public async dispose(): Promise<void> {
    this.users.clear()
  }

  public async create(input: Omit<User, 'createdAt'>): Promise<User> {
    const parsed = CreateUserInputSchema.parse({ ...input, role: input.role ?? this.defaultRole })
    if (this.users.has(parsed.id)) {
      throw new Error(`User "${parsed.id}" already exists`)
    }
    const user: User = {
      id: parsed.id,
      name: parsed.name,
      role: parsed.role,
      createdAt: Date.now(),
      ...(parsed.email ? { email: parsed.email } : {}),
    }
    this.users.set(parsed.id, user)
    return user
  }

  public async get(id: string): Promise<User | undefined> {
    return this.users.get(id)
  }

  public async update(
    id: string,
    patch: Partial<Omit<User, 'id' | 'createdAt'>>,
  ): Promise<User> {
    const existing = this.users.get(id)
    if (!existing) throw new Error(`User "${id}" not found`)
    UpdateUserInputSchema.parse(patch)
    const updated: User = { ...existing, ...patch }
    this.users.set(id, updated)
    return updated
  }

  public async delete(id: string): Promise<boolean> {
    return this.users.delete(id)
  }

  public async list(limit = 100): Promise<ReadonlyArray<User>> {
    const all = [...this.users.values()]
    all.sort((a, b) => b.createdAt - a.createdAt)
    return all.slice(0, limit)
  }
}

// ---------------------------------------------------------------------------
// SessionGate — per-user session manager
// ---------------------------------------------------------------------------

/** A session owned by a user. */
export interface UserSession {
  /** Session id. */
  readonly id: string
  /** User id. */
  readonly userId: string
  /** Session title. */
  readonly title: string
  /** When the session was created. */
  readonly createdAt: number
  /** When the session was last active. */
  readonly lastActiveAt: number
}

/** Zod schema for {@link UserSession}. */
export const UserSessionSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  title: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  lastActiveAt: z.number().int().nonnegative(),
})

/** Per-user session gate. Maps userId -> sessionId. */
export class SessionGate {
  private readonly sessions: Map<string, UserSession> = new Map()

  /** Create or return the active session for a user. */
  public async open(userId: string, title = 'untitled'): Promise<UserSession> {
    const existing = [...this.sessions.values()].find((s) => s.userId === userId)
    if (existing) {
      const bumped: UserSession = { ...existing, lastActiveAt: Date.now() }
      this.sessions.set(existing.id, bumped)
      return bumped
    }
    const session: UserSession = {
      id: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId,
      title,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    }
    UserSessionSchema.parse(session)
    this.sessions.set(session.id, session)
    return session
  }

  /** Close a session. */
  public close(id: string): boolean {
    return this.sessions.delete(id)
  }

  /** List sessions for a user. */
  public listForUser(userId: string): ReadonlyArray<UserSession> {
    return [...this.sessions.values()].filter((s) => s.userId === userId)
  }

  /** Get a session by id. */
  public get(id: string): UserSession | undefined {
    return this.sessions.get(id)
  }

  /** Number of sessions. */
  public get size(): number {
    return this.sessions.size
  }
}

// ---------------------------------------------------------------------------
// MultiUserRuntime — wires everything together
// ---------------------------------------------------------------------------

/** Options for {@link MultiUserRuntime}. */
export interface MultiUserRuntimeOptions {
  readonly userStore: BaseUserStore
  readonly policy: BasePermissionPolicy
  readonly sessionGate?: SessionGate
}

/**
 * Composes user store, policy, and session gate. The agent
 * loop calls {@link authorize} before each tool call.
 */
export class MultiUserRuntime {
  private readonly users: BaseUserStore
  private readonly policy: BasePermissionPolicy
  private readonly sessions: SessionGate

  public constructor(options: MultiUserRuntimeOptions) {
    this.users = options.userStore
    this.policy = options.policy
    this.sessions = options.sessionGate ?? new SessionGate()
  }

  /** Initialise the user store. */
  public async init(): Promise<void> {
    await this.users.init()
  }

  /** Release resources. */
  public async dispose(): Promise<void> {
    await this.users.dispose()
  }

  /** Get the underlying user store. */
  public get userStore(): BaseUserStore {
    return this.users
  }

  /** Get the underlying policy. */
  public get permissionPolicy(): BasePermissionPolicy {
    return this.policy
  }

  /** Get the underlying session gate. */
  public get sessionGate(): SessionGate {
    return this.sessions
  }

  /**
   * Check whether `userId` is allowed to invoke `tool`.
   * Throws if the user does not exist (Rule 7).
   */
  public async authorize(userId: string, tool: string, input?: unknown): Promise<PermissionDecision> {
    const user = await this.users.get(userId)
    if (!user) throw new Error(`User "${userId}" not found`)
    return this.policy.check({ user, tool, ...(input !== undefined ? { input } : {}) })
  }
}