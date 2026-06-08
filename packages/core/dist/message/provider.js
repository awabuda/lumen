/**
 * Provider contract — every LLM backend implements this.
 *
 * The contract is intentionally small (3 methods). Provider-specific quirks
 * (prompt caching, reasoning mode, tool choice forcing) are expressed via
 * {@link ProviderCapabilities} and the `providerOptions` field on
 * {@link ChatRequest}.
 *
 * Why an abstract class, not an interface:
 *   - We get free `instanceof` checks.
 *   - Subclasses can override ONE method (e.g. `chat` only) and inherit
 *     sensible defaults for the others.
 *   - Default implementations can throw "not supported", making it obvious
 *     which providers are embed-only, chat-only, or full.
 */
/**
 * Abstract base for all LLM providers.
 *
 * Lifecycle: subclass sets `id`, `capabilities`; optionally overrides
 * `chat`, `stream`, `embed`. The base provides:
 *   - Identity (id)
 *   - Default `stream` that wraps `chat` (for providers without native streaming)
 *   - Default `embed` that throws (for chat-only providers)
 *   - `validateRequest()` that subclasses can override for early validation
 */
export class BaseProvider {
    /**
     * Stream a chat response. Default implementation calls `chat` and
     * synthesizes stream events — providers SHOULD override for token-by-token
     * streaming.
     */
    async *stream(request, options) {
        const start = {
            role: 'assistant',
            content: '',
            toolCalls: [],
        };
        yield { type: 'message_start', message: start };
        try {
            const response = await this.chat(request, options);
            const text = response.message.content ?? '';
            // Synthesize a content_delta for the whole text. Subclasses that
            // support real streaming should NOT use this default.
            if (text.length > 0) {
                yield { type: 'content_delta', delta: text };
            }
            for (const tc of response.message.toolCalls) {
                yield { type: 'tool_call_complete', toolCall: tc };
            }
            yield { type: 'message_complete', message: response.message };
        }
        catch (err) {
            yield { type: 'error', error: err instanceof Error ? err : new Error(String(err)) };
        }
    }
    /**
     * Generate embeddings. Default throws — override in providers that
     * support it (and set `capabilities.embeddings = true`).
     */
    async embed(_request, _options) {
        throw new Error(`Provider ${this.id} does not support embeddings`);
    }
    /**
     * Hook for subclasses to validate a request before sending. The base
     * implementation is a no-op.
     */
    validateRequest(_request) {
        // intentionally empty
    }
}
//# sourceMappingURL=provider.js.map