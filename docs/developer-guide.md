# PKE 开发者文档

> 适用范围：`D:\\code\\pke` 全部代码与文档。
> 最后更新：2026-11-12（Phase 4 收口、Phase 5 立项后；第 9 章为 Phase 5 开发指南）
> 读者：接手开发的 Agent / 人。读完本文 + `docs/handoff-2026-11-12.md` 即可开工。

## 1. 项目概览

本地优先的个人知识库：笔记与附件存在浏览器 IndexedDB，自建同步服务做多端复制，
PWA 支持离线；自托管在阿里云 ECS，通过 Tailscale 访问。

- 前端：Vite 8 + React 19 + TypeScript strict + Dexie 4；编辑器 Milkdown。
- 服务端：Node 22 + Express 5 + better-sqlite3（`server/pke-sync-server.js`、`server/pke-web-server.js`）。
- 测试：Vitest（jsdom + fake-indexeddb）+ Playwright（msedge）+ 服务端回归脚本。
- 单人单仓库：`main` 分支，无远程；提交即发布依据。

## 2. 环境与命令

**本机没有系统级 Node**，必须加便携路径：

```bat
set PATH=C:\\Program Files\\nodejs;%PATH%
```

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发服务器 `127.0.0.1:5273`（无 Service Worker） |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest 单元测试 |
| `npm run build` | 构建 `dist/`（含 PWA precache） |
| `npx playwright test` | E2E：自动 build + preview 到 `127.0.0.1:4273` |
| `node server/verify-pull-since.js` | 服务端回归（临时库/端口/附件目录，跑完自清） |

服务端依赖不在根 `package.json`：`cd server && npm install`（`server/package.json` 同时让
`server/*.js` 保持 CommonJS，根包是 `type: module`）。

环境坑：npm 走 `registry.npmmirror.com`；GitHub 直连不可用（release 资源用 `gh-proxy.com` 镜像）；
Tailscale Funnel 在大陆不稳，只用 tailnet `serve`。

## 3. 目录结构

```text
src/
  App.tsx                 视图切换（notes / graph / canvas）、全局状态、同步面板入口
  components/             编辑器、图谱、画布、同步、版本历史、数据面板、引导页
  domain/                 笔记、标签、双链解析（纯函数）
  storage/                Dexie schema 与各仓库（notes/relations/versions/tombstones/canvas/meta）
  sync/                   sync 主流程、autoSync、blobs、blobStatus、blobRetry、devices、versions、shareConfig
  search/bm25.ts          本地全文检索（中英混合分词 + 加权）
  graph/                  图谱构建、布局、邻居
  markdown/attachmentRef  `![name](attachment:<id>)` 与 data URL 的互转
  backup/                 加密备份（AES-GCM + PBKDF2）、打包、下载
server/
  pke-sync-server.js      同步 API（sqlite）
  pke-web-server.js       静态站 + /api 反代（同源入口）
  verify-pull-since.js    服务端回归脚本
tests/unit/               Vitest
tests/e2e/                Playwright（默认 1280；手机用例自建 390 上下文）
docs/                     收口报告、子项记录、交接文件、本开发者文档
```

## 4. 数据模型（schema v6）

数据库名 `pke`；`src/storage/db.ts` 的 `PkeDatabase` 负责版本迁移。

| 表 | 主键 / 索引 | 关键字段 |
| --- | --- | --- |
| `workspaces` | `id` | 默认 `local` |
| `notes` | `id`；`workspaceId, updatedAt, folder, *tags` | title/body/tags/folder/updatedAt |
| `attachments` | `id`；`noteId, hash` | 含 `blob`（文件本体） |
| `attachment_refs` | `id`；`noteId, hash` | 远端附件元数据（不含 blob） |
| `note_links` | `id`；`sourceId, targetId` | 双链解析结果 |
| `relations` | `id`；`sourceId, targetId, createdAt` | 手动关系（画布连线也落这里） |
| `note_versions` | `id`；`noteId, createdAt` | 每次保存前快照 |
| `sync_tombstones` | `id`；`kind, deletedAt` | 删除传播（note/relation/attachment） |
| `canvas_cards` | `noteId` | 画布坐标 x/y（本机，不同步） |
| `meta` | `key` | schema_version、同步配置、弱网开关、引导标记、视口 |

