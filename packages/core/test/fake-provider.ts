/**
 * A fake provider for testing the agent loop. Records calls and returns
 * pre-canned responses. Lives in test/ so it doesn't ship.
 */
import type { ChatRequest, ChatResponse, ProviderCapabilities } from '../src/message/provider.js'
import { BaseProvider } from '../src/message/provider.js'
import type { AssistantMessage, StreamEvent, StreamOptions } from '../src/message/index.js'

export interface ScriptedStep {
  /** What the assistant should return at this step. */
  readonly message: AssistantMessage
  /** Optional delay in ms (defaults to 0). */
  readonly delayMs?: number
}

/** A scripted provider: replays a pre-canned sequence of responses. */
export class FakeProvider extends BaseProvider {
  public readonly id = 'fake'
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

  constructor(script: ScriptedStep[]) {
    super()
    this.script = script
  }

  public override async chat(
    _request: ChatRequest,
    _options?: StreamOptions,
  ): Promise<ChatResponse> {
    // Clone the request so the stored copy doesn't mutate when the
    // agent loop appends more messages after this call returns.
    this.calls.push({
      ..._request,
      messages: [..._request.messages],
    })
    const step = this.script[this.callIndex]
    if (!step) {
      throw new Error(`FakeProvider: script exhausted at call ${this.callIndex}`)
    }
    this.callIndex += 1
    if (step.delayMs) {
      await new Promise((r) => setTimeout(r, step.delayMs))
    }
    return { message: step.message, latencyMs: step.delayMs ?? 0 }
  }

  public override async *stream(
    _request: ChatRequest,
    _options?: StreamOptions,
  ): AsyncGenerator<StreamEvent, void, void> {
    const response = await this.chat(_request, _options)
    yield { type: 'message_start', message: { role: 'assistant', content: '', toolCalls: [] } }
    if (response.message.content) {
      yield { type: 'content_delta', delta: response.message.content }
    }
    for (const tc of response.message.toolCalls) {
      yield { type: 'tool_call_complete', toolCall: tc }
    }
    yield { type: 'message_complete', message: response.message }
  }
}
