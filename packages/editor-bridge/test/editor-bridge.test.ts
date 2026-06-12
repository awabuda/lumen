/** Tests for @lumen/editor-bridge. */

import { describe, expect, it } from 'vitest'
import {
  BaseEditorAdapter,
  EditorCommandSchema,
  JetBrainsEditorAdapter,
  MockEditorAdapter,
  PositionSchema,
  RangeSchema,
  SelectionResultSchema,
  TextEditSchema,
  VSCodeEditorAdapter,
} from '../src/index.js'

describe('PositionSchema', () => {
  it('rejects negative line or character', () => {
    expect(PositionSchema.safeParse({ line: -1, character: 0 }).success).toBe(false)
    expect(PositionSchema.safeParse({ line: 0, character: -1 }).success).toBe(false)
  })

  it('accepts zero-indexed positions', () => {
    expect(PositionSchema.safeParse({ line: 0, character: 0 }).success).toBe(true)
  })
})

describe('RangeSchema', () => {
  it('requires start and end', () => {
    expect(RangeSchema.safeParse({}).success).toBe(false)
    expect(
      RangeSchema.safeParse({
        start: { line: 0, character: 0 },
        end: { line: 1, character: 0 },
      }).success,
    ).toBe(true)
  })
})

describe('TextEditSchema', () => {
  it('requires path, range, newText', () => {
    expect(TextEditSchema.safeParse({}).success).toBe(false)
  })
})

describe('EditorCommandSchema (discriminated union)', () => {
  it('accepts open-file', () => {
    expect(
      EditorCommandSchema.safeParse({ kind: 'open-file', path: '/x' }).success,
    ).toBe(true)
  })

  it('accepts show-info', () => {
    expect(
      EditorCommandSchema.safeParse({ kind: 'show-info', message: 'hi' }).success,
    ).toBe(true)
  })

  it('requires edits array for apply-edits', () => {
    expect(
      EditorCommandSchema.safeParse({ kind: 'apply-edits', edits: [] }).success,
    ).toBe(false)
    expect(
      EditorCommandSchema.safeParse({
        kind: 'apply-edits',
        edits: [
          {
            path: '/x',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            newText: 'y',
          },
        ],
      }).success,
    ).toBe(true)
  })

  it('accepts insert-text', () => {
    expect(
      EditorCommandSchema.safeParse({
        kind: 'insert-text',
        path: '/x',
        position: { line: 0, character: 0 },
        text: 'a',
      }).success,
    ).toBe(true)
  })

  it('rejects unknown kinds', () => {
    expect(
      EditorCommandSchema.safeParse({ kind: 'delete-everything' }).success,
    ).toBe(false)
  })
})

describe('SelectionResultSchema', () => {
  it('requires path, text, range', () => {
    expect(SelectionResultSchema.safeParse({}).success).toBe(false)
  })
})

describe('BaseEditorAdapter is abstract', () => {
  it('cannot be instantiated directly', () => {
    // @ts-expect-error — abstract class
    new (BaseEditorAdapter as any)()
  })
})

describe('MockEditorAdapter', () => {
  it('records dispatched commands', async () => {
    const adapter = new MockEditorAdapter()
    await adapter.dispatch({ kind: 'open-file', path: '/x' })
    await adapter.dispatch({ kind: 'show-info', message: 'hi' })
    expect(adapter.history).toHaveLength(2)
    expect(adapter.history[0]?.kind).toBe('open-file')
  })

  it('returns selection when configured', async () => {
    const adapter = new MockEditorAdapter({
      selection: {
        path: '/x',
        text: 'hello',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      },
    })
    const res = await adapter.dispatch({ kind: 'get-selection', path: '/x' })
    expect(res.ok).toBe(true)
  })

  it('returns no-selection error when unconfigured', async () => {
    const adapter = new MockEditorAdapter()
    const res = await adapter.dispatch({ kind: 'get-selection', path: '/x' })
    expect(res.ok).toBe(false)
  })

  it('captures dispatch errors (Rule 7)', async () => {
    const adapter = new MockEditorAdapter({ error: new Error('boom') })
    const res = await adapter.dispatch({ kind: 'show-info', message: 'x' })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('boom')
  })

  it('subscribe + emit round-trips events', () => {
    const adapter = new MockEditorAdapter()
    const events: string[] = []
    const unsub = adapter.onEvent((e) => events.push(e.path))
    adapter.emit({ kind: 'file-saved', path: '/a' })
    adapter.emit({ kind: 'selection-changed', path: '/b' })
    unsub()
    adapter.emit({ kind: 'file-saved', path: '/c' })
    expect(events).toEqual(['/a', '/b'])
  })

  it('exposes id "mock" and editorKind "mock" and isProduction=false', () => {
    const adapter = new MockEditorAdapter()
    expect(adapter.id).toBe('mock')
    expect(adapter.editorKind).toBe('mock')
    expect(adapter.isProduction).toBe(false)
  })

  it('rejects invalid command at the schema level', async () => {
    const adapter = new MockEditorAdapter()
    // @ts-expect-error — testing bad command
    await expect(adapter.dispatch({ kind: 'nope' })).rejects.toThrow()
  })
})

