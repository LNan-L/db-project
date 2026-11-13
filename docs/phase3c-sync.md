# Phase 3c — 自建同步服务 + 客户端同步

## 服务端

- 阿里云 ECS：Ubuntu 22.04、2 核 2G、40G ESSD、1 Mbps 峰值。
- 同步服务：`/opt/pke-sync`（`server.js`、`pke-sync.db`），systemd `pke-sync.service`，绑定 `127.0.0.1:3000`，**不对公网开放**。
- 同源 Web 入口：`/opt/pke-web`（`server.js` = `server/pke-web-server.js`，`site/` = 最新 `dist`），systemd `pke-web.service`，绑定 `127.0.0.1:8080`，`/api` 反代到 3000。
- **稳定 HTTPS（2026-11-11 起）**：`tailscale serve --bg 8080` + `tailscale funnel --bg 8080`，固定域名 `https://pke.example-tailnet.ts.net/`，Let's Encrypt 证书自动续期。
  - serve：tailnet 内访问（PC 装 Tailscale 后走这条）
  - funnel：公网可访问（手机不装 App 时走这条；静态站公开，`/api` 仍需 token）
  - 关闭公网：`tailscale funnel --https=443 off`
- 临时隧道（`pke-tunnel.service`，pinggy）保留作备用：免费 60 分钟、域名随机；Tailscale 可用后不再是默认入口。
- 密钥：`/etc/pke-sync.env`（含 `PKE_TOKEN`），不进仓库。
- API：`GET /health`、`GET /api/v1/pull?since=`、`POST /api/v1/push`、`GET /api/v1/versions/:id`；Bearer token 鉴权。

## 增量游标：2026-11-11 修复的缺陷

**症状**：补推 4 篇内容时间为 11-08/11-09 的笔记后，已经同步过的设备（`since=当天 10:53`）拉到 **0 篇**；全新设备（`since=1970`）却能看到 5 篇。

**根因**：`pull` 用 `notes.updated_at`（笔记**内容**修改时间）当变更游标，而 `since` 是**同步**时间。两者时钟源不同，任何"内容时间早于上次同步时间"的数据永远不会被已同步设备拉到。

**修复**：

- `notes` 增加 `synced_at`（服务端**接收**时间），`pull` 改为 `WHERE synced_at > ?`，排序也用 `synced_at`。
- 启动时自动迁移：老库 `ALTER TABLE` 补列 + 回填成迁移时刻，让存量数据对所有设备可见一次。
- `synced_at` 用单调游标生成（`max(now, last+1)`），响应 `serverTime` 取 `max(now, cursor)`，避免同一毫秒内漏数据。
- 加 `idx_notes_synced` 索引。

**验证**：`server/verify-pull-since.js`（临时库 + 随机端口，10 条断言，不碰生产库）。

```bash
# 在服务器上运行（需要 express / better-sqlite3 / cors）
cd /opt/pke-sync
NODE_PATH=/opt/pke-sync/node_modules node verify-pull-since.js --server /opt/pke-sync/server.js
```

结果：旧代码 **2 FAILED**（`backfilled old notes visible` actual=0），新代码 **ALL PASS**；生产库迁移日志 `synced_at backfilled for 5 notes`，老游标拉取由 0 变为 5，紧接着再拉为 0。

## 客户端

- 「同步」面板：服务器地址、token、设备名、立即同步。
- 先拉后推；首次同步只推送**本地已有**的笔记，避免把刚拉下来的内容再推回去（revision 虚增）。

### 自动同步 / 重试 / 离线（2026-11-11）

- **自动触发**：任何本地写入（新建/保存/删除笔记、加/删关系、加/删附件）后调用 `notifyLocalChange()`，防抖 **2 秒**后自动同步。引擎在 `src/sync/autoSync.ts`。
- **失败重试**：退避 **5s → 15s → 60s → 300s**，最多 4 次；手动「立即同步」会清零重试计数。
- **离线**：`navigator.onLine === false` 时不发请求，状态置 `offline`；监听 `window.online` 事件自动恢复。
- **「离线队列」**：不需要额外队列表。同步是「先拉后推 + 全量关系/附件 + 墓碑」，失败时未推的内容仍留在本地（dirty 笔记、墓碑），下次成功即补齐，天然幂等。
- **状态可见**：面板显示 `自动同步：…`（待同步 / 同步中 / 失败+倒计时 / 离线 / 冲突）；侧栏「同步」按钮出现 `…`、`!`、`(N)`。
- **界面刷新**：自动同步在 React 之外改库，成功后必须重载列表（`App` 订阅引擎状态，`lastSuccessAt` 变化时 `refresh()`），否则出现「同步完成但列表还是空的」。
- **后台冲突**：自动同步发现的冲突存进引擎状态，打开面板即可继续处理，解决一个清一个。
- 双方都改过的同一笔记 → 冲突列表：保留本地 / 使用远端 / 生成冲突副本。
- 使用远端前会写入本地版本历史；冲突副本会保留两边内容。
- token 存本地 IndexedDB。

