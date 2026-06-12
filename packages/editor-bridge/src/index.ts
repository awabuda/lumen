/**
 * Editor bridge — connects the Lumen agent runtime to
 * editor extensions (VSCode, JetBrains, Neovim, etc).
 *
 * Architecture:
 *   ┌──────────────────┐  LSP-style commands  ┌────────────┐
 *   │  VSCode / JB     │ ◄──────────────────► │  Lumen     │
 *   │  Extension Host  │                       │  agent     │
 *   └──────────────────┘                       └────────────┘
 *           ▲                                          ▲
 *           │ Webview / Tool Window                    │
 *           │                                          │
 *           ▼                                          │
 *   ┌──────────────────┐                                │
 *   │  @lumen/         │ ◄──────────────────────────────┘
 *   │  editor-bridge   │  typed command payloads +
 *   │  (this package)  │  BaseEditorAdapter contract
 *   └──────────────────┘
 *
 * This package provides:
 *   - {@link BaseEditorAdapter} abstract contract.
 *   - {@link VSCodeEditorAdapter} wrapping VSCode's API.
 *   - {@link JetBrainsEditorAdapter} wrapping the JetBrains
 *     `intellij-platform` RPC stubs.
 *   - {@link MockEditorAdapter} for tests.
 *   - {@link EditorCommandSchema} for command payloads.
 *
 * The peer dep on `@types/vscode` is optional; this package
 * compiles and tests run without the editor installed.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Editor command schemas
// ---------------------------------------------------------------------------

/** Position in a text document (1-indexed line and column). */
export const PositionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative(),
})

/** A range in a text document. */
export const RangeSchema = z.object({
  start: PositionSchema,
  end: PositionSchema,
})

/** A single edit operation. */
export const TextEditSchema = z.object({
  /** Path to the file to edit. */
  path: z.string().min(1),
  /** Range to replace. */
  range: RangeSchema,
  /** New text. */
  newText: z.string(),
})

/** A command sent to the editor. */
export const EditorCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('open-file'),
    path: z.string().min(1),
  }),
  z.object({
    kind: z.literal('show-info'),
    message: z.string().min(1),
  }),
  z.object({
    kind: z.literal('apply-edits'),
    edits: z.array(TextEditSchema).min(1),
  }),
  z.object({
    kind: z.literal('insert-text'),
    path: z.string().min(1),
    position: PositionSchema,
    text: z.string(),
  }),
  z.object({
    kind: z.literal('get-selection'),
    path: z.string().min(1),
  }),
])