**迁移约定**：新增表必须 `this.version(N).stores({ ...全部旧表..., 新表 })`（Dexie 只保留本版本列出的表），
并补一条「旧版本库升级后数据不丢」的单元测试（参考 `tests/unit/canvas.test.ts` 的 v5→v6 用例）。

## 5. 同步协议

**客户端**（`src/sync/sync.ts`）：先拉后推。

1. `GET /api/v1/pull?since=<synced_at 游标>&deviceId&deviceName` → notes/relations/attachments/serverTime。
2. 合并：远端更新覆盖、远端删除清本地、本地改动按 `updatedAt`/revision 判定冲突。
3. `POST /api/v1/push`：`{deviceId, deviceName, notes:[...baseRevision], relations, attachments}`；
   服务端 revision 冲突返回 `conflicts`（不覆盖）。
4. 记录 `revisions[id]`、`lastSyncAt = serverTime`，写入本地配置。

**游标**：`notes.synced_at` 是服务端接收时间且严格递增，不能用内容时间（历史 bug，见
`verify-pull-since.js` 头注释）。本地 0 篇 + 有游标时强制全量拉（自愈）。

**服务端接口**：

| 方法 / 路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查（无需 auth） |
| `GET /api/v1/pull` | 增量拉取；被吊销设备 403 `device-revoked` |
| `POST /api/v1/push` | 推送；revision 冲突返回 conflicts |
| `GET /api/v1/versions/:id` | 版本历史，`limit`（默认/上限 200）+ `before` 游标 + `nextCursor` |
| `GET /api/v1/devices` | 设备列表 + `revoked[]` |
| `DELETE /api/v1/devices/:id` | 吊销（移入 `revoked_devices`） |
| `DELETE /api/v1/revoked-devices/:id` | 恢复 |
| `PUT/GET /api/v1/attachments/:id/blob` | 附件二进制（单文件 ≤16 MB） |

**鉴权**：全局 Bearer token（`/etc/pke-sync.env` 的 `PKE_TOKEN`）。设备吊销只按 deviceId 拦截，
`4.7` 按设备 token 暂缓（`docs/backlog.md` B-1）。

**客户端定时器**：`autoSync` 2 秒防抖；失败按 `[5s, 15s, 60s, 300s]` 重试；
附件下载另有独立的退避（5s/15s/60s/300s，4 次后手动）与批量预取（并发 2、单篇 10 MB）。

## 6. 前端架构

- `App.tsx`：`view: 'notes' | 'graph' | 'canvas'`；笔记列表/搜索/标签过滤；懒加载编辑器与数据面板；
  同步配置扫码导入（URL hash，不进服务器日志）。
- 编辑器（`NoteEditor`）：Milkdown；正文存 `attachment:<id>` 引用、显示时换 data URL；
  保存前写版本；附件按需下载 + 退避 + 批量预取 + 弱网开关（meta）。
- 图谱（`GraphView`）：SVG，缩放/平移/拖动/1-3 层/搜索定位；手动关系与 AI 占位样式。
- 画布（`CanvasView`）：世界坐标 + 视口 `translate/scale`；卡片坐标存 `canvas_cards`；
  连线落 `relations`；布局与视口本机持久化。
- 同步面板（`SyncPanel`）：服务器/token/设备名、二维码、设备撤销/恢复、冲突解决、附件失败与弱网开关。
- 版本历史（`VersionHistory`）：本机 + 云端合并时间线；云端分页（50/页，加载更多）；恢复前确认。
- PWA：`vite-plugin-pwa` 预缓存；dev 模式 `devOptions.enabled: false`（5273 无 SW）。
- 备份：ZIP/`.pke.enc`（AES-256-GCM + PBKDF2 + 恢复码），导入时校验 manifest/hash。