describe('VSCodeEditorAdapter', () => {
  const makeApi = (overrides: Partial<{
    showInformationMessage: (m: string) => Promise<string | undefined>
    openTextDocument: (u: { fsPath: string }) => Promise<unknown>
    applyEdit: (e: unknown) => Promise<boolean>
  }> = {}) => ({
    window: {
      showInformationMessage: overrides.showInformationMessage ?? (async () => undefined),
    },
    workspace: {
      textDocuments: [],
      openTextDocument: overrides.openTextDocument ?? (async () => ({ getText: () => '', lineAt: () => ({ text: '' }) })),
      applyEdit: overrides.applyEdit ?? (async () => true),
    },
  })

  it('exposes id "vscode" and editorKind "vscode" and isProduction=true', () => {
    const adapter = new VSCodeEditorAdapter({ api: makeApi() as never })
    expect(adapter.id).toBe('vscode')
    expect(adapter.editorKind).toBe('vscode')
    expect(adapter.isProduction).toBe(true)
  })

  it('open-file calls workspace.openTextDocument', async () => {
    const calls: Array<{ fsPath: string }> = []
    const adapter = new VSCodeEditorAdapter({
      api: makeApi({
        openTextDocument: async (u) => {
          calls.push(u)
          return { getText: () => '', lineAt: () => ({ text: '' }) }
        },
      }) as never,
    })
    const res = await adapter.dispatch({ kind: 'open-file', path: '/x' })
    expect(res.ok).toBe(true)
    expect(calls[0]?.fsPath).toBe('/x')
  })

  it('show-info calls window.showInformationMessage', async () => {
    const messages: string[] = []
    const adapter = new VSCodeEditorAdapter({
      api: makeApi({
        showInformationMessage: async (m) => {
          messages.push(m)
          return undefined
        },
      }) as never,
    })
    await adapter.dispatch({ kind: 'show-info', message: 'hi' })
    expect(messages).toEqual(['hi'])
  })

  it('apply-edits calls workspace.applyEdit', async () => {
    const edits: unknown[] = []
    const adapter = new VSCodeEditorAdapter({
      api: makeApi({
        applyEdit: async (e) => {
          edits.push(e)
          return true
        },
      }) as never,
    })
    await adapter.dispatch({
      kind: 'apply-edits',
      edits: [
        {
          path: '/x',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          newText: 'a',
        },
      ],
    })
    expect(edits).toHaveLength(1)
  })

  it('get-selection returns document text', async () => {
    const adapter = new VSCodeEditorAdapter({
      api: makeApi({
        openTextDocument: async () => ({
          getText: () => 'contents',
          lineAt: () => ({ text: 'contents' }),
        }),
      }) as never,
    })
    const res = await adapter.dispatch({ kind: 'get-selection', path: '/x' })
    expect(res.ok).toBe(true)
    expect((res.data as { text: string }).text).toBe('contents')
  })
})

describe('JetBrainsEditorAdapter', () => {
  const makeApi = (overrides: Partial<{
    showNotification: (m: string) => Promise<void>
    openFile: (p: string) => Promise<void>
    applyEdits: (p: string, e: ReadonlyArray<unknown>) => Promise<void>
    getSelection: (p: string) => Promise<unknown>
  }> = {}) => ({
    showNotification: overrides.showNotification ?? (async () => {}),
    openFile: overrides.openFile ?? (async () => {}),
    applyEdits: overrides.applyEdits ?? (async () => {}),
    getSelection: overrides.getSelection ?? (async () => null),
  })

  it('exposes id "jetbrains" and editorKind "jetbrains"', () => {
    const adapter = new JetBrainsEditorAdapter({ api: makeApi() as never })
    expect(adapter.id).toBe('jetbrains')
    expect(adapter.editorKind).toBe('jetbrains')
    expect(adapter.isProduction).toBe(true)
  })

  it('groups apply-edits by path', async () => {
    const calls: Array<{ path: string; count: number }> = []
    const adapter = new JetBrainsEditorAdapter({
      api: makeApi({
        applyEdits: async (p, edits) => {
          calls.push({ path: p, count: edits.length })
        },
      }) as never,
    })
    await adapter.dispatch({
      kind: 'apply-edits',
      edits: [
        { path: '/a', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '1' },
        { path: '/a', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '2' },
        { path: '/b', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }, newText: '3' },
      ],
    })
    expect(calls).toEqual([
      { path: '/a', count: 2 },
      { path: '/b', count: 1 },
    ])
  })

  it('get-selection returns the selection data', async () => {
    const adapter = new JetBrainsEditorAdapter({
      api: makeApi({
        getSelection: async () => ({
          path: '/x',
          text: 'selected',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
        }),
      }) as never,
    })
    const res = await adapter.dispatch({ kind: 'get-selection', path: '/x' })
    expect(res.ok).toBe(true)
  })

  it('get-selection returns error when nothing is selected', async () => {
    const adapter = new JetBrainsEditorAdapter({
      api: makeApi({ getSelection: async () => null }) as never,
    })
    const res = await adapter.dispatch({ kind: 'get-selection', path: '/x' })
    expect(res.ok).toBe(false)
  })
})