## 同步范围（2026-11-11 扩展）

| 对象 | 语义 | 备注 |
| --- | --- | --- |
| 笔记 | 内容冲突检测 + revision + 墓碑 | 原有能力 |
| 手动关系 | 集合语义（id = `manual:<小id>:<大id>`），无内容冲突 | 全量 + 墓碑推送；服务端只在变化时推进游标 |
| 附件 | **仅元数据**（name/mime/size/hash） | 落在本地 `attachment_refs`，不伪造 blob；二进制传输另做 |

**删除墓碑**：本地删笔记 / 关系 / 附件时写 `sync_tombstones`，push 成功后清除；拉到远端墓碑时同时清掉本地墓碑，避免"删了又推回去"。此前客户端的删除根本不会同步，这是本轮补上的。


**墓碑只翻转 deleted**：客户端删行后本地已没有两端信息，推墓碑时只能带 id。服务端若用 `excluded` 全量覆盖，会把关系的 `source_id/target_id`（附件的 name/mime/size/hash）抹成空串——已改为"墓碑沿用库里已有字段"。回归脚本加了 `relation tombstone keeps endpoints` 断言。

**真机实测（2026-11-11 晚）**：

| 操作 | 面板 | 服务端 |
| --- | --- | --- |
| 加一条手动关系后同步 | `关系 0/1` | `relations` 出现 live 行，两端正确；且能把同 id 的历史墓碑翻回 live |
| 删除该关系后同步 | `关系 0/1` | 该行 `deleted=1`，**两端仍保留** |
| 给笔记加附件后同步 | `附件 0/1` | `attachments` 一条元数据（樱花.jpg / image/jpeg / 275776 / sha256），无 blob |

schema 升到 **v5**（新增 `sync_tombstones`、`attachment_refs`，Dexie 自动迁移）。服务端新增 `relations`、`attachments` 两张表，`POST /api/v1/push` 接受 `relations`、`attachments` 数组并返回 `relationsApplied`、`attachmentsApplied`。

## 真机验收（2026-11-11）

环境：手机经 pinggy HTTPS 隧道同源访问（服务器静态站 + `/api` 反代），PC 经 SSH 隧道 `127.0.0.1:3000`。

| 步骤 | 期望 | 实测 |
| --- | --- | --- |
| PC 首次推送 | 推送 N | 推送 1 → 服务端 revision=1 |
| 手机首次拉取 | 拉取 1、推送 0 | 一致，且服务端 revision 仍为 1（**未反写**） |
| 手机改后同步 | 推送 1 | 推送 1 → revision=2，device 变为手机 UUID，版本历史新增 1 条 |
| PC 改后同步 | 推送 1 | 推送 1 → revision=3 |
| 换 origin 后手机重配 | 拉取 1、推送 1 | 一致，新 device id 正常，→ revision=4 |
| 双方都改 | 冲突 1、推送 0 | 一致：本地/远端并列，**不静默覆盖** |
| 选择"使用远端" | 只改本地、不推送 | 一致，服务端 revision 保持 4 |
| 真实数据首次上云 | 推送 4、拉取 1 | 一致，服务端 5 篇 / 8 条版本 |

验收结论：**PC ↔ 服务端 ↔ 手机** 的推送、拉取、冲突检测与三种解决分支在真机上成立。

## 真机联调记录（2026-11-11 晚，手机接入排查）

### 访问入口实测

| 入口 | 稳定性 | 实测 | 结论 |
| --- | --- | --- | --- |
| Tailscale `serve`（仅 tailnet） | 稳 | 直连，固定域名 | 推荐给已装 Tailscale 的设备 |
| Tailscale `funnel`（公网） | 差 | 5 次请求 1 次超时，单请求 3–6 s | 大陆网络不可靠，**不作默认** |
| pinggy 临时隧道 | 稳 | ~25 KB/s，一次 pull 约 6 s | 手机当前主用 |
| localhost.run | 稳但极慢 | ~3.4 KB/s | 弃用 |

固定域名：`https://pke.example-tailnet.ts.net/`（serve 与 funnel 共用，Let's Encrypt 自动续期）。

### 游标相关的三个坑（均已修）