## 7. 测试与质量门

**单元（Vitest）**

- 环境：jsdom + `fake-indexeddb`（`tests/setup.ts`）；每个用例自建 `PkeDatabase('pke-test-…')`，`afterEach` 关闭并删除。
- 覆盖：domain 纯函数、存储仓库、同步合并/冲突、blob 解析、备份加解密、图谱、画布、退避调度等。
- 当前基线：**27 文件 / 130 用例**。

**E2E（Playwright）**

- 配置：`playwright.config.ts`，`msedge`，webServer 先 `npm run build` 再 `preview` 到 4273。
- 约定：用 `data-testid` 定位；外部网络一律 `page.route` mock；退避类用 `page.clock.install()` + `fastForward`
  避免真等；手机用例 `browser.newContext({ viewport: { width: 390, height: 844 } })`。
- 当前基线：**53 条**。

**服务端回归**：`node server/verify-pull-since.js`（52 条断言），临时库/端口/blob 目录，可重复执行；
改服务端后必须本机 + 线上各跑一次。

**质量门（每个子项都要全绿）**：`typecheck` → `npm test` → `npx playwright test` → `server verify`；
然后部署并记录。新增功能必须带测试，否则不算完成。

## 8. 构建、部署与回滚

| 动作 | 做法 |
| --- | --- |
| 前端 | `npm run build`；`tar` 上传 → `/opt/pke-web/site.new` → `mv site site.prev-<时间>` → `mv site.new site` |
| 服务端 | 先备份 `server.js`（与库：`better-sqlite3` 在线 backup）→ scp 覆盖 → `systemctl restart pke-sync` → 跑线上回归 |
| 验证 | `curl http://127.0.0.1:3000/health`；`curl http://10.0.0.10:8080/`；线上 `assets/index-*.js` 与本地一致 |
| 回滚 | 前端换回 `site.prev-*`；服务端换回 `server.js.bak-*` 并重启 |

拓扑：ECS `8.148.85.25`（tailnet `10.0.0.10`）；`pke-sync` 只绑 `127.0.0.1:3000`；
`pke-web` 绑 `10.0.0.10:8080`；`tailscale serve` 提供 `https://…ts.net`。PC 已加入 tailnet
（`lnan`），同步直连 ts.net，不再需要 SSH 隧道（应急脚本保留）。

## 9. Phase 5 开发指南（AI / MCP / 质量分析）

> **库与 AI 策略（2026-11-12）**：当前仍是单库 = 主库（main），AI 允许云端 provider；
> 敏感库（sensitive）只规划、未实现（`docs/dual-library-plan.md`）。Phase 5 的 AI 入口固定按
> 「main → 云端」工作；在敏感库实现前，不要在 provider 层引入跨库共享。
> 计划中的 5.0.1：把 `AiSettings` 的 chat 与 embedding 拆成两套端点（云端两家可能不同厂商）。


> 立项书：`docs/phase5-bootstrap.md`。本节是**实现约束**；未实现的模块标「计划」。

### 9.1 模块规划

```text
src/ai/provider.ts        ✅ 5.0：AiProvider 接口 + OpenAI 兼容实现（health/embed/chat）
src/ai/settings.ts        ✅ 5.0：ai_settings 读写（meta），隐私确认时间戳
src/ai/prompt.ts          草稿/关系建议 prompt 组装（可单测）
src/search/vector.ts      切块、余弦相似度、RRF 融合
src/search/vectorIndex.ts 索引构建/重建/缓存（IndexedDB）
src/components/AiPanel.tsx ✅ 5.0：设置面板（5.2 再扩草稿区）
src/quality/analyze.ts    重复/孤立/断链候选（纯函数，可单测）
server/mcp-server.js      MCP 进程（stdio 优先）
server/mcp-tools.js       工具实现（search/read/draft/write/quality）
server/audit.js           写 audit_logs（sqlite）
```