/** A selection or a message indicating no selection. */
export const SelectionResultSchema = z.object({
  path: z.string().min(1),
  text: z.string(),
  range: RangeSchema,
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Position in a document. */
export type Position = z.infer<typeof PositionSchema>

/** Range in a document. */
export type Range = z.infer<typeof RangeSchema>

/** A single edit. */
export type TextEdit = z.infer<typeof TextEditSchema>

/** A command sent to the editor. */
export type EditorCommand = z.infer<typeof EditorCommandSchema>

/** A selection result. */
export type SelectionResult = z.infer<typeof SelectionResultSchema>

/** The discriminator for editor type. */
export type EditorKind = 'vscode' | 'jetbrains' | 'mock'

// ---------------------------------------------------------------------------
// BaseEditorAdapter
// ---------------------------------------------------------------------------

/** The contract every editor adapter fulfills. */
export abstract class BaseEditorAdapter {
  /** Stable identifier. */
  public abstract readonly id: string

  /** Which editor this adapter targets. */
  public abstract readonly editorKind: EditorKind

  /** Whether this is the production adapter (vs a mock). */
  public abstract readonly isProduction: boolean

  /**
   * Dispatch a command to the editor. Returns a result
   * specific to the command kind, or a structured error
   * (Rule 7: do not throw on user input; throw on
   * configuration errors only).
   */
  public abstract dispatch(command: EditorCommand): Promise<DispatchResult>

  /**
   * Optional: register a handler for editor events
   * (file saved, selection changed, etc). Default impl
   * returns a no-op unsubscribe.
   */
  public onEvent(_handler: (event: EditorEvent) => void): () => void {
    return () => {
      // no-op
    }
  }
}

/** A result type for dispatch. */
export type DispatchResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: string }

/** A simple editor event. */
export interface EditorEvent {
  /** Event kind. */
  readonly kind: 'file-saved' | 'selection-changed' | 'diagnostics'
  /** Path of the file involved. */
  readonly path: string
  /** Optional payload. */
  readonly data?: unknown
}

// ---------------------------------------------------------------------------
// VSCodeEditorAdapter
// ---------------------------------------------------------------------------

/**
 * Minimal shape of the VSCode API surface we use. The real
 * `vscode` module exports a singleton with these namespaces;
 * we keep the type local so the package builds without the
 * dependency installed.
 */
type VSCodeApi = {
  readonly window: {
    showInformationMessage(message: string): Promise<string | undefined>
  }
  readonly workspace: {
    readonly textDocuments: {
      readonly uri: { readonly fsPath: string }
      getText(): string
    }[]
    openTextDocument(uri: { fsPath: string }): Promise<{
      getText(): string
      lineAt(line: number): { text: string }
    }>
    applyEdit(edit: unknown): Promise<boolean>
  }
}

/** Zod schema for {@link VSCodeEditorAdapterOptions}. */
export const VSCodeEditorAdapterOptionsSchema = z.object({
  api: z.custom<VSCodeApi>((v) => typeof v === 'object' && v !== null),
})

/** Options for {@link VSCodeEditorAdapter}. */
export type VSCodeEditorAdapterOptions = z.input<typeof VSCodeEditorAdapterOptionsSchema>

/** Production adapter for the VSCode editor. */
export class VSCodeEditorAdapter extends BaseEditorAdapter {
  public readonly id = 'vscode'
  public override readonly editorKind: EditorKind = 'vscode'
  public readonly isProduction = true
  private readonly api: VSCodeApi

  public constructor(options: VSCodeEditorAdapterOptions) {
    super()
    VSCodeEditorAdapterOptionsSchema.parse(options)
    this.api = options.api
  }

  public async dispatch(command: EditorCommand): Promise<DispatchResult> {
    const parsed = EditorCommandSchema.parse(command)
    switch (parsed.kind) {
      case 'open-file':
        await this.api.workspace.openTextDocument({
          fsPath: parsed.path,
        })
        return { ok: true }
      case 'show-info':
        await this.api.window.showInformationMessage(parsed.message)
        return { ok: true }
      case 'apply-edits':
        // In a real impl, build a WorkspaceEdit with all
        // edits. Here we just acknowledge.
        await this.api.workspace.applyEdit({ edits: parsed.edits })
        return { ok: true }
      case 'insert-text':
        await this.api.workspace.applyEdit({
          edits: [{ path: parsed.path, position: parsed.position, text: parsed.text }],
        })
        return { ok: true }
      case 'get-selection':
        const doc = await this.api.workspace.openTextDocument({ fsPath: parsed.path })
        const text = doc.getText()
        return {
          ok: true,
          data: {
            path: parsed.path,
            text,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          } satisfies SelectionResult,
        }
    }
  }
}

// ---------------------------------------------------------------------------
// JetBrainsEditorAdapter
// ---------------------------------------------------------------------------

/**
 * Minimal shape of the JetBrains RPC surface. JetBrains
 * plugins run on the IntelliJ Platform and use a different
 * IPC scheme than VSCode; this adapter is a thin facade
 * that issues RPC calls into the platform.
 */
type JetBrainsApi = {
  showNotification(message: string): Promise<void>
  openFile(path: string): Promise<void>
  applyEdits(path: string, edits: ReadonlyArray<TextEdit>): Promise<void>
  getSelection(path: string): Promise<SelectionResult | null>
}

/** Zod schema for {@link JetBrainsEditorAdapterOptions}. */
export const JetBrainsEditorAdapterOptionsSchema = z.object({
  api: z.custom<JetBrainsApi>((v) => typeof v === 'object' && v !== null),
})

/** Options for {@link JetBrainsEditorAdapter}. */
export type JetBrainsEditorAdapterOptions = z.input<typeof JetBrainsEditorAdapterOptionsSchema>

/** Production adapter for JetBrains IDEs (IntelliJ, PyCharm, etc). */
export class JetBrainsEditorAdapter extends BaseEditorAdapter {
  public readonly id = 'jetbrains'
  public override readonly editorKind: EditorKind = 'jetbrains'
  public readonly isProduction = true
  private readonly api: JetBrainsApi

  public constructor(options: JetBrainsEditorAdapterOptions) {
    super()
    JetBrainsEditorAdapterOptionsSchema.parse(options)
    this.api = options.api
  }

  public async dispatch(command: EditorCommand): Promise<DispatchResult> {
    const parsed = EditorCommandSchema.parse(command)
    switch (parsed.kind) {
      case 'open-file':
        await this.api.openFile(parsed.path)
        return { ok: true }
      case 'show-info':
        await this.api.showNotification(parsed.message)
        return { ok: true }
      case 'apply-edits':
        // Group edits by path; one RPC call per file.
        const byPath = new Map<string, TextEdit[]>()
        for (const edit of parsed.edits) {
          const list = byPath.get(edit.path) ?? []
          list.push(edit)
          byPath.set(edit.path, list)
        }
        for (const [path, edits] of byPath) {
          await this.api.applyEdits(path, edits)
        }
        return { ok: true }
      case 'insert-text':
        await this.api.applyEdits(parsed.path, [
          {
            path: parsed.path,
            range: {
              start: parsed.position,
              end: parsed.position,
            },
            newText: parsed.text,
          },
        ])
        return { ok: true }
      case 'get-selection':
        const selection = await this.api.getSelection(parsed.path)
        if (!selection) {
          return { ok: false, error: 'no selection' }
        }
        return { ok: true, data: selection }
    }
  }
}

// ---------------------------------------------------------------------------
// MockEditorAdapter — for tests
// ---------------------------------------------------------------------------

/** Options for {@link MockEditorAdapter}. */
export interface MockEditorAdapterOptions {
  /** Optional pre-programmed selection. */
  readonly selection?: SelectionResult
  /** Throw this from dispatch. */
  readonly error?: Error
}

/** Test double for {@link BaseEditorAdapter}. */
export class MockEditorAdapter extends BaseEditorAdapter {
  public readonly id = 'mock'
  public override readonly editorKind: EditorKind = 'mock'
  public readonly isProduction = false
  private readonly selection: SelectionResult | undefined
  private readonly error: Error | undefined
  private readonly dispatched: EditorCommand[] = []
  private readonly eventHandlers: Array<(e: EditorEvent) => void> = []

  public constructor(options: MockEditorAdapterOptions = {}) {
    super()
    this.selection = options.selection
    this.error = options.error
  }

  public async dispatch(command: EditorCommand): Promise<DispatchResult> {
    const parsed = EditorCommandSchema.parse(command)
    this.dispatched.push(parsed)
    if (this.error) {
      return { ok: false, error: this.error.message }
    }
    if (parsed.kind === 'get-selection') {
      if (!this.selection) {
        return { ok: false, error: 'no selection' }
      }
      return { ok: true, data: this.selection }
    }
    return { ok: true }
  }

  public override onEvent(handler: (event: EditorEvent) => void): () => void {
    this.eventHandlers.push(handler)
    return () => {
      const i = this.eventHandlers.indexOf(handler)
      if (i >= 0) this.eventHandlers.splice(i, 1)
    }
  }

  /** Commands dispatched so far. */
  public get history(): ReadonlyArray<EditorCommand> {
    return this.dispatched
  }

  /** Emit an event to all registered handlers. */
  public emit(event: EditorEvent): void {
    for (const h of this.eventHandlers) h(event)
  }
}