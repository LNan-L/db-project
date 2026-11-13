# Phase 5 收口报告 — AI / MCP / 质量分析

批准日期：2026-11-12
收口日期：2026-11-12
工程：`D:\\code\\pke`
线上：`https://pke.example-tailnet.ts.net` → `site`（前端）+ `pke-sync`（同步/审计）

## 一、交付范围

| 子阶段 | 需求 | 内容 | 文档 |
| --- | --- | --- | --- |
| 5.0 | — | AI provider 抽象、AI 设置、隐私闸门（按目的地判定 + origin 绑定授权） | `phase5-0-provider.md` |
| 5.0.1 | — | chat（DeepSeek）/ embedding（硅基流动 bge-m3）双端点拆分、各自授权 | `phase5-0-1-endpoints.md` |
| 5.1 | REQ-301 | 混合检索：本地向量索引 + BM25 RRF，失败回退全文 | `phase5-1-hybrid-search.md` |
| 5.2 | REQ-205 | AI 草稿助手：检索参考 → 预览 → 确认写入 | `phase5-2-ai-draft.md` |
| 5.3 | REQ-302 | MCP stdio 服务（搜索/读取/草稿 + confirm 写入 + audit_logs） | `phase5-3-mcp.md` |
| 5.4 | REQ-304 | 质量分析：重复/孤立/断链 + 逐项确认处理 + 审计展示 | `phase5-4-quality.md` |
| 5.5 | — | PC PWA 可安装/离线验证 | `phase5-5-pwa.md` |

## 二、验收对照

| 需求 | 验收原文 | 结果 | 证据 |
| --- | --- | --- | --- |
| REQ-301 | 语义检索可回退 | 通过 | 真实 DeepSeek + bge-m3：索引 4/4，显示「混合检索（全文 + 语义）」；关闭向量回退 BM25（E2E） |
| REQ-205 | 草稿确认后写入 | 通过 | 预览阶段笔记数不变；确认后 4→5，关系落为手动关系（截图存 `docs/phase5-live-confirm.png`） |
| REQ-302 | MCP 工具 + 写操作授权 + 审计 | 通过 | `verify-mcp.js` 21 条 PASS；未确认写入被拒且不落库；审计含 write_note/create_relation |
| REQ-304 | 列出重复/孤立/断链，逐项确认后处理 | 通过 | 单元 7 条 + E2E 2 条；合并确认前取消不改数据，确认后 4→3 |
| 5.5 | PC PWA 安装/离线 | 通过 | `pwa.spec.ts` 校验 manifest/SW 接管；`offline.spec.ts` 断网读写 |

**基线（2026-11-12）**

```text
npm run typecheck   -> 通过
npm test            -> 26 files, 126 tests
npx playwright test -> 49 passed
server verify       -> 52 assertions ALL PASS
```

## 三、关键设计决定

1. **隐私按目的地判定**：只有 loopback 算本地；每个端点单独授权并绑定 origin，改地址即失效；
   非法时间戳视为未授权（fail-closed）。AI 关闭时 0 次 provider 调用。
2. **写入必须确认**：AI 草稿与 MCP 写工具都不会静默落库；MCP 用 `confirm: true`，
   UI 用内联确认行（不再用浏览器原生 `confirm`，避免被拦时表现为「点了没反应」）。
3. **索引不先清空**：重建逐篇覆盖，失败保留旧索引；只有全部成功才清理其它模型旧行。
4. **审计只追加**：`audit_logs` 无更新/删除接口，MCP 写操作自动记录。
5. **主库/敏感库分开**：Phase 5 只做主库（云端 AI）；敏感库只规划，Phase 6 再做（`dual-library-plan.md`）。

## 四、遗留与边界

| 项 | 说明 | 去向 |
| --- | --- | --- |
| 向量索引整表载入内存 | 当前几十篇可接受，上千篇需元数据表/近似索引 | 待定（B-7 性能） |
| 错误不持久化、无熔断 | 靠回退 + 原因提示 | 待定 |
| 关闭向量不自动清索引 | 提供手动「清空索引」 | 可接受 |
| 远端嵌入非逐次确认 | 受端点授权约束，5.2 草稿逐次确认；嵌入按批次 | Phase 6 双库时重审 |
| 敏感库（本地模型） | 只预留位置，完全未开工 | Phase 6 |
| 按设备独立 token | 单 token + 设备注册/撤销 | B-1 |
| 自定义域名 | 暂不购买 | B-2 |
| 画布同步 | 未同步 | B-3 |
| 跨笔记附件预取 | 未做 | B-4 |
| 服务端加密 / 密钥轮换 | 未做 | B-5 / B-6 |
| PWA maskable 图标、iOS 存储回收 | 见 5.5 边界 | B-7 |
| MCP 无 update/delete | 有意限制 | 可接受 |

## 五、Phase 6 入口（草案）

1. **敏感库**：独立 Dexie 库 + 库切换 + 不同步（或加密同步）+ 敏感库强制本地模型 + 加密备份；
2. **本地模型**：Ollama（或等价）安装、模型管理、本地嵌入；
3. **服务端加密与密钥轮换**（B-5/B-6）：如果敏感库要走同步；
4. **性能与可访问性**（B-7）：向量索引规模化、a11y 审计；
5. **可选**：按设备 token（B-1）、画布同步（B-3）、跨笔记附件预取（B-4）。

## 六、结论

Phase 5 的四个 REQ（205 / 301 / 302 / 304）全部通过验收，5.5 的 PC PWA 可安装/离线验证完成。
主库 AI 链路（DeepSeek chat + 硅基流动 bge-m3）已在真实模型下跑通；敏感库与本地模型按负责人决定
推迟到 Phase 6。**Phase 5 可以收口。**
