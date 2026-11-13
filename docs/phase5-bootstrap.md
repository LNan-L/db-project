# Phase 5 立项书 — AI 助手、语义检索、MCP 与质量分析

状态：**已立项**（2026-11-12，项目负责人确认「正式立项 phase 5」）
日期：2026-11-12
工程：`D:\\code\\pke`
前置：Phase 1–4 已收口（见各 `phase*-closure.md`）
需求来源：`pke/docs/req-open.json` 的 REQ-205 / REQ-301 / REQ-302 / REQ-304
讨论记录：`docs/phase5-plan.md`（已被本文件取代，保留作决策背景）

## 一、立项理由

Phase 1–4 解决的是「记得住、同步得动、手机能用」。到 Phase 4 收口时，立项设想里只剩 AI 这一段没做：

1. **检索停在字面匹配**：BM25 找不到「同义/换一种说法」的笔记，问「哪篇讲过 X」只能靠人翻。
2. **重复、孤立、断链只能人肉发现**：笔记到几十篇后，这类质量损耗开始明显。
3. **外部工具无法安全使用知识库**：REQ-302 要求 MCP，但必须解决「搜索/读取/草稿写入 + 授权 + audit_logs」。

## 二、范围（按交付顺序）

### 5.0 决策与 AI 基础设施（先做）

- `AiProvider` 抽象：`embed()` / `chat()` / `health()`，本地与远端实现同一接口。
- 设置页：选择 provider、baseUrl、model、embedding model；「允许把内容发到远端」开关（**默认关闭**）。
- 隐私闸门：任何远端调用前展示「将发送 N 篇笔记 / M 字符」，需用户确认；确认记录时间戳。
- 默认实现：本地 OpenAI 兼容端点（如 Ollama `http://127.0.0.1:11434/v1`），不内置任何云端 key。

### 5.1 REQ-301 混合检索

- 本地向量索引：按段落切块，嵌入结果存 IndexedDB（schema v7）。
- BM25（已有）与向量结果用 RRF 融合；顶部结果给出出处（笔记 + 段落摘要）。
- **向量关闭/不可用时回退纯 BM25**（验收硬要求）。
- 设置里提供「重建索引」与 provider 切换后的重建提示。

### 5.2 REQ-205 AI 草稿助手

- 入口：编辑器/搜索页「AI 草稿」；输入意图 → 检索 top-k → 生成草稿。
- 产出对象：`{ title, body, relations[] }`，显示在草稿区，**不写正式数据**。
- 用户确认后：新建笔记或写入当前笔记（走现有 `updateNote`，自动进版本历史）；关系建议走 `addManualRelation`。
- AI 建议在编辑器里从「样式占位」升级为真实结果（保留 Phase 2 的视觉区分）。

### 5.3 REQ-302 MCP 接口

- 进程：独立 Node 服务（`server/mcp-server.js`），优先 stdio（本机客户端），可选 HTTP/SSE 走 tailnet。
- 数据来源：同步 API（pull/push），要求笔记已同步；本地未同步笔记不可见（写进文档）。
- 工具：`search_notes`、`read_note`、`list_tags`、`draft_note`、`write_note`、`create_relation`、`quality_candidates`。
- 写操作：必须带 `confirm: true`（客户端人工批准）+ 服务端记 `audit_logs`（时间、工具、参数摘要、结果、token 标识）。
- 不开放公网；HTTP/SSE 只监听 tailnet 或由 `pke-web` 反代。

### 5.4 REQ-304 知识质量分析

- 候选：重复（标题/正文相似度）、孤立（无出入链且无手动关系）、断链（`[[目标]]` 解析失败）。
- 列表逐项展示 + 勾选；处理动作（合并/删除/建链）**逐项确认**后执行。
- 复用版本历史与墓碑机制，删除可同步。
- **已完成 2026-11-12**：见 `docs/phase5-4-quality.md`（重复/孤立/断链 + 逐项确认合并/建目标 + 审计展示）。

### 5.5 PC 端 PWA 与收口

- PC 用 `https://….ts.net` 或本地 `build + preview`；迁移步骤先同步、再切 origin（详见 `docs/phase5-plan.md` 第 3 节）。
- 收口报告 `docs/phase5-closure.md`。
- **已完成 2026-11-12**：PNG 192/512 图标、manifest 校验、SW 接管与离线 E2E；见
  `docs/phase5-5-pwa.md`，收口见 `docs/phase5-closure.md`。

## 三、不在本阶段

| 事项 | 原因 |
| --- | --- |
| 域名 / 公网入口（4.8） | 负责人明确暂不做，见 `docs/backlog.md` B-2 |
| 多人协作 / 权限体系 | 单人使用，不立项 |
| 按设备独立 token（4.7） | 暂缓，见 B-1；MCP 写授权用确认 + audit |
| 云端托管模型服务 | 默认本地；远端仅作为用户自配的兼容端点 |
| 移动端新界面 | 手机布局已在 Phase 4 收口 |

