# Phase 5.3 实施记录 — MCP（REQ-302）

日期：2026-11-12
工程：`D:\\code\\pke`
状态：**已实现、回归通过、审计接口已部署**（服务端 2026-11-12 20:20）。
上游依据：`docs/phase5-bootstrap.md` 5.3；需求原文：`pke/docs/req-open.json` REQ-302。

## 一、范围

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| 5.3-a | stdio MCP 服务（JSON-RPC 2.0，逐行消息） | 完成 |
| 5.3-b | 工具：`search_notes` / `read_note` / `list_tags` / `draft_note` | 完成 |
| 5.3-c | 受控写入：`write_note` / `create_relation`，必须 `confirm: true` | 完成 |
| 5.3-d | 数据经同步 API（pull/push），不监听端口、不暴露公网 | 完成 |
| 5.3-e | 服务端 `audit_logs` 表 + `POST/GET /api/v1/audit-logs` | 完成 |
| 5.3-f | 回归脚本 `server/verify-mcp.js`（21 条断言） | 完成 |

## 二、实现

**`server/mcp-server.js`**（CommonJS，Node 22 内置 `fetch`）

- 传输：stdin 逐行读 JSON-RPC，stdout 逐行回包；`initialize` / `ping` / `tools/list` /
  `tools/call`；`notifications/*` 不回包。请求串行处理，避免缓存竞态。
- 数据：首次工具调用 `pull?since=1970-01-01` 全量进内存（notes/relations），写操作后缓存失效重拉。
- 搜索：标题 ×3、标签 ×2、正文（最多 5 次）关键词计分，返回 id/标题/摘要；不做向量检索。
- 草稿：`draft_note` 只返回 `{title, body, sourceIds}` 模板，**不写库**；真正的 AI 草稿仍在 UI 5.2。
- 写入：`write_note` / `create_relation` 未带 `confirm: true` 直接 `isError`；
  成功后 `push`（deviceId=`mcp`）→ `POST /api/v1/audit-logs`。
- 环境：`PKE_SYNC_URL`（默认 `http://127.0.0.1:3000`）、`PKE_TOKEN`（必填）、
  `PKE_MCP_DEVICE`（默认 `mcp`）。

**服务端（`server/pke-sync-server.js`）**

- 启动建表 `audit_logs(id, at, tool, device, params_digest, result, note_id)` + 时间索引。
- `POST /api/v1/audit-logs`：只追加，字段截断，返回 id。
- `GET /api/v1/audit-logs?limit=`：按 id 倒序，默认 50、上限 200。

## 三、工具清单

| 工具 | 写入 | 说明 |
| --- | --- | --- |
| `search_notes {query, limit?}` | 否 | 关键词加权搜索，limit 默认 5 / 最大 20 |
| `read_note {id}` | 否 | 返回正文、标签、文件夹、revision |
| `list_tags {}` | 否 | 标签及次数 |
| `draft_note {intent, sourceIds?}` | 否 | 返回草稿模板，明确标注「尚未写入」 |
| `write_note {title, body, confirm}` | 是 | `confirm` 必须为 true；创建笔记并审计 |
| `create_relation {sourceId, targetId, confirm}` | 是 | 手动关系，id=`manual:<a>:<b>`；审计 |

## 四、验收

```text
node server/verify-mcp.js     -> 21 PASS（临时库/随机端口）
node server/verify-pull-since -> 52 assertions ALL PASS
生产审计接口 smoke             -> POST id=1, GET 可见 verify_mcp_smoke
```

覆盖：initialize/tools 列表、搜索命中、读取正文、标签统计、草稿不落库、未确认写入被拒且不落库、
确认写入 revision=1、关系未确认被拒/确认后持久化、audit_logs 含 write_note 与 create_relation。

## 五、使用方式（MCP 客户端配置）

```json
{
  "mcpServers": {
    "pke": {
      "command": "node",
      "args": ["D:\\\\code\\\\pke\\server\\mcp-server.js"],
      "env": {
        "PKE_SYNC_URL": "https://pke.example-tailnet.ts.net",
        "PKE_TOKEN": "<同步 token>",
        "PKE_MCP_DEVICE": "mcp"
      }
    }
  }
}
```

token 取自服务器 `/etc/pke-sync.env` 的 `PKE_TOKEN`；不要写进仓库/日志。MCP 需要笔记已同步；
离线时所有工具都会报「同步服务返回 …」。

### 不接 MCP 宿主也能测：`server/mcp-call.js`

默认读 `D:\work\pke-secrets\sync-token.txt`、连 `*.ts.net`：

```bash
node server/mcp-call.js tools
node server/mcp-call.js search 实验 --limit 3
node server/mcp-call.js read <noteId>
node server/mcp-call.js draft "整理同步与备份" --sources <id1>,<id2>
node server/mcp-call.js write "MCP 测试笔记" "通过 MCP 写入" --confirm   # 不带 --confirm 会被本地拒绝
node server/mcp-call.js relate <sourceId> <targetId> --confirm
node server/mcp-call.js audit --limit 5
```

写入成功后：应用下一次同步（约 30 秒）或刷新后出现新笔记；`audit` 能看到对应记录；
MCP 没有删除工具，测试笔记请在应用里删除。

## 六、边界

1. 只读 + 创建类写入；没有 update/delete 工具（避免 MCP 改坏已有笔记）。
2. `confirm: true` 是「人工批准」的协议信号，MCP 无法替用户判断；客户端需在调用前二次确认。
3. 搜索是关键词（非 5.1 的向量混合），MCP 进程不依赖 embedding/模型。
4. 全量 pull 进内存；当前量级可接受，上千篇需改增量缓存/分页。
5. 审计只追加、没有查询 UI；先用 `GET /api/v1/audit-logs` 或 5.4 的质量分析面板查看。
6. 每次 MCP 拉取会以 `mcp` 设备登记；可在「数据」面板撤销该设备。

## 七、部署记录（2026-11-12 20:20）

- 服务端：备份 `server.js.bak-20261112-202018` + `pke-sync.db.bak-20261112-202018`；
  scp 新 `server.js` → `systemctl restart pke-sync` → 52 条回归通过。
- 前端无改动（MCP 为本地进程），无需重新发布站点。

## 八、下一步

5.4 REQ-304 质量分析：重复/孤立/断链检测 + 审计展示；5.5 PC PWA + 收口。
