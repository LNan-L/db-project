# Phase 5.0.1 实施记录 — chat / embedding 端点拆分

日期：2026-11-12
工程：`D:\\code\\pke`
状态：**已实现、通过本地验收并部署**（2026-11-12 19:52）。
动机：主库方案定为「DeepSeek chat + 硅基流动 BAAI/bge-m3 嵌入」，两家供应商、两把 key；
原设置只有一个 baseUrl/key，无法同时指向两家。

## 一、范围

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| 5.0.1-a | `AiSettings` 拆成 `chat` / `embedding` 两个端点（各自 baseUrl/model/key/授权） | 完成 |
| 5.0.1-b | 每个端点独立远端授权（时间 + 绑定 origin；改地址即失效） | 完成 |
| 5.0.1-c | 设置面板分区：对话端点 / 嵌入端点，各自测试连接、清除 key | 完成 |
| 5.0.1-d | provider 工厂拆分：`createChatProvider` / `createEmbeddingProvider`，各自 fail-closed | 完成 |
| 5.0.1-e | 向量索引/检索只用 embedding 端点；草稿生成只用 chat 端点 | 完成 |
| 5.0.1-f | 旧版单端点设置自动迁移到两个端点（同 baseUrl/key，模型各取各的） | 完成 |

## 二、实现

**设置（`src/ai/settings.ts`）**

```ts
interface AiEndpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
  remoteAllowed: boolean;
  remoteConsentAt: string | null;
  remoteConsentBaseUrl: string | null;
}
interface AiSettings {
  enabled: boolean;
  chat: AiEndpoint;        // 默认 https://api.deepseek.com/v1 + deepseek-chat
  embedding: AiEndpoint;   // 默认 https://api.siliconflow.cn/v1 + BAAI/bge-m3
  vectorSearchEnabled: boolean;
}
```

- `endpointBlockedReason(endpoint)`：按目的地判断 loopback/远端；远端必须「允许 + 合法时间戳 + origin 绑定」。
- 两个端点互不影响：chat 授权不等于 embedding 授权。
- 旧结构（`baseUrl/model/embeddingModel/apiKey/remoteAllowed/...`）载入时自动映射到两端点。
- 保存仍保留未知字段。

**provider（`src/ai/provider.ts`）**

- `createChatProvider(settings)` / `createEmbeddingProvider(settings)`：各自检查对应端点，抛错带角色前缀
  （「对话服务：…」/「嵌入服务：…」）；loopback 不携带 key。

**调用点**

- 混合检索/索引构建 → `createEmbeddingProvider`，向量模型读 `settings.embedding.model`。
- 草稿生成 → `createChatProvider`；检索参考时若 embedding 是远端，会先确认「查询意图将发送到该 origin」，
  生成前再按 chat 端点确认发送篇数/字符数。

**UI（`AiPanel`）**

- 两个分区：对话端点（`ai-chat-*`）、嵌入端点（`ai-embedding-*`），各自 baseUrl/模型/key/授权/测试连接。
- 语义检索区沿用：开关、重建索引、清空索引、已索引状态（模型显示 `embedding.model`）。

## 三、验收与测试

```text
npm run typecheck   -> 通过
npm test            -> 25 files, 119 tests passed
npx playwright test -> 46 passed（ai-settings 双端点 6 条）
server verify       -> 52 assertions ALL PASS（服务端无改动）
```

- 单元：默认值（DeepSeek/硅基流动）；两端点往返与 trim；旧配置迁移；未知字段保留；
  损坏配置回退；授权时间/origin 校验；两端点独立授权；loopback 不需要授权；
  `createChatProvider`/`createEmbeddingProvider` 只读各自端点、各自 key、未授权抛错、loopback 不带 key。
- E2E：两分区默认值与分别测试连接/保存/刷新持久化；未授权 chat 0 请求；chat 授权绑定 origin；
  取消授权保持阻塞；已授权 chat 请求带 `Bearer` key。

## 三·补、交互修复（2026-11-12 19:58）

反馈「没输 key / 点不动」后调整：

- **保存不再要求授权**：远端未授权时也能保存地址/模型/key；授权只影响「使用」（测试连接、检索、草稿），
  保存提示会说明「仍需授权」。
- **授权改为面板内联确认**：勾选「允许…发到远端」后出现「确认发送到 <origin>？允许 / 取消」，
  不再依赖浏览器原生 `confirm`（容易被拦或看不见，表现为「点了没反应」）。
- 没有 key 时「测试连接」返回 401/连接失败是预期；AI 功能在填 key 并启用前不会自动调用。
- 「重建向量索引」的远端确认也改为内联「继续重建/取消」；AI 未启用时显示可见提示（不再只靠按钮 tooltip）。
- 重建失败的提示带「首个错误」（401/模型名/网络可区分）；远端嵌入端点没填 key 时直接拦住并提示，
  不再空跑三次失败。

## 四、已知边界

1. 当前只服务主库；敏感库的库级 AI 策略仍是规划（`docs/dual-library-plan.md`）。
2. 两个端点各自授权；用户需要分别勾选（这是刻意的，避免一次授权覆盖两家供应商）。
3. 旧的单端点设置在首次载入时迁移，但不会自动帮用户改 baseUrl/model（沿用旧值）。
4. embedding 端点若与 chat 端点同为远端，草稿生成可能触发两次确认（检索意图 + 生成内容）。

## 五、部署记录（2026-11-12 19:52）

- 纯前端：`/opt/pke-web/site`（旧站点 `site.prev-20261112-201331`），线上 `assets/index-YluqwVK6.js`（含内联确认/免授权保存/内联重建确认/失败原因与 key 校验）。
- 服务端未重启；设置默认端点指向 DeepSeek / 硅基流动，但 `enabled=false` 且远端未授权，不会自动调用。

## 六、下一步

5.3 REQ-302 MCP：stdio/HTTP 工具（search/read/draft/write），写操作确认 + `audit_logs`；不依赖真实模型，用脚本验收。
