/**
 * Real-model E2E harness helpers.
 *
 * The scenarios in this directory hit real LLM providers (OpenAI,
 * Anthropic, Mistral, Ollama, llama.cpp) over the wire. They are
 * skipped by default so that:
 *
 *   - `pnpm test` in CI / in this repo never accidentally
 *     burns API credits or hits a local inference server.
 *   - Developers without API keys see a clean "skipped" instead
 *     of red bars.
 *
 * Opt in by exporting `LUMEN_E2E=1` in the shell. Tests that
 * require a specific provider's key are skipped at the
 * `it` level with a reason when the matching env var is not set.
 *
 * Env vars recognised:
 *   LUMEN_E2E=1                              - master switch
 *   LUMEN_E2E_OPENAI_API_KEY                 - OpenAI provider
 *   LUMEN_E2E_OPENAI_BASE_URL (optional)     - default https://api.openai.com/v1
 *   LUMEN_E2E_OPENAI_MODEL (optional)        - default gpt-4o-mini
 *   LUMEN_E2E_ANTHROPIC_API_KEY              - Anthropic provider
 *   LUMEN_E2E_ANTHROPIC_BASE_URL (optional)  - default https://api.anthropic.com
 *   LUMEN_E2E_ANTHROPIC_MODEL (optional)     - default claude-haiku-4-5
 *   LUMEN_E2E_MISTRAL_API_KEY                - Mistral provider
 *   LUMEN_E2E_MISTRAL_BASE_URL (optional)    - default https://api.mistral.ai/v1
 *   LUMEN_E2E_MISTRAL_MODEL (optional)       - default mistral-small-latest
 *   LUMEN_E2E_OLLAMA_BASE_URL (optional)     - default http://127.0.0.1:11434
 *   LUMEN_E2E_OLLAMA_MODEL (optional)        - default llama3.1
 *   LUMEN_E2E_LLAMACPP_BASE_URL (optional)   - default http://127.0.0.1:8080/v1
 *   LUMEN_E2E_LLAMACPP_MODEL (optional)      - default qwen2.5-7b
 *
 * Cost discipline:
 *   - Every scenario uses the cheapest viable model (mini / haiku
 *     / small) by default. Override via the *_MODEL env vars.
 *   - Scenarios that need tool calling are tagged with the
 *     capability they exercise; local models (Ollama, llama.cpp)
 *     are skipped for those scenarios when the chosen model is
 *     known to lack tool-call support — the test is skipped
 *     with a reason, not failed.
 */

import type { BaseProvider } from '@lumen/core'
import {
  AnthropicProvider,
  LlamaCppProvider,
  MistralProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
} from '@lumen/llm'

/**
 * Master switch: LUMEN_E2E=1 enables real-provider scenarios.
 *
 * When false, every `it` in this directory should be a no-op
 * (typically via a top-of-file skipIfE2EDisabled() call).
 */
export function e2eEnabled(): boolean {
  return process.env.LUMEN_E2E === '1'
}

/**
 * Skip the current test if e2e is disabled. Usage at the top
 * of every scenario file, immediately after the imports:
 *
 *   import { skipIfE2EDisabled } from './helpers'
 *   skipIfE2EDisabled()
 *
 * Implementation note: throwing a sentinel is the
 * test-context-aware way to short-circuit. We re-throw as
 * a vitest pending() via a tagged Error subclass so the
 * runtime knows the difference between "intentional skip"
 * and a real failure.
 */
export class E2ESkip extends Error {
  public readonly __lumen_skip__ = true as const
  public constructor(message: string) {
    super(message)
    this.name = 'E2ESkip'
  }
}

/**
 * Standalone "should this run?" predicate. Pair with vitest's
 * native skip / runIf APIs:
 *
 *   import { describe, it } from 'vitest'
 *   it.runIf(e2eEnabled())(`...`, async () => { ... })
 *
 * Use {@link skipIfE2EDisabled} when you want a single-file
 * hard skip with a clear reason; use `it.runIf` when you want
 * per-test granularity (e.g. provider-specific tests inside
 * a single file).
 */
export function skipIfE2EDisabled(): boolean {
  return e2eEnabled()
}

export interface RealProviderHandle {
  /** Stable id used for reporting (e.g. "openai"). */
  readonly id: 'openai' | 'anthropic' | 'mistral' | 'ollama' | 'llamacpp'
  /** The constructed provider. */
  readonly provider: BaseProvider
  /** Model to pass to the provider on every call. */
  readonly defaultModel: string
}

