# Lumen Project Task Board

> **Source of truth for project state.** This file is updated as subagents
> complete work and the orchestrator reviews it. The numbering matches the
> architecture doc's modules (A-M). Sub-tasks under each ID are the units
> subagents can be assigned to.

Legend: `[ ]` pending · `[~]` in progress · `[x]` done · `[!]` blocked

---

## P0 — MVP & Skeleton (target: 2-3 days)

### A. Engineering infra
- [x] A1.1 pnpm workspace configured
- [x] A1.2 turbo pipeline configured
- [x] A1.3 TypeScript strict + noUncheckedIndexedAccess base
- [x] A1.4 biome configured
- [x] A1.5 changesets configured
- [x] A1.6 .nvmrc + engines locked
- [x] A1.7 README + docs/ARCHITECTURE.md
- [x] A1.8 .gitignore

### B. Core engine
- [ ] B1.x — Message types, context, serialization
- [ ] B2.x — Main agent loop, hooks, budget, interrupt
- [ ] B3.x — Hook system
- [ ] B4.x — Tool protocol
- [ ] B5.x — `packages/core` package (base.ts, agent.ts, message.ts, hooks.ts)

### C. LLM adapter
- [ ] C1.x — Provider abstraction (`packages/llm/src/base.ts`)
- [ ] C2.x — OpenAI-compatible concrete provider
- [ ] C3.x — Anthropic concrete provider
- [ ] C4.x — Ollama/local provider
- [ ] C5.x — `packages/llm` package

### D. Tools
- [ ] D1.x — BaseTool contract (`packages/tools/src/base.ts`)
- [ ] D2.x — ToolRegistry
- [ ] D3.x — read_file, write_file, patch implementations
- [ ] D4.x — terminal, terminal_background
- [ ] D5.x — git_status, git_diff
- [ ] D6.x — `packages/tools` package

### I. CLI
- [ ] I1.x — commander skeleton
- [ ] I2.x — `lumen chat` command
- [ ] I3.x — `apps/cli` package

### H. Config
- [x] H1.1 — `@lumen/config` package (schema, loader, errors, define)
- [x] H1.2 — Tests for loader
- [ ] H1.3 — Hot-reload support
- [ ] H1.4 — Profile switching

---

## P1 — Tool completeness (target: weeks 2-3)

### D. Tools (continued)
- [ ] D7.x — list_dir, search_files, file_info
- [ ] D8.x — web_search, web_fetch
- [ ] D9.x — gh CLI bridge for PR creation
- [ ] D10.x — Time / env tools
- [ ] D11.x — Toolset grouping + lazy loading
- [ ] D12.x — Sandboxing (Docker)

### E. Memory
- [ ] E1.x — `packages/memory` base contract
- [ ] E2.x — SQLite session store
- [ ] E3.x — FTS5 indexing
- [ ] E4.x — sqlite-vec vector store
- [ ] E5.x — Working memory
- [ ] E6.x — Cross-session retrieval

### I. CLI (continued)
- [ ] I4.x — TUI with Ink
- [ ] I5.x — `lumen` (default TUI command)
- [ ] I6.x — `lumen model`, `lumen config`, `lumen tools`
- [ ] I7.x — `lumen session`, `lumen doctor`, `lumen update`

### L. Testing
- [ ] L1.x — Vitest configured in all packages
- [ ] L2.x — Contract tests for every base
- [ ] L3.x — Integration test: agent loop end-to-end

---

## P2 — Polish (target: weeks 4-6)

### F. Skills
- [ ] F1.x — Skill base contract
- [ ] F2.x — SKILL.md parser
- [ ] F3.x — Triggering (embedding + LLM decide)
- [ ] F4.x — Auto-evolution
- [ ] F5.x — Self-creation from trajectory

### G. MCP
- [ ] G1.x — JSON-RPC framing (stdio)
- [ ] G2.x — JSON-RPC framing (http+sse)
- [ ] G3.x — MCP client
- [ ] G4.x — MCP tool proxy into ToolRegistry

### E. Memory (continued)
- [ ] E7.x — Long-term profile
- [ ] E8.x — Reflection + fact extraction
- [ ] E9.x — Conflict detection

### H. Config (continued)
- [ ] H2.x — pino structured logging
- [ ] H3.x — Telemetry
- [ ] H4.x — `lumen doctor`, `lumen replay`

### L. Testing (continued)
- [ ] L4.x — Snapshot tests for TUI
- [ ] L5.x — Real-scenario scripts

---

## P3 — Advanced (ongoing)

### J. Multi-surface
- [ ] J1.x — Web dashboard (Next.js)
- [ ] J2.x — Desktop (Tauri)
- [ ] J3.x — VSCode extension
- [ ] J4.x — JetBrains plugin

### K. Advanced capabilities
- [ ] K1.x — Subagent delegation
- [ ] K2.x — Cron scheduler
- [ ] K3.x — Plan/act mode
- [ ] K4.x — Multi-user collaboration

### M. Docs & release
- [ ] M1.x — User docs (zh + en)
- [ ] M2.x — Developer docs
- [ ] M3.x — npm + binary + Docker + Homebrew
- [ ] M4.x — Security audit

---

## Review log

| Date | Unit | Reviewer | Result |
|---|---|---|---|
| 2026-06-08 | H1.1 H1.2 @lumen/config | orchestrator | ✅ typecheck + 3 tests pass |

