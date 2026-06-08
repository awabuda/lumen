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
import { ToolError, ToolValidationError } from '../errors/index.js';
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
export class BaseTool {
    /** Optional version, surfaces in the descriptor. */
    version = '0.0.0';
    /**
     * Public entry point used by the agent loop. DO NOT override — override
     * `execute` instead.
     */
    async call(input, ctx) {
        const parsed = this.inputSchema.safeParse(input);
        if (!parsed.success) {
            throw new ToolValidationError(this.name, parsed.error.issues.map((i) => ({
                path: i.path.join('.'),
                message: i.message,
            })));
        }
        try {
            return await this.execute(parsed.data, ctx);
        }
        catch (err) {
            if (err instanceof ToolError)
                throw err;
            throw new ToolError(`Tool ${this.name} failed: ${err.message ?? String(err)}`, {
                toolName: this.name,
                cause: err,
            });
        }
    }
    /** Descriptor used by the registry and the LLM tool schema. */
    describe() {
        // We use z.toJSONSchema where available (zod 3.23+); fall back to a
        // minimal shape if not. The conversion is best-effort — providers
        // that need exact JSON Schema can re-derive.
        const json = toJsonSchema(this.inputSchema);
        return {
            name: this.name,
            description: this.description,
            inputSchema: this.inputSchema,
            inputJsonSchema: json,
            risk: this.risk,
            version: this.version,
        };
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
import { ZodFirstPartyTypeKind } from 'zod';
const toJsonSchema = (schema) => {
    return convert(schema);
};
const convert = (s) => {
    if (s._def?.typeName === ZodFirstPartyTypeKind.ZodObject) {
        const shape = s.shape;
        const properties = {};
        const required = [];
        for (const [key, value] of Object.entries(shape)) {
            properties[key] = convert(value);
            if (!isOptional(value)) {
                required.push(key);
            }
        }
        const out = { type: 'object', properties };
        if (required.length > 0)
            out.required = required;
        return out;
    }
    if (s._def?.typeName === ZodFirstPartyTypeKind.ZodString) {
        return { type: 'string' };
    }
    if (s._def?.typeName === ZodFirstPartyTypeKind.ZodNumber) {
        return { type: 'number' };
    }
    if (s._def?.typeName === ZodFirstPartyTypeKind.ZodBoolean) {
        return { type: 'boolean' };
    }
    if (s._def?.typeName === ZodFirstPartyTypeKind.ZodArray) {
        const inner = s._def.type;
        return { type: 'array', items: convert(inner) };
    }
    if (s._def?.typeName === ZodFirstPartyTypeKind.ZodEnum) {
        const values = s.options;
        return { type: 'string', enum: values };
    }
    if (s._def?.typeName === ZodFirstPartyTypeKind.ZodLiteral) {
        const v = s.value;
        return { type: typeof v, enum: [v] };
    }
    if (s._def?.typeName === ZodFirstPartyTypeKind.ZodUnion) {
        const options = (s._def.options);
        return { anyOf: options.map((o) => convert(o)) };
    }
    // Fallback: opaque
    return {};
};
const isOptional = (s) => {
    if (s._def?.typeName === ZodFirstPartyTypeKind.ZodOptional)
        return true;
    if (s._def?.typeName === ZodFirstPartyTypeKind.ZodDefault)
        return true;
    return false;
};
// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------
/**
 * A simple, type-safe registry of tools. Insertion order is preserved
 * (useful for deterministic tool listing in the system prompt).
 */
export class ToolRegistry {
    tools = new Map();
    /** Register a tool. Throws if a tool with the same name is already registered. */
    register(tool) {
        if (this.tools.has(tool.name)) {
            throw new Error(`Tool "${tool.name}" is already registered`);
        }
        this.tools.set(tool.name, tool);
        return this;
    }
    /** Register multiple tools. Returns this for chaining. */
    registerAll(tools) {
        for (const t of tools)
            this.register(t);
        return this;
    }
    /** Look up a tool by name. Returns undefined if not found. */
    get(name) {
        return this.tools.get(name);
    }
    /** Require a tool by name. Throws if not found. */
    require(name) {
        const t = this.tools.get(name);
        if (!t)
            throw new Error(`Tool "${name}" is not registered`);
        return t;
    }
    /** List all tool descriptors (for the LLM tool schema). */
    list() {
        return [...this.tools.values()].map((t) => t.describe());
    }
    /** Number of registered tools. */
    get size() {
        return this.tools.size;
    }
    /** All tool names. */
    names() {
        return [...this.tools.keys()];
    }
}
//# sourceMappingURL=index.js.map