### 9.2 设置与隐私（5.0 / 5.0.1 已实现）

`meta.ai_settings`（JSON）：

```ts
interface AiEndpoint {
  baseUrl: string; model: string; apiKey: string;
  remoteAllowed: boolean; remoteConsentAt: string | null; remoteConsentBaseUrl: string | null;
}
interface AiSettings {
  enabled: boolean;
  chat: AiEndpoint;        // 默认 DeepSeek: https://api.deepseek.com/v1 + deepseek-chat
  embedding: AiEndpoint;   // 默认硅基流动: https://api.siliconflow.cn/v1 + BAAI/bge-m3
  vectorSearchEnabled: boolean;
}
```

- **按目的地判断远端**：`isLoopbackBaseUrl()` 为真才是本地；每个端点单独授权、绑定 origin，改地址即失效。
- 两端点互不影响：chat 授权不等于 embedding 授权；`endpointBlockedReason()` 分别检查。
- 旧版单端点设置载入时自动迁移为两端点（同 baseUrl/key，模型各取各的）。
- key 只存 IndexedDB，不上传、不进日志/备份；loopback 请求不携带 key。
- `describeRemoteSend()` 供草稿/重建索引前的二次确认复用。

### 9.3 `AiProvider` 接口（5.0 已实现）

```ts
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface AiProvider {
  id: string;                     // openai-compatible:<kind>:<model>
  kind: 'local' | 'remote';
  health(signal?: AbortSignal): Promise<boolean>;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
  chat(messages: ChatMessage[], options?: { temperature?: number; signal?: AbortSignal }): Promise<string>;
}
```

错误处理：非 2xx 带服务端 `error.message` 摘要（截断）；非 JSON、`data` 非数组、向量维度不一致都抛错。

工厂：`createChatProvider(settings)` 只读 `settings.chat`，`createEmbeddingProvider(settings)` 只读
`settings.embedding`；两者都在内部强制授权检查（fail-closed）。测试注入 mock provider（不联网）。

### 9.4 向量索引（5.1 已实现，schema v7）

- 表 `embeddings`：主键 `noteId`、索引 `model`；行 `{ noteId, model, dimension, noteUpdatedAt, updatedAt, chunks[] }`，
  `chunks` 为 `{ text, offset, vector }`。**只存本机**，不同步、不进备份。
- 切块：`src/search/vector.ts` 的 `stripMarkdown` + `chunkNote`（≤500 字、每篇 ≤20 块、按句子边界）。
- 索引：`ensureVectorIndex` 按 `noteUpdatedAt`/`model` 增量；每批 8 块调 `embed()`；连续 3 次失败停止；
  **AI 未启用时直接返回**；同模型构建单飞（in-flight）；AbortSignal 贯穿；单次默认最多 50 篇。
  `rebuildVectorIndex` 逐篇覆盖、不先清空（失败保留旧索引），全部成功后清理其它模型旧行。
- 查询：问题嵌入 → 每篇取最高分块余弦 → 与 BM25 做 RRF（k=60，`mergeHybrid`，结果上限 20）。
  维度与模型不一致、provider 报错、索引为空都会回退 BM25 并带 `reason`；UI 只在真正跑通时标「混合检索」。
- 降级：provider 不可用/索引为空/用户关闭向量 → 纯 BM25（REQ-301 硬要求）。
- 设置面板提供开关键、`重建向量索引`、已索引篇数与进度。

### 9.5 AI 草稿流程（5.2 已实现）

1. 侧栏「草稿」→ 输入意图；参考来源用 5.1 的 `hybridSearch`（向量关闭时 `searchBm25`），取前 5 篇。
2. `buildDraftPrompt()` 组装 system（只输出 JSON）+ user（意图 + 参考摘录）。
3. `provider.chat()`（temperature 0.3，30s AbortSignal）→ `parseDraft()` 校验：
   title/body 必填；`relations[].targetNoteId` 必须来自本次检索到的 id，其它丢弃。
