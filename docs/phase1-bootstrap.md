# Phase 1 生产工程 — 实现与收口记录

状态：**Phase 1 已收口（2026-11-09，项目负责人批准）**

日期：2026-11-08
路径：`D:\\code\\pke`
决策：OPEN-013=A（重写生产代码，不复制原型实现）

## 本次做了什么

- 新建独立生产工程，原型 `D:\work\projects\pke` 保持不动。
- 技术栈：Vite + React + TypeScript strict + Dexie。
- 生产数据层 v1：
  - `workspaces`（默认 `local`）
  - `notes`（id / workspaceId / title / body / tags / folder / createdAt / updatedAt）
  - `meta`（schema_version）
- 稳定 ID、标签规范化、笔记纯构造函数、CRUD 仓库。
- 测试：Vitest + fake-indexeddb。
- **没有复制原型实现**；本轮只写生产工程自己的数据层。

## 测试结果（第二次）

```text
npm run typecheck -> exit 0
npm test          -> 6 files, 25 tests passed
npm run build     -> exit 0；PWA 129 precache entries / 3191 KiB
npx playwright test -> 12 passed（11/11 对位 + hardening）
```

覆盖：

- 默认笔记字段、稳定 ID、标题/文件夹裁剪、标签去重。
- 默认 workspace + schema_version。
- 笔记创建/更新/列表/删除；重开 IndexedDB 后仍在。
- **原型导出包迁移**：ID/正文/标签/文件夹/附件 hash/关系保留。
- 重复导入幂等；篡改 hash 整包拒绝且不写入。

数据契约见 `docs/phase1-data-contract.md`。

## 生产 UI 第一版

- 笔记列表、新建、选择、编辑标题、Markdown 正文、保存、删除（二次确认）。
- 刷新后从生产 IndexedDB 恢复。
- 编辑器懒加载；主入口 317 KB。
- **只写了 CRUD/Markdown 这一刀，没有复制原型 UI/实现。**

## 生产标签 + 文件夹（第二刀）

- 标签添加/移除；按标签过滤。
- 文件夹字段；按目录过滤；列表显示目录。
- 先写 E2E，跑出失败基线（`note-folder` 不存在），再实现；实现后 E2E 通过。

## 生产双链 + 反向引用（第三刀）

- `[[标题]]` / `[[稳定ID|显示名]]` 解析；跳过代码块/行内代码。
- 编辑器内双链只显示标题，点击跳转；保存当前草稿后再跳。
- 右侧出链/反向引用面板；同名歧义不猜，标断链/歧义。
- 先写 E2E，失败基线为 `outgoing-link` 不存在；实现后通过。

## 生产搜索（第四刀）

- BM25 本地索引：标题/标签/正文加权；中英混合分词；可从正文重建。
- 搜索框、结果摘要、点击打开、命中词高亮、清空恢复。
- 先写 E2E，失败基线为 `search-input` 不存在；实现后通过。

## 生产导入导出 + 同机备份 A + PWA（第五刀）

- ZIP 导出：Markdown、manifest、schema_version、每篇 SHA-256。
- 导入：校验 hash/schema；空白工作区导入；同 ID 跳过；结果预览后确认写入。
- 数据面板：持久化状态、usage/quota、最近导出、7 天备份提醒。
- PWA：service worker 预缓存；断网读写/刷新通过。
- 仍按 OPEN-011=A：同机可恢复副本，不是独立备份。
- 先写 E2E，失败基线为 `open-data` 不存在 / service worker 未注册；实现后通过。

## 生产附件 + 内联图片（第六刀）

- 附件上传/移除；IndexedDB Blob；SHA-256。
- 图片 ≤1 MB 自动内联到正文（data URL）；编辑器直接显示。
- 导出 ZIP 增加 `attachments/`；manifest 记录 hash/size/mime/note_id；导入校验后恢复。
- 先写 E2E，失败基线为 `attachment-input` 不存在；实现后通过。

## Markdown 全要素 + Obsidian/Logseq 导入 + MRC/重启（第七刀）

- 导入 `.md` 文件（多选）；无 manifest；标题取 Frontmatter title 或文件名；正文保留。
- Markdown 标题/列表/引用/代码块/链接/图片/表格逐项 E2E。
- MRC 六步生产回归 + 浏览器完全重启。
- 先写 E2E，失败基线为 `import-file` 非 multiple；实现后通过。

## 批量删除 + 文件夹管理（第八刀）

- 侧边栏批量模式 + 复选框；删除选中（N）二次确认；附件级联删除。
- 文件夹字段/过滤/目录显示。
- 先写 E2E，失败基线为 `batch-toggle` 不存在；实现后通过。

## 收口 + hardening（第九刀）

- React ErrorBoundary，避免渲染错误白屏。
- 坏包导入不写入；取消删除保留笔记；E2E 覆盖。
- 保存状态 `aria-live`、导入消息 `aria-live`、数据面板关闭按钮自动聚焦。
- 测试：25 个单元测试 + 12 个 E2E 通过；生产工程 11/11 对位 + 1 个 hardening。
- 收口报告：`docs/phase1-closure.md`。

## 还没做

- 标签、文件夹、双链/反向引用、搜索。
- 导入导出、备份恢复、BM25。
- 原型 11 个 E2E 中，目前只移植/通过了 CRUD+Markdown 1 个；其余 10 个待生产 UI 支持后移植。
- OPEN-011 B 的加密/网盘/跨设备部分（缺你的密钥/目录/设备信息）。
- git 提交（缺 user.name / user.email）。

## 下一步建议

1. 先写生产数据契约 + 迁移测试：读取原型导出 ZIP，保留 ID/Frontmatter/附件 hash/关系。
2. 再写生产 UI 的 CRUD + Markdown，并移植原型 E2E 作为验收规格。
3. 测试全绿后，再逐模块决定是否借鉴原型实现；不直接复制。

## 启动

```bat
cd D:\\\\code\\\\pke
set PATH=C:\\\\Program Files\\\\nodejs;%PATH%
npm run dev
```

打开 http://127.0.0.1:5273
