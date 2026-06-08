/**
 * Tool contract — every callable capability in the agent.
 *
 * Tools are pure-ish: they take validated input, do something, return
 * output. They are *not* allowed to know about the provider, the agent
 * loop, or the conversation history (those go in {@link ToolContext}).
 *
 * A tool's identity is its `name`. Two tools with the same name in the
 * same registry is a configuration error.
 *
 * Why an abstract class:
 *   - The base enforces the `name` / `description` / `inputSchema` /
 *     `risk` contract via abstract members.
 *   - `execute()` can call the protected `validateInput()` to keep
 *     subclasses from forgetting validation.
 *   - Subclasses override `execute()` and inherit everything else.
 */

import { z, type ZodIssue } from 'zod'
import { ToolError, ToolValidationError } from '../errors/index.js'

/**
 * Risk classification — controls whether the user is asked for approval
 * before invocation.
 */
export type ToolRisk = 'safe' | 'approval-required' | 'dangerous'

/**
 * Per-invocation context. Tools can read but should not mutate this.
 */
export interface ToolContext {
  /** Current working directory (set by the CLI / composition root). */
  readonly cwd: string
  /** Abort signal — tools should check this in long-running loops. */
  readonly signal: AbortSignal
  /** Conversation session id. */
  readonly sessionId: string
  /** Optional environment passthrough (e.g. for credentialed tools). */
  readonly env?: Readonly<Record<string, string>>
  /** Logger — defaults to a no-op if not provided. */
  readonly log?: {
    debug: (msg: string, meta?: Record<string, unknown>) => void
    info: (msg: string, meta?: Record<string, unknown>) => void
    warn: (msg: string, meta?: Record<string, unknown>) => void
    error: (msg: string, meta?: Record<string, unknown>) => void
  }
}

export interface ToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: z.ZodType<unknown>
  readonly risk: ToolRisk
  /** JSON Schema form of inputSchema, for providers that need it. */
  readonly inputJsonSchema: Record<string, unknown>
}

/**
 * Abstract base for all tools.
 *
 * Subclasses MUST set:
 *   - `name` (string, unique within a registry)
 *   - `description` (string, used by the LLM to decide when to call)
 *   - `inputSchema` (Zod schema, validated before `execute` runs)
 *   - `risk` (one of the three levels)
 *
 * Subclasses MUST override:
 *   - `execute(input, ctx)` — the actual work
 *
 * The base `execute()` call wraps subclasses with input validation and
 * error normalization.
 */
export abstract class BaseTool {
  public abstract readonly name: string
  public abstract readonly description: string
  public abstract readonly inputSchema: z.ZodType<unknown>
  public abstract readonly risk: ToolRisk
  /** Optional version, surfaces in the descriptor. */
  public readonly version: string = '0.0.0'

  /**
   * The actual implementation. The base `call()` method handles validation
   * and error wrapping; subclasses should override THIS method, not `call`.
   */
  protected abstract execute(input: unknown, ctx: ToolContext): Promise<unknown>