4. 预览可编辑，**不写库**；用户点「确认写入」→ `createStoredNote` + `addManualRelation` + `notifyLocalChange`。
5. 远端 provider：生成前用 `describeRemoteSend()` 逐次确认（篇数/字符数/目标 origin）。

### 9.6 MCP（5.3 已实现）

- 进程：`server/mcp-server.js`（CommonJS，Node 22 `fetch`）；stdio 逐行 JSON-RPC，不监听端口。
- 数据：`pull?since=1970-01-01` 全量进内存；写操作 `push` 后缓存失效重拉；要求笔记已同步。
- 工具：`search_notes` / `read_note` / `list_tags` / `draft_note`（只返回草稿）；
  `write_note` / `create_relation` 必须 `confirm: true`。
- 审计：写成功后 `POST /api/v1/audit-logs`（tool、device、参数摘要、结果、note_id）；
  服务端 `audit_logs` 只追加，`GET` 默认 50 条。
- 环境：`PKE_SYNC_URL`、`PKE_TOKEN`、`PKE_MCP_DEVICE`；token 只走 env，不回显。
- 回归：`node server/verify-mcp.js`（临时库 + 随机端口，21 条断言）。

### 9.7 质量分析（5.4 已实现）

- `src/quality/analyze.ts`：纯函数，输入 notes + manual relations，输出重复/孤立/断链 + summary。
  - 重复：标题相同，或长正文相似（标题 Jaccard ≥0.7 且正文 ≥0.5，或正文 ≥0.85）；
  - 孤立：无解析成功的出链、无入链、无手动关系；
  - 断链：复用 `domain/wikiLinks`（忽略代码块）。
- `src/quality/actions.ts`：`mergeDuplicateNotes`（正文/标签合并、关系迁移、删除走墓碑与版本）、
  `createMissingTarget`。
- `QualityPanel`：侧栏「质量」；合并/创建都必须先内联确认；审计日志用
  `fetchAuditLogs()`（同步 API，无 token 时只提示不可用）。

### 9.8 PC PWA（计划）

两个免域名方案：PC 打开 `https://…ts.net`，或本地 `build + preview`（localhost 安全上下文）。
切换前必须先在 5273 同步一次（换 origin 不迁移 IndexedDB），步骤见 `docs/phase5-plan.md` 第 3 节。

### 9.9 Phase 5 测试策略

- 所有 provider 调用可注入 mock；单测不联网、不读真实 token。
- 每个 REQ 至少一条 E2E 走「用户路径」，并断言**确认前不写库**（205/304）或**降级仍可用**（301）。
- MCP 用独立脚本回归（stdio 调用 + audit_logs 断言），纳入质量门。

### 9.10 开关与回滚

- 功能默认关闭：`ai_settings.enabled=false`（5.0 已实现）；5.1/5.2 入口需同时检查总开关与功能开关。
- 向量检索单独开关（`vector_search_enabled`），关闭即纯 BM25。
- 任何一期出问题：关开关 + 前端回滚 `site.prev-*`，不涉及数据库迁移回退（v7 迁移只增表）。

## 10. 约定与陷阱

1. 代码头部用 `@req REQ-xxx` 标注需求；文档命名 `phaseN-*.md`，收口写 `phaseN-closure.md`。
2. 新增 E2E 必须有 `data-testid`；避免依赖文本顺序或时间戳。
3. 换行风格不统一（README/styles/sync.ts 是 CRLF，其余多为 LF）：编辑时保持文件原样，避免整文件 diff。
4. 依赖：走 npm 镜像；不要引入需要 GitHub 直连的安装步骤；服务端依赖进 `server/package.json`。
5. 安全：token、恢复码不进仓库/日志/文档；不把 3000/8080 开放公网。
6. 部署前先备份；前端保留上一版 `site.prev-*`；服务端保留 `server.js.bak-*` 与库备份。
7. 不要重新讨论已收口范围（Phase 1–4）；未排期事项按 `docs/backlog.md` 的重启条件处理。
