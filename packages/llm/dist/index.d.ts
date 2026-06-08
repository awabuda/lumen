/**
 * @lumen/llm — provider implementations for the Lumen agent framework.
 *
 * Exports a single concrete provider, {@link OpenAICompatibleProvider},
 * which talks the OpenAI Chat Completions protocol. This protocol is
 * implemented (often with minor variations) by OpenAI, DeepSeek, Moonshot,
 * Ollama, vLLM, llama.cpp, MiniMax and most other modern LLM backends.
 *
 * The provider is fully stand-alone: it depends only on `@lumen/core`
 * for the {@link BaseProvider} contract. The rest of the agent runtime
 * is not required to use it.
 *
 * Quick start:
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
 * For non-OpenAI endpoints:
 *
 * ```ts
 * import { OpenAICompatibleProvider } from '@lumen/llm'
 *
 * const provider = new OpenAICompatibleProvider({
 *   id: 'deepseek',
 *   baseUrl: 'https://api.deepseek.com/v1',
 *   apiKey: process.env.DEEPSEEK_API_KEY!,
 *   defaultModel: 'deepseek-chat',
 * })
 * ```
 */
export { OpenAICompatibleProvider, createOpenAIProvider } from './openai-compatible.js';
export type { OpenAICompatibleOptions } from './openai-compatible.js';
export { HttpStatusError, ResponseShapeError, StreamParseError, isRetryableStatus } from './errors.js';
//# sourceMappingURL=index.d.ts.map