## 四、关键决策

**已定**（随立项固定）：

1. 不开放公网；MCP 只走 tailnet / 本机。
2. 数据默认不出本机；远端 provider 默认关闭，开启需明确确认并逐次提示。
3. 所有 AI/MCP 写入先草稿，用户确认后才落库。
4. 向量索引存本地 IndexedDB，与同步数据解耦（不把向量同步到服务器）。

**2026-11-12 追加决策（双库）**：

- 主库（main）走云端 OpenAI 兼容 API；敏感库（sensitive）只允许本地模型，
  **Phase 5 只做主库，敏感库完全不开工**（详见 `docs/dual-library-plan.md`）。
- 因此原 5.2.5「本地模型环境」移出 Phase 5，改为主库云端 provider 配置；
  并在 5.0 增加 5.0.1「chat / embedding 端点拆分」（云端两家可能不同厂商）——**已完成 2026-11-12**，见 `docs/phase5-0-1-endpoints.md`。

**5.0 开工前需负责人确认**：

1. 本地模型/嵌入服务用哪个（默认 Ollama OpenAI 兼容端点）。
2. 是否允许配置云端端点（默认不允许；允许则加确认闸门）。
3. 向量维度与切换 provider 后的重建策略（建议随 provider 记录，切回需重建）。

## 五、验收标准

验收按 `req-open.json` 原文，逐条给出测量方式：

| REQ | 原文验收 | 测量方式 |
| --- | --- | --- |
| REQ-301 | 执行混合检索；关闭向量检索后全文检索仍然可用 | 单元：RRF 融合顺序；E2E：关闭向量后同一查询仍返回 BM25 结果 |
| REQ-205 | AI 检索笔记并生成草稿或关系建议；用户确认前不写入正式数据 | E2E：草稿出现但笔记数不变；确认后笔记/关系才增加 |
| REQ-302 | MCP 搜索、读取和草稿写入；写操作经过授权并记录 audit_logs | 脚本：stdio 调用 search/read/draft 成功；无 confirm 的 write 被拒；audit_logs 有记录 |
| REQ-304 | 列出重复、孤立和断链候选；用户逐项确认后才执行处理 | 单元：三类候选构造；E2E：列表 → 勾选 → 确认 → 数据变化 |

## 六、里程碑与质量门

| 顺序 | 里程碑 | 完成标准 |
| --- | --- | --- |
| 1 | 5.0 决策与 provider 基础 | 设置页可切换 provider；本地/远端 mock 均可 health；隐私闸门有测试 |
| 2 | 5.1 混合检索 | REQ-301 验收通过；重建索引可用 |
| 3 | 5.2 AI 草稿 | REQ-205 验收通过；确认流程进版本历史 |
| 4 | 5.3 MCP | REQ-302 验收通过；audit_logs 可查 |
| 5 | 5.4 质量分析 | REQ-304 验收通过 |
| 6 | 5.5 PC PWA + 收口 | PC 可安装/离线；收口报告批准 |

### 5.2.5（已移出 Phase 5）

原「本地模型环境（Ollama）」随敏感库规划移入 Phase 6（见 `docs/dual-library-plan.md`）。
Phase 5 的真实模型验证改为主库的云端 provider：负责人在 AI 设置里填 baseUrl/key，
不写入仓库；5.1/5.2 的代码验收仍以 mock 为准。

质量门（每步都跑）：`npm run typecheck`、`npm test`、`npx playwright test`、`node server/verify-pull-since.js`；
涉及服务端改动时先备份、重启、跑线上回归。

## 七、风险与应对

| 风险 | 应对 |
| --- | --- |
| 本地模型效果/速度不确定 | provider 可替换；先做检索与草稿骨架，用 mock 验收；模型质量不阻塞流程 |
| 嵌入维度变更导致索引失效 | 索引记录 provider/model/维度；不匹配时提示重建 |
| 向量全量扫描随笔记增长变慢 | 先限制块数（如每篇 ≤20 块）并记录规模上限；必要时再引入近似索引 |
| MCP 数据源要求已同步 | 文档写明；MCP 启动时提示「最近同步时间」，未同步改动不可见 |
| 远端调用泄露内容 | 默认关闭 + 每次确认 + 记录确认时间；不内置 key |
| MCP 写操作误伤 | `confirm` 参数 + audit_logs + 走版本历史可恢复 |

## 八、交付物

1. 代码：`src/ai/*`、`src/search/*`（向量）、`src/components/AiPanel*`、`server/mcp-server.js`、服务端 `audit_logs`。
2. 文档：本立项书、`docs/developer-guide.md` 第 9 章（Phase 5 开发指南）、各子项实施记录、`docs/phase5-closure.md`。
3. 测试：单元 + E2E + MCP 脚本回归，纳入质量门。

## 九、开发者文档

Phase 5 的开发细节（模块边界、接口形状、存储设计、测试与部署）统一写入
[`docs/developer-guide.md`](developer-guide.md) 第 9 章，不另开零散文档。
