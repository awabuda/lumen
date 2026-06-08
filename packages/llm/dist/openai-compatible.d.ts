/**
 * OpenAI-compatible provider.
 *
 * Implements {@link BaseProvider} against the OpenAI Chat Completions HTTP
 * protocol. Because DeepSeek, Moonshot (Kimi), Anthropic-via-gateway, Ollama,
 * vLLM, llama.cpp's server, MiniMax and most other modern backends expose
 * the same wire format (or a strict superset), one class covers them all.
 *
 * Wiring: the caller picks the endpoint via {@link OpenAICompatibleOptions.baseUrl}
 * and the auth via {@link OpenAICompatibleOptions.apiKey}; everything else
 * falls back to the OpenAI defaults. This deliberately **does not** hard-code
 * any specific provider's URL.
 *
 * Protocol notes:
 *   - POST {baseUrl}/chat/completions with `Authorization: Bearer <key>`.
 *   - Tool calls in requests use the `tools` array; tool calls in responses
 *     are nested under `choices[0].message.tool_calls`.
 *   - Streaming is server-sent events prefixed with `data: ` and terminated
 *     by `data: [DONE]`. We parse the chunks incrementally and feed the
 *     agent loop's {@link StreamEvent} union.
 *   - Stop reason mapping: `stop` → `'stop'`, `tool_calls` → `'tool_calls'`,
 *     `length` → `'length'`, `content_filter` → `'content_filter'`.
 *     Anything else (including missing) maps to `undefined` rather than
 *     fabricating a value.
 */
import { z } from 'zod';
import { BaseProvider, type ChatRequest, type ChatResponse, type EmbedRequest, type EmbedResponse, type ProviderCapabilities, type StreamEvent, type StreamOptions } from '@lumen/core';
export declare const OpenAIRequestBodySchema: z.ZodObject<{
    model: z.ZodString;
    messages: z.ZodArray<z.ZodObject<{
        role: z.ZodString;
        content: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNull]>>;
        name: z.ZodOptional<z.ZodString>;
        tool_calls: z.ZodOptional<z.ZodArray<z.ZodObject<{
            id: z.ZodString;
            type: z.ZodLiteral<"function">;
            function: z.ZodObject<{
                name: z.ZodString;
                arguments: z.ZodString;
            }, "strip", z.ZodTypeAny, {
                name: string;
                arguments: string;
            }, {
                name: string;
                arguments: string;
            }>;
        }, "strip", z.ZodTypeAny, {
            function: {
                name: string;
                arguments: string;
            };
            type: "function";
            id: string;
        }, {
            function: {
                name: string;
                arguments: string;
            };
            type: "function";
            id: string;
        }>, "many">>;
        tool_call_id: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        role: string;
        name?: string | undefined;
        content?: string | null | undefined;
        tool_calls?: {
            function: {
                name: string;
                arguments: string;
            };
            type: "function";
            id: string;
        }[] | undefined;
        tool_call_id?: string | undefined;
    }, {
        role: string;
        name?: string | undefined;
        content?: string | null | undefined;
        tool_calls?: {
            function: {
                name: string;
                arguments: string;
            };
            type: "function";
            id: string;
        }[] | undefined;
        tool_call_id?: string | undefined;
    }>, "many">;
    temperature: z.ZodOptional<z.ZodNumber>;
    max_tokens: z.ZodOptional<z.ZodNumber>;
    top_p: z.ZodOptional<z.ZodNumber>;
    stop: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodString, "many">]>>;
    stream: z.ZodOptional<z.ZodBoolean>;
    tools: z.ZodOptional<z.ZodArray<z.ZodObject<{
        type: z.ZodLiteral<"function">;
        function: z.ZodObject<{
            name: z.ZodString;
            description: z.ZodOptional<z.ZodString>;
            parameters: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
            strict: z.ZodOptional<z.ZodBoolean>;
        }, "strip", z.ZodTypeAny, {
            name: string;
            description?: string | undefined;
            parameters?: Record<string, unknown> | undefined;
            strict?: boolean | undefined;
        }, {
            name: string;
            description?: string | undefined;
            parameters?: Record<string, unknown> | undefined;
            strict?: boolean | undefined;
        }>;
    }, "strip", z.ZodTypeAny, {
        function: {
            name: string;
            description?: string | undefined;
            parameters?: Record<string, unknown> | undefined;
            strict?: boolean | undefined;
        };
        type: "function";
    }, {
        function: {
            name: string;
            description?: string | undefined;
            parameters?: Record<string, unknown> | undefined;
            strict?: boolean | undefined;
        };
        type: "function";
    }>, "many">>;
    tool_choice: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodRecord<z.ZodString, z.ZodUnknown>]>>;
}, "strip", z.ZodTypeAny, {
    model: string;
    messages: {
        role: string;
        name?: string | undefined;
        content?: string | null | undefined;
        tool_calls?: {
            function: {
                name: string;
                arguments: string;
            };
            type: "function";
            id: string;
        }[] | undefined;
        tool_call_id?: string | undefined;
    }[];
    stop?: string | string[] | undefined;
    temperature?: number | undefined;
    max_tokens?: number | undefined;
    top_p?: number | undefined;
    stream?: boolean | undefined;
    tools?: {
        function: {
            name: string;
            description?: string | undefined;
            parameters?: Record<string, unknown> | undefined;
            strict?: boolean | undefined;
        };
        type: "function";
    }[] | undefined;
    tool_choice?: string | Record<string, unknown> | undefined;
}, {
    model: string;
    messages: {
        role: string;
        name?: string | undefined;
        content?: string | null | undefined;
        tool_calls?: {
            function: {
                name: string;
                arguments: string;
            };
            type: "function";
            id: string;
        }[] | undefined;
        tool_call_id?: string | undefined;
    }[];
    stop?: string | string[] | undefined;
    temperature?: number | undefined;
    max_tokens?: number | undefined;
    top_p?: number | undefined;
    stream?: boolean | undefined;
    tools?: {
        function: {
            name: string;
            description?: string | undefined;
            parameters?: Record<string, unknown> | undefined;
            strict?: boolean | undefined;
        };
        type: "function";
    }[] | undefined;
    tool_choice?: string | Record<string, unknown> | undefined;
}>;
/**
 * Constructor options for {@link OpenAICompatibleProvider}.
 *
 * `baseUrl` defaults to the public OpenAI endpoint but is **always
 * overridable** — this is the single point of configuration for swapping in
 * DeepSeek, Moonshot, Ollama, MiniMax, a local llama.cpp, or a corporate
 * gateway. `apiKey` may be empty for local servers that don't require
 * authentication.
 */
