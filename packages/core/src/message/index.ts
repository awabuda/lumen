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

import { z } from 'zod'

// -----------------------------------------------------------------------------
// Roles
// -----------------------------------------------------------------------------

export const Role = {
  System: 'system',
  User: 'user',
  Assistant: 'assistant',
  Tool: 'tool',
} as const

export type RoleValue = (typeof Role)[keyof typeof Role]

// -----------------------------------------------------------------------------
// Parts (multimodal content)
// -----------------------------------------------------------------------------

export const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
})
export type TextPart = z.infer<typeof TextPartSchema>

export const ImagePartSchema = z.object({
  type: z.literal('image'),
  // Either a URL the provider can fetch, or base64 inline data
  source: z.union([
    z.object({ kind: z.literal('url'), url: z.string().url() }),
    z.object({ kind: z.literal('base64'), mediaType: z.string(), data: z.string() }),
  ]),
  // Optional alt text for accessibility / logging
  alt: z.string().optional(),
})
export type ImagePart = z.infer<typeof ImagePartSchema>

export const ContentPartSchema = z.discriminatedUnion('type', [TextPartSchema, ImagePartSchema])
export type ContentPart = z.infer<typeof ContentPartSchema>

// -----------------------------------------------------------------------------
// Tool calls (assistant -> agent)
// -----------------------------------------------------------------------------

export const ToolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  // Provider-supplied JSON arguments; we keep them as `unknown` here and
  // validate against the tool's input schema at dispatch time.
  arguments: z.record(z.unknown()),
})
export type ToolCall = z.infer<typeof ToolCallSchema>

// -----------------------------------------------------------------------------
// Tool results (tool -> agent)
// -----------------------------------------------------------------------------

export const ToolResultSchema = z.object({
  toolCallId: z.string().min(1),
  // Either content (success) or error (failure). Exactly one is set.
  content: z.string().optional(),
  isError: z.boolean().default(false),
  // Optional structured payload for tools that want to return typed data
  data: z.record(z.unknown()).optional(),
})
export type ToolResult = z.infer<typeof ToolResultSchema>

// -----------------------------------------------------------------------------
// Per-role message schemas
// -----------------------------------------------------------------------------

export const SystemMessageSchema = z.object({
  role: z.literal('system'),
  content: z.string(),
  name: z.string().optional(),
})
export type SystemMessage = z.infer<typeof SystemMessageSchema>

export const UserMessageSchema = z.object({
  role: z.literal('user'),
  // Users can speak in text or with attachments
  content: z.union([z.string(), z.array(ContentPartSchema)]),
  name: z.string().optional(),
})
export type UserMessage = z.infer<typeof UserMessageSchema>

export const AssistantMessageSchema = z.object({
  role: z.literal('assistant'),
  // Plain text content (mutually exclusive with toolCalls)
  content: z.string().optional(),
  // Tool calls requested by the model
  toolCalls: z.array(ToolCallSchema).default([]),
  // Reasoning / chain-of-thought (model-specific)
  reasoning: z.string().optional(),
  // Provider-specific metadata
  model: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
      totalTokens: z.number().int().nonnegative(),
      // P23.6 (fix #8) — optional per-message cost in USD.
      // Providers that track cost (Anthropic, OpenAI usage
      // endpoints) populate this; the rest omit it and the
      // cost budget stays infinite. Pre-P23.6 the field did
      // not exist and Budget.addCost() was unreachable.
      costUsd: z.number().nonnegative().optional(),
    })
    .optional(),
  // Stop reason from the provider
  finishReason: z.enum(['stop', 'tool_calls', 'length', 'content_filter', 'error']).optional(),
})
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>

export const ToolMessageSchema = z.object({
  role: z.literal('tool'),
  // The tool result for a specific call
  results: z.array(ToolResultSchema).min(1),
  name: z.string().optional(),
})
export type ToolMessage = z.infer<typeof ToolMessageSchema>

export const MessageSchema = z.discriminatedUnion('role', [
  SystemMessageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  ToolMessageSchema,
])
export type Message = z.infer<typeof MessageSchema>

// -----------------------------------------------------------------------------
// Reasoning part (for streaming, before the actual content)
// -----------------------------------------------------------------------------

export interface ReasoningPart {
  readonly type: 'reasoning'
  readonly text: string
}

// -----------------------------------------------------------------------------
// Streaming events (provider -> agent)
// -----------------------------------------------------------------------------

export type StreamEvent =
  | { type: 'message_start'; message: AssistantMessage }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'content_delta'; delta: string }
  | { type: 'tool_call_delta'; id?: string; name?: string; argumentsDelta?: string }
  | { type: 'tool_call_complete'; toolCall: ToolCall }
  | { type: 'message_complete'; message: AssistantMessage }
  | { type: 'error'; error: Error }

export interface StreamOptions {
  /** AbortSignal for cancellation. */
  signal?: AbortSignal
  /** Provider-specific headers (e.g. for tracing). */
  headers?: Record<string, string>
}
