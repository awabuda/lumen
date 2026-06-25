---
layout: home

hero:
  name: Lumen
  text: TypeScript-native agent runtime
  tagline: Build autonomous agents against OpenAI, Anthropic, Mistral, Ollama, and llama.cpp.
  actions:
    - theme: brand
      text: Get started
      link: /developer
    - theme: alt
      text: Architecture
      link: /architecture
    - theme: alt
      text: View on GitHub
      link: https://github.com/lumen/lumen

features:
  - title: Provider-agnostic
    details: One Agent API for OpenAI, Anthropic, Mistral, Ollama, and llama.cpp. Switch providers without rewriting your tools or your streaming code.
  - title: Typed tools
    details: Tools are Zod-validated. ToolRisk is a typed union. The agent loop is a deterministic state machine, not a string of "if/else on JSON shape" checks.
  - title: Pluggable memory
    details: In-memory store for tests, SqliteStore (FTS5 + WAL + sqlite-vec) for production. Same interface, same store contract.
  - title: MCP-native
    details: First-class Model Context Protocol client over stdio and Streamable HTTP. Bearer / custom-header auth. Session-id rotation.
  - title: Streaming-first
    details: agent.run for one-shot, agent.streamRun for token-by-token. Same event envelope, no second code path.
  - title: Real-model test harness
    details: LUMEN_E2E=1 exercises every provider on the wire. LUMEN_BENCH=1 reports p50/p95/max latency. Both default-skipped, so 'pnpm test' in CI stays green.
---

## What is Lumen?

Lumen is a TypeScript-native agent runtime — the missing layer between an LLM SDK and a production application. It packages the choices every agent project has to make (which provider, how to call tools, how to remember context, how to stream tokens, how to talk to MCP) behind one consistent surface.

It is built for engineers who want to ship agent features without becoming an agent-framework engineer.

## Read next

- The [architecture document](/architecture) explains the package layout, the agent loop state machine, and the provider adapter contract.
- The [security document](/security) covers the trust boundary between user prompts, tool execution, and provider egress.
- The [developer guide](/developer) walks you through adding a tool, swapping a provider, and writing your first real-model E2E test.
