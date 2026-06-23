# Real-model E2E scenarios

These tests hit real LLM providers (OpenAI, Anthropic, Mistral, Ollama,
llama.cpp) over the wire. They are **skipped by default** — running
`pnpm --filter @lumen/cli test` in CI or in this repo never burns API
credits or hits a local inference server.

## Enabling

Set `LUMEN_E2E=1` in your shell. Then provide keys/URLs for whichever
providers you want to exercise. The helpers in `helpers.ts` will
auto-detect which providers are configured; each scenario runs once
per configured provider.

```bash
# Cheapest viable setup (one cloud provider + one local).
export LUMEN_E2E=1
export LUMEN_E2E_OPENAI_API_KEY=sk-...
# Optional overrides:
#   export LUMEN_E2E_OPENAI_MODEL=gpt-4o-mini   # default
#   export LUMEN_E2E_OPENAI_BASE_URL=https://api.openai.com/v1

# Anthropic:
export LUMEN_E2E_ANTHROPIC_API_KEY=sk-ant-...
#   export LUMEN_E2E_ANTHROPIC_MODEL=claude-haiku-4-5   # default

# Mistral:
export LUMEN_E2E_MISTRAL_API_KEY=...
#   export LUMEN_E2E_MISTRAL_MODEL=mistral-small-latest # default

# Ollama (local, no key required):
export LUMEN_E2E_OLLAMA_BASE_URL=http://127.0.0.1:11434
#   export LUMEN_E2E_OLLAMA_MODEL=llama3.1              # default

# llama.cpp (local OpenAI-compatible server):
export LUMEN_E2E_LLAMACPP_BASE_URL=http://127.0.0.1:8080/v1
#   export LUMEN_E2E_LLAMACPP_MODEL=qwen2.5-7b          # default
```

Then run:

```bash
pnpm --filter @lumen/cli test -- test/real-model
```

## What's covered

| # | Scenario | What it exercises |
|---|----------|-------------------|
| 01 | `01-basic-chat.test.ts` | One-shot chat round-trip. Canary. |
| 02 | `02-tool-calling.test.ts` | Model calls a real tool, gets the result, answers. |
| 03 | `03-multi-step.test.ts` | Two tool calls in sequence (lookup → compute). |
| 04 | `04-streaming.test.ts`   | `agent.streamRun()` yields `text:delta` events. |
| 05 | `05-memory-persistence.test.ts` | SqliteStore writes, fresh store reads. |

## Cost discipline

- Every scenario uses the cheapest viable model by default
  (`gpt-4o-mini`, `claude-haiku-4-5`, `mistral-small-latest`,
  `llama3.1` for Ollama, `qwen2.5-7b` for llama.cpp).
- Scenario 05 writes a 1-message conversation; the other
  scenarios stay under 1k tokens.
- A full pass with the four cloud providers (each running all
  five scenarios) typically costs < $0.05 USD.

## When a scenario fails

1. Check the model is reachable (curl the base URL).
2. Check the model id is correct (typos are the #1 cause).
3. Tool-calling scenarios need a model with tool support.
   Older Ollama models (llama3.1 base, mistral 7b v0.1) do
   not support tool calls — set `LUMEN_E2E_OLLAMA_MODEL` to
   a tool-capable variant (llama3.3, qwen2.5, gpt-oss) to
   enable them.
4. If only Anthropic or only OpenAI is set up, the
   `E2ESkip` for the missing provider will surface with a
   clear "no providers configured" message; that is
   **expected**, not a failure.
