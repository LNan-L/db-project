# 双库规划 — 主库（云端 AI）/ 敏感库（本地模型）

状态：**规划中，未开工**。Phase 5 仍只做「主库」；敏感库只预留位置。
日期：2026-11-12
决策人：项目负责人

## 一、已定方向（2026-11-12）

| 库 | 内容 | AI 策略 | 当前状态 |
| --- | --- | --- | --- |
| 主库 `main` | 日常/普通内容 | 允许云端 OpenAI 兼容 API | Phase 5 正在做 |
| 敏感库 `sensitive` | 敏感信息 | **只允许本地模型，禁止任何云端调用** | 仅预留，Phase 5 完全不开工 |

由此调整：原计划 5.2.5「本地模型环境（Ollama）」**移出 Phase 5**，随敏感库进入 Phase 6；
Phase 5 的真实模型验证改为主库的云端 provider（由负责人在 AI 设置里配置，key 只存本机）。

## 二、为什么不是加一个开关那么简单

1. **数据隔离**：`notes.workspaceId` 字段一直存在，但 UI 与同步都没真正使用。
   敏感库建议**独立 Dexie 数据库**（如 `pke-sensitive`）+ 独立同步配置/凭据，
   避免一次查询/备份把两库混在一起。
2. **同步策略**：主库照常同步到 ECS；敏感库默认**不参与云同步**（或只允许端到端加密同步，
   走 OPEN-011 B），必须在协议层强制，不能只靠 UI 自觉。
3. **AI 策略按库强制**：provider 选择前先取库策略；`sensitive` 一律 local，且 remote 调用 fail-closed。
   只靠面板里选「本地」不够（5.0 评审已证明标签不可信）。
4. **备份**：敏感库只能加密备份（OPEN-011 B），且绝不能进入主库 ZIP。
5. **UI**：库切换器、敏感库入口、导入导出范围；Phase 5 不实现，避免出现死入口。

## 三、Phase 5 需要预留的位置（只做最小）

1. **provider 拆分**：主库云端 chat 与 embedding 很可能不是同一厂商
   （例如 DeepSeek 提供 chat 但没有 embeddings），`AiSettings` 需要拆成
   `chat { baseUrl, model, apiKey }` 与 `embedding { baseUrl, model, apiKey }` 两套端点。
   这是 5.0 的增量改动（记作 5.0.1），在配云端 provider 前完成。
2. **库级策略接口**：所有 AI 入口（搜索、草稿、MCP、质量分析）统一经
   `aiPolicyFor(library)` 取得策略；Phase 5 固定返回 `main → cloud`，
   `sensitive → local-only（未实现）`，先留接口与常量。
3. **文档与注释**：明确「当前单库 = 主库」，敏感库未实现。
4. **不做**：敏感库的 UI、存储、同步、备份代码一律不写；不放禁用入口。

## 四、Phase 6 范围（草案）

- 敏感库独立存储 + 库切换 + 导入导出隔离。
- 敏感库不同步（默认）或加密同步（评估后定）。
- 本地模型：Ollama（或等价）安装、本地嵌入、模型管理；sensitive 强制本地。
- 敏感库加密备份（独立口令/恢复码）。
- MCP：默认不暴露敏感库；如需，单独授权与审计。

## 五、待决问题

1. 主库 **chat** 供应商：DeepSeek / 硅基流动 / 阿里百炼 / OpenAI / 其他。
2. 主库 **embedding** 供应商：DeepSeek 无 embeddings；候选：硅基流动 Qwen3-Embedding、
   阿里 text-embedding-v3、OpenAI text-embedding-3-small。
3. 敏感库隔离方式：独立 Dexie 数据库（推荐）还是 workspaceId。
4. 敏感库同步：完全不同步（推荐）还是加密同步。
5. 是否现在放一个「敏感库（未开放）」的只读入口（当前建议：不放）。
