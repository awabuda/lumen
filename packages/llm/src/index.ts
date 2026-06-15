/**
 * @lumen/llm — provider implementations for the Lumen agent framework.
 *
 * Exports two concrete providers:
 *
 *   - {@link OpenAICompatibleProvider} — talks the OpenAI Chat Completions
 *     protocol. This protocol is implemented (often with minor variations)
 *     by OpenAI, DeepSeek, Moonshot, Ollama, vLLM, llama.cpp, MiniMax and
 *     most other modern LLM backends.
 *
 *   - {@link AnthropicProvider} — talks Anthropic's Messages API
 *     (`/v1/messages`). Used by Claude Sonnet, Opus, and Haiku, and by
 *     any Anthropic-compatible gateway.
 *
 *   - {@link OllamaProvider} — talks Ollama's native `/api/chat`,
 *     `/api/embed`, and `/api/embeddings` endpoints. Used for local
 *     inference against llama.cpp-backed models (llama3.1, mistral,
 *     qwen2.5, gemma2, etc.). Note: OpenAI-compatible gateways in front
 *     of Ollama should use {@link OpenAICompatibleProvider} instead.
 *
 * The providers are fully stand-alone: they depend only on `@lumen/core`
 * for the {@link BaseProvider} contract. The rest of the agent runtime
 * is not required to use them.
 *
 * Quick start (OpenAI):
 *
 * ```ts
 * import { createOpenAIProvider } from '@lumen/llm'
 *
 * const provider = createOpenAIProvider({
 *   apiKey: process.env.OPENAI_API_KEY!,
 *   defaultModel: 'gpt-4o-mini',
 * })
 * ```
 *
 * Quick start (Anthropic):
 *
 * ```ts
 * import { createAnthropicProvider } from '@lumen/llm'
 *
 * const provider = createAnthropicProvider({
 *   apiKey: process.env.ANTHROPIC_API_KEY!,
 *   defaultModel: 'claude-sonnet-4-5',
 * })
 * ```
 *
 * Quick start (Ollama, local):
 *
 * ```ts
 * import { createOllamaProvider } from '@lumen/llm'
 *
 * const provider = createOllamaProvider({
 *   defaultModel: 'llama3.1',
 * })
 * ```
 */

export { OpenAICompatibleProvider, createOpenAIProvider } from './openai-compatible.js'
export type { OpenAICompatibleOptions } from './openai-compatible.js'
export {
  AnthropicProvider,
  createAnthropicProvider,
  DEFAULT_ANTHROPIC_VERSION,
  DEFAULT_MAX_TOKENS,
} from './anthropic.js'
export type {
  AnthropicOptions,
  AnthropicSystemBlock,
  AnthropicCacheControl,
} from './anthropic.js'
export { OllamaProvider, createOllamaProvider, DEFAULT_OLLAMA_BASE_URL, parseNdjsonLines } from './ollama.js'
export type { OllamaOptions } from './ollama.js'
export { GeminiProvider, createGeminiProvider, DEFAULT_GEMINI_BASE_URL, GeminiOptionsSchema } from './gemini.js'
export type { GeminiOptions } from './gemini.js'
export {
  MistralProvider,
  createMistralProvider,
  DEFAULT_MISTRAL_BASE_URL,
  DEFAULT_MISTRAL_MODEL,
  DEFAULT_MISTRAL_EMBED_MODEL,
  MISTRAL_PROVIDER_ID,
} from './mistral.js'
export type { MistralProviderOptions } from './mistral.js'
export { HttpStatusError, ResponseShapeError, StreamParseError, isRetryableStatus } from './errors.js'
