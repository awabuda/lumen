/**
 * Provider pool — a {@link BaseProvider} that fans requests out to a
 * registered set of backends with a chosen routing strategy and
 * automatic failover.
 *
 * Why this lives in the agent layer:
 *   - {@link BaseProvider} is the wire contract. Pooling is policy
 *     on top of that wire, not part of it.
 *   - Routing decisions depend on call-site info (which capability
 *     the caller needs, which model it asked for, what the last
 *     error was). That's a caller-policy layer, not a provider
 *     concern.
 *
 * Strategies:
 *   - `'capability'` — pick the first provider whose
 *     `capabilities[capability]` is `true`. Best when the caller
 *     only knows what the request needs, not who should handle it.
 *   - `'name'` — pick the provider whose `id` matches. Best when
 *     the caller knows exactly which backend it wants.
 *   - `'round-robin'` — cycle through providers in registration
 *     order. Best for load distribution across equivalent backends.
 *   - `'weighted'` — weighted random selection. Best when some
 *     backends should get more traffic (cost, latency, SLO).
 *
 * Failover:
 *   On a chat / embed error, the pool tries the next provider in
 *   the candidate list. After exhausting the list it throws a
 *   {@link PoolExhaustedError} that carries every underlying
 *   error so the caller can decide whether to bubble, log, or
 *   downgrade.
 *
 * What the pool does NOT do:
 *   - Circuit breaking (no per-provider failure rate tracking).
 *     Add a wrapper if you need it.
 *   - Caching (use the agent-level prompt cache, not the pool).
 *   - Concurrent fan-out (one request → one provider). The point
 *     is the opposite: choose one, fail over on error.
 */

import { z } from 'zod'
import { Mutex } from '../concurrency/index.js'
import { AgentError, ConfigError } from '../errors/index.js'
import {
  BaseProvider,
  type ChatRequest,
  type ChatResponse,
  type EmbedRequest,
  type EmbedResponse,
  type ProviderCapabilities,
  ProviderError,
  type StreamEvent,
  type StreamOptions,
} from '../index.js'
import { type CircuitBreaker, CircuitOpenError } from './circuit-breaker.js'

/** Routing strategy for the pool. */
export type RoutingStrategy = 'capability' | 'name' | 'round-robin' | 'weighted'

/** Which capability a `'capability'` strategy should require. */
export type CapabilityKey = keyof ProviderCapabilities

/** Per-provider configuration registered with the pool. */
export interface PooledProviderConfig {
  /** The provider instance to register. */
  readonly provider: BaseProvider
  /**
   * Optional weight for the `'weighted'` strategy. Defaults to 1.
   * Larger weights get more traffic.
   */
  readonly weight?: number
  /**
   * Optional tag used to filter the candidate set, e.g. a region
   * or a model family. The pool itself does not interpret tags;
   * the caller's routing rule can read them via
   * {@link BaseProviderPool.registered}.
   */
  readonly tag?: string
}

/** Options for the pool constructor. */
export interface ProviderPoolOptions {
  /** Routing strategy. Defaults to `'round-robin'`. */
  readonly strategy?: RoutingStrategy
  /**
   * For `'capability'` strategy: which capability key to require
   * `true`. Defaults to `'toolUse'`.
   */
  readonly capability?: CapabilityKey
  /**
   * For `'name'` strategy: which provider id to route to. Must
   * match one of the registered providers' `id`.
   */
  readonly targetId?: string
  /**
   * Initial set of providers. More can be added with
   * {@link BaseProviderPool.register} / removed with
   * {@link BaseProviderPool.unregister}.
   */
  readonly providers?: ReadonlyArray<PooledProviderConfig>
  /**
   * Random source for `'weighted'`. Defaults to Math.random;
   * tests can inject a deterministic source.
   */
  readonly random?: () => number
  /**
   * Optional circuit breaker. When present, providers that are
   * in the `open` state are filtered out of the candidate list
   * (fail-fast) and a failed call increments the failure counter
   * for the provider it was attributed to. Defaults to no
   * breaker (back-compat with P8 callers).
   */
  readonly circuit?: CircuitBreaker
}

