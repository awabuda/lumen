/**
 * llama.cpp provider.
 *
 * llama.cpp ships an OpenAI-compatible HTTP server (`llama-server`).
 * The wire format is a strict subset of the OpenAI Chat Completions
 * API at `http://127.0.0.1:8080/v1` (the same endpoint shape OpenAI
 * uses, just on a different port and a different process).
 *
 * This file is a thin convenience wrapper over
 * {@link OpenAICompatibleProvider} — the whole implementation is
 * "set the default baseUrl and call super()". Inheriting is the right
 * move here because llama.cpp's protocol differences from OpenAI are
 * 100% in the endpoint/header layer, not in the response parsing;
 * {@link OpenAICompatibleProvider} already handles all of it.
 *
 * If you need llama.cpp's *non-OpenAI* endpoints (e.g. `/completion`
 * for raw prompt-completion, `/infill` for FIM, or the slot management
 * APIs at `/slots`), write a separate provider that talks to those
 * directly. This class sticks to the OpenAI surface because that is
 * what llama.cpp's `llama-server -m model.gguf` mode exposes.
 *
 * Defaults:
 *   - baseUrl: `http://127.0.0.1:8080/v1`
 *   - defaultModel: caller MUST supply — there is no sane default;
 *     llama.cpp loads whatever `.gguf` you started the server with,
 *     and the model id in the request must match the loaded model's
 *     template name. Use a value the operator has configured.
 *
 * Capabilities (as exposed by llama.cpp's server):
 *   - chat: true
 *   - streaming: true
 *   - tool_use: depends on the loaded model. Tools that produce JSON
 *     arguments will work for any model that has been instruction-
 *     tuned; otherwise the model hallucinates arguments. We default
 *     `toolUse: true` and let the operator override if they know the
 *     loaded model can't follow tool schemas.
 *   - embeddings: true (via `/v1/embeddings`, requires `--embedding`
 *     flag at server start).
 *   - vision: false. llama.cpp supports multimodal GGUF but the
 *     OpenAI-compatible server does not yet expose `image_url` parts.
 *   - promptCaching: false. llama.cpp has KV-cache reuse internally
 *     but no `cache_control` style API on the wire.
 *
 * Running the server the Lumen way:
 *
 *   llama-server \
 *     -m /path/to/model.gguf \
 *     --port 8080 \
 *     --host 127.0.0.1 \
 *     --embedding   # only if you want /v1/embeddings
 *
 * Then in Lumen:
 *
 *   const provider = new LlamaCppProvider({
 *     defaultModel: 'qwen2.5-7b-instruct',
 *     // baseUrl defaults to http://127.0.0.1:8080/v1
 *   })
 *
 * For a remote llama.cpp (e.g. across a Tailscale network), pass
 * `baseUrl` explicitly. For an apiKey-gated deployment, pass `apiKey`
 * and the provider will attach `Authorization: Bearer ***.
 */

import { type OpenAICompatibleOptions, OpenAICompatibleProvider } from './openai-compatible.js'

/** Default llama.cpp server base URL. */
const DEFAULT_BASE_URL = 'http://127.0.0.1:8080/v1'

/** Stable id reported via `BaseProvider.id`. */
const PROVIDER_ID = 'llama-cpp'

/** Options accepted by {@link LlamaCppProvider}. Mirrors OpenAI-compatible. */
export type LlamaCppOptions = Omit<OpenAICompatibleOptions, 'baseUrl'> & {
  /** Override the default base URL (`http://127.0.0.1:8080/v1`). */
  readonly baseUrl?: string
}

/**
 * llama.cpp `llama-server` provider.
 *
 * The implementation is the superclass — this subclass only sets the
 * default baseUrl, the stable id, and documents the operational
 * expectations (which model is loaded, whether `--embedding` was
 * passed, etc.).
 */
export class LlamaCppProvider extends OpenAICompatibleProvider {
  public constructor(options: LlamaCppOptions) {
    super({
      id: PROVIDER_ID,
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      ...options,
    })
  }
}

/** Factory mirroring the other providers' style. */
export const createLlamaCppProvider = (options: LlamaCppOptions): LlamaCppProvider =>
  new LlamaCppProvider(options)
