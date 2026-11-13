# Phase 5.0 实施记录 — AI Provider、设置与隐私闸门

日期：2026-11-12
工程：`D:\\code\\pke`
状态：**已实现、通过本地验收并部署**（前端改动；默认关闭，不影响现有功能）。
上游依据：`docs/phase5-bootstrap.md` 的 5.0。

## 一、范围

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| 5.0-a | `AiProvider` 抽象（health / embed / chat），可注入 fetch、可中断 | 完成 |
| 5.0-b | OpenAI 兼容实现（Ollama 与自配远端共用） | 完成 |
| 5.0-c | AI 设置面板：服务类型/地址/模型/嵌入模型/key/总开关 | 完成 |
| 5.0-d | 隐私闸门：按目的地判断远端；授权绑定 origin，改地址即失效 | 完成 |
| 5.0-e | 连通性检查（8s 超时，AbortController 真正取消请求） | 完成 |

## 二、实现

**`src/ai/settings.ts`**

- `AiSettings` 存 `meta.ai_settings`：`enabled`（默认 false）、`providerKind`（仅 UI 标签）、
  `baseUrl`（默认 `http://127.0.0.1:11434/v1`，必须是绝对 http(s)）、`model`、`embeddingModel`、
  `apiKey`、`remoteAllowed`、`remoteConsentAt`、`remoteConsentBaseUrl`（授权绑定的 origin）、
  `vectorSearchEnabled`（5.1 用）。
- **按目的地判断远端**：`isLoopbackBaseUrl()`（127.0.0.1 / localhost / ::1）为真才算本地；
  标签写 local 但地址是远端，同样要求授权（评审 P0-1）。
- **授权绑定地址**：`remoteBlockedReason()` 同时检查 `remoteAllowed`、合法时间戳、以及
  `remoteConsentBaseUrl === 当前 origin`；地址变了旧授权不生效（P0-3）。
- `normalizeAiSettings()`：非法 JSON / 非法时间戳 / 缺字段都回退或置空（fail-closed）；
  保存时保留未知字段，避免旧版本回写抹掉新字段。
- `describeRemoteSend()` 供 5.2 发送前二次确认复用。

**`src/ai/provider.ts`**

- `OpenAiCompatibleProvider`：`GET /models`（健康检查，不带 Content-Type）、
  `POST /embeddings`、`POST /chat/completions`（`stream: false`，temperature 默认 0.2）。
- 所有方法接受 `AbortSignal`；`createProvider()` 内部先跑 `remoteBlockedReason()`，不通过直接抛错
  （P0-2：不再依赖调用方记得检查）。
- loopback 地址不携带 API key（P1-7）；远端只在授权后带 `Authorization`。
- 错误附带服务端返回的简短原因（截断 200 字），并防御畸形响应（非 JSON、data 非数组、维度不一致）。
- 构造时把 fetch 包成箭头函数调用（原生 fetch 直接存成实例方法会 `Illegal invocation`）。

**`src/components/AiPanel.tsx` + `App.tsx`**

- 侧栏「AI」入口（`data-testid="sidebar-ai"`），面板懒加载。
- 本地/远端切换；远端才显示 API key（可一键清除）；远端授权勾选触发 `window.confirm`，
  文案写明将发送到的 **origin**；确认后写时间戳与绑定 origin，取消则保持关闭。
- 改服务地址会立即清空旧授权（P0-3 的 UI 侧）。
- 「测试连接」：先查闸门（未授权/地址非法直接拒绝且不发请求），通过后用 AbortController 8s 超时；
  成功/失败只显示 origin，不显示完整 URL（避免 URL 内嵌凭据出现在界面）。
- 地址必须绝对 http(s)，`abc` 这类相对地址在保存时拒绝（P1-5，避免静默打到站点自身）。

## 三、评审与修复（2026-11-12）

独立评审 Agent 复查后修复：

| 级别 | 问题 | 修法 |
| --- | --- | --- |
| P0 | 闸门按 UI 标签判断，local + 远端地址可绕过 | 改为按 baseUrl 目的地判断；E2E 覆盖「local 标签 + 远端地址」被拒且 0 请求 |
| P0 | 授权只在 UI 一个调用点检查 | `createProvider()` 内部强制检查并抛错；单测锁住 |
| P0 | 授权不绑定地址，改地址可复用旧授权 | 记录 `remoteConsentBaseUrl` 并比对 origin；改地址清空授权 |
| P1 | 读设置失败时弹窗无关闭按钮 | 增加可关闭的错误面板 + 组件测试 |
| P1 | 地址不校验、保存后 state/DB 不一致 | 绝对 URL + http(s) 校验；保存写回 normalize 后的值 |
| P1 | 超时不取消请求 | AbortController + signal 透传到 fetch |
| P1 | key 生命周期 | loopback 不发 key；新增「清除 key」；切地址时授权失效 |
| P2 | 时间戳非法、相对地址、错误信息缺原因、非 JSON 响应、id 不含模型 | 逐项修正 |

## 四、验收与测试

```text
npm run typecheck   -> 通过
npm test            -> 23 files, 101 tests passed
npx playwright test -> 41 passed（ai-settings.spec.ts 5 条）
server verify       -> 52 assertions ALL PASS（服务端本轮无改动）
```

新增用例：

- 单元：设置默认值/规范化/未知字段保留/时间戳与 origin 绑定/目的地分类/非法地址；
  provider 的 health/embed/chat、错误原因、维度校验、signal 透传、`createProvider` 拒绝未授权远端、
  loopback 不带 key、远端带 key。
- 组件：读设置失败可关闭、相对地址保存被拒、未授权远端不发请求。
- E2E：默认本地并保存；**未授权远端 0 请求**；local 标签 + 远端地址被拒；授权绑定 origin（改地址失效）；
  取消确认后仍被拒；授权远端请求携带 `Bearer` key。

## 五、部署记录（2026-11-12 18:20）

- 纯前端：`/opt/pke-web/site`（旧站点 `site.prev-20261112-182046`），线上 `assets/index-DDJv0YGR.js`。
- 服务端未重启；功能默认关闭（`ai_settings.enabled=false`），不影响现有编辑/同步。

## 六、已知边界

1. **浏览器直连本地模型的 CORS**：PC 的 `127.0.0.1:5273`（dev）与 `127.0.0.1:4273`（preview）
   都属 localhost，Ollama 默认放行；手机/PWA 从 `*.ts.net` 访问会被浏览器拦截，
   需要 `OLLAMA_ORIGINS` 或服务端代理。5.2 前定方案。
2. API key 存 IndexedDB（与同步 token 同等级），页面被 XSS 时可读；不写日志、不进备份导出。
3. 闸门在客户端；本机应用，威胁模型与既有 token 相同（不防修改本机代码的人）。
4. AbortController 只取消前端请求，不会中断服务端已开始的计算。
5. AI 总开关默认关闭；5.1/5.2 的入口需同时检查 `enabled` 与对应功能开关。

## 七、下一步

5.1 REQ-301 混合检索：schema v7 `embeddings` 表、切块、余弦、RRF 融合、关闭向量回退 BM25。
