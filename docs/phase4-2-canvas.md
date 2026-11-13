# Phase 4.2 实施记录 — 无限画布（REQ-201）

日期：2026-11-12
工程：`D:\\code\\pke`
状态：**已实现、通过本地验收并部署到生产站点**（2026-11-12 02:11）。
上游依据：立项设想 Phase 4 原定范围 = REQ-201 无限画布 + REQ-202 全文搜索（后者在 Phase 1 已提前完成）；
Phase 4 当时先做了移动端产品化（A1–A3），本阶段补回原定的 REQ-201。

## 验收标准（来自 `pke/docs/req-open.json`）

> REQ-201：添加、移动画布卡片并建立连线；重新进入后布局保持。

## 一、范围

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| 4.2-a | 画布视图（无限平移/缩放，网格背景），与笔记/图谱并列入口 | 完成 |
| 4.2-b | 从笔记添加卡片、拖动摆放、从画布移除（不删笔记） | 完成 |
| 4.2-c | 拖右侧圆点建立连线，落成手动关系（图谱/同步共用同一份数据） | 完成 |
| 4.2-d | 重新进入后布局保持：卡片坐标 + 视口（平移/缩放）都持久化 | 完成 |
| 4.2-e | 笔记删除后画布卡片自动清理 | 完成 |

## 二、实现

**数据层（schema v6）**

- `src/storage/db.ts`：新增 `canvas_cards` 表（`noteId` 主键，`x/y/createdAt/updatedAt`），`SCHEMA_VERSION = 6`。
  只存「哪篇笔记摆在哪」，不复制正文。
- `src/storage/canvas.ts`：
  - `listCanvasCards` / `saveCanvasCard`（坐标取整、upsert）/ `removeCanvasCard`
  - `pruneCanvasCards(existingNoteIds)`：清掉笔记已删除的卡片
  - `loadCanvasViewport` / `saveCanvasViewport`：视口（`x/y/k`）存 `meta.canvas_viewport`，非法值丢弃

**视图（`src/components/CanvasView.tsx`）**

- 世界坐标 + 视口 `translate/scale`；滚轮以光标为中心缩放（min 30% / max 200%），拖动空白处平移。
- 卡片固定 240×120，拖拽移动（按缩放换算位移），松手写库；双击卡片打开笔记。
- 连线：卡片右侧圆点拖到另一张卡片上，复用 `addManualRelation`；已有连线不重复添加，禁止连自己。
  连线承载在 SVG 上，点击可选中并用工具栏「删除选中连线」移除。
- 新卡片按 3 列网格摆在视口中心附近，避免互相遮挡。
- 笔记列表为空（尚未加载完）时不执行清理，防止把画布误删。
- 视口/卡片位置保存做 400ms 去抖，避免拖动时频繁写 IndexedDB。

**入口（`src/App.tsx`）**

- 视图状态扩为 `notes | graph | canvas`；顶栏、侧栏、右下浮层各加一个「画布」入口。
- 画布上的「双击打开」会把视图切回笔记并选中该篇。

**样式（`src/styles.css`）**

- `.canvas-view / .canvas-stage / .canvas-card / .canvas-edge*`，窄屏（≤720px）隐藏操作提示文字。

## 三、验收与测试

```text
npm run typecheck   -> 通过
npm test            -> 17 files, 70 tests passed
npx playwright test -> 28 passed（新增 canvas.spec.ts）
server verify       -> 37 assertions ALL PASS（服务端本轮无改动）
```

新增用例：

- `tests/unit/canvas.test.ts`：坐标取整/upsert 保留 `createdAt`、单卡删除与 prune、视口往返与非法值拒绝。
- `tests/e2e/canvas.spec.ts`（REQ-201 验收路径）：新建两篇笔记 → 画布添加两张卡片 → 拖动（断言世界坐标变化）
  → 拖圆点建连线（断言 1 条边 + 提示）→ 刷新后卡片坐标与连线仍在 → 缩放 110% 刷新后保持。

视觉证据：`docs/phase4-2-canvas.png`。

## 四、部署记录（2026-11-12 02:11）

- `dist/` 打包上传到 `/opt/pke-web/site`（旧站点保留为 `site.prev-20261112-0211xx`），
  线上入口加载 `assets/index-CbXkjOWZ.js`；`pke-web` active。
- 本轮服务端（`pke-sync`）无改动，不需要重启同步服务。
- 老设备首次打开会走 Dexie v5 → v6 迁移；单元测试覆盖「v5 库升级后笔记/关系不丢、`canvas_cards` 为空」。
- 手机 PWA 需要刷新一次（或重开）才会拿到新版本。

## 四、已知边界

1. **画布布局是本机数据，不参与同步**：不同屏幕尺寸摆放不同，强行同步会互相覆盖。卡片之间的连线是手动关系，
   会同步；笔记内容照常同步。换设备后需要在那边重新摆卡片。
2. 布局**不进 ZIP/加密备份**（备份以笔记、附件、关系为准）；恢复备份后画布为空。
3. 没有卡片尺寸调整、分组、颜色、贴纸等画布装饰；没有自动布局（力导向/对齐吸附）。
4. 大画布（数百张卡）未做虚拟化；当前卡片数量级（几十张）无压力。
5. 连线只能连接画布上已有的两张卡片；跨画布/跨工作区不在范围。

## 五、下一步（Phase 4 小项队列）

按项目负责人决定：Phase 4 原定功能（无限画布）完成后，剩余产品化小项也归入 Phase 4：

| 顺序 | 事项 | 来源 |
| --- | --- | --- |
| 4.3 | 附件下载自动退避重试 | 待办 #3 |
| 4.4 | 版本历史服务端分页（上限 200） | 待办 #4 |
| 4.5 | 手机首次配置引导页 | 待办 #6 |
| 4.6 | 按设备独立 token（让吊销真正生效） | 安全增强 |
| 4.7 | 自有域名 + Let's Encrypt 第二入口（需域名） | 待办 #2 |

Phase 5 保留给 AI（REQ-205 / 301 / 302 / 304），未立项。
