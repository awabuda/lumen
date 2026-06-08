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
import { z } from 'zod';
/**
 * Risk classification — controls whether the user is asked for approval
 * before invocation.
 */
export type ToolRisk = 'safe' | 'approval-required' | 'dangerous';
/**
 * Per-invocation context. Tools can read but should not mutate this.
 */
export interface ToolContext {
    /** Current working directory (set by the CLI / composition root). */
    readonly cwd: string;
    /** Abort signal — tools should check this in long-running loops. */
    readonly signal: AbortSignal;
    /** Conversation session id. */
    readonly sessionId: string;
    /** Optional environment passthrough (e.g. for credentialed tools). */
    readonly env?: Readonly<Record<string, string>>;
    /** Logger — defaults to a no-op if not provided. */
    readonly log?: {
        debug: (msg: string, meta?: Record<string, unknown>) => void;
        info: (msg: string, meta?: Record<string, unknown>) => void;
        warn: (msg: string, meta?: Record<string, unknown>) => void;
        error: (msg: string, meta?: Record<string, unknown>) => void;
    };
}
export interface ToolDescriptor {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: z.ZodType<unknown>;
    readonly risk: ToolRisk;
    /** Tool version, surfaced to the LLM so it can reason about capability changes. */
    readonly version: string;
    /** JSON Schema form of inputSchema, for providers that need it. */
    readonly inputJsonSchema: Record<string, unknown>;
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
export declare abstract class BaseTool {
    abstract readonly name: string;
    abstract readonly description: string;
    abstract readonly inputSchema: z.ZodType<unknown>;
    abstract readonly risk: ToolRisk;
    /** Optional version, surfaces in the descriptor. */
    readonly version: string;
    /**
     * The actual implementation. The base `call()` method handles validation
     * and error wrapping; subclasses should override THIS method, not `call`.
     */
    protected abstract execute(input: unknown, ctx: ToolContext): Promise<unknown>;
    /**
     * Public entry point used by the agent loop. DO NOT override — override
     * `execute` instead.
     */
    call(input: unknown, ctx: ToolContext): Promise<unknown>;
    /** Descriptor used by the registry and the LLM tool schema. */
    describe(): ToolDescriptor;
}
/**
 * A simple, type-safe registry of tools. Insertion order is preserved
 * (useful for deterministic tool listing in the system prompt).
 */
export declare class ToolRegistry {
    private readonly tools;
    /** Register a tool. Throws if a tool with the same name is already registered. */
    register(tool: BaseTool): this;
    /** Register multiple tools. Returns this for chaining. */
    registerAll(tools: ReadonlyArray<BaseTool>): this;
    /** Look up a tool by name. Returns undefined if not found. */
    get(name: string): BaseTool | undefined;
    /** Require a tool by name. Throws if not found. */
    require(name: string): BaseTool;
    /** List all tool descriptors (for the LLM tool schema). */
    list(): ToolDescriptor[];
    /** Number of registered tools. */
    get size(): number;
    /** All tool names. */
    names(): string[];
}
//# sourceMappingURL=index.d.ts.map