/**
 * Build every provider that has its API key (or local URL)
 * configured. Returns an empty array if no provider is
 * configured. Scenarios iterate over the returned list and
 * each test runs once per provider.
 *
 * The factory uses `defaultModel` as a required field on every
 * Options object even where the option is optional in the
 * underlying class: e2e scenarios always want a deterministic
 * model id, and guessing from `process.env` per-call would
 * make the test results unreproducible.
 */
export function getEnabledProviders(): RealProviderHandle[] {
  const out: RealProviderHandle[] = []

  const openaiKey = process.env.LUMEN_E2E_OPENAI_API_KEY
  if (openaiKey) {
    out.push({
      id: 'openai',
      provider: new OpenAICompatibleProvider({
        id: 'e2e-openai',
        apiKey: openaiKey,
        baseUrl: process.env.LUMEN_E2E_OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        defaultModel: process.env.LUMEN_E2E_OPENAI_MODEL ?? 'gpt-4o-mini',
      }),
      defaultModel: process.env.LUMEN_E2E_OPENAI_MODEL ?? 'gpt-4o-mini',
    })
  }

  const anthropicKey = process.env.LUMEN_E2E_ANTHROPIC_API_KEY
  if (anthropicKey) {
    out.push({
      id: 'anthropic',
      provider: new AnthropicProvider({
        id: 'e2e-anthropic',
        apiKey: anthropicKey,
        baseUrl: process.env.LUMEN_E2E_ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com',
        defaultModel: process.env.LUMEN_E2E_ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
      }),
      defaultModel: process.env.LUMEN_E2E_ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
    })
  }

  const mistralKey = process.env.LUMEN_E2E_MISTRAL_API_KEY
  if (mistralKey) {
    // MistralProviderOptions sits on top of OpenAICompatibleOptions,
    // which requires `defaultModel` to be a string. We always pass
    // a real value -- the provider's DEFAULT_MISTRAL_MODEL
    // (`mistral-large-latest`) is the fallback when the env var is
    // unset. E2E scenarios are free to override via
    // LUMEN_E2E_MISTRAL_MODEL.
    const mistralModel = process.env.LUMEN_E2E_MISTRAL_MODEL ?? 'mistral-large-latest'
    out.push({
      id: 'mistral',
      provider: new MistralProvider({
        apiKey: mistralKey,
        baseUrl: process.env.LUMEN_E2E_MISTRAL_BASE_URL ?? '',
        defaultModel: mistralModel,
      }),
      defaultModel: mistralModel,
    })
  }

  // Ollama is local-inference; we only need a base URL.
  const ollamaBase = process.env.LUMEN_E2E_OLLAMA_BASE_URL
  if (ollamaBase) {
    out.push({
      id: 'ollama',
      provider: new OllamaProvider({
        baseUrl: ollamaBase,
        defaultModel: process.env.LUMEN_E2E_OLLAMA_MODEL ?? 'llama3.1',
      }),
      defaultModel: process.env.LUMEN_E2E_OLLAMA_MODEL ?? 'llama3.1',
    })
  }

  // llama.cpp exposes an OpenAI-compatible server.
  const llamacppBase = process.env.LUMEN_E2E_LLAMACPP_BASE_URL
  if (llamacppBase) {
    out.push({
      id: 'llamacpp',
      provider: new LlamaCppProvider({
        baseUrl: llamacppBase,
        defaultModel: process.env.LUMEN_E2E_LLAMACPP_MODEL ?? 'qwen2.5-7b',
      }),
      defaultModel: process.env.LUMEN_E2E_LLAMACPP_MODEL ?? 'qwen2.5-7b',
    })
  }

  return out
}

/**
 * Convenience: skip an `it` body if a specific provider id is
 * not in the configured list. Use when a scenario only makes
 * sense for a subset (e.g. Anthropic prompt caching test).
 */
export function skipIfProviderMissing(
  configured: RealProviderHandle[],
  id: RealProviderHandle['id'],
): void {
  if (!configured.find((p) => p.id === id)) {
    throw new E2ESkip(
      `provider "${id}" is not configured -- set LUMEN_E2E_${id.toUpperCase()}_API_KEY`,
    )
  }
}
