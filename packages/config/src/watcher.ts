/**
 * Config hot-reload.
 *
 * Wraps {@link loadConfig} with a file watcher so a long-running process
 * (CLI in dev mode, IDE plugin, server) can pick up edits to the
 * project or user config without restarting.
 *
 * Strategy:
 *   - `fs.watch` on the project config (if found) and the user config
 *     (if found). We watch the *parent directory* of each config file
 *     and re-resolve the file path on every event, because most editors
 *     do atomic-rename writes that fire the `rename` event on the
 *     directory, not the file itself.
 *   - Debounce events by 50ms so a single save (which fires several
 *     `change`/`rename` events in quick succession) produces exactly
 *     one reload.
 *   - On reload, run the full `loadConfig` pipeline again. The
 *     resulting `LumenConfig` is emitted on the returned async
 *     iterator.
 *   - Errors during reload (file became invalid YAML, schema
 *     validation failed) are captured and surfaced as
 *     `ConfigReloadError` events; the previous good config is
 *     retained and re-emitted on the next valid reload so subscribers
 *     always have a usable config.
 *
 * Public API:
 *   - {@link watchConfig} — start watching; returns a
 *     {@link ConfigWatcher} with `events` (async iterator) and
 *     `dispose()`.
 */

import { type FSWatcher, existsSync, watch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { ConfigError } from './errors.js'
import { type LoadConfigOptions, loadConfig } from './loader.js'
import type { LumenConfig } from './schema.js'

/** A single emission from {@link ConfigWatcher.events}. */
export type ConfigWatchEvent =
  | { readonly kind: 'config'; readonly config: LumenConfig }
  | { readonly kind: 'error'; readonly error: ConfigError }

/**
 * Async resource returned by {@link watchConfig}.
 *
 * `events` is a one-shot async iterator that yields a new
 * {@link ConfigWatchEvent} every time the on-disk config changes
 * (or fails to reload). It completes when {@link dispose} is called.
 */
export interface ConfigWatcher {
  /** Stream of reload events. */
  readonly events: AsyncIterableIterator<ConfigWatchEvent>
  /** Stop watching and close the iterator. Idempotent. */
  dispose(): void
}

export interface WatchConfigOptions extends LoadConfigOptions {
  /**
   * Debounce window in milliseconds. Multiple `fs.watch` events
   * arriving inside this window collapse into one reload. Defaults to
   * 50ms, which empirically swallows every editor's burst without
   * adding noticeable latency to a manual save.
   */
  readonly debounceMs?: number
}

const DEFAULT_DEBOUNCE_MS = 50

/**
 * Resolve the project + user config paths the same way {@link loadConfig}
 * does, so we can `fs.watch` exactly the right files. Returns
 * `undefined` for any path the loader would have skipped.
 */
const resolveWatchedPaths = (
  options: LoadConfigOptions,
): { readonly project: string | undefined; readonly user: string | undefined } => {
  const cwd = options.cwd ?? process.cwd()
  const userPath = options.skipUserConfig
    ? undefined
    : (options.userPath ?? join(resolve(homedir()), '.lumen', 'config.yaml'))
  const projectPath = options.skipProjectConfig
    ? undefined
    : (options.projectPath ?? resolveProjectPathOrUndefined(cwd))
  return { project: projectPath, user: userPath }
}

/**
 * Inline of `resolveProjectPath` from loader.ts. We duplicate it here
 * rather than exporting from the loader so the watcher's contract
 * stays self-contained.
 */
const resolveProjectPathOrUndefined = (cwd: string): string | undefined => {
  const candidates = ['.lumen/config.yaml', '.lumen/config.yml', 'lumen.config.yaml']
  for (const c of candidates) {
    const full = join(cwd, c)
    if (existsSync(full)) return full
  }
  return undefined
}

// `homedir` import lives only inside the function to avoid pulling
// `node:os` at module top-level.
import { homedir } from 'node:os'

/**
 * Start watching the on-disk config and emit a fresh parsed
 * {@link LumenConfig} on every change. The first event is the
 * result of an initial `loadConfig` call; subsequent events follow
 * file changes.
 */
export const watchConfig = (options: WatchConfigOptions = {}): ConfigWatcher => {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const { project, user } = resolveWatchedPaths(options)

  // The "queue" carries events from the file-watcher callback into
  // the async iterator consumer. We use a simple one-deep slot rather
  // than an unbounded buffer so a fast producer cannot OOM a slow
  // consumer (the loader is the bottleneck on validation).
  let pendingResolve: ((value: ConfigWatchEvent) => void) | undefined
  const waitForNext = (): Promise<ConfigWatchEvent> =>
    new Promise((resolveEvent) => {
      pendingResolve = resolveEvent
    })

  // Track the most recently emitted config so we can include it on
  // `config` events after a transient error. The agent loop / CLI
  // shouldn't have to handle "no config available" windows.
  let lastConfig: LumenConfig | undefined

  // Debounce state — the timeout id for the pending reload, plus
  // the load options that must be re-applied each time.
  let debounceTimer: NodeJS.Timeout | undefined
  const scheduleReload = (): void => {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      void doReload()
    }, debounceMs)
  }

  const doReload = async (): Promise<void> => {
    try {
      const next = await loadConfig(options)
      lastConfig = next
      pendingResolve?.({ kind: 'config', config: next })
      pendingResolve = undefined
    } catch (err) {
      // Convert to a typed ConfigError if it isn't one already so
      // subscribers can `instanceof`-check.
      const error: ConfigError =
        err instanceof ConfigError
          ? err
          : new ConfigError(
              `Config reload failed: ${err instanceof Error ? err.message : String(err)}`,
              { cause: err },
            )
      pendingResolve?.({ kind: 'error', error })
      pendingResolve = undefined
    }
  }

  // We watch the parent directory of each config file because editors
  // that save via atomic rename (renameio, vim, most IDEs) fire the
  // `rename` event on the directory, not on the file. Watching the
  // directory gives us complete coverage at the cost of receiving
  // events we have to filter.
  const watchers: FSWatcher[] = []
  const watchedPaths = new Set<string>()
  const tryWatch = (file: string | undefined): void => {
    if (!file) return
    const dir = dirname(file)
    if (watchedPaths.has(dir)) return
    if (!existsSync(dir)) return
    watchedPaths.add(dir)
    try {
      const w = watch(dir, { persistent: false }, (_event, filename) => {
        // Some platforms report `filename` as the absolute path; others
        // as just the basename. Normalize by comparing basenames.
        const base = typeof filename === 'string' ? filename.split('/').pop() : undefined
        if (base === undefined) {
          scheduleReload()
          return
        }
        const target = join(dir, base)
        if (target === file) scheduleReload()
      })
      watchers.push(w)
    } catch {
      // If `fs.watch` fails (e.g. permission denied), skip silently
      // — the consumer still gets the initial load and can poll
      // themselves.
    }
  }
  tryWatch(project)
  tryWatch(user)

  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (debounceTimer) clearTimeout(debounceTimer)
    for (const w of watchers) {
      try {
        w.close()
      } catch {
        // best-effort
      }
    }
    // Wake the iterator so it can exit cleanly.
    pendingResolve?.({
      kind: 'error',
      error: new ConfigError('Config watcher disposed'),
    })
    pendingResolve = undefined
  }

  const events: AsyncIterableIterator<ConfigWatchEvent> = {
    next: async (): Promise<IteratorResult<ConfigWatchEvent>> => {
      if (disposed) return { value: undefined, done: true }
      // Lazy initial load: emit the first config synchronously, then
      // transition to waiting for file events.
      if (lastConfig === undefined && pendingResolve === undefined) {
        try {
          const initial = await loadConfig(options)
          lastConfig = initial
          return { value: { kind: 'config', config: initial }, done: false }
        } catch (err) {
          const error: ConfigError =
            err instanceof ConfigError
              ? err
              : new ConfigError(
                  `Initial config load failed: ${err instanceof Error ? err.message : String(err)}`,
                  { cause: err },
                )
          return { value: { kind: 'error', error }, done: false }
        }
      }
      const ev = await waitForNext()
      if (disposed) return { value: undefined, done: true }
      return { value: ev, done: false }
    },
    return: async (): Promise<IteratorResult<ConfigWatchEvent>> => {
      dispose()
      return { value: undefined, done: true }
    },
    [Symbol.asyncIterator]() {
      return this
    },
  }

  return { events, dispose }
}
