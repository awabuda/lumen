/**
 * Message protocol — the lingua franca between the agent loop, providers,
 * and tools.
 *
 * Every message is a discriminated union on `role`. The Zod schemas are the
 * source of truth; TypeScript types are inferred from them via `z.infer`.
 *
 * Design choices:
 *   - We use OpenAI-style content arrays (`parts`) to support multimodal
 *     input, but flatten to plain string when the provider is text-only.
 *   - `reasoning` is a separate field on assistant messages (for models
 *     that emit chain-of-thought as a separate stream).
 *   - `tool_call_id` on tool messages ties results back to the specific
 *     tool call that produced them.
 */
import { z } from 'zod';
export declare const Role: {
    readonly System: "system";
    readonly User: "user";
    readonly Assistant: "assistant";
    readonly Tool: "tool";
};
export type RoleValue = (typeof Role)[keyof typeof Role];
export declare const TextPartSchema: z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "text";
    text: string;
}, {
    type: "text";
    text: string;
}>;
export type TextPart = z.infer<typeof TextPartSchema>;
export declare const ImagePartSchema: z.ZodObject<{
    type: z.ZodLiteral<"image">;
    source: z.ZodUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"url">;
        url: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        kind: "url";
        url: string;
    }, {
        kind: "url";
        url: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"base64">;
        mediaType: z.ZodString;
        data: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        kind: "base64";
        mediaType: string;
        data: string;
    }, {
        kind: "base64";
        mediaType: string;
        data: string;
    }>]>;
    alt: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "image";
    source: {
        kind: "url";
        url: string;
    } | {
        kind: "base64";
        mediaType: string;
        data: string;
    };
    alt?: string | undefined;
}, {
    type: "image";
    source: {
        kind: "url";
        url: string;
    } | {
        kind: "base64";
        mediaType: string;
        data: string;
    };
    alt?: string | undefined;
}>;
export type ImagePart = z.infer<typeof ImagePartSchema>;
export declare const ContentPartSchema: z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
    type: z.ZodLiteral<"text">;
    text: z.ZodString;
}, "strip", z.ZodTypeAny, {
    type: "text";
    text: string;
}, {
    type: "text";
    text: string;
}>, z.ZodObject<{
    type: z.ZodLiteral<"image">;
    source: z.ZodUnion<[z.ZodObject<{
        kind: z.ZodLiteral<"url">;
        url: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        kind: "url";
        url: string;
    }, {
        kind: "url";
        url: string;
    }>, z.ZodObject<{
        kind: z.ZodLiteral<"base64">;
        mediaType: z.ZodString;
        data: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        kind: "base64";
        mediaType: string;
        data: string;
    }, {
        kind: "base64";
        mediaType: string;
        data: string;
    }>]>;
    alt: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "image";
    source: {
        kind: "url";
        url: string;
    } | {
        kind: "base64";
        mediaType: string;
        data: string;
    };
    alt?: string | undefined;
}, {
    type: "image";
    source: {
        kind: "url";
        url: string;
    } | {
        kind: "base64";
        mediaType: string;
        data: string;
    };
    alt?: string | undefined;
}>]>;
export type ContentPart = z.infer<typeof ContentPartSchema>;
export declare const ToolCallSchema: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    arguments: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, "strip", z.ZodTypeAny, {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}, {
    id: string;
    name: string;
    arguments: Record<string, unknown>;
}>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export declare const ToolResultSchema: z.ZodObject<{
    toolCallId: z.ZodString;
    content: z.ZodOptional<z.ZodString>;
    isError: z.ZodDefault<z.ZodBoolean>;
    data: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    toolCallId: string;
    isError: boolean;
    content?: string | undefined;
    data?: Record<string, unknown> | undefined;
}, {
    toolCallId: string;
    content?: string | undefined;
    data?: Record<string, unknown> | undefined;
    isError?: boolean | undefined;
}>;
export type ToolResult = z.infer<typeof ToolResultSchema>;
export declare const SystemMessageSchema: z.ZodObject<{
    role: z.ZodLiteral<"system">;
    content: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    role: "system";
    content: string;
    name?: string | undefined;
}, {
    role: "system";
    content: string;
    name?: string | undefined;
}>;
export type SystemMessage = z.infer<typeof SystemMessageSchema>;
export declare const UserMessageSchema: z.ZodObject<{
    role: z.ZodLiteral<"user">;
    content: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "text";
        text: string;
    }, {
        type: "text";
        text: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        source: z.ZodUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"url">;
            url: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            kind: "url";
            url: string;
        }, {
            kind: "url";
            url: string;
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"base64">;
            mediaType: z.ZodString;
            data: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            kind: "base64";
            mediaType: string;
            data: string;
        }, {
            kind: "base64";
            mediaType: string;
            data: string;
        }>]>;
        alt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "image";
        source: {
            kind: "url";
            url: string;
        } | {
            kind: "base64";
            mediaType: string;
            data: string;
        };
        alt?: string | undefined;
    }, {
        type: "image";
        source: {
            kind: "url";
            url: string;
        } | {
            kind: "base64";
            mediaType: string;
            data: string;
        };
        alt?: string | undefined;
    }>]>, "many">]>;
    name: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    role: "user";
    content: string | ({
        type: "text";
        text: string;
    } | {
        type: "image";
        source: {
            kind: "url";
            url: string;
        } | {
            kind: "base64";
            mediaType: string;
            data: string;
        };
        alt?: string | undefined;
    })[];
    name?: string | undefined;
}, {
    role: "user";
    content: string | ({
        type: "text";
        text: string;
    } | {
        type: "image";
        source: {
            kind: "url";
            url: string;
        } | {
            kind: "base64";
            mediaType: string;
            data: string;
        };
        alt?: string | undefined;
    })[];
    name?: string | undefined;
}>;
export type UserMessage = z.infer<typeof UserMessageSchema>;
export declare const AssistantMessageSchema: z.ZodObject<{
    role: z.ZodLiteral<"assistant">;
    content: z.ZodOptional<z.ZodString>;
    toolCalls: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        arguments: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        name: string;
        arguments: Record<string, unknown>;
    }, {
        id: string;
        name: string;
        arguments: Record<string, unknown>;
    }>, "many">>;
    reasoning: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    usage: z.ZodOptional<z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        totalTokens: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    }, {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    }>>;
    finishReason: z.ZodOptional<z.ZodEnum<["stop", "tool_calls", "length", "content_filter", "error"]>>;
}, "strip", z.ZodTypeAny, {
    role: "assistant";
    toolCalls: {
        id: string;
        name: string;
        arguments: Record<string, unknown>;
    }[];
    content?: string | undefined;
    reasoning?: string | undefined;
    model?: string | undefined;
    usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    } | undefined;
    finishReason?: "length" | "stop" | "tool_calls" | "content_filter" | "error" | undefined;
}, {
    role: "assistant";
    content?: string | undefined;
    toolCalls?: {
        id: string;
        name: string;
        arguments: Record<string, unknown>;
    }[] | undefined;
    reasoning?: string | undefined;
    model?: string | undefined;
    usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    } | undefined;
    finishReason?: "length" | "stop" | "tool_calls" | "content_filter" | "error" | undefined;
}>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export declare const ToolMessageSchema: z.ZodObject<{
    role: z.ZodLiteral<"tool">;
    results: z.ZodArray<z.ZodObject<{
        toolCallId: z.ZodString;
        content: z.ZodOptional<z.ZodString>;
        isError: z.ZodDefault<z.ZodBoolean>;
        data: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        toolCallId: string;
        isError: boolean;
        content?: string | undefined;
        data?: Record<string, unknown> | undefined;
    }, {
        toolCallId: string;
        content?: string | undefined;
        data?: Record<string, unknown> | undefined;
        isError?: boolean | undefined;
    }>, "many">;
    name: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    role: "tool";
    results: {
        toolCallId: string;
        isError: boolean;
        content?: string | undefined;
        data?: Record<string, unknown> | undefined;
    }[];
    name?: string | undefined;
}, {
    role: "tool";
    results: {
        toolCallId: string;
        content?: string | undefined;
        data?: Record<string, unknown> | undefined;
        isError?: boolean | undefined;
    }[];
    name?: string | undefined;
}>;
export type ToolMessage = z.infer<typeof ToolMessageSchema>;
export declare const MessageSchema: z.ZodDiscriminatedUnion<"role", [z.ZodObject<{
    role: z.ZodLiteral<"system">;
    content: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    role: "system";
    content: string;
    name?: string | undefined;
}, {
    role: "system";
    content: string;
    name?: string | undefined;
}>, z.ZodObject<{
    role: z.ZodLiteral<"user">;
    content: z.ZodUnion<[z.ZodString, z.ZodArray<z.ZodDiscriminatedUnion<"type", [z.ZodObject<{
        type: z.ZodLiteral<"text">;
        text: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        type: "text";
        text: string;
    }, {
        type: "text";
        text: string;
    }>, z.ZodObject<{
        type: z.ZodLiteral<"image">;
        source: z.ZodUnion<[z.ZodObject<{
            kind: z.ZodLiteral<"url">;
            url: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            kind: "url";
            url: string;
        }, {
            kind: "url";
            url: string;
        }>, z.ZodObject<{
            kind: z.ZodLiteral<"base64">;
            mediaType: z.ZodString;
            data: z.ZodString;
        }, "strip", z.ZodTypeAny, {
            kind: "base64";
            mediaType: string;
            data: string;
        }, {
            kind: "base64";
            mediaType: string;
            data: string;
        }>]>;
        alt: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "image";
        source: {
            kind: "url";
            url: string;
        } | {
            kind: "base64";
            mediaType: string;
            data: string;
        };
        alt?: string | undefined;
    }, {
        type: "image";
        source: {
            kind: "url";
            url: string;
        } | {
            kind: "base64";
            mediaType: string;
            data: string;
        };
        alt?: string | undefined;
    }>]>, "many">]>;
    name: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    role: "user";
    content: string | ({
        type: "text";
        text: string;
    } | {
        type: "image";
        source: {
            kind: "url";
            url: string;
        } | {
            kind: "base64";
            mediaType: string;
            data: string;
        };
        alt?: string | undefined;
    })[];
    name?: string | undefined;
}, {
    role: "user";
    content: string | ({
        type: "text";
        text: string;
    } | {
        type: "image";
        source: {
            kind: "url";
            url: string;
        } | {
            kind: "base64";
            mediaType: string;
            data: string;
        };
        alt?: string | undefined;
    })[];
    name?: string | undefined;
}>, z.ZodObject<{
    role: z.ZodLiteral<"assistant">;
    content: z.ZodOptional<z.ZodString>;
    toolCalls: z.ZodDefault<z.ZodArray<z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        arguments: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    }, "strip", z.ZodTypeAny, {
        id: string;
        name: string;
        arguments: Record<string, unknown>;
    }, {
        id: string;
        name: string;
        arguments: Record<string, unknown>;
    }>, "many">>;
    reasoning: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    usage: z.ZodOptional<z.ZodObject<{
        inputTokens: z.ZodNumber;
        outputTokens: z.ZodNumber;
        totalTokens: z.ZodNumber;
    }, "strip", z.ZodTypeAny, {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    }, {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    }>>;
    finishReason: z.ZodOptional<z.ZodEnum<["stop", "tool_calls", "length", "content_filter", "error"]>>;
}, "strip", z.ZodTypeAny, {
    role: "assistant";
    toolCalls: {
        id: string;
        name: string;
        arguments: Record<string, unknown>;
    }[];
    content?: string | undefined;
    reasoning?: string | undefined;
    model?: string | undefined;
    usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    } | undefined;
    finishReason?: "length" | "stop" | "tool_calls" | "content_filter" | "error" | undefined;
}, {
    role: "assistant";
    content?: string | undefined;
    toolCalls?: {
        id: string;
        name: string;
        arguments: Record<string, unknown>;
    }[] | undefined;
    reasoning?: string | undefined;
    model?: string | undefined;
    usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
    } | undefined;
    finishReason?: "length" | "stop" | "tool_calls" | "content_filter" | "error" | undefined;
}>, z.ZodObject<{
    role: z.ZodLiteral<"tool">;
    results: z.ZodArray<z.ZodObject<{
        toolCallId: z.ZodString;
        content: z.ZodOptional<z.ZodString>;
        isError: z.ZodDefault<z.ZodBoolean>;
        data: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
    }, "strip", z.ZodTypeAny, {
        toolCallId: string;
        isError: boolean;
        content?: string | undefined;
        data?: Record<string, unknown> | undefined;
    }, {
        toolCallId: string;
        content?: string | undefined;
        data?: Record<string, unknown> | undefined;
        isError?: boolean | undefined;
    }>, "many">;
    name: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    role: "tool";
    results: {
        toolCallId: string;
        isError: boolean;
        content?: string | undefined;
        data?: Record<string, unknown> | undefined;
    }[];
    name?: string | undefined;
}, {
    role: "tool";
    results: {
        toolCallId: string;
        content?: string | undefined;
        data?: Record<string, unknown> | undefined;
        isError?: boolean | undefined;
    }[];
    name?: string | undefined;
}>]>;
export type Message = z.infer<typeof MessageSchema>;
export interface ReasoningPart {
    readonly type: 'reasoning';
    readonly text: string;
}
export type StreamEvent = {
    type: 'message_start';
    message: AssistantMessage;
} | {
    type: 'reasoning_delta';
    delta: string;
} | {
    type: 'content_delta';
    delta: string;
} | {
    type: 'tool_call_delta';
    id?: string;
    name?: string;
    argumentsDelta?: string;
} | {
    type: 'tool_call_complete';
    toolCall: ToolCall;
} | {
    type: 'message_complete';
    message: AssistantMessage;
} | {
    type: 'error';
    error: Error;
};
export interface StreamOptions {
    /** AbortSignal for cancellation. */
    signal?: AbortSignal;
    /** Provider-specific headers (e.g. for tracing). */
    headers?: Record<string, string>;
}
//# sourceMappingURL=index.d.ts.map