# Phase 1 数据契约（v2，迁移第一版）

## 生产存储（IndexedDB / Dexie）

| 表 | 关键字段 | 说明 |
|---|---|---|
| workspaces | id, name, createdAt | 默认 `local` |
| notes | id, workspaceId, title, body, tags[], folder, createdAt, updatedAt | ID 为稳定身份 |
| attachments | id, noteId, name, mime, size, hash, blob | hash 为内容 SHA-256 |
| note_links | id, sourceId, targetId, target, type, createdAt | 关系索引，派生/迁移用 |
| meta | key, value, updatedAt | schema_version |

- schema_version = 2。
- 笔记 ID 不因标题/文件夹变化；文件夹只做组织。
- 标签去重、去 `#`、拒绝含空格。
- 迁移不覆盖已有笔记：同 ID 已存在则跳过并计数。

## 原型导出包（Phase 0，schema_version=5）

- `manifest.json`：app、schema_version、exported_at、notes、relations、attachments。
- 笔记文件：YAML Frontmatter（id/title/created/updated/tags/folder/schema_version）+ Markdown 正文。
- 附件文件：`attachments/<id>-<name>`，manifest 记录 hash/size/mime/note_id。
- 关系：`source_id`、`target_id`、`target`、`type=wikilink`。

## 迁移规则

1. **ID 原样保留**；不因导入重新生成。
2. 正文/Frontmatter 解码后写入 `notes`；不改写 Markdown 正文。
3. 附件 hash/size 校验通过才写入；hash 不匹配整包拒绝。
4. 关系按 manifest 写入 `note_links`；同 ID/关系重复则跳过。
5. 重复导入幂等：笔记/附件/关系均按 ID 去重。
6. 空库导入是 Phase 1 第一验收场景；冲突覆盖策略在 UI 迁移流程中再做。

## 当前迁移器限制

- 只接受原型 schema_version=5；更早/更新版本拒绝并提示。
- 没有 UI 层导入入口；迁移器是数据层 API。
- 冲突副本/关系重名解析不在本版迁移器处理。
