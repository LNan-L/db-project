# Phase 4.3 实施记录 — 附件下载自动退避重试

日期：2026-11-12
工程：`D:\\code\\pke`
状态：**已实现、通过本地验收并部署到生产站点**（2026-11-12 02:23）。
来源：Phase 3/4 收口时留下的边界「附件下载失败只有手动重试」；本次按项目负责人决定的 Phase 4.3 处理。

## 一、范围

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| 4.3-a | 失败后按 5s → 15s → 60s → 300s 自动重试 | 完成 |
| 4.3-b | 四次自动重试后停手，保留手动重试按钮 | 完成 |
| 4.3-c | 编辑器显示「第 N 次失败 / 稍后自动重试 / 自动重试已停止」 | 完成 |
| 4.3-d | 同步面板显示同样的退避状态，手动重试重置计数并取消定时器 | 完成 |
| 4.3-e | 同一附件并发下载去重（修掉 effect 重入导致的重复请求） | 完成 |
| 4.3-f | 关闭笔记时取消定时器并暂停展示，避免后台空转 | 完成 |

## 二、实现

**`src/sync/blobRetry.ts`（新增）**

- `BLOB_RETRY_DELAYS_MS = [5000, 15000, 60000, 300000]`；`retryDelayFor(attempt)` 返回第 N 次失败后的延迟，
  超出序列返回 `null`（停止自动重试）。
- `scheduleBlobRetry(id, attempt, run)`：同一附件只保留一个定时器（重复安排会替换）；
  `cancelBlobRetry` / `cancelAllBlobRetries` 负责取消。

**`src/sync/blobStatus.ts`（扩展）**

- 失败记录从 `{id, name}` 扩展为 `{id, name, attempts, nextRetryAt, exhausted}`，供编辑器与同步面板共用。
- 新增 `pauseAllBlobRetries()`：编辑器卸载时清掉「自动重试中」的展示，但保留失败记录（仍可手动重试）。

**`src/components/NoteEditor.tsx`**

- 用 `retryAttemptsRef` 按附件记录失败次数；失败时计算出下次时间并登记，定时器到点触发 `downloadNonce` 重跑下载。
- 成功时清失败记录、取消该附件的定时器、重置计数。
- 手动重试（编辑器按钮 / 同步面板广播）会取消所有定时器、清零计数、立即重下。
- 新增 `inFlightRef` 去重：`attachments` 状态变化会让下载 effect 重跑一次，之前会并发重复拉同一个附件（弱网下翻倍耗流），现在跳过进行中的 id。

**`src/components/SyncPanel.tsx`**

- 失败行追加状态：「已失败 N 次，已安排自动重试」/「自动重试已停止（已失败 N 次），可手动重试」。

## 三、验收与测试

```text
npm run typecheck   -> 通过
npm test            -> 19 files, 77 tests passed
npx playwright test -> 30 passed
server verify       -> 37 assertions ALL PASS（服务端本轮无改动）
```

新增用例：

- `tests/unit/blobRetry.test.ts`：退避序列（含越界/非整数）、到点触发、同附件去重、取消与停止。
- `tests/unit/blobStatus.test.ts`：失败记录字段、暂停、手动重试清空并广播、订阅快照。
- `tests/e2e/attachment-auto-retry.spec.ts`（用 `page.clock` 控制时间，不真等 6 分钟）：
  1. 失败 1 次 → 5s 后自动重试成功（不点任何按钮）；
  2. 一直失败 → 5s/15s/60s/300s 共 4 次自动重试后停手，再快进 10 分钟也不发请求；
     同步面板显示「自动重试已停止」，手动重试仍可用且计数重新从 1 开始。
- `tests/e2e/attachment-progress.spec.ts` 调整：改为失败 1 次后手动重试成功，避免 5s 自动重试抢先。

## 四、已知边界

1. 退避只在**笔记打开期间**跑：关闭笔记会取消定时器，面板仍显示失败并可手动重试。这样不会在后台空转请求。
2. 固定序列，没有加随机抖动（单客户端串行重试，暂不需要）。
3. 一次最多处理正文里前 3 个缺失附件（沿用既有上限），其余打开下次再拉。
4. 没有跨设备协同重试：每台设备各自退避。

## 五、部署记录（2026-11-12 02:23）

- `dist/` 上传到 `/opt/pke-web/site`（旧站点保留为 `site.prev-20261112-022237`），线上加载 `assets/index-BUjKbVR9.js`。
- 服务端 `pke-sync` 无改动，未重启。
- 手机 PWA 需刷新一次（或重开）拿新版本；退避逻辑只在前端。
