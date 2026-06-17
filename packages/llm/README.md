# @lumen/llm

Provider implementations for the Lumen agent framework. Each provider
implements the `BaseProvider` contract from `@lumen/core` and is fully
standalone — you can use them without pulling in the rest of the agent
runtime.

## Providers

| Provider | Protocol | Use it for |
|---|---|---|
| `OpenAICompatibleProvider` | OpenAI Chat Completions | OpenAI, DeepSeek, Moonshot, vLLM, llama.cpp gateways, MiniMax and most modern LLM backends |
| `AnthropicProvider` | Anthropic Messages API | Claude Sonnet, Opus, Haiku (and Anthropic-compatible gateways) |
| `OllamaProvider` | Ollama native `/api/chat` | Local inference against Ollama |
| `LlamaCppProvider` | OpenAI-compatible | `llama-server` from llama.cpp |
| `GeminiProvider` | Google Gemini API | Gemini Pro, Flash, etc. |
| `MistralProvider` | OpenAI-compatible + native `/v1/embeddings` | Mistral chat + Mistral embeddings |

`OpenAICompatibleProvider` is the most common starting point: most
modern LLM backends ship a thin OpenAI-compatible gateway.

## Quick start

```ts
import { createOpenAIProvider } from '@lumen/llm'

const apiKey = process.env.OPENAI_API_KEY
if (!apiKey) throw new Error('OPENAI_API_KEY is required')

const provider = createOpenAIProvider({
  apiKey,
  defaultModel: 'gpt-4o-mini',
})

const response = await provider.chat({
  messages: [{ role: 'user', content: 'Hello' }],
})
```

```ts
import { createAnthropicProvider } from '@lumen/llm'

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required')

const provider = createAnthropicProvider({
  apiKey,
  defaultModel: 'claude-sonnet-4-5',
})
```

```ts
import { createOllamaProvider } from '@lumen/llm'

const provider = createOllamaProvider({
  defaultModel: 'llama3.1',
  // baseUrl defaults to http://127.0.0.1:11434
})
```

## Embeddings

`OpenAICompatibleProvider.embed()` and `MistralProvider.embed()` talk
the OpenAI-style `/v1/embeddings` endpoint. `OllamaProvider.embed()`
uses Ollama's native `/api/embed`. The `EmbeddingSource` structural
type in `@lumen/memory/embedder` accepts any of them, so the retriever
stays provider-agnostic.

## Prompt caching (Anthropic)

`AnthropicProvider` honors `anthropicSystemBlocks` and
`anthropicCacheTools` `providerOptions` for prompt caching:

```ts
await provider.chat({
  messages: [...],
  providerOptions: {
    anthropicSystemBlocks: [
      { type: 'text', text: 'You are...', cache_control: { type: 'ephemeral' } },
    ],
  },
})
```

## Error types

```ts
import { HttpStatusError, ResponseShapeError, StreamParseError, isRetryableStatus } from '@lumen/llm'
```

All providers throw `HttpStatusError` for non-2xx, `ResponseShapeError`
for missing fields, and `StreamParseError` for malformed SSE chunks.
`isRetryableStatus(code)` returns `true` for 408 / 409 / 429 / 5xx.

## License

MIT