  /**
   * Public entry point used by the agent loop. DO NOT override — override
   * `execute` instead.
   */
  public async call(input: unknown, ctx: ToolContext): Promise<unknown> {
    const parsed = this.inputSchema.safeParse(input)
    if (!parsed.success) {
      throw new ToolValidationError(
        this.name,
        parsed.error.issues.map((i: ZodIssue) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      )
    }
    try {
      return await this.execute(parsed.data, ctx)
    } catch (err) {
      if (err instanceof ToolError) throw err
      throw new ToolError(`Tool ${this.name} failed: ${(err as Error).message ?? String(err)}`, {
        toolName: this.name,
        cause: err,
      })
    }
  }

  /** Descriptor used by the registry and the LLM tool schema. */
  public describe(): ToolDescriptor {
    // We use z.toJSONSchema where available (zod 3.23+); fall back to a
    // minimal shape if not. The conversion is best-effort — providers
    // that need exact JSON Schema can re-derive.
    const json = toJsonSchema(this.inputSchema)
    return {
      name: this.name,
      description: this.description,
      inputSchema: this.inputSchema,
      inputJsonSchema: json,
      risk: this.risk,
    }
  }
}

// -----------------------------------------------------------------------------
// JSON Schema helper (lightweight, zod 3.x compatible)
// -----------------------------------------------------------------------------

/**
 * Convert a Zod schema to a JSON Schema-compatible object. We use
 * zod-to-json-schema if available, else a minimal hand-rolled conversion
 * for the shapes we care about. The result is "good enough" for LLM tool
 * use; it is not a complete JSON Schema implementation.
 */
import { ZodFirstPartyTypeKind, type ZodTypeAny } from 'zod'

const toJsonSchema = (schema: z.ZodType<unknown>): Record<string, unknown> => {
  return convert(schema as ZodTypeAny)
}

const convert = (s: ZodTypeAny): Record<string, unknown> => {
  if (s._def?.typeName === ZodFirstPartyTypeKind.ZodObject) {
    const shape = (s as z.ZodObject<z.ZodRawShape>).shape
    const properties: Record<string, unknown> = {}
    const required: string[] = []
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = convert(value as ZodTypeAny)
      if (!isOptional(value as ZodTypeAny)) {
        required.push(key)
      }
    }
    const out: Record<string, unknown> = { type: 'object', properties }
    if (required.length > 0) out.required = required
    return out
  }
  if (s._def?.typeName === ZodFirstPartyTypeKind.ZodString) {
    return { type: 'string' }
  }
  if (s._def?.typeName === ZodFirstPartyTypeKind.ZodNumber) {
    return { type: 'number' }
  }
  if (s._def?.typeName === ZodFirstPartyTypeKind.ZodBoolean) {
    return { type: 'boolean' }
  }
  if (s._def?.typeName === ZodFirstPartyTypeKind.ZodArray) {
    const inner = (s as z.ZodArray<ZodTypeAny>)._def.type as ZodTypeAny
    return { type: 'array', items: convert(inner) }
  }
  if (s._def?.typeName === ZodFirstPartyTypeKind.ZodEnum) {
    const values = (s as z.ZodEnum<[string, ...string[]]>).options
    return { type: 'string', enum: values }
  }
  if (s._def?.typeName === ZodFirstPartyTypeKind.ZodLiteral) {
    const v = (s as z.ZodLiteral<unknown>).value
    return { type: typeof v, enum: [v] }
  }
  if (s._def?.typeName === ZodFirstPartyTypeKind.ZodUnion) {
    const options = ((s as unknown as { _def: { options: ReadonlyArray<ZodTypeAny> } })._def.options) as ReadonlyArray<ZodTypeAny>
    return { anyOf: options.map((o: ZodTypeAny) => convert(o)) }
  }
  // Fallback: opaque
  return {}
}

const isOptional = (s: ZodTypeAny): boolean => {
  if (s._def?.typeName === ZodFirstPartyTypeKind.ZodOptional) return true
  if (s._def?.typeName === ZodFirstPartyTypeKind.ZodDefault) return true
  return false
}

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

/**
 * A simple, type-safe registry of tools. Insertion order is preserved
 * (useful for deterministic tool listing in the system prompt).
 */
export class ToolRegistry {
  private readonly tools = new Map<string, BaseTool>()

  /** Register a tool. Throws if a tool with the same name is already registered. */
  public register(tool: BaseTool): this {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`)
    }
    this.tools.set(tool.name, tool)
    return this
  }

  /** Register multiple tools. Returns this for chaining. */
  public registerAll(tools: ReadonlyArray<BaseTool>): this {
    for (const t of tools) this.register(t)
    return this
  }

  /** Look up a tool by name. Returns undefined if not found. */
  public get(name: string): BaseTool | undefined {
    return this.tools.get(name)
  }

  /** Require a tool by name. Throws if not found. */
  public require(name: string): BaseTool {
    const t = this.tools.get(name)
    if (!t) throw new Error(`Tool "${name}" is not registered`)
    return t
  }

  /** List all tool descriptors (for the LLM tool schema). */
  public list(): ToolDescriptor[] {
    return [...this.tools.values()].map((t) => t.describe())
  }

  /** Number of registered tools. */
  public get size(): number {
    return this.tools.size
  }

  /** All tool names. */
  public names(): string[] {
    return [...this.tools.keys()]
  }
}
