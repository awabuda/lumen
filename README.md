# Lumen

> A self-improving TypeScript agent framework with first-class extensibility.

Lumen is an AI agent runtime and developer toolkit. It lets you build, run, and evolve
LLM-powered agents that can call tools, manage memory, expose skills, and talk to MCP
servers — all written in modern TypeScript.

## Why Lumen

- **Self-improving** — agents learn from their own trajectories and crystallize reusable skills.
- **Pluggable everywhere** — providers, tools, memory backends, skills, MCP servers are all
  loadable extensions. Nothing is hard-wired.
- **Inheritable abstractions** — every core type extends a base contract, so you can subclass
  and customize at exactly the seam you need.
- **Standalone packages** — each package in `packages/` can be installed and used on its own.
  `lumen/llm` works without `lumen/core` if all you need is a model client.

## Quick start

```bash
pnpm install
pnpm dev
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full module dependency graph,
extension points, and design philosophy.

## Packages

| Package | Purpose |
|---|---|
| `@lumen/core` | Agent runtime, message loop, hooks |
| `@lumen/llm` | Multi-provider model client |
| `@lumen/tools` | Built-in tool implementations |
| `@lumen/memory` | Session, working, and long-term memory |
| `@lumen/skills` | Skill engine (load, invoke, evolve) |
| `@lumen/mcp` | Model Context Protocol client |
| `@lumen/config` | Layered configuration |
| `@lumen/cli` | CLI + TUI entry point |

## License

MIT
