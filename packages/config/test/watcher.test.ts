/**
 * Tests for the config hot-reload watcher.
 *
 * Strategy: write a real YAML file to a temp directory, start
 * `watchConfig` pointed at it, and assert that edits produce
 * `kind:'config'` events with the new values.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchConfig, type ConfigWatchEvent } from '../src/index.js'
import { ConfigValidationError } from '../src/errors.js'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('watchConfig', () => {
  let dir: string
  const watchers: Array<{ dispose(): void }> = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lumen-config-watch-'))
  })

  afterEach(() => {
    for (const w of watchers) w.dispose()
    watchers.length = 0
    rmSync(dir, { recursive: true, force: true })
  })

  it('emits the initial config synchronously on first iteration', async () => {
    const path = join(dir, 'config.yaml')
    writeFileSync(path, 'defaultModel: foo\n', 'utf8')
    const watcher = watchConfig({
      projectPath: path,
      skipUserConfig: true,
    })
    watchers.push(watcher)
    const first = await watcher.events.next()
    expect(first.done).toBe(false)
    const ev = first.value as ConfigWatchEvent
    expect(ev.kind).toBe('config')
    if (ev.kind === 'config') {
      expect(ev.config.defaultModel).toBe('foo')
    }
  })

  it('emits a new config when the file is rewritten', async () => {
    const path = join(dir, 'config.yaml')
    writeFileSync(path, 'defaultModel: alpha\n', 'utf8')
    const watcher = watchConfig({
      projectPath: path,
      skipUserConfig: true,
      debounceMs: 5,
    })
    watchers.push(watcher)
    // Drain the initial event.
    const initial = await watcher.events.next()
    if (initial.done) throw new Error('expected initial config event')
    expect(initial.value.kind).toBe('config')

    // Edit the file. We bump mtime to nudge editors that use
    // atomic-rename semantics (the watcher already covers those, but
    // this is belt-and-braces for slow CI filesystems).
    writeFileSync(path, 'defaultModel: beta\n', 'utf8')
    utimesSync(path, new Date(), new Date())

    const next = await watcher.events.next()
    expect(next.done).toBe(false)
    const ev = next.value
    expect(ev.kind).toBe('config')
    if (ev.kind === 'config') {
      expect(ev.config.defaultModel).toBe('beta')
    }
  })

  it('emits an error event when a rewrite produces invalid YAML', async () => {
    const path = join(dir, 'config.yaml')
    writeFileSync(path, 'defaultModel: alpha\n', 'utf8')
    const watcher = watchConfig({
      projectPath: path,
      skipUserConfig: true,
      debounceMs: 5,
    })
    watchers.push(watcher)
    const initial = await watcher.events.next()
    if (initial.done) throw new Error('expected initial config event')
    expect(initial.value.kind).toBe('config')

    // Replace with a YAML sequence at the top level — invalid for our
    // schema (must be a mapping).
    writeFileSync(path, '- a\n- b\n', 'utf8')
    utimesSync(path, new Date(), new Date())

    const next = await watcher.events.next()
    expect(next.done).toBe(false)
    const ev = next.value
    expect(ev.kind).toBe('error')
  })

  it('dispose() stops the iterator and closes the watcher', async () => {
    const path = join(dir, 'config.yaml')
    writeFileSync(path, 'defaultModel: gamma\n', 'utf8')
    const watcher = watchConfig({
      projectPath: path,
      skipUserConfig: true,
      debounceMs: 5,
    })
    const initial = await watcher.events.next()
    if (initial.done) throw new Error('expected initial event')
    watcher.dispose()
    // After dispose, subsequent next() should resolve to done.
    const after = await watcher.events.next()
    expect(after.done).toBe(true)
  })

  it('re-exported ConfigValidationError can be used as a type guard', () => {
    // Sanity check: keep the import alive and confirm the type is
    // exported (catches accidental private renames).
    const err = new ConfigValidationError('boom', [])
    expect(err).toBeInstanceOf(ConfigValidationError)
  })
})