1. **游标跑到数据前面**：某次同步报告成功但内容没落库，之后每次 pull 都用这个 `since`，早于它的内容永远拉不到 —— 表现是"同步完成但列表为空"。修复：`syncNotes` 检测到「本地 0 篇 + 游标非空」时强制从 1970 全量拉（自愈），并保留手动「全量重同步」兜底。
2. **「全量重同步」在非空设备上会回推旧内容**：重置 `lastSyncAt` 后，客户端把本地每篇都视为脏、同时把远端也视为脏 → 全部判成冲突 → 未改动的本地内容被强制回推。实测把刚剥离的 360 KB 内联图片又推回了服务端。修复：该按钮在本地有笔记时禁用。
3. **状态不可见**：面板现在显示「本机 IndexedDB：N 篇 · 游标 since …」，上面两类问题一眼可辨。

### 已知问题：手机窄屏布局（未修）

实测 390px 宽（手机竖屏）：侧栏与编辑器仍然并排，编辑器被压到约 100px，正文逐字换行。`responsive.spec.ts` 只覆盖 1280px 宽，窄屏没有约束。

建议：`@media (max-width: 720px)` 下改为单栏——列表占满宽，选中笔记后切到编辑器（带返回按钮）。

### 正文内联 base64 图片（2026-11-11 已修）

Phase 1 加附件时会把图片以 `data:` URL 内联进 Markdown 正文，后果：

- 同一张图存两份（正文 base64 + 附件 blob）
- 275 KB 的图片 → 正文 367 KB → 一次 pull 约 370 KB
- 走 pinggy 实测 **80 秒**，手机端必然 `Failed to fetch`

临时处置：服务端剥掉超长正文里的 `![..](data:...)` 行（附件保留、旧正文进版本历史），API 响应加 gzip（370 KB → 275 KB）。

修法（**已实现**）：`src/markdown/attachmentRef.ts`

- **存库 / 同步**：正文里是 `![name](attachment:<id>)`，通常几十字节
- **编辑器显示**：加载时把引用换成 `data:` URL（图片渲染行为完全不变，E2E 断言仍通过）
- **保存**：提交前把 data URL 换回引用
- 导出包保留引用；导入时附件 id 原样保留，所以换设备导入后图片照样能显示
- 单测 `attachmentRef.test.ts` 覆盖「data URL ↔ 引用」往返、无关链接不动、引用缺失时保留原样

效果：一张 275 KB 的图不再撑大正文（367 KB → 约 40 字节），同步负载回到 KB 级。

真机验证（2026-11-11 21:25）：PC 加图后正文 `![校徽.jpg](attachment:13368abd…)`（67 字节，改造前 367,747 字节），服务端 `attachments` 两条元数据；手机新 origin 同步 `拉取 4，附件 2/0`，一次 pull 响应 2.4 KB / 2.7 秒（改造前 370 KB / 80 秒）。手机上图片暂时不显示，等附件二进制同步。

## 测试

```text
npm test            -> 15 files, 57 tests passed
npm run build       -> PWA precache 3235.42 KiB
npx playwright test -> 21 passed
```

新增测试：`sync.test.ts`（关系/附件元数据/墓碑）、`autoSync.test.ts`（防抖、退避重试、离线恢复、冲突留存）、`attachmentRef.test.ts`（正文引用往返）。

## 已知边界 / 未完成

- 附件**二进制**尚未同步（只同步元数据）；笔记版本历史尚未同步。
- 设备管理（多设备列表、撤销）未做；自动同步 / 退避重试 / 离线恢复已实现。
- 临时隧道域名会变（= origin 会变，手机上旧 IndexedDB 数据"看不见"）；已改用 Tailscale 固定域名规避。
- Tailscale 方案要求设备先加入同一 tailnet；`serve` 只对 tailnet 内开放（非公网）。
- `cloudflared` 服务器上二进制损坏（1.6 MB 截断），暂不可用；`localhost.run` 实测仅 ~3.4 KB/s，不适合 3 MB 级 PWA。
- 服务器明文存储；OPEN-001=A 允许，但传输依赖 SSH 隧道 / 临时 HTTPS。
- 客户端判断"远端脏"仍用内容时间 `updatedAt`：被回填的旧内容能拉到并新增，但若本地已存在同 ID 且内容不同，会保守地不覆盖（不丢数据）。
- 关系/附件没有 revision，靠最后写入者决定；两端同时删/加同一关系时以最后同步的一方为准。
- **手机窄屏布局未适配**（见上）：390px 下编辑器被压成一条，需要单栏切换。
- 附件二进制已支持（上传/按需下载），但缺少下载进度与失败重试 UI。

## 环境注意

本机没有系统级 Node，`npm` 需要先加便携 Node 路径：

```bat
set PATH=C:\\Program Files\\nodejs;%PATH%
```