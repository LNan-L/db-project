# Phase 4.6 实施记录 — 附件批量预取与弱网模式

日期：2026-11-12
工程：`D:\\code\\pke`
状态：**已实现、通过本地验收并部署**（2026-11-12 02:36；纯前端）。
来源：Phase 3 收口遗留「1 Mbps 上行下附件按需下载可用，但批量附件不可行」；按 Phase 4.6 处理。

## 一、范围

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| 4.6-a | 打开笔记时一次补齐该篇缺失附件（旧实现只拉正文前 3 个） | 完成 |
| 4.6-b | 下载并发上限 2、单篇总量上限 10 MB，超出预算的留手动下载并提示 | 完成 |
| 4.6-c | 同步面板「弱网模式」开关：开启后打开笔记不自动预取，只提示条数 + 手动「下载」 | 完成 |
| 4.6-d | 多附件时进度显示为「正在下载 N 个附件：总百分比」 | 完成 |
| 4.6-e | 手动重试 / 面板重试 / 手动下载在弱网模式下仍然可用 | 完成 |

## 二、实现

**`src/sync/attachmentPrefetch.ts`（新增）**

- `PREFETCH_CONCURRENCY = 2`、`PREFETCH_TOTAL_BYTES = 10 MB`。
- `planPrefetch(candidates, budget)`：按正文顺序装入预算内的附件，装不下的进 `skipped`；
  未知大小按 0 计（不占预算）。
- `runWithConcurrency(items, limit, worker)`：有界并发、结果顺序稳定。
- 弱网模式存 `meta.attachment_prefetch`（`off` / `auto`，默认 `auto`），按设备本地保存。

**`src/components/NoteEditor.tsx`**

- 下载 effect 重写：先读弱网模式；开启且非手动触发时只 `setPendingDownloads(n)`，不动网络。
- 正常路径取出所有缺失附件的元数据，`planPrefetch` 后以并发 2 下载；每完成一个写入 IndexedDB 并
  清掉失败记录/退避定时器。
- 进度改成 `progressMap`（按附件 id），多附件时聚合为总数百分比。
- 新增提示：「有 N 个附件未下载（弱网模式已停止自动预取）」+「下载」按钮；
  「另有 N 个附件超过单篇预取上限（10 MB）」。
- 手动下载 / 重试 / 面板重试都会置 `forceDownloadRef`，绕过弱网开关。

**`src/components/SyncPanel.tsx`**

- 新增「弱网模式：打开笔记时不自动预取附件（仍可手动下载）」复选框
  （`data-testid="sync-weak-net"`），切换即写 meta，无需保存配置。

## 三、验收与测试

```text
npm run typecheck   -> 通过
npm test            -> 20 files, 82 tests passed
npx playwright test -> 36 passed（新增 attachment-prefetch.spec.ts 2 条）
server verify       -> 52 assertions ALL PASS（服务端本轮无改动）
```

新增用例：

- `tests/unit/attachmentPrefetch.test.ts`：预算装箱顺序与跳过、默认 10 MB 上限、并发不超过 2 且结果有序、
  弱网模式读写。
- `tests/e2e/attachment-prefetch.spec.ts`：
  1. 一篇笔记正文引用 4 个附件 → 打开后 4 个全部下载（旧的「只拉前 3 个」会漏第 4 个），进度条消失；
  2. 打开弱网模式 → 打开笔记不发任何 blob 请求、显示「有 2 个附件未下载」→ 点「下载」→ 2 个附件补齐。

## 四、已知边界

1. **只预取当前打开的笔记**，不在后台为其他笔记批量拉取（避免替用户消耗流量）；「批量」指一篇内的全部附件。
2. 总量上限按单篇 10 MB 估算（用元数据里的 `size`）；元数据缺失按 0，可能略微超出实际预算。
3. 弱网模式是设备本地设置，不随同步走。
4. 附件下载仍走串行退避重试（Phase 4.3）；并发只作用于首次批量预取。

## 五、部署记录（2026-11-12 02:36）

- 仅前端：`dist/` → `/opt/pke-web/site`（旧站点 `site.prev-20261112-023555`），线上
  `assets/index-D5HBNxCN.js`；服务端未重启。
- 手机 PWA 刷新一次后生效。