export interface OpenAICompatibleOptions {
    /** Stable identifier reported via `BaseProvider.id`. Defaults to `'openai'`. */
    readonly id?: string;
    /** Base URL of the API, e.g. `https://api.openai.com/v1`. No trailing slash. */
    readonly baseUrl: string;
    /** Bearer token (or empty for local servers). */
    readonly apiKey?: string;
    /** Default model id, used when a request omits `model`. */
    readonly defaultModel: string;
    /** Extra headers merged into every request (e.g. tracing ids). */
    readonly defaultHeaders?: Readonly<Record<string, string>>;
    /** Per-request timeout in milliseconds. Defaults to 60s. */
    readonly timeoutMs?: number;
    /** Capabilities override; lets callers opt into streaming/tool use they know the backend supports. */
    readonly capabilities?: Partial<ProviderCapabilities>;
    /**
     * Inject a custom fetch implementation (used by tests). Defaults to the
     * global `fetch` available in Node 20+.
     */
    readonly fetchImpl?: typeof fetch;
}
/**
 * {@link BaseProvider} implementation that talks to any OpenAI-compatible
 * HTTP backend.
 *
 * The provider does **not** carry any default URL — it must always be
 * constructed with a `baseUrl`. For convenience, the {@link createOpenAIProvider}
 * factory wires up the public OpenAI endpoint, and helpers like
 * {@link openAICompatibleFor} can build providers from
 * `ProviderConfig` entries.
 */
export declare class OpenAICompatibleProvider extends BaseProvider {
    readonly id: string;
    readonly capabilities: ProviderCapabilities;
    private readonly baseUrl;
    private readonly apiKey;
    private readonly defaultModel;
    private readonly defaultHeaders;
    private readonly timeoutMs;
    private readonly fetchImpl;
    constructor(options: OpenAICompatibleOptions);
    /**
     * Send a chat request to `{baseUrl}/chat/completions` and return the
     * assistant's reply.
     *
     * @throws {@link ProviderError} for any non-2xx response or network failure.
     * @throws DOMException `AbortError` when `options.signal` fires.
     */
    chat(request: ChatRequest, options?: StreamOptions): Promise<ChatResponse>;
    /**
     * Stream a chat response, yielding one or more {@link StreamEvent}s.
     *
     * Each `data: {...}` chunk is validated against {@link OpenAIStreamChunkSchema}
     * and translated into content deltas, tool-call deltas, and finally a
     * `message_complete` event. Tool calls are accumulated across chunks
     * (the OpenAI protocol streams them as partial JSON) and emitted complete.
     */
    stream(request: ChatRequest, options?: StreamOptions): AsyncGenerator<StreamEvent, void, void>;
    /**
     * Embeddings are not part of the OpenAI-compatible "chat" surface that
     * this class targets. Override in a subclass or build a dedicated
     * `OpenAIEmbeddingProvider` if you need them.
     */
    embed(_request: EmbedRequest, _options?: StreamOptions): Promise<EmbedResponse>;
    /** Construct the JSON body for the chat completions endpoint. */
    private buildRequestBody;
    /** Build a request, attach auth/headers, and execute the fetch. */
    private performFetch;
    /** Convert a non-2xx HTTP response into a typed `ProviderError`. */
    private makeHttpError;
}
/**
 * Parse an SSE response body into individual `data:` payloads.
 *
 * The OpenAI chat-completions stream uses two relevant line shapes:
 *   - `data: {json}`  — one event per JSON object
 *   - `data: [DONE]`   — terminator; we stop iteration
 *
 * We strip comment lines (`: ...`), blank lines, and event-name lines. We
 * concatenate multi-line data values according to the SSE spec, although the
 * OpenAI providers we've seen never split a single event across lines.
 */
export declare function parseSseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, void>;
/** Parse a JSON string into a Zod-validated shape, throwing a typed error. */
export declare function parseResponseJson<S extends z.ZodTypeAny>(text: string, schema: S): z.infer<S>;
/**
 * Convenience factory: build an {@link OpenAICompatibleProvider} pointed at
 * the public OpenAI endpoint.
 *
 * @param opts - All options except `baseUrl`, which is set to
 *   `https://api.openai.com/v1`.
 */
export declare function createOpenAIProvider(opts: {
    readonly apiKey: string;
    readonly defaultModel: string;
    readonly id?: string;
    readonly defaultHeaders?: Readonly<Record<string, string>>;
    readonly timeoutMs?: number;
    readonly fetchImpl?: typeof fetch;
}): OpenAICompatibleProvider;
//# sourceMappingURL=openai-compatible.d.ts.map