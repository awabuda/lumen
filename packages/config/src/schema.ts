/**
 * The full Lumen configuration schema, expressed as a Zod object.
 *
 * Every public-facing setting lives here. Subsystems read nested slices
 * through the helpers in `loader.ts`; they should never parse env vars
 * themselves.
 *
 * Defaults are intentionally minimal — most fields are optional and resolved
 * by the consumer package.
 */

import { z } from 'zod'

const ProviderIdSchema = z.enum([
  'openai',
  'anthropic',
  'google',
  'ollama',
  'custom',
])

const ProviderConfigSchema = z
  .object({
    id: ProviderIdSchema,
    apiKey: z.string().optional(),
    baseUrl: z.string().url().optional(),
    defaultModel: z.string().min(1).optional(),
    headers: z.record(z.string()).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()

const ModelConfigSchema = z
  .object({
    provider: ProviderIdSchema,
    name: z.string().min(1),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().positive().optional(),
    topP: z.number().min(0).max(1).optional(),
    reasoning: z.boolean().optional(),
  })
  .strict()

const MemoryConfigSchema = z
  .object({
    backend: z.enum(['sqlite', 'memory']).default('sqlite'),
    path: z.string().optional(),
    vectorDimensions: z.number().int().positive().default(1536),
    ftsEnabled: z.boolean().default(true),
  })
  .strict()

const ToolsConfigSchema = z
  .object({
    enabled: z.array(z.string()).default([]),
    disabled: z.array(z.string()).default([]),
    defaultTimeoutMs: z.number().int().positive().default(30_000),
    dangerousRequireApproval: z.boolean().default(true),
  })
  .strict()

const SkillsConfigSchema = z
  .object({
    directories: z.array(z.string()).default([]),
    autoEvolve: z.boolean().default(true),
    reflectEveryNInvocations: z.number().int().positive().default(5),
  })
  .strict()

const McpServerConfigSchema = z
  .object({
    name: z.string().min(1),
    transport: z.enum(['stdio', 'http']),
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
    url: z.string().url().optional(),
    /**
     * Bearer token for HTTP transport. We automatically attach it
     * as `Authorization: Bearer *** when this is set, UNLESS the
     * `headers` field already contains an `Authorization` entry
     * (in which case the user-provided value wins).
     */
    apiKey: z.string().min(1).optional(),
    /**
     * Custom HTTP headers for HTTP transport. Use this to plug in
     * non-Bearer auth schemes (mTLS-issued tokens, custom header
     * names, signed JWTs) without us having to special-case them.
     */
    headers: z.record(z.string()).default({}),
    enabled: z.boolean().default(true),
  })
  .strict()
  .refine(
    (s) => (s.transport === 'stdio' ? Boolean(s.command) : Boolean(s.url)),
    { message: 'stdio transport requires `command`; http transport requires `url`' },
  )

const McpConfigSchema = z
  .object({
    servers: z.array(McpServerConfigSchema).default([]),
  })
  .strict()

const AgentConfigSchema = z
  .object({
    maxIterations: z.number().int().positive().default(50),
    budgetTokens: z.number().int().positive().optional(),
    budgetCostUsd: z.number().positive().optional(),
    oneTurnGraceCall: z.boolean().default(true),
    stream: z.boolean().default(true),
  })
  .strict()

const LoggingConfigSchema = z
  .object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
    file: z.string().optional(),
    redactSecrets: z.boolean().default(true),
  })
  .strict()

export const LumenConfigSchema = z
  .object({
    agent: AgentConfigSchema.default({}),
    providers: z.array(ProviderConfigSchema).default([]),
    models: z.array(ModelConfigSchema).default([]),
    defaultModel: z.string().min(1).optional(),
    memory: MemoryConfigSchema.default({}),
    tools: ToolsConfigSchema.default({}),
    skills: SkillsConfigSchema.default({}),
    mcp: McpConfigSchema.default({}),
    logging: LoggingConfigSchema.default({}),
  })
  .strict()

export type LumenConfig = z.infer<typeof LumenConfigSchema>
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>
export type ModelConfig = z.infer<typeof ModelConfigSchema>
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>
export {
  McpServerConfigSchema,
}