// ---------------------------------------------------------------------------
// Zod schemas (public surface — see CLAUDE.md rule #4)
// ---------------------------------------------------------------------------

/** Zod schema for {@link PooledProviderConfig}. */
export const PooledProviderConfigSchema = z.object({
  provider: z.unknown(), // BaseProvider instances are not zod-validatable
  weight: z.number().positive().optional(),
  tag: z.string().min(1).optional(),
})

/** Zod schema for {@link ProviderPoolOptions}. */
export const ProviderPoolOptionsSchema = z.object({
  strategy: z.enum(['capability', 'name', 'round-robin', 'weighted']).optional(),
  capability: z
    .enum([
      'streaming',
      'embeddings',
      'toolUse',
      'vision',
      'reasoning',
      'promptCaching',
      'structuredOutput',
      'maxContextTokens',
    ])
    .optional(),
  targetId: z.string().min(1).optional(),
  providers: z.array(PooledProviderConfigSchema).optional(),
  random: z.function().optional(),
})

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the pool has tried every candidate provider and all
 * of them failed. The `attempts` array records (providerId, error)
 * for every attempt so callers can decide whether to surface a
 * generic "all backends down" or pick out a specific failure.
 */
export class PoolExhaustedError extends AgentError {
  public readonly attempts: ReadonlyArray<{ readonly providerId: string; readonly error: unknown }>
  public constructor(
    attempts: ReadonlyArray<{ readonly providerId: string; readonly error: unknown }>,
  ) {
    super(
      `Provider pool exhausted after ${attempts.length} attempt(s): ${attempts.map((a) => a.providerId).join(', ')}`,
    )
    this.name = 'PoolExhaustedError'
    this.attempts = attempts
  }
}

// ---------------------------------------------------------------------------
// Base contract
// ---------------------------------------------------------------------------

/** Base class every concrete pool must extend. */
export abstract class BaseProviderPool extends BaseProvider {
  public abstract override readonly id: string
  public abstract override readonly capabilities: ProviderCapabilities
  /** All currently-registered providers, in registration order. */
  public abstract readonly registered: ReadonlyArray<PooledProviderConfig>
  /** Add a provider to the pool. Returns `this` for chaining. */
  public abstract register(config: PooledProviderConfig): this
  /** Remove a provider by id. Returns true if removed. */
  public abstract unregister(providerId: string): boolean
  /** Pick the next provider per the configured strategy. */
  protected abstract pickProvider(request?: ChatRequest | EmbedRequest): BaseProvider
  /** Recompute the pool's own `capabilities` from its members. */
  protected abstract recomputeCapabilities(): ProviderCapabilities
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

/**
 * Default {@link BaseProviderPool} implementation.
 *
 * Concurrency-safe at the round-robin cursor: a private
 * {@link Mutex} serializes the read-modify-write of
 * {@link ProviderPool.roundRobinIndex} inside
 * {@link ProviderPool.candidatesFor}, so two concurrent
 * `chat` / `embed` / `stream` calls each get a distinct
 * provider pick. Without the lock, both calls can read the
 * same cursor and pick the same provider.
 *
 * `register` / `unregister` are intentionally synchronous:
 * the JS event loop is single-threaded, so the check + mutate
 * pair inside them cannot interleave. The cursor advancement
 * is the only real race.
 */
export class ProviderPool extends BaseProviderPool {
  public readonly id = 'pool'
  public readonly capabilities: ProviderCapabilities
  public registered: ReadonlyArray<PooledProviderConfig>
  private readonly strategy: RoutingStrategy
  private readonly capability: CapabilityKey
  private readonly targetId?: string
  private readonly random: () => number
  /** Optional per-provider circuit breaker (P9.4). */
  private readonly circuit?: CircuitBreaker
  /**
   * FIFO mutex that serializes cursor advancement and
   * registration mutations. Contended only by callers that hit
   * the pool concurrently; the common agent-loop pattern is
   * serialized at a higher level (one request at a time), so
   * this is uncontended in practice and the cost is a single
   * promise-chain snap.
   */
  private readonly mutex: Mutex
  private roundRobinIndex = 0

  public constructor(options: ProviderPoolOptions = {}) {
    super()
    this.strategy = options.strategy ?? 'round-robin'
    this.capability = options.capability ?? 'toolUse'
    this.targetId = options.targetId
    this.random = options.random ?? Math.random
    this.circuit = options.circuit
    this.registered = options.providers ? [...options.providers] : []
    this.capabilities = this.recomputeCapabilities()
    this.mutex = new Mutex({ name: 'provider-pool' })
  }

  public register(config: PooledProviderConfig): this {
    // Reject duplicate ids so `unregister` and routing remain deterministic.
    // (Synchronous — JS event loop is single-threaded, so this check + the
    // mutation that follows cannot interleave with another caller's code.
    // The cursor-mutation race is contained inside `candidatesFor`.)
    if (this.registered.some((p) => p.provider.id === config.provider.id)) {
      throw new ConfigError(`Provider id already registered: ${config.provider.id}`, {
        field: 'provider.id',
      })
    }
    this.registered = [...this.registered, config]
    this.invalidate()
    return this
  }

  public unregister(providerId: string): boolean {
    const before = this.registered.length
    this.registered = this.registered.filter((p) => p.provider.id !== providerId)
    if (this.registered.length === before) return false
    this.invalidate()
    // Re-seek the round-robin cursor so we don't skip or repeat.
    if (this.roundRobinIndex >= this.registered.length) this.roundRobinIndex = 0
    return true
  }

  protected pickProvider(_request?: ChatRequest | EmbedRequest): BaseProvider {
    if (this.registered.length === 0) {
      throw new ConfigError('ProviderPool has no registered providers')
    }
    switch (this.strategy) {
      case 'name': {
        if (!this.targetId) {
          throw new ConfigError("ProviderPool strategy 'name' requires options.targetId", {
            field: 'targetId',
          })
        }
        const match = this.registered.find((p) => p.provider.id === this.targetId)
        if (!match) {
          throw new ConfigError(`No registered provider with id '${this.targetId}'`, {
            field: 'targetId',
          })
        }
        return match.provider
      }
      case 'capability': {
        const capable = this.registered.filter((p) => {
          const cap = p.provider.capabilities[this.capability]
          return typeof cap === 'boolean' ? cap : false
        })
        if (capable.length === 0) {
          throw new ConfigError(
            `No registered provider has capability '${String(this.capability)}': true. ` +
              `Registered: ${this.registered.map((p) => p.provider.id).join(', ')}`,
            { field: 'capability' },
          )
        }
        return capable[this.roundRobinIndex % capable.length]!.provider
      }
      case 'round-robin': {
        const idx = this.roundRobinIndex % this.registered.length
        this.roundRobinIndex = (this.roundRobinIndex + 1) % this.registered.length
        return this.registered[idx]!.provider
      }
      case 'weighted': {
        return this.pickWeighted()
      }
      default: {
        // Exhaustiveness check — TypeScript will flag a new strategy
        // added to the union that we forgot to handle.
        const _exhaustive: never = this.strategy
        throw new AgentError(`Unhandled strategy: ${String(_exhaustive)}`)
      }
    }
  }

  private pickWeighted(): BaseProvider {
    const weights = this.registered.map((p) => p.weight ?? 1)
    const total = weights.reduce((s, w) => s + w, 0)
    let r = this.random() * total
    for (let i = 0; i < this.registered.length; i += 1) {
      r -= weights[i]!
      if (r <= 0) return this.registered[i]!.provider
    }
    // Numerical drift: fall back to last registered.
    return this.registered[this.registered.length - 1]!.provider
  }

