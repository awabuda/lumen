/**
 * Toolset — a named, lazy-initialised bundle of {@link BaseTool}
 * instances.
 *
 * Why a separate concept from {@link ToolRegistry}:
 *   - The registry is a flat list of already-constructed tools.
 *     Every tool is constructed up front, so the cost of
 *     spinning up the full default palette is paid whether or
 *     not the agent ever calls any of them.
 *   - A toolset is a recipe: a name plus a factory that
 *     returns tools on demand. The CLI can read a config
 *     like `tools.enabled: ['fs', 'git']` and only pay
 *     the construction cost for those two sets.
 *
 * Two kinds of toolsets:
 *   - {@link StaticToolset} — the factory runs once and
 *     the result is cached.
 *   - {@link LazyToolset} — the factory runs *every* time
 *     {@link materialize} is called, and the result is
 *     returned to the caller without caching. Useful when
 *     the tools hold per-call state (e.g. a per-session
 *     context).
 *
 * The {@link ToolRegistry} now exposes a `registerToolset`
 * method that materializes a toolset's tools and adds
 * them under a `name:tool` namespacing convention. Two
 * toolsets can ship the same tool name without colliding
 * because each lives under its own prefix.
 */

import type { BaseTool } from './index.js'

/** A factory that returns a fresh array of tools. */
export type ToolsetFactory = () => ReadonlyArray<BaseTool>

/**
 * The contract every toolset implements.
 *
 * A toolset is intentionally *not* a BaseTool itself —
 * it is a *collection* of tools that share a lifecycle
 * and a name. The composition root instantiates the
 * toolset, calls `materialize()`, and registers the
 * resulting tools with a {@link ToolRegistry}.
 */
export abstract class BaseToolset {
  /** Stable identifier used as a namespacing prefix. */
  public abstract readonly id: string
  /** Human-readable name. */
  public abstract readonly name: string
  /** One-line description, shown by `lumen tools --toolset`. */
  public abstract readonly description: string

  /**
   * Return the tools this toolset contributes. The
   * semantics of "when does the factory run?" depend on
   * the concrete subclass ({@link StaticToolset} caches;
   * {@link LazyToolset} does not).
   */
  public abstract materialize(): ReadonlyArray<BaseTool>
}

/**
 * Materialize the factory exactly once and cache the
 * result. Subsequent calls to `materialize()` return
 * the same array. Use this for toolsets whose tools
 * are stateless (the typical case).
 */
export class StaticToolset extends BaseToolset {
  public readonly id: string
  public readonly name: string
  public readonly description: string
  private readonly factory: ToolsetFactory
  private cache: ReadonlyArray<BaseTool> | null = null

  public constructor(opts: {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly factory: ToolsetFactory
  }) {
    super()
    this.id = opts.id
    this.name = opts.name
    this.description = opts.description
    this.factory = opts.factory
  }

  public materialize(): ReadonlyArray<BaseTool> {
    if (this.cache) return this.cache
    this.cache = this.factory()
    return this.cache
  }
}

/**
 * Re-run the factory on every `materialize()` call. Use
 * for toolsets whose tools are stateful or per-session
 * (e.g. a tool that holds a per-conversation context
 * object).
 */
export class LazyToolset extends BaseToolset {
  public readonly id: string
  public readonly name: string
  public readonly description: string
  private readonly factory: ToolsetFactory

  public constructor(opts: {
    readonly id: string
    readonly name: string
    readonly description: string
    readonly factory: ToolsetFactory
  }) {
    super()
    this.id = opts.id
    this.name = opts.name
    this.description = opts.description
    this.factory = opts.factory
  }

  public materialize(): ReadonlyArray<BaseTool> {
    return this.factory()
  }
}

/**
 * The set of toolsets that ship with `@lumen/tools`. The
 * CLI composition root can iterate this list to wire the
 * default palette lazily; the user can opt in to a
 * subset by id.
 */
export const BUILT_IN_TOOLSETS: ReadonlyArray<BaseToolset> = []
