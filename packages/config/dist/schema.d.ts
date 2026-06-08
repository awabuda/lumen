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
import { z } from 'zod';
declare const ProviderConfigSchema: z.ZodObject<{
    id: z.ZodEnum<["openai", "anthropic", "google", "ollama", "custom"]>;
    apiKey: z.ZodOptional<z.ZodString>;
    baseUrl: z.ZodOptional<z.ZodString>;
    defaultModel: z.ZodOptional<z.ZodString>;
    headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
    timeoutMs: z.ZodOptional<z.ZodNumber>;
}, "strict", z.ZodTypeAny, {
    id: "openai" | "anthropic" | "google" | "ollama" | "custom";
    apiKey?: string | undefined;
    baseUrl?: string | undefined;
    defaultModel?: string | undefined;
    headers?: Record<string, string> | undefined;
    timeoutMs?: number | undefined;
}, {
    id: "openai" | "anthropic" | "google" | "ollama" | "custom";
    apiKey?: string | undefined;
    baseUrl?: string | undefined;
    defaultModel?: string | undefined;
    headers?: Record<string, string> | undefined;
    timeoutMs?: number | undefined;
}>;
declare const ModelConfigSchema: z.ZodObject<{
    provider: z.ZodEnum<["openai", "anthropic", "google", "ollama", "custom"]>;
    name: z.ZodString;
    temperature: z.ZodOptional<z.ZodNumber>;
    maxTokens: z.ZodOptional<z.ZodNumber>;
    topP: z.ZodOptional<z.ZodNumber>;
    reasoning: z.ZodOptional<z.ZodBoolean>;
}, "strict", z.ZodTypeAny, {
    provider: "openai" | "anthropic" | "google" | "ollama" | "custom";
    name: string;
    temperature?: number | undefined;
    maxTokens?: number | undefined;
    topP?: number | undefined;
    reasoning?: boolean | undefined;
}, {
    provider: "openai" | "anthropic" | "google" | "ollama" | "custom";
    name: string;
    temperature?: number | undefined;
    maxTokens?: number | undefined;
    topP?: number | undefined;
    reasoning?: boolean | undefined;
}>;
declare const McpServerConfigSchema: z.ZodEffects<z.ZodObject<{
    name: z.ZodString;
    transport: z.ZodEnum<["stdio", "http"]>;
    command: z.ZodOptional<z.ZodString>;
    args: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    env: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
    url: z.ZodOptional<z.ZodString>;
    enabled: z.ZodDefault<z.ZodBoolean>;
}, "strict", z.ZodTypeAny, {
    name: string;
    enabled: boolean;
    transport: "stdio" | "http";
    args: string[];
    env: Record<string, string>;
    command?: string | undefined;
    url?: string | undefined;
}, {
    name: string;
    transport: "stdio" | "http";
    enabled?: boolean | undefined;
    command?: string | undefined;
    args?: string[] | undefined;
    env?: Record<string, string> | undefined;
    url?: string | undefined;
}>, {
    name: string;
    enabled: boolean;
    transport: "stdio" | "http";
    args: string[];
    env: Record<string, string>;
    command?: string | undefined;
    url?: string | undefined;
}, {
    name: string;
    transport: "stdio" | "http";
    enabled?: boolean | undefined;
    command?: string | undefined;
    args?: string[] | undefined;
    env?: Record<string, string> | undefined;
    url?: string | undefined;
}>;
export declare const LumenConfigSchema: z.ZodObject<{
    agent: z.ZodDefault<z.ZodObject<{
        maxIterations: z.ZodDefault<z.ZodNumber>;
        budgetTokens: z.ZodOptional<z.ZodNumber>;
        budgetCostUsd: z.ZodOptional<z.ZodNumber>;
        oneTurnGraceCall: z.ZodDefault<z.ZodBoolean>;
        stream: z.ZodDefault<z.ZodBoolean>;
    }, "strict", z.ZodTypeAny, {
        maxIterations: number;
        oneTurnGraceCall: boolean;
        stream: boolean;
        budgetTokens?: number | undefined;
        budgetCostUsd?: number | undefined;
    }, {
        maxIterations?: number | undefined;
        budgetTokens?: number | undefined;
        budgetCostUsd?: number | undefined;
        oneTurnGraceCall?: boolean | undefined;
        stream?: boolean | undefined;
    }>>;
    providers: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodEnum<["openai", "anthropic", "google", "ollama", "custom"]>;
        apiKey: z.ZodOptional<z.ZodString>;
        baseUrl: z.ZodOptional<z.ZodString>;
        defaultModel: z.ZodOptional<z.ZodString>;
        headers: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
        timeoutMs: z.ZodOptional<z.ZodNumber>;
    }, "strict", z.ZodTypeAny, {
        id: "openai" | "anthropic" | "google" | "ollama" | "custom";
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        defaultModel?: string | undefined;
        headers?: Record<string, string> | undefined;
        timeoutMs?: number | undefined;
    }, {
        id: "openai" | "anthropic" | "google" | "ollama" | "custom";
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        defaultModel?: string | undefined;
        headers?: Record<string, string> | undefined;
        timeoutMs?: number | undefined;
    }>, "many">>;
    models: z.ZodDefault<z.ZodArray<z.ZodObject<{
        provider: z.ZodEnum<["openai", "anthropic", "google", "ollama", "custom"]>;
        name: z.ZodString;
        temperature: z.ZodOptional<z.ZodNumber>;
        maxTokens: z.ZodOptional<z.ZodNumber>;
        topP: z.ZodOptional<z.ZodNumber>;
        reasoning: z.ZodOptional<z.ZodBoolean>;
    }, "strict", z.ZodTypeAny, {
        provider: "openai" | "anthropic" | "google" | "ollama" | "custom";
        name: string;
        temperature?: number | undefined;
        maxTokens?: number | undefined;
        topP?: number | undefined;
        reasoning?: boolean | undefined;
    }, {
        provider: "openai" | "anthropic" | "google" | "ollama" | "custom";
        name: string;
        temperature?: number | undefined;
        maxTokens?: number | undefined;
        topP?: number | undefined;
        reasoning?: boolean | undefined;
    }>, "many">>;
    defaultModel: z.ZodOptional<z.ZodString>;
    memory: z.ZodDefault<z.ZodObject<{
        backend: z.ZodDefault<z.ZodEnum<["sqlite", "memory"]>>;
        path: z.ZodOptional<z.ZodString>;
        vectorDimensions: z.ZodDefault<z.ZodNumber>;
        ftsEnabled: z.ZodDefault<z.ZodBoolean>;
    }, "strict", z.ZodTypeAny, {
        backend: "sqlite" | "memory";
        vectorDimensions: number;
        ftsEnabled: boolean;
        path?: string | undefined;
    }, {
        path?: string | undefined;
        backend?: "sqlite" | "memory" | undefined;
        vectorDimensions?: number | undefined;
        ftsEnabled?: boolean | undefined;
    }>>;
    tools: z.ZodDefault<z.ZodObject<{
        enabled: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        disabled: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        defaultTimeoutMs: z.ZodDefault<z.ZodNumber>;
        dangerousRequireApproval: z.ZodDefault<z.ZodBoolean>;
    }, "strict", z.ZodTypeAny, {
        enabled: string[];
        disabled: string[];
        defaultTimeoutMs: number;
        dangerousRequireApproval: boolean;
    }, {
        enabled?: string[] | undefined;
        disabled?: string[] | undefined;
        defaultTimeoutMs?: number | undefined;
        dangerousRequireApproval?: boolean | undefined;
    }>>;
    skills: z.ZodDefault<z.ZodObject<{
        directories: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
        autoEvolve: z.ZodDefault<z.ZodBoolean>;
        reflectEveryNInvocations: z.ZodDefault<z.ZodNumber>;
    }, "strict", z.ZodTypeAny, {
        directories: string[];
        autoEvolve: boolean;
        reflectEveryNInvocations: number;
    }, {
        directories?: string[] | undefined;
        autoEvolve?: boolean | undefined;
        reflectEveryNInvocations?: number | undefined;
    }>>;
    mcp: z.ZodDefault<z.ZodObject<{
        servers: z.ZodDefault<z.ZodArray<z.ZodEffects<z.ZodObject<{
            name: z.ZodString;
            transport: z.ZodEnum<["stdio", "http"]>;
            command: z.ZodOptional<z.ZodString>;
            args: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
            env: z.ZodDefault<z.ZodRecord<z.ZodString, z.ZodString>>;
            url: z.ZodOptional<z.ZodString>;
            enabled: z.ZodDefault<z.ZodBoolean>;
        }, "strict", z.ZodTypeAny, {
            name: string;
            enabled: boolean;
            transport: "stdio" | "http";
            args: string[];
            env: Record<string, string>;
            command?: string | undefined;
            url?: string | undefined;
        }, {
            name: string;
            transport: "stdio" | "http";
            enabled?: boolean | undefined;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            url?: string | undefined;
        }>, {
            name: string;
            enabled: boolean;
            transport: "stdio" | "http";
            args: string[];
            env: Record<string, string>;
            command?: string | undefined;
            url?: string | undefined;
        }, {
            name: string;
            transport: "stdio" | "http";
            enabled?: boolean | undefined;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            url?: string | undefined;
        }>, "many">>;
    }, "strict", z.ZodTypeAny, {
        servers: {
            name: string;
            enabled: boolean;
            transport: "stdio" | "http";
            args: string[];
            env: Record<string, string>;
            command?: string | undefined;
            url?: string | undefined;
        }[];
    }, {
        servers?: {
            name: string;
            transport: "stdio" | "http";
            enabled?: boolean | undefined;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            url?: string | undefined;
        }[] | undefined;
    }>>;
    logging: z.ZodDefault<z.ZodObject<{
        level: z.ZodDefault<z.ZodEnum<["trace", "debug", "info", "warn", "error"]>>;
        file: z.ZodOptional<z.ZodString>;
        redactSecrets: z.ZodDefault<z.ZodBoolean>;
    }, "strict", z.ZodTypeAny, {
        level: "trace" | "debug" | "info" | "warn" | "error";
        redactSecrets: boolean;
        file?: string | undefined;
    }, {
        level?: "trace" | "debug" | "info" | "warn" | "error" | undefined;
        file?: string | undefined;
        redactSecrets?: boolean | undefined;
    }>>;
}, "strict", z.ZodTypeAny, {
    agent: {
        maxIterations: number;
        oneTurnGraceCall: boolean;
        stream: boolean;
        budgetTokens?: number | undefined;
        budgetCostUsd?: number | undefined;
    };
    providers: {
        id: "openai" | "anthropic" | "google" | "ollama" | "custom";
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        defaultModel?: string | undefined;
        headers?: Record<string, string> | undefined;
        timeoutMs?: number | undefined;
    }[];
    models: {
        provider: "openai" | "anthropic" | "google" | "ollama" | "custom";
        name: string;
        temperature?: number | undefined;
        maxTokens?: number | undefined;
        topP?: number | undefined;
        reasoning?: boolean | undefined;
    }[];
    memory: {
        backend: "sqlite" | "memory";
        vectorDimensions: number;
        ftsEnabled: boolean;
        path?: string | undefined;
    };
    tools: {
        enabled: string[];
        disabled: string[];
        defaultTimeoutMs: number;
        dangerousRequireApproval: boolean;
    };
    skills: {
        directories: string[];
        autoEvolve: boolean;
        reflectEveryNInvocations: number;
    };
    mcp: {
        servers: {
            name: string;
            enabled: boolean;
            transport: "stdio" | "http";
            args: string[];
            env: Record<string, string>;
            command?: string | undefined;
            url?: string | undefined;
        }[];
    };
    logging: {
        level: "trace" | "debug" | "info" | "warn" | "error";
        redactSecrets: boolean;
        file?: string | undefined;
    };
    defaultModel?: string | undefined;
}, {
    agent?: {
        maxIterations?: number | undefined;
        budgetTokens?: number | undefined;
        budgetCostUsd?: number | undefined;
        oneTurnGraceCall?: boolean | undefined;
        stream?: boolean | undefined;
    } | undefined;
    defaultModel?: string | undefined;
    providers?: {
        id: "openai" | "anthropic" | "google" | "ollama" | "custom";
        apiKey?: string | undefined;
        baseUrl?: string | undefined;
        defaultModel?: string | undefined;
        headers?: Record<string, string> | undefined;
        timeoutMs?: number | undefined;
    }[] | undefined;
    models?: {
        provider: "openai" | "anthropic" | "google" | "ollama" | "custom";
        name: string;
        temperature?: number | undefined;
        maxTokens?: number | undefined;
        topP?: number | undefined;
        reasoning?: boolean | undefined;
    }[] | undefined;
    memory?: {
        path?: string | undefined;
        backend?: "sqlite" | "memory" | undefined;
        vectorDimensions?: number | undefined;
        ftsEnabled?: boolean | undefined;
    } | undefined;
    tools?: {
        enabled?: string[] | undefined;
        disabled?: string[] | undefined;
        defaultTimeoutMs?: number | undefined;
        dangerousRequireApproval?: boolean | undefined;
    } | undefined;
    skills?: {
        directories?: string[] | undefined;
        autoEvolve?: boolean | undefined;
        reflectEveryNInvocations?: number | undefined;
    } | undefined;
    mcp?: {
        servers?: {
            name: string;
            transport: "stdio" | "http";
            enabled?: boolean | undefined;
            command?: string | undefined;
            args?: string[] | undefined;
            env?: Record<string, string> | undefined;
            url?: string | undefined;
        }[] | undefined;
    } | undefined;
    logging?: {
        level?: "trace" | "debug" | "info" | "warn" | "error" | undefined;
        file?: string | undefined;
        redactSecrets?: boolean | undefined;
    } | undefined;
}>;
export type LumenConfig = z.infer<typeof LumenConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
export type ModelConfig = z.infer<typeof ModelConfigSchema>;
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>;
export {};
//# sourceMappingURL=schema.d.ts.map