  protected recomputeCapabilities(): ProviderCapabilities {
    if (this.registered.length === 0) {
      return {
        streaming: false,
        embeddings: false,
        toolUse: false,
        vision: false,
        reasoning: false,
        promptCaching: false,
        structuredOutput: false,
        maxContextTokens: 0,
      }
    }
    // Logical OR across all registered providers — the pool can do
    // anything at least one member can do. We build the result as
    // a fresh literal because ProviderCapabilities fields are
    // readonly; we cannot mutate the accumulator in place.
    const acc = {
      streaming: false,
      embeddings: false,
      toolUse: false,
      vision: false,
      reasoning: false,
      promptCaching: false,
      structuredOutput: false,
      maxContextTokens: 0,
    }
    for (const p of this.registered) {
      const c = p.provider.capabilities
      acc.streaming = acc.streaming || c.streaming
      acc.embeddings = acc.embeddings || c.embeddings
      acc.toolUse = acc.toolUse || c.toolUse
      acc.vision = acc.vision || c.vision
      acc.reasoning = acc.reasoning || c.reasoning
      acc.promptCaching = acc.promptCaching || c.promptCaching
      acc.structuredOutput = acc.structuredOutput || c.structuredOutput
      if (c.maxContextTokens > acc.maxContextTokens) {
        acc.maxContextTokens = c.maxContextTokens
      }
    }
    return acc
  }

  private invalidate(): void {
    // The `capabilities` field is `readonly` on the class; this
    // works because TS allows mutation of the fields of an object
    // literal/instance even when the class declares the property
    // `readonly` — a real instance property, not a getter.
    Object.assign(this.capabilities, this.recomputeCapabilities())
    // Round-robin cursor may need to clamp.
    if (this.roundRobinIndex >= this.registered.length) this.roundRobinIndex = 0
  }

  public async chat(request: ChatRequest, options?: StreamOptions): Promise<ChatResponse> {
    return this.runWithFailover((p) => p.chat(request, options), request)
  }

  public override async *stream(
    request: ChatRequest,
    options?: StreamOptions,
  ): AsyncGenerator<StreamEvent, void, void> {
    // Failover for streams is best-effort: we start with the picked
    // provider and, if its very first event is an error, fall back
    // to the next candidate. Once we have emitted a non-error event
    // we commit to that provider — a half-streamed response cannot
    // be resumed on a different backend.
    const candidates = await this.candidatesFor(request)
    if (candidates.length === 0) {
      throw new ConfigError('ProviderPool has no registered providers')
    }
    let lastError: unknown
    for (const provider of candidates) {
      let firstEvent: StreamEvent | undefined
      const iter = provider.stream(request, options)
      try {
        const head = await iter.next()
        if (head.done === true) {
          // Stream ended without producing any events; try the next.
          lastError = new ProviderError(`Provider '${provider.id}' produced an empty stream`, {
            providerId: provider.id,
            retryable: true,
          })
          continue
        }
        firstEvent = head.value
      } catch (err) {
        lastError = err
        continue
      }
      // Commit to this provider.
      if (firstEvent) yield firstEvent
      for await (const ev of iter) yield ev
      return
    }
    throw new PoolExhaustedError(
      candidates.map((p, _i) => ({ providerId: p.id, error: lastError })),
    )
  }

  public override async embed(
    request: EmbedRequest,
    options?: StreamOptions,
  ): Promise<EmbedResponse> {
    return this.runWithFailover((p) => p.embed(request, options), request)
  }

