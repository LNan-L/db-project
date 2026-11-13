# Phase 3 验收 / 收口报告（已收口）

日期：2026-11-11
工程：`D:\\code\\pke`
状态：**已于 2026-11-11 由项目负责人批准正式收口。**

## 收口决定

- 批准人：项目负责人（用户）
- 批准日期：2026-11-11
- 依据：Phase 3a / 3b / 3c 验收项全部通过；57 单元测试 + 21 E2E + 服务端 26 条回归断言；真机（PC ↔ 服务端 ↔ 手机）互推、冲突、删除、附件二进制全部实测。
- 结论：**Phase 3 关闭**；同步与版本历史进入维护状态。产品化增强（手机入口、窄屏布局、设备吊销、附件下载 UI）归入 Phase 4，另立项。

## 范围对照

| 子项 | 需求 | 验收内容 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 3a | REQ-303 | 本地版本历史：每次保存前快照、可查看、可恢复、恢复本身也进历史 | 通过 | `versions.test.ts`、`version-history.spec.ts` |
| 3b | REQ-204 | 导入同 ID 不同内容不再静默跳过；预览 + 三种解决（保留本地 / 使用远端 / 冲突副本） | 通过 | `package.test.ts`、`conflict.spec.ts` |
| 3c | REQ-204 / REQ-303 | 自建同步服务 + 客户端先拉后推 + revision + 冲突检测与解决 + 删除墓碑 | 通过 | `sync.test.ts`、`sync-ui.spec.ts`、真机验收（见下） |

## 实现清单

**客户端**

- `src/sync/sync.ts`：先拉后推、revision 基线、冲突检测、三种解决、墓碑、关系/附件元数据、附件上传调度。
- `src/sync/autoSync.ts`：2 秒防抖自动同步、退避重试 5s/15s/60s/300s、离线恢复、冲突留存。
- `src/sync/blobs.ts`：附件文件上传 / 按需下载。
- `src/sync/versions.ts`：云端版本拉取 + 与本机版本合并成时间线。
- `src/sync/devices.ts`：设备列表。
- `src/markdown/attachmentRef.ts`：正文存 `![name](attachment:<id>)`，显示时换回 data URL。
- `src/storage/tombstones.ts`：笔记/关系/附件删除墓碑。
- schema **v5**：新增 `sync_tombstones`、`attachment_refs`，Dexie 自动迁移。

**服务端**（`server/pke-sync-server.js`）

- API：`/health`、`/api/v1/pull`、`/api/v1/push`、`/api/v1/versions/:id`、`/api/v1/devices`、`PUT|GET /api/v1/attachments/:id/blob`。
- 增量游标用 `synced_at`（服务端接收时间）+ 单调游标；旧库自动迁移回填。
- 附件元数据在 sqlite，文件在 `/opt/pke-sync/blobs`；Bearer 鉴权，单文件上限 16 MB。
- 设备注册表：每次 pull/push 记录 deviceId / 名称 / 最近活跃。
- 回归脚本 `server/verify-pull-since.js`：临时库 + 临时 blob 目录，26 条断言。

**访问入口**

| 入口 | 用途 | 说明 |
| --- | --- | --- |
| `127.0.0.1:5273` | PC 主应用 | 唯一主入口 |
| SSH 隧道 `127.0.0.1:3000` | PC 同步 | 已验证 |
| `tailscale serve` | tailnet 内固定 HTTPS | `https://pke.example-tailnet.ts.net/` |
| pinggy 临时隧道 | 手机（不装 App） | 域名 60 分钟变；已实测可用 |

## 真机验收（2026-11-11）

| 验收点 | 实测结果 |
| --- | --- |
| PC 首次推送 | revision=1 |
| 手机首次拉取 | 拉取 1、推送 0，服务端 revision 不虚增（未反写） |
| 手机修改后同步 | rev=2，device 变为手机 UUID，版本历史 +1 |
| PC 修改后同步 | rev=3 |
| 换 origin 后手机重配 | 拉取 1、推送 1，新 deviceId 正常，rev=4 |
| 双方都改 | 冲突 1、本地/远端并列、**推送 0（不静默覆盖）** |
| 使用远端 | 只改本地不推送，服务端 revision 不动 |
| 删除传播 | 笔记/关系墓碑进服务端，关系墓碑保留两端 id |
| 关系同步 | 加/删均与服务端一致，历史墓碑可翻回 live |
| 附件元数据 | `attachments` 两条（樱花.jpg 275,776 B / 校徽.jpg 119,715 B） |
| 附件二进制 | 两张图上传后 blob 大小与元数据一致；手机按需下载后图片显示 |
| 正文体积 | 内联 base64 改造后正文 367,747 B → 67 B；一次 pull 370 KB / 80 s → 2.4 KB / 2.7 s |
| 自动同步 | 保存后 2–3 秒自动同步，列表自动刷新 |
| 版本历史 | 面板显示「云端历史 N 条」，本机/云端标签，云端版本可恢复 |
| 设备注册 | 面板显示已注册设备（Windows 本机；Android 下次同步后登记） |

## 测试基线（2026-11-11）

`text
npm run typecheck   -> 通过
npm test            -> 15 files, 57 tests passed
npm run build       -> PWA precache 130 entries / 3246.79 KiB
npx playwright test -> 21 passed
server verify       -> 26 assertions, ALL PASS
`

## 已知边界 / 遗留

1. **手机窄屏布局未适配**：390px 下侧栏与编辑器并排，编辑器被压到约 100px、正文逐字换行；`responsive.spec.ts` 只覆盖 1280px。
2. 附件下载缺少进度提示与失败重试 UI（当前静默重试到下一轮）。
3. 设备注册表只能看，不能吊销/踢出。
4. 版本历史服务端上限 200 条，无分页。
5. 手机公网入口仍是临时隧道；`tailscale funnel` 在大陆网络实测 20% 请求超时（3–6 s/请求），不作默认。
6. `cloudflared` 在服务器上二进制损坏（1.6 MB 截断），未重装。
7. 服务器明文存储；OPEN-001=A 允许，传输依赖 SSH 隧道 / HTTPS。
8. 1 Mbps 上行：文本够用，附件（百 KB 级）按需下载尚可，批量附件不可行。

## 结论

Phase 3 的三条线（本地版本历史、导入冲突、自建同步与多端冲突）**验收通过**：核心链路在真机上闭环，同步范围覆盖笔记、手动关系、附件元数据与附件文件，删除可传播，冲突不静默覆盖。

以上遗留项均属**产品化增强**，不影响 Phase 3 的验收目标。建议批准收口，把手机入口、窄屏布局、设备吊销等并入下一阶段。
