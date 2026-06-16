# Lumen — 自进化的 TypeScript Agent 框架

Lumen 是一个 monorepo 结构的 AI Agent 框架，支持 OpenAI / Anthropic / Ollama 等多种 LLM 后端。

## 快速开始

```bash
git clone https://github.com/awabuda/lumen.git
cd lumen
pnpm install
pnpm --filter @lumen/cli build
```

## 使用方式

```bash
# 检查环境
node apps/cli/dist/index.js doctor

# 单次执行
node apps/cli/dist/index.js run "列出当前目录的 .ts 文件"

# 交互式对话 (TUI)
node apps/cli/dist/index.js chat

# 查看已注册的工具
node apps/cli/dist/index.js tools list

# 查看模型列表
node apps/cli/dist/index.js model list

# 查看配置
node apps/cli/dist/index.js config show

# 会话管理
node apps/cli/dist/index.js session list

# 回放历史会话
node apps/cli/dist/index.js replay <session-id>
```

## 配置

默认配置文件: `~/.lumen/config.yaml`

```yaml
defaultModel: gpt-4o-mini
models:
  - id: openai
    provider: openai-compatible
    baseUrl: https://api.openai.com/v1
    apiKey: ${OPENAI_API_KEY}
    defaultModel: gpt-4o-mini
  - id: anthropic
    provider: anthropic
    apiKey: ${ANTHROPIC_API_KEY}
    defaultModel: claude-sonnet-4-20250514
  - id: ollama
    provider: ollama
    baseUrl: http://localhost:11434
    defaultModel: llama3

profiles:
  work:
    defaultModel: gpt-4o
  local:
    defaultModel: llama3
```

## 项目结构

```
lumen/
├── apps/cli/          # CLI 入口 (commander + Ink TUI)
├── packages/
│   ├── config/        # 配置加载、热重载、profile 切换
│   ├── core/          # Agent 引擎、消息类型、工具协议、Hook、Memory、Logger
│   ├── llm/           # LLM 适配器 (OpenAI / Anthropic / Ollama)
│   ├── tools/         # 内置工具 (文件系统、终端、Git、GitHub、元信息)
│   ├── memory/        # 记忆存储 (SQLite + FTS5 + 向量搜索)
│   ├── skills/        # 技能系统 (Markdown 技能解析、触发匹配)
│   └── mcp/           # MCP 客户端 (stdio + Streamable HTTP)
└── docs/              # 架构文档
```

## 技术栈

- TypeScript strict + noUncheckedIndexedAccess
- pnpm workspaces + turborepo
- Zod (运行时校验 + JSON Schema 生成)
- better-sqlite3 + FTS5 (全文搜索)
- sqlite-vec (可选，向量搜索)
- Ink + React (TUI)
- Commander (CLI 框架)
- Vitest (测试)

## 开发

```bash
pnpm install
pnpm -r typecheck    # 全量类型检查
pnpm -r test         # 全量测试 (887 tests, 81 test files, 11 packages)
pnpm -r build        # 全量构建
```

## License

MIT