  /**
   * Return the ordered list of candidate providers per the
   * configured strategy. The order matters for failover.
   *
   * Side effect: advances the round-robin cursor exactly once
   * per call. The cursor advances even if the caller only
   * dispatches to the head of the list — that's the point of
   * round-robin: even on a single successful request, the next
   * call should land on a different provider.
   */
  private async candidatesFor(
    _request?: ChatRequest | EmbedRequest,
  ): Promise<ReadonlyArray<BaseProvider>> {
    // The cursor advancement (read index → advance → return) is
    // two operations. Without locking, two concurrent callers
    // can both read the same cursor value and pick the same
    // provider. The mutex guarantees read-modify-write is atomic.
    return this.mutex.runExclusive(() => {
      if (this.registered.length === 0) return []
      switch (this.strategy) {
        case 'name': {
          if (!this.targetId) {
            throw new ConfigError("ProviderPool strategy 'name' requires options.targetId", {
              field: 'targetId',
            })
          }
          const match = this.registered.find((p) => p.provider.id === this.targetId)
          if (!match) {
            throw new ConfigError(`No registered provider with id '${this.targetId}'`, {
              field: 'targetId',
            })
          }
          return [match.provider]
        }
        case 'capability': {
          const capable = this.registered.filter((p) => {
            const cap = p.provider.capabilities[this.capability]
            return typeof cap === 'boolean' ? cap : false
          })
          if (capable.length === 0) {
            throw new ConfigError(
              `No registered provider has capability '${String(this.capability)}': true. ` +
                `Registered: ${this.registered.map((p) => p.provider.id).join(', ')}`,
              { field: 'capability' },
            )
          }
          // Pick the head of the capable list (round-robin) but include
          // the rest in order so failover walks the whole capable set
          // before giving up.
          const start = this.roundRobinIndex % capable.length
          this.roundRobinIndex = (this.roundRobinIndex + 1) % this.registered.length
          return capable
            .slice(start)
            .concat(capable.slice(0, start))
            .map((c) => c.provider)
        }
        case 'round-robin': {
          const start = this.roundRobinIndex % this.registered.length
          this.roundRobinIndex = (this.roundRobinIndex + 1) % this.registered.length
          return this.registered
            .slice(start)
            .concat(this.registered.slice(0, start))
            .map((c) => c.provider)
        }
        case 'weighted': {
          return [this.pickWeighted()]
        }
        default: {
          return []
        }
      }
    })
  }

  /**
   * Try `fn` against each candidate in order; collect the first
   * success. If every candidate fails, throw a
   * {@link PoolExhaustedError} with the full attempt list.
   *
   * Errors that are NOT {@link ProviderError} are treated as
   * fatal and re-thrown immediately — they typically indicate a
   * bug or a programming error, not a transient backend issue.
   */
  private async runWithFailover<T>(
    fn: (provider: BaseProvider) => Promise<T>,
    request: ChatRequest | EmbedRequest,
  ): Promise<T> {
    const candidates = await this.candidatesFor(request)
    if (candidates.length === 0) {
      throw new ConfigError('ProviderPool has no registered providers')
    }
    const attempts: Array<{ providerId: string; error: unknown }> = []
    for (const provider of candidates) {
      // Check the circuit *before* calling. A `CircuitOpenError`
      // is itself a transient failure we record — but we don't
      // count it against the breaker (no point in punishing the
      // breaker for being open). We treat it as a non-fatal
      // skip and continue to the next candidate.
      if (this.circuit) {
        try {
          this.circuit.allow(provider.id)
        } catch (err) {
          if (err instanceof CircuitOpenError) {
            attempts.push({ providerId: provider.id, error: err })
            continue
          }
          throw err
        }
      }
      try {
        const result = await fn(provider)
        this.circuit?.recordSuccess(provider.id)
        return result
      } catch (err) {
        if (!(err instanceof ProviderError)) {
          // Non-provider error: programming bug or invalid request.
          // Do not failover — surface the original error to help debugging.
          throw err
        }
        this.circuit?.recordFailure(provider.id)
        attempts.push({ providerId: provider.id, error: err })
      }
    }
    throw new PoolExhaustedError(attempts)
  }
}
