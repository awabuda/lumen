/**
 * Desktop bridge — connects the Lumen agent runtime to a
 * Tauri-based desktop client.
 *
 * Architecture:
 *   ┌─────────────────┐  IPC (Tauri commands)  ┌────────────┐
 *   │  Tauri Rust     │ ◄────────────────────►│  Lumen     │
 *   │  (system, fs,   │                        │  agent     │
 *   │   notifications) │                        │            │
 *   └─────────────────┘                        └────────────┘
 *           ▲                                          ▲
 *           │ WebView (React)                          │
 *           │                                          │
 *           ▼                                          │
 *   ┌─────────────────┐                                │
 *   │  @lumen/desktop-│ ◄──────────────────────────────┘
 *   │  bridge (this)  │  typed IPC payload schemas +
 *   │                 │  BaseDesktopAdapter contract
 *   └─────────────────┘
 *
 * This package provides:
 *   - {@link BaseDesktopAdapter} abstract contract.
 *   - {@link TauriDesktopAdapter} implementation that wraps
 *     `@tauri-apps/api` (optional peer dep).
 *   - {@link MockDesktopAdapter} for tests.
 *   - IPC payload Zod schemas.
 *
 * The companion Tauri Rust crate (sibling repo) implements
 * the system commands; this package is the JS-side glue.
 *
 * Why a separate package:
 *   Tests for the bridge should not require Tauri. The
 *   {@link MockDesktopAdapter} lets the React UI be tested
 *   in plain jsdom + vitest, and lets the CLI drive the
 *   same agent flow in headless mode.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// IPC payload schemas — shared between JS and Rust
// ---------------------------------------------------------------------------

/** Request to invoke a Lumen tool from the desktop UI. */
export const ToolInvokeRequestSchema = z.object({
  /** Tool name (e.g. 'read_file'). */
  name: z.string().min(1),
  /** Validated tool input. */
  input: z.record(z.unknown()),
  /** Session id (for context). */
  sessionId: z.string().optional(),
})

/** Tool invocation result. */
export const ToolInvokeResponseSchema = z.object({
  /** Whether the invocation succeeded. */
  success: z.boolean(),
  /** The tool output, if successful. */
  output: z.unknown().optional(),
  /** Error message, if failed. */
  error: z.string().optional(),
  /** Wall-clock duration in ms. */
  durationMs: z.number().nonnegative(),
})

/** Status notification from the system (battery, network, etc.). */
export const SystemStatusSchema = z.object({
  /** OS family: 'macos' | 'linux' | 'windows' | 'unknown'. */
  os: z.enum(['macos', 'linux', 'windows', 'unknown']),
  /** Whether the agent is online. */
  online: z.boolean(),
  /** Free disk space in MB. */
  diskFreeMb: z.number().nonnegative().optional(),
  /** Current notification permission status. */
  notificationPermission: z.enum(['granted', 'denied', 'default']).optional(),
})

/** A desktop notification payload. */
export const NotificationRequestSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  /** Optional icon URL or data URI. */
  icon: z.string().optional(),
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Inferred type from {@link ToolInvokeRequestSchema}. */
export type ToolInvokeRequest = z.infer<typeof ToolInvokeRequestSchema>

/** Inferred type from {@link ToolInvokeResponseSchema}. */
export type ToolInvokeResponse = z.infer<typeof ToolInvokeResponseSchema>

/** Inferred type from {@link SystemStatusSchema}. */
export type SystemStatus = z.infer<typeof SystemStatusSchema>

/** Inferred type from {@link NotificationRequestSchema}. */
export type NotificationRequest = z.infer<typeof NotificationRequestSchema>

// ---------------------------------------------------------------------------
// BaseDesktopAdapter
// ---------------------------------------------------------------------------

/** The contract every desktop adapter fulfills. */
export abstract class BaseDesktopAdapter {
  /** Stable identifier. */
  public abstract readonly id: string

  /** Whether this adapter is the production one (vs a mock). */
  public abstract readonly isProduction: boolean

  /** Get the current system status. */
  public abstract getSystemStatus(): Promise<SystemStatus>

  /** Show a desktop notification. */
  public abstract notify(request: NotificationRequest): Promise<void>

  /**
   * Invoke a Lumen tool from the UI. The adapter delegates
   * to the running agent runtime; this is the wire between
   * Tauri events and the {@link ToolRegistry}.
   */
  public abstract invokeTool(request: ToolInvokeRequest): Promise<ToolInvokeResponse>

  /**
   * Optional: subscribe to system events (clipboard change,
   * window focus, etc). Default impl returns a no-op
   * unsubscribe function.
   */
  public subscribe(_handler: (event: SystemStatus) => void): () => void {
    return () => {
      // no-op
    }
  }
}

