/**
 * Wires {@link runProviderContractTests} against every
 * concrete provider shipped by `@lumen/llm`. The wrapper is
 * its own file so the per-provider test files (which focus on
 * wire-format / streaming / tool-use details) stay focused.
 *
 * If you add a new provider, add another `runXxxContractTests`
 * block here — no other change is required.
 */

import {
  AnthropicProvider,
  createAnthropicProvider,
  createOllamaProvider,
  createOpenAIProvider,
  OllamaProvider,
  OpenAICompatibleProvider,
} from '../src/index.js'
import { runProviderContractTests } from './contract-suite.js'

runProviderContractTests(
  'OpenAICompatibleProvider',
  () =>
    new OpenAICompatibleProvider({
      id: 'openai',
      apiKey: 'sk-test',
      baseUrl: 'https://example.invalid/v1',
      defaultModel: 'gpt-test',
    }),
)

runProviderContractTests(
  'AnthropicProvider',
  () =>
    new AnthropicProvider({
      apiKey: 'sk-ant-test',
      baseUrl: 'https://example.invalid',
      defaultModel: 'claude-test',
    }),
)

runProviderContractTests(
  'OllamaProvider',
  () =>
    new OllamaProvider({
      defaultModel: 'llama-test',
    }),
)

runProviderContractTests('createOpenAIProvider()', () =>
  createOpenAIProvider({ apiKey: 'sk-test', defaultModel: 'gpt-test' }),
)
runProviderContractTests('createAnthropicProvider()', () =>
  createAnthropicProvider({
    apiKey: 'sk-ant-test',
    baseUrl: 'https://example.invalid',
    defaultModel: 'claude-test',
  }),
)
runProviderContractTests('createOllamaProvider()', () =>
  createOllamaProvider({ defaultModel: 'llama-test' }),
)
