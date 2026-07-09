/**
 * A tiny fake provider for CLI-side tests.
 *
 * This is a *deliberately small* re-implementation of the
 * helper that lives at `packages/core/test/fake-provider.ts`.
 * We do not share that file across packages because:
 *   - it is a test-only utility (lives under `test/`)
 *   - cross-package test imports would couple the cli
 *     package to the internals of the core package
 *   - the only behaviour this fake needs is "return a
 *     scripted assistant message per call" — no streaming,
 *     no tool dispatch, no embeddings. The core fake is
 *     much richer because core tests need it.
 *
 * If a future CLI test needs richer fake behaviour, prefer
 * extending *this* file (adding methods, supporting
 * streaming) over importing from `packages/core/test/`.
 */
import type { ChatRequest, ChatResponse, ProviderCapabilities, StreamOptions } from '@lumen/core'
import { BaseProvider } from '@lumen/core'
import type { AssistantMessage } from '@lumen/core'

export interface ScriptedStep {
  /** The assistant message the provider returns for this step. */
  readonly message: AssistantMessage
}

export class FakeProvider extends BaseProvider {
  public readonly id = 'cli-fake'
  public readonly capabilities: ProviderCapabilities = {
    streaming: false,
    embeddings: false,
    toolUse: true,
    vision: false,
    reasoning: false,
    promptCaching: false,
    structuredOutput: false,
    maxContextTokens: 8000,
  }
  public readonly calls: ChatRequest[] = []
  private readonly script: ScriptedStep[]
  private callIndex = 0

  public constructor(script: ScriptedStep[]) {
    super()
    this.script = script
  }

  public override async chat(
    _request: ChatRequest,
    _options?: StreamOptions,
  ): Promise<ChatResponse> {
    this.calls.push({ ..._request, messages: [..._request.messages] })
    const step = this.script[this.callIndex]
    if (!step) {
      throw new Error(`FakeProvider: script exhausted at call ${this.callIndex}`)
    }
    this.callIndex += 1
    return { message: step.message, latencyMs: 0 }
  }
}
