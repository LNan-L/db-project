# Phase 4.4 实施记录 — 版本历史服务端分页

日期：2026-11-12
工程：`D:\\code\\pke`
状态：**已实现、通过本地验收并部署（2026-11-12 02:28）**。
来源：Phase 3/4 收口遗留「版本历史服务端上限 200 条，无分页」；按项目负责人决定的 Phase 4.4 处理。

## 一、范围

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| 4.4-a | 服务端 `GET /api/v1/versions/:id` 支持 `limit` + `before` 游标，返回 `nextCursor` | 完成 |
| 4.4-b | 不传参数时保持旧行为（最新 200 条），老客户端不受影响 | 完成 |
| 4.4-c | 版本面板首屏只拉一页（50 条），「加载更多云端历史」按游标追加 | 完成 |
| 4.4-d | 追加时按远端 id 去重；本地版本只在内存里合并，不重复拉 | 完成 |
| 4.4-e | 回归覆盖：服务端分页不重不漏、客户端 URL/游标解析、E2E 两页加载 | 完成 |

## 二、实现

**服务端（`server/pke-sync-server.js`）**

- 游标用自增主键 `id`（插入顺序稳定，避免同 `created_at` 排不稳定）：

```sql
SELECT ... FROM note_versions WHERE note_id = ? AND id < ? ORDER BY id DESC LIMIT ?
```

- `limit` 默认 200、上限 200（`Math.min` 截断）；`before` 非正整数时忽略。
- 仅当本页取满并且确实还有更早的行时返回 `nextCursor`（最后一行 id），否则 `null`——
  这样客户端不会拿着一个没有下一页的游标再请求一次。

**客户端**

- `src/sync/versions.ts`：新增 `fetchRemoteVersionsPage(config, noteId, {before, limit}, fetchImpl)`
  返回 `{versions, nextCursor}`；`fetchRemoteVersions` 保留为「只取第一页」的兼容包装。
- `src/components/VersionHistory.tsx`：首屏 `limit=50`；有 `nextCursor` 时显示「加载更多云端历史」，
  追加后按 id 去重合并再 `buildTimeline(local, merged)`；加载失败提示但不清空已加载内容。
- 同步面板「保存配置」补了 `data-testid="sync-config-save"`，方便测试配置持久化。

## 三、验收与测试

```text
npm run typecheck   -> 通过
npm test            -> 19 files, 78 tests passed
npx playwright test -> 31 passed（新增 version-pagination.spec.ts）
server verify       -> 52 assertions ALL PASS（本机 + 线上）
```

新增用例：

- `tests/unit/versionsSync.test.ts`：分页 URL（`?limit=2&before=12`）、`nextCursor` 解析、
  末页空页、500 时返回空页。
- `tests/e2e/version-pagination.spec.ts`：mock 两页云端版本 → 打开面板只显示 2 条 →
  点「加载更多」→ 3 条、按钮消失、实际发出的 `before=20`。
- `server/verify-pull-since.js`：同一笔记推 5 个版本，默认分页 5 条且无游标；
  `limit=2` 依次取到 `v5/v4`、`v3/v2`、`v1`，末页游标 `null`，三页 id 不重叠。

线上实测（真实数据）：对 `note=d617f796…` 请求 `?limit=1` 返回 1 条、`nextCursor=38`。

## 四、已知边界

1. 只能向「更早」翻页；没有页码跳转，也没有服务端总数统计（`count(*)` 成本随历史增长，暂不提供）。
2. 面板恢复版本后会重置回第一页（已加载的后续页会重新拉取）。
3. 本地版本表仍然是完整读取（本机历史量级小）；只有云端历史走分页。
4. 新写入的版本在后续页里不会出现（游标只向旧数据走），需要刷新面板才能看到最新版本。

## 五、部署记录（2026-11-12 02:28）

| 步骤 | 结果 |
| --- | --- |
| 备份 | `/opt/pke-sync/server.js.bak-20261112-022758`、`verify-pull-since.js.bak-20261112-022758` |
| 上传 + 重启 | `systemctl restart pke-sync` → active，`/health` ok |
| 线上回归 | 52 assertions ALL PASS |
| 前端 | `/opt/pke-web/site`（旧站点 `site.prev-20261112-022828`），线上 `assets/index-mfQU3ryo.js` |
| 真实数据抽查 | `?limit=1` → 1 条 + `nextCursor=38` |
