# Phase 2 — 图谱

验收报告：`docs/phase2-closure.md`（2026-11-09 已收口）。

## 已完成（第一刀）

- 图谱视图切换（笔记 ↔ 图谱）。
- 节点/边来自现有 `[[双链]]` 解析；去重。
- 缩放（50%–250%）、平移、拖动节点。
- 节点选择；双击或「打开笔记」进入编辑器。
- 1/2/3 层邻居局部图谱。
- 搜索定位节点并居中。
- 确定性布局，不依赖随机数。
- E2E：`tests/e2e/graph.spec.ts`。

## 已完成（第二刀：REQ-106）

- 手动关系表（schema v3，`relations`），新增/删除/持久化。
- 图谱中显式双链实线、手动关系蓝色虚线，视觉区分。
- 手动关系随加密备份导出/导入（manifest `type: manual`）。
- 删除笔记级联删除手动关系。
- E2E：`tests/e2e/graph-relations.spec.ts`。

## 待完成

- AI 待审核建议的**样式/占位**已完成（橙色点线、图例、明确标注）；真实 AI 生成在 Phase 5。
- 图谱布局持久化（若需要）。
- 大图谱性能与虚拟化。

## 验证

```text
npm run typecheck -> exit 0
npm test          -> 33 tests passed
npx playwright test -> 18 passed
```
