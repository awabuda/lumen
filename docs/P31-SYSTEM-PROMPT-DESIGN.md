/**
 * P31 设计锁定 — system prompt 分层 + cache boundary
 *
 * > **纯设计 pass。** P31 把 system prompt 表面从单条 4 行字符串
 * > (`packages/core/src/agent/index.ts:208-211`) 升级为
 * > 7 stable section + 1 dynamic section 的分层结构,
 * > 并采用显式 cache boundary marker,直接对齐 OpenClaw 主分支
 * > 的设计 (`<!-- OPENCLAW_CACHE_BOUNDARY -->`,见
 * > `packages/ai/src/utils/system-prompt-cache-boundary.ts:8`),
 * > 同时保留 Hermes 的 per-session byte-stable 不变量
 * > (`agent/conversation_loop.py:996-1004`)。
 *
 * ## 0. 为什么是 P31
 *
 * ### 0.1 来源
 *
 * 2026-07-29 审计(§D 测试失败 + §GAP-2 model fallback)暴露了
 * system prompt 当前只是一条 4 行字符串,既没有分层,
 * 也没有 cache_control 意识。Anthropic provider 本身已经
 * 内置了结构化 block 的 primitive
 * (`packages/llm/src/anthropic.ts:198-219`,
 * `AnthropicSystemBlock` + `cache_control: {type: 'ephemeral'}`),
 * 还内置了给 power user 用的
 * `resolveSystemBlocks(providerOptions.anthropicSystemBlocks)`
 * (anthropic.ts:788-802),但 `Agent.run` 路径 (index.ts:505)
 * 只是把 `this.systemPrompt` 直接塞进单条 message —
 * 默认调用路径根本走不到 `resolveSystemBlocks`。
 * 这个 primitive 完全闲置。
 *
 * 2026-07-29 审计同时指出,用户既是使用者又是开发者:
 * 当他们加一个新 feature (P30+) 想验证 agent loop 行为时,
 * 默认的 `lumen run` system prompt 太薄,无法演示新 feature。
 * P31 把 system prompt 做得足够丰富,使得同一个
 * `lumen run "<test prompt>"` 调用就能跑通 identity / tools /
 * skills / project context / dynamic state 这套组合 —
 * 开发者不需要每个 feature 单独记一个 `--system-prompt` flag。
 *
 * ### 0.2 四框架 fetch 验证 (2026-07-29)
 *
 * | 框架 | 已验证源码 | 对 P31 的关键启示 |
 * | --- | --- | --- |
 * | **Hermes Agent** | `~/.hermes/hermes-agent/agent/conversation_loop.py:980-1004` + `agent_init.py:295-411,636-638,1325` + `chat_completion_helpers.py:1495-1505` | Per-session byte-stable `_cached_system_prompt` + `ephemeral_system_prompt` 在 API 调用时拼接。**没有**显式 cache boundary marker,依赖 Anthropic 在 byte-stable prefix 上的自动 cache。System prompt 进 API 时是单条 string。 |
 * | **OpenClaw** | `/Users/chengpengtao/workspace/openclaw-main/packages/ai/src/utils/system-prompt-cache-boundary.ts:8-65` + `src/agents/system-prompt.ts:74-87,145-168,1079-1297` + `packages/ai/src/providers/anthropic.ts:1548-1603` + `src/agents/sessions/resource-loader.ts:72-89` | 显式 `<!-- OPENCLAW_CACHE_BOUNDARY -->` marker 切成 stable prefix(打 `cache_control`) + dynamic suffix(不打)。Anthropic provider 的 `buildAnthropicSystemBlocks` 完成 split + `cache_control` 注入。4 个 provider(Anthropic / OpenAI / Mistral / Google)共享同一份 systemPrompt string 协议。LRU 64 stable-prefix cache 以 SHA-256 input hash 为 key。 |
 * | **LangChain 1.0** | (复用 P23 §0.3 — LangChain 没有 marker 协议;`SystemMessage` 是单条 string) | 确认 marker-based split 是 OpenClaw 的独有发明,不是行业惯例。lumen P31 选择跟随 OpenClaw 是有立场的取舍。 |
 * | **Claude Code** | (复用 P27 §0.2) | 把 `CLAUDE.md` 作为项目级文件,但**没有** cache boundary marker。再次印证 marker 是 OpenClaw 独有。 |
 *
 * **综合判断**:OpenClaw 的 marker 协议是唯一已验证的上游设计,
 * 在 system-prompt 层显式暴露 stable/dynamic 切分(Hermes 是
 * 隐式的;LangChain / Claude Code 是 monolith)。P31 把 marker
 * 移植到 lumen 下,用 `LUMEN_CACHE_BOUNDARY` 前缀(保持 lumen
 * namespace 规则,CLAUDE.md rule #1),并把 Hermes 的 per-session
 * cache 提升为 lumen 内部的 `_cachedSystemPrompt` 实例字段。
 *
 * ### 0.3 六问审计 (post-P30.B2)
 *
 * | # | 问题 | P31 前现状 | P31 后目标 |
 * | --- | --- | --- | --- |
 * | 1 | system prompt 分层 | 单条 4 行字符串 | 8 stable section + 1 dynamic (HEARTBEAT.md),显式 cache boundary |
 * | 2 | cache_control 已 wire up | primitive 在 `anthropic.ts` 闲置 | `buildRequestBody` 主路径走 marker-aware splitter |
 * | 3 | context 文件(AGENTS / SOUL / USER / IDENTITY / TOOLS / BOOTSTRAP / MEMORY / HEARTBEAT) | 未加载 | walk-up 到 git root + 大小写不敏感候选优先级;7 stable + HEARTBEAT dynamic |
 * | 4 | tool registry 渲染 | `ToolRegistry` schemas 只走 `request.tools`,不进 system prompt | L8 runtime block 同时携带 `ToolRegistry` schema dump 和 L5 TOOLS.md 的使用引导(职责分离) |
 * | 4b | skill 描述进入 system | `SkillTriggerMiddleware` P20.6 注入 system prompt — 部分实现 | L8 runtime block 也携带 active-skill 索引(紧邻 `ToolRegistry` dump);完整 skill 内容仍 lazy 通过 `skill_view` 加载 |
 * | 5 | session 级 cache | 无 | `_cachedSystemPrompt` 实例字段 + LRU 64 跨 session |
 * | 6 | 每轮 dynamic 内容 | 通过 `+ "\n\n" + ephemeral` 拼进 system prompt(Hermes 模式) | 在 marker 处切分,dynamic suffix 绕过 `cache_control` |
 *
 * ## 1. 架构决策(本 pass 锁定)
 *
 * ### 1.1 单 string + cache boundary marker(OpenClaw 模式)
 *
 * - **范围**:`packages/core/src/agent/system-prompt.ts`
 *   通过 7 stable section builder + 1 dynamic section builder
 *   构建**单条**字符串。stable 之间用 `\n\n` 拼接,
 *   stable 与 dynamic 之间用 `<!-- LUMEN_CACHE_BOUNDARY -->`
 *   隔开。
 * - **为什么不是给 provider 一个 typed `SystemLayer[]`**:理由
 *   与 OpenClaw 一致 — Anthropic provider 在 wire-format 层
 *   自己切分,OpenAI / Mistral / Google 反正只接受单 string。
 *   lumen 保留 `providerOptions.anthropicSystemBlocks`
 *   作为 power-user 逃生通道(已经在
 *   `anthropic.ts:788-802`)。
 *
 * ### 1.2 8 stable section + 1 dynamic(对齐 OpenClaw `CONTEXT_FILE_ORDER`)
 *
 * 根据用户 2026-07-29 的指示:保留 agent 生态中已有的
 * 规范 context 文件名 — `SOUL.md`、`USER.md`、`AGENTS.md`、
 * `IDENTITY.md`、`HEARTBEAT.md` — 并补齐 `TOOLS.md`、
 * `BOOTSTRAP.md`、`MEMORY.md`,以完整对齐 OpenClaw 的
 * 7 文件优先级。lumen P31 从 `<cwd>/` 加载全部 7 stable 文件
 * (其中 `SOUL.md` / `IDENTITY.md` / `USER.md` 等个人文件
 * 走 `~/.lumen/` fallback),HEARTBEAT.md 走 dynamic。
 *
 * | # | Section | Cache zone | Source |
 * | --- | --- | --- | --- |
 * | L1 | **project** (AGENTS.md) | stable | `<cwd>/AGENTS.md` 或 `<cwd>/CLAUDE.md`(大小写不敏感,walk-up 到 git root);对齐 OpenClaw `resource-loader.ts:72-89` |
 * | L2 | **soul** (SOUL.md) | stable | `<cwd>/SOUL.md` 优先,fallback `~/.lumen/SOUL.md`;persona/tone |
 * | L3 | **identity** (IDENTITY.md) | stable | `<cwd>/IDENTITY.md` 优先,fallback `~/.lumen/IDENTITY.md`;built-in 之外的身份定义 |
 * | L4 | **user** (USER.md) | stable | `<cwd>/USER.md` 优先,fallback `~/.lumen/USER.md`;用户偏好 / profile |
 * | L5 | **tools** (TOOLS.md) | stable | `<cwd>/TOOLS.md` 优先,fallback `~/.lumen/TOOLS.md`;工具使用引导(与 L8 中 `ToolRegistry` schema dump 职责分离) |
 * | L6 | **bootstrap** (BOOTSTRAP.md) | stable | `<cwd>/BOOTSTRAP.md` 优先,fallback `~/.lumen/BOOTSTRAP.md`;首轮回复规则("follow before normal reply") |
 * | L7 | **memory** (MEMORY.md) | stable | `<cwd>/MEMORY.md` 优先,fallback `~/.lumen/MEMORY.md`;长期记忆快照(与会话内 recall 分离) |
 * | L8 | **runtime** | stable | cwd、git status 快照、sandbox 信息、model + provider 名、`ToolRegistry` schema dump(首轮时冻结) |
 * | **D1** | **heartbeat** (HEARTBEAT.md) | **dynamic** | `<cwd>/HEARTBEAT.md` 优先,fallback `~/.lumen/HEARTBEAT.md`;另加 session_id、当前时间、ephemeral 提示 — 按定义在 cache boundary 之下 |
 *
 * Section 顺序与 OpenClaw `CONTEXT_FILE_ORDER`
 * (`system-prompt.ts:74-87`)一致,**L8 runtime 等价于
 * OpenClaw 的 tools-metadata + bootstrap-info 合并**
 * (lumen 的 runtime block 携带 cwd / git / sandbox / model —
 * 与 OpenClaw "Bootstrap pending" 几行的角色相同,见
 * `system-prompt.ts:340-353`)。HEARTBEAT.md 映射到 OpenClaw
 * 的 dynamic 文件
 * (`DYNAMIC_CONTEXT_FILE_BASENAMES = new Set(["heartbeat.md"])`,
 * `system-prompt.ts:84`)。
 *
 * **按文件查找规则**(P31 新增,OpenClaw 没有):
 * L2 / L3 / L4 / L5 / L6 / L7 的查找顺序是
 * `<cwd>/<file>` 优先,fallback `~/.lumen/<file>`。
 * Fallback 存在是因为部分用户把 persona / identity / preferences
 * 这类个人文件放在 `~/.lumen/`(lumen HOME 目录)而不是
 * 项目内。L1 (AGENTS.md) 的项目文件查找走 walk-up 到
 * git root(没有 `~/.lumen/` fallback — AGENTS.md 按定义是
 * per-project)。
 *
 * **跨 section 去重**:如果 `<cwd>/SOUL.md` 已经把 agent
 * 身份也编码进去了,操作者可以把 L3 (`IDENTITY.md`) 留空,
 * builder 直接跳过空 section(不输出空 heading)。
 * OpenClaw 的 `buildProjectContextSection` 也是同样的
 * 空数组跳过逻辑,见 `system-prompt.ts:228-232`。
 *
 * ### 1.3 cache boundary 放置
 *
 * - Stable sections L1–L8 用 `\n\n` 拼接。
 * - L8 (runtime) 是最后一个 stable section;boundary marker
 *   跟在它后面。
 * - D1 (HEARTBEAT.md + dynamic) 追加在 marker 之后,
 *   多段 dynamic 内容之间用 `\n\n` 拼接。
 * - D1 为空时,`ensureSystemPromptCacheBoundary` 仍然
 *   追加 marker,这样后续 hook 注入
 *   (`prependSystemPromptAdditionAfterCacheBoundary`)
 *   会路由到 dynamic suffix,**而不是** stable prefix。
 *   这就是 OpenClaw 的不变量
 *   (`system-prompt-cache-boundary.ts:19-24`)。
 *
 * ### 1.4 Per-session `_cachedSystemPrompt`(Hermes 模式)
 *
 * - `Agent` 实例持有 `private cachedSystemPrompt?: string`。
 * - 首轮:`cachedSystemPrompt = await buildSystemPrompt(ctx)`。
 * - 后续轮:如果 `SectionContext` 输入哈希匹配 build 哈希,
 *   复用 `cachedSystemPrompt`;只在输入变化时(工具注册
 *   增量、skill 集增量、项目文件 mtime 等)rebuild。
 * - 是否跨 session resume 持久化?**否** — `_cachedSystemPrompt`
 *   只在内存里。持久化的 session DB 仅存储构建好的字符串,
 *   用于诊断回放(P20.4),resume 时重建而非逐字恢复
 *   (这跟 Hermes `_session_db.update_system_prompt`
 *   在 `conversation_loop.py:423` 的行为不同;
 *   lumen 选择重建,因为 `SectionContext` 包含 runtime /
 *   skill / tool 状态,这些在重启后可能已变)。
 *
 * ### 1.5 跨 session LRU stable-prefix cache(OpenClaw 模式)
 *
 * - 64-entry LRU,key 是 `JSON.stringify(ctxSummary)` 的 SHA-256。
 * - `ctxSummary` = `SectionContext` 中**只影响 STABLE prefix**
 *   的子集(cwd、tool list、skill list、项目文件路径 + mtime、
 *   model 标识)。
 * - Dynamic section **永不**缓存 — 每轮重新计算。
 * - 64-entry 上限沿用 OpenClaw 默认值
 *   (`SYSTEM_PROMPT_STABLE_PREFIX_CACHE_LIMIT = 64`,
 *   `system-prompt.ts:87`);lumen 直接照搬。
 *
 * ## 2. 文件清单
 *
 * | 路径 | 用途 | 状态 |
 * | --- | --- | --- |
 * | `packages/core/src/agent/system-prompt-boundary.ts` | `SYSTEM_PROMPT_CACHE_BOUNDARY` 常量 + `split` / `strip` / `ensure` / `prepend` / `sanitizeSurrogates` | NEW (P31.1) |
 * | `packages/core/src/agent/system-prompt-sections.ts` | 8 section builders + `buildSystemPrompt(ctx)` aggregator | NEW (P31.2) |
 * | `packages/core/src/agent/system-prompt-context-files.ts` | `loadContextFiles(cwd, lumenHome)` 扫描 `<cwd>` 找 8 个 OpenClaw context 文件;`~/.lumen/` fallback 个人文件(SOUL / IDENTITY / USER / TOOLS / BOOTSTRAP / MEMORY) | NEW (P31.3a) |
 * | `packages/core/src/agent/system-prompt-project.ts` | `loadProjectContextFile(cwd)` walk-up 到 git root + 大小写不敏感 AGENTS.md / CLAUDE.md 候选优先级(L1 子加载器) | NEW (P31.3b) |
 * | `packages/core/src/agent/system-prompt-cache.ts` | `cacheStablePromptPrefix` LRU + `hashStablePromptInput` SHA-256 | NEW (P31.4) |
 * | `packages/llm/src/anthropic.ts` | `buildAnthropicSystemBlocksFromString` marker-aware splitter;现有 `resolveSystemBlocks(providerOptions.anthropicSystemBlocks)` 保留为逃生通道 | MODIFIED (P31.5) |
 * | `packages/core/src/agent/index.ts` | `Agent` 增加 `cachedSystemPrompt: string \| undefined` + `buildAndCacheSystemPrompt(ctx)` 方法 | MODIFIED (P31.6) |
 * | `apps/cli/src/composition.ts` | `buildAgent` 构造 `SectionContext` 并调用 `buildSystemPrompt`;新增 `--no-cache-boundary` flag 用于降级 | MODIFIED (P31.6) |
 * | `apps/cli/src/commands/init.ts` | `--with-claude-md` flag 写出 `<cwd>/CLAUDE.md` 模板 | MODIFIED (P31.7) |
 * | `packages/core/test/system-prompt-boundary.test.ts` | 8 个测试,对齐 OpenClaw `system-prompt-cache-boundary.test.ts` | NEW (P31.1) |
 * | `packages/core/test/system-prompt-sections.test.ts` | 8 个 section builder × 每个 3-5 个测试 | NEW (P31.2) |
 * | `packages/core/test/system-prompt-context-files.test.ts` | 6 个测试(cwd 优先 / `~/.lumen/` fallback / HEARTBEAT 路由到 dynamic / 截断 / 空跳过) | NEW (P31.3a) |
 * | `packages/core/test/system-prompt-project.test.ts` | 5 个测试(大小写不敏感 / walk-up / git-root 检测) | NEW (P31.3b) |
 * | `packages/core/test/system-prompt-cache.test.ts` | LRU eviction + 哈希确定性 | NEW (P31.4) |
 * | `packages/llm/test/anthropic-marker.test.ts` | 4 个测试(marker × cacheControl 矩阵) | NEW (P31.5) |
 *
 * ## 3. Commit 分解
 *
 * | # | Commit | 文件 | LoC 估计 | 验证 |
 * | --- | --- | --- | --- | --- |
 * | **P31.0** | `docs: P31 system prompt layering design lock` | `docs/P31-SYSTEM-PROMPT-DESIGN.md`(本文) | +260 | 文档 review |
 * | **P31.1** | `feat(core): system prompt cache boundary primitive` | `system-prompt-boundary.ts` + test | +150 / +150 | `pnpm --filter @lumen/core test` |
 * | **P31.2** | `feat(core): 7 section builders + aggregator` | `system-prompt-sections.ts` + test | +250 / +300 | 同上 |
 * | **P31.3** | `feat(core): 8 OpenClaw context-file loaders (cwd + `~/.lumen/` fallback)` | `system-prompt-context-files.ts` + test | +150 / +200 | 同上 + real cwd |
 * | **P31.4** | `feat(core): AGENTS.md / CLAUDE.md project context loader (sub-loader for L1)` | `system-prompt-project.ts` + test | +100 / +120 | 同上 + real cwd + real git repo |
 * | **P31.5** | `feat(core): LRU stable prefix cache + SHA-256 input hash` | `system-prompt-cache.ts` + test | +50 / +80 | 同上 |
 * | **P31.6** | `feat(llm): Anthropic provider marker-aware system block splitter` | `anthropic.ts` modify + test | +80 / +150 | `pnpm --filter @lumen/llm test` |
 * | **P31.7** | `feat(core): Agent.run system prompt cache + composition wiring` | `index.ts` + `composition.ts` + test | +150 / +200 | `pnpm --filter @lumen/cli test`;真实 `lumen run`;验证两次 run byte-stable |
 * | **P31.8** | `feat(cli): lumen init --with-claude-md writes project prompt template` | `init.ts` + `index.ts` + test | +50 / +80 | cli test + 真实 init |
 *
 * **总计**:8 commit,~830 行实现 + ~1080 行测试 +
 * ~260 行文档,预计 4-6 session。
 *
 * ## 4. 风险与缓解
 *
 * | 风险 | 来源 | 缓解 |
 * | --- | --- | --- |
 * | P31.5 改 Anthropic provider wire-up 路径,可能破坏所有 Anthropic e2e 测试 | `anthropic.ts:740-780` `buildRequestBody` 是热路径 | 保留 `resolveSystemBlocks(providerOptions.anthropicSystemBlocks)` 作为逃生通道;为 marker × cacheControl 矩阵加 4 个单测 |
 * | P31.6 在 `AgentConfig` 引入新的可选 `systemPromptContext` 字段,可能破坏 test fixture | index.ts:71 已经有 `systemPrompt?: string` | 保留 `systemPrompt?: string` 作为 identity-section override;新字段是可选 |
 * | session 级 cache 污染跨测试状态 | `_cachedSystemPrompt` 是实例属性 | 测试 setup 通过 `delete agent.cachedSystemPrompt` 或每个 test 用 unique model 重置 |
 * | byte-stable 测试易碎(字符串比较) | OpenClaw 已有同样 footgun | 用 SHA-256 哈希比对完整 stable prefix,不做原始字符串比较 |
 * | dynamic 内容泄漏进 stable prefix | OpenClaw 的 `ensureSystemPromptCacheBoundary` 正是为此而设计 | `buildSystemPrompt` 中始终调用 `ensureSystemPromptCacheBoundary` |
 * | 用户在 `<cwd>/CLAUDE.md` 等文件中直接写入 marker 字面量 | Boundary marker 是 `\n<!-- LUMEN_CACHE_BOUNDARY -->\n` | `sanitizeSurrogates` **不**剥 marker;依赖 `ensureSystemPromptCacheBoundary` 先 check-then-pos |
 *
 * ## 5. 与上游对比(决策日志)
 *
 * | 决策 | Hermes | OpenClaw | **lumen P31** | 理由 |
 * | --- | --- | --- | --- | --- |
 * | system prompt 形态 | 单 string | 单 string + marker | **单 string + marker** | OpenClaw — 显式 cache boundary,易于调试 |
 * | stable/dynamic 切分 | 字符串拼接(无 marker) | 显式 marker | **显式 marker** | OpenClaw — `ensureSystemPromptCacheBoundary` 防御性追加 |
 * | cache_control 标记 | 隐式(byte-stable) | 显式 | **显式** | OpenClaw — 可调试 + 4 provider 测试矩阵已存在 |
 * | session 级 cache | 实例属性 `_cached_system_prompt` | 无 | **实例属性** | Hermes — 单 session 收益是真实的 |
 * | 跨 session LRU | 无 | LRU 64 + SHA-256 | **LRU 64 + SHA-256** | OpenClaw — tools/skills 稳定时跨重启收益 |
 * | 项目文件 walk | (未验证,文档声称 walk-up 到 git root) | 单层目录 | **walk-up 到 git root** | Hermes 文档主张,合理 |
 * | 项目文件候选 | (未验证) | `["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]` | **同上** | OpenClaw — 行业已收敛 |
 * | sanitize unicode | 不在 prompt 路径 | `sanitizeSurrogates` 每个 block | **`sanitizeSurrogates`** | OpenClaw — 防 unicode high-surrogate 攻击 |
 * | 多断点 cache | system + 3 个滑动 message 断点 | system + tools + messages(动态预算) | **v1 只用 system** | KISS — 量了收益再加 message 断点 |
 * | ephemeral 处理 | `+ "\n\n" + ephemeral`(污染 stable prefix) | N/A(用 dynamic suffix) | **通过 marker 走 dynamic suffix** | OpenClaw — 永不污染 stable prefix |
 *
 * ## 6. 兼容性说明
 *
 * - `AgentConfig.systemPrompt?: string`(index.ts:71)
 *   类型不变;语义上现在成为 identity-section override
 *   (归入 L3 IDENTITY.md 优先级链)。现有 fixture 不受影响。
 * - `providerOptions.anthropicSystemBlocks`(anthropic.ts:303)
 *   类型不变;power-user 逃生通道。
 * - `DEFAULT_SYSTEM_PROMPT` 常量(index.ts:208)降级为
 *   L3 IDENTITY.md fallback — 仅当 `systemPrompt` 未设置
 *   **且** `<cwd>/IDENTITY.md` 和 `~/.lumen/IDENTITY.md`
 *   都不存在时使用。L2 SOUL.md fallback 同理(无 SOUL.md 时)。
 * - `--no-cache-boundary` CLI flag 可关掉 marker 注入
 *   (system prompt 进 provider 时是单 string,如有支持
 *   就打 `cache_control`,不做 boundary 切分)。用于
 *   把 marker 字面量当字面渲染的 provider。
 * - L8 runtime block 携带 `ToolRegistry` schema dump
 *   + active-skill 索引。现有 P20.6 `SkillTriggerMiddleware`
 *   继续注入;L8 只是它的 canonical 归宿(无语义变化,
 *   仅迁移位置)。
 *
 * ## 7. 待评审开放问题
 *
 * 1. **`--no-cache-boundary` 是否保留?** 风险:每个 flag
 *    都是维护负担。收益:边缘 provider(把 marker 字面量
 *    渲染出来的自建 OpenAI-compatible)。默认:ship the flag,
 *    默认 off。
 * 2. **per-user vs per-project 划分 — 用户 2026-07-29 已确认**:8 个 context 文件分两组:
 *    - **Per-project (仅 L1)**:`AGENTS.md` / `CLAUDE.md`。Walk-up 到 git root,无 `~/.lumen/` fallback。
 *    - **Per-user (L2–L7 stable + D1)**:`SOUL.md` / `USER.md` / `IDENTITY.md` / `TOOLS.md` / `BOOTSTRAP.md` / `MEMORY.md` / `HEARTBEAT.md`。`<cwd>/` 优先,`~/.lumen/` fallback。
 *    待定问题:`~/.lumen/` fallback 是逐文件(每个文件独立查两边)还是 all-or-nothing(要么全部走 cwd,要么全部走 `~/.lumen/`)?默认:逐文件,但 P31.3a 落地后再评审。
 * 3. **cache 命中率可观测性?** OpenClaw 没暴露 cache 命中
 *    指标。lumen 可以在 `Telemetry` (P8.3) 加一个
 *    `cache_hits` 计数器。P31 不在范围内,P31.9 follow-up。
 * 4. **多断点 message cache**(Hermes 模式):推迟到 P31+。
 *    先 profile;如果 system 单断点命中率达到 80%+ 就足够。
 *
 * ## 8. 引用(已验证源码)
 *
 * - `~/.hermes/hermes-agent/agent/conversation_loop.py:980-1004`
 *   (effective_system = active + "\n\n" + ephemeral)
 * - `~/.hermes/hermes-agent/agent/agent_init.py:295-411,636-638,1325`
 *   (ephemeral_system_prompt 字段、Anthropic auto-cache 声明、
 *   `_cached_system_prompt` 实例属性)
 * - `~/.hermes/hermes-agent/AGENTS.md:7-12`("Per-conversation
 *   prompt caching is sacred")
 * - `/Users/chengpengtao/workspace/openclaw-main/packages/ai/src/utils/system-prompt-cache-boundary.ts:8-65`
 *   (SYSTEM_PROMPT_CACHE_BOUNDARY 常量 + split/strip/ensure/prepend)
 * - `/Users/chengpengtao/workspace/openclaw-main/packages/ai/src/providers/anthropic.ts:1548-1603`
 *   (buildAnthropicSystemBlocksFromString marker-aware splitter)
 * - `/Users/chengpengtao/workspace/openclaw-main/src/agents/system-prompt.ts:74-87`
 *   (CONTEXT_FILE_ORDER 7 文件优先级 map)
 * - `/Users/chengpengtao/workspace/openclaw-main/src/agents/system-prompt.ts:145-168`
 *   (cacheStablePromptPrefix LRU + hashStablePromptInput SHA-256)
 * - `/Users/chengpengtao/workspace/openclaw-main/src/agents/sessions/resource-loader.ts:72-89`
 *   (AGENTS.md / CLAUDE.md 大小写不敏感候选优先级)
 * - `/Users/chengpengtao/workspace/lumen/packages/core/src/agent/index.ts:71,208-211,312,336,505`
 *   (当前单 string system prompt 表面)
 * - `/Users/chengpengtao/workspace/lumen/packages/llm/src/anthropic.ts:198-219,309-350,740-780,788-820`
 *   (现有 AnthropicSystemBlock + resolveSystemBlocks + splitSystemAndMessages 基础设施)
 */
