# Phase 1 生产工程 — 对位验收报告

日期：2026-11-09
路径：`D:\\code\\pke`
状态：**Phase 1 已收口（2026-11-09，项目负责人批准）**

## 结果

```text
npm run typecheck -> exit 0
npm test          -> 7 files, 29 tests passed
npm run build     -> exit 0；PWA 129 precache entries / 3202 KiB
npx playwright test -> 15 passed
```

## 与原型的 11 项 E2E 对位

| # | 原型验收 | 生产 E2E |
|---|---|---|
| 1 | CRUD/Markdown | crud.spec.ts |
| 2 | 标签/文件夹 | tags-folders.spec.ts |
| 3 | 双链/反向引用 | links.spec.ts |
| 4 | 搜索/高亮 | search.spec.ts |
| 5 | 导出/空白导入 | backup.spec.ts |
| 6 | 附件/内联图片 | attachments.spec.ts |
| 7 | 离线 | offline.spec.ts |
| 8 | Markdown 全要素/Obsidian/Logseq | markdown-import.spec.ts |
| 9 | MRC 六步 | mrc.spec.ts |
| 10 | 浏览器完全重启 | restart.spec.ts |
| 11 | 批量删除/文件夹管理 | batch-delete.spec.ts |

**生产工程 11/11 对位完成。**  
收口后新增原型 schema 5 ZIP 导入 E2E，总数 14。

## 仍需注意

- OPEN-011 B 未实现；备份仍按 A（同机可恢复副本，不是独立备份）。
- 附件 >1 MB 不内联；图片 alt 在格式规范化时有边界。
- Markdown 列表符号/表格宽度会被编辑器规范化。
- 文件夹不是拖拽/重命名管理；无文件夹删除。
- 没有生产化性能/可访问性专项测试。
- 生产 Package schema=2，与原型 schema=5 通过迁移器衔接；跨版本兼容只覆盖 5→2。
- Phase 1 是否正式收口由项目负责人批准，不由编码 Agent 宣布。