// ---------------------------------------------------------------------------
// TauriDesktopAdapter — production implementation
// ---------------------------------------------------------------------------

/**
 * Minimal shape of Tauri's invoke API. The real
 * `@tauri-apps/api` module exports an `invoke` function
 * with this signature; we keep the type local so this
 * package compiles even without the dependency installed.
 */
type TauriInvoke = {
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>
}

/** Zod schema for {@link TauriDesktopAdapterOptions}. */
export const TauriDesktopAdapterOptionsSchema = z.object({
  /**
   * The Tauri invoke function. In production, pass
   * `(await import('@tauri-apps/api/core')).invoke`. In
   * tests, omit it — the adapter throws on every call.
   */
  invoke: z.custom<TauriInvoke>(
    (v) => typeof v === 'function' || typeof (v as { invoke?: unknown })?.invoke === 'function',
  ),
})

/** Options for {@link TauriDesktopAdapter}. */
export type TauriDesktopAdapterOptions = z.input<typeof TauriDesktopAdapterOptionsSchema>

/** Production desktop adapter — wraps Tauri's invoke API. */
export class TauriDesktopAdapter extends BaseDesktopAdapter {
  public readonly id = 'tauri'
  public readonly isProduction = true
  private readonly invoke: TauriInvoke['invoke']

  public constructor(options: TauriDesktopAdapterOptions) {
    super()
    TauriDesktopAdapterOptionsSchema.parse(options)
    this.invoke = options.invoke.invoke.bind(options.invoke)
  }

  public async getSystemStatus(): Promise<SystemStatus> {
    const raw = await this.invoke<unknown>('lumen_system_status')
    return SystemStatusSchema.parse(raw)
  }

  public async notify(request: NotificationRequest): Promise<void> {
    NotificationRequestSchema.parse(request)
    await this.invoke('lumen_notify', { request })
  }

  public async invokeTool(request: ToolInvokeRequest): Promise<ToolInvokeResponse> {
    const parsed = ToolInvokeRequestSchema.parse(request)
    const startedAt = Date.now()
    try {
      const output = await this.invoke<unknown>('lumen_invoke_tool', { request: parsed })
      return {
        success: true,
        output,
        durationMs: Date.now() - startedAt,
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startedAt,
      }
    }
  }
}

// ---------------------------------------------------------------------------
// MockDesktopAdapter — for tests
// ---------------------------------------------------------------------------

/** Options for {@link MockDesktopAdapter}. */
export interface MockDesktopAdapterOptions {
  /** Initial status. Defaults to macos + online. */
  readonly status?: SystemStatus
  /** Pre-programmed tool responses, keyed by tool name. */
  readonly toolResponses?: Readonly<Record<string, unknown>>
  /** Throw this error from invokeTool. */
  readonly error?: Error
}

/** Test double for {@link BaseDesktopAdapter}. */
export class MockDesktopAdapter extends BaseDesktopAdapter {
  public readonly id = 'mock'
  public readonly isProduction = false
  private status: SystemStatus
  private readonly toolResponses: Readonly<Record<string, unknown>>
  private readonly error: Error | undefined
  private notifyCount = 0
  private invokeCount = 0

  public constructor(options: MockDesktopAdapterOptions = {}) {
    super()
    this.status = options.status ?? {
      os: 'macos',
      online: true,
      diskFreeMb: 50_000,
      notificationPermission: 'default',
    }
    this.toolResponses = options.toolResponses ?? {}
    this.error = options.error
  }

  public async getSystemStatus(): Promise<SystemStatus> {
    return SystemStatusSchema.parse(this.status)
  }

  public async notify(request: NotificationRequest): Promise<void> {
    NotificationRequestSchema.parse(request)
    this.notifyCount += 1
  }

  public async invokeTool(request: ToolInvokeRequest): Promise<ToolInvokeResponse> {
    const parsed = ToolInvokeRequestSchema.parse(request)
    this.invokeCount += 1
    const startedAt = Date.now()
    if (this.error) {
      return {
        success: false,
        error: this.error.message,
        durationMs: Date.now() - startedAt,
      }
    }
    const output =
      parsed.name in this.toolResponses ? this.toolResponses[parsed.name] : { echo: parsed.input }
    return {
      success: true,
      output,
      durationMs: Date.now() - startedAt,
    }
  }

  /** Number of notifications issued. */
  public get notificationCount(): number {
    return this.notifyCount
  }

  /** Number of tool invocations. */
  public get invocationCount(): number {
    return this.invokeCount
  }

  /** Update the status (for tests that exercise status changes). */
  public setStatus(status: SystemStatus): void {
    this.status = status
  }
}
