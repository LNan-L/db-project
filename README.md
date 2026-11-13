# Personal Knowledge Engine — Phase 1

本地优先的 Markdown 个人知识库。

- Phase 1 已收口（2026-11-09，项目负责人批准）
- Phase 2 已收口（2026-11-09）
- **Phase 3 已收口（2026-11-11）**：本地版本历史、导入冲突、自建同步 + 多端同步/冲突、附件二进制、设备注册（见 `docs/phase3-closure.md`）
- **Phase 4 已收口（2026-11-12，含 4.1–4.6 扩展）**：手机单栏布局、扫码配置、附件下载进度；设备吊销、无限画布、附件退避、版本分页、手机引导、批量预取（见 `docs/phase4-closure.md`）
- **Phase 4.1（2026-11-12 已部署）**：设备吊销 / 恢复、清理旧设备记录（见 `docs/phase4-1-device-revocation.md`）
- **Phase 4.2（2026-11-12）**：无限画布（REQ-201）——卡片添加 / 移动、拖拽连线、布局与视口持久化（见 `docs/phase4-2-canvas.md`）
- **Phase 4.3（2026-11-12）**：附件下载自动退避重试（5s/15s/60s/300s，4 次后保留手动重试；见 `docs/phase4-3-attachment-retry.md`）
- **Phase 4.4（2026-11-12）**：版本历史服务端分页（游标 `before`，面板「加载更多云端历史」；见 `docs/phase4-4-version-pagination.md`）
- **Phase 4.5（2026-11-12）**：手机首次配置引导页（未配置时引导扫码 / 先离线使用；见 `docs/phase4-5-mobile-onboarding.md`）
- **Phase 4.6（2026-11-12）**：附件批量预取（并发 2 / 单篇 10 MB）+ 弱网模式开关（见 `docs/phase4-6-attachment-prefetch.md`）
- **Phase 5 已立项（2026-11-12）**：AI 助手、语义检索、MCP、质量分析（见 `docs/phase5-bootstrap.md`；实现约束见开发者文档第 9 章）
- **Phase 5.0 已完成（2026-11-12）**：AI provider 抽象、AI 设置面板、隐私闸门（见 `docs/phase5-0-provider.md`）
- **Phase 5.1 已完成（2026-11-12）**：语义混合检索（本地向量索引 + BM25 RRF，可回退全文；见 `docs/phase5-1-hybrid-search.md`）
- **Phase 5.2 已完成（2026-11-12）**：AI 草稿助手（检索参考 → 草稿预览 → 确认写入；见 `docs/phase5-2-ai-draft.md`）
- **Phase 5.0.1（2026-11-12）**：AI 设置拆分 chat（DeepSeek）/ embedding（硅基流动 bge-m3）双端点、各自授权（见 `docs/phase5-0-1-endpoints.md`）
- **Phase 5.3 已完成（2026-11-12）**：MCP stdio 服务（搜索/读取/草稿 + confirm 写入 + audit_logs；见 `docs/phase5-3-mcp.md`）
- **Phase 5.4 已完成（2026-11-12）**：质量分析（重复/孤立/断链，逐项确认合并/建目标，审计展示；见 `docs/phase5-4-quality.md`）
- **Phase 5.5 已完成（2026-11-12）**：PC PWA 可安装/离线（PNG 图标、manifest、SW 接管；见 `docs/phase5-5-pwa.md`）
- **Phase 5 已收口（2026-11-12）**：REQ-205/301/302/304 全部验收（见 `docs/phase5-closure.md`）
- **B-7 已完成（2026-11-12）**：图谱布局预算、弹窗键盘可达、图谱 aria 标签（见 `docs/b7-perf-a11y.md`）

## 当前能力

- 笔记 CRUD、Milkdown Markdown 编辑
- 标签、文件夹/过滤、批量删除
- `[[双链]]`、反向引用
- 本地 BM25 搜索 + 命中高亮；语义混合检索（Phase 5.1，可关闭/回退）
- AI 草稿助手（Phase 5.2）：检索参考 → 预览 → 确认写入；远端端点逐次确认
- MCP 服务（Phase 5.3）：stdio 六工具，写操作 `confirm: true` + `audit_logs`
- 质量分析（Phase 5.4）：重复/孤立/断链，逐项确认处理；审计日志展示
- PC PWA 安装与离线（Phase 5.5）
- 图谱视图（Phase 2 已收口）：缩放/平移/拖动、1/2/3 层、搜索定位、手动关系与视觉区分、AI 样式占位
- 无限画布（Phase 4.2）：从笔记添加卡片、自由摆放、拖圆点连线；连线即手动关系（图谱共用），布局与视口本机持久化
- 本地版本历史与恢复（Phase 3a）；云端历史分页加载（Phase 4.4）
- 自建同步服务 + 双端同步/冲突（Phase 3c；PC 走 tailnet 直连，应急可回隧道）
- 设备吊销 / 恢复：同步面板逐台「撤销」，被撤销设备无法再 pull/push，可随时恢复（Phase 4.1）
- ZIP/Markdown 导入导出
- OPEN-011 B 加密备份（口令 + 恢复码 + 网盘目录）
- 附件/内联图片
- PWA 离线、完全重启持久化
- Obsidian/Logseq Markdown 导入

## 启动

```bat
cd D:\\code\\pke
set PATH=C:\\Program Files\\nodejs;%PATH%
npm install
npm run dev
```

默认地址：`http://127.0.0.1:5273`（唯一主入口）。双击 `启动PKE.cmd`。

PC 的同步地址填 `https://pke.example-tailnet.ts.net`：PC 已登录 Tailscale（服务开机自启），
直连同步服务，**不需要 SSH 隧道**，PC 随时可以关机。
应急（Tailscale 不可用时）：双击 `启动PKE同步隧道.cmd`，把同步地址临时改回 `http://127.0.0.1:3000`，用完改回。

## 验证

```bat
npm run typecheck
npm test
npm run build
npx playwright test
```

结果（2026-11-12）：27 个单元测试文件 / 130 个单元测试；53 个 E2E；服务端回归 `node server/verify-pull-since.js` 52 条断言全过。

## 文档

- [合并运行形态](docs/consolidation.md)
- [Phase 1 收口报告](docs/phase1-closure.md)
- [生产对位验收](docs/phase1-parity-report.md)
- [OPEN-011 B](docs/open-011-b.md)
- [实现记录](docs/phase1-bootstrap.md)
- [Phase 4.1 设备吊销](docs/phase4-1-device-revocation.md)
- [Phase 4.2 无限画布](docs/phase4-2-canvas.md)
- [Phase 4.3 附件自动退避](docs/phase4-3-attachment-retry.md)
- [Phase 4.4 版本分页](docs/phase4-4-version-pagination.md)
- [Phase 4.5 手机引导页](docs/phase4-5-mobile-onboarding.md)
- [Phase 4.6 附件批量预取](docs/phase4-6-attachment-prefetch.md)
- [未完成 / 暂缓项目](docs/backlog.md)
- [开发者文档](docs/developer-guide.md)
- [Phase 5 立项书](docs/phase5-bootstrap.md)
- [Phase 5.0 Provider/设置](docs/phase5-0-provider.md)
- [Phase 5.1 混合检索](docs/phase5-1-hybrid-search.md)
- [Phase 5.2 AI 草稿](docs/phase5-2-ai-draft.md)
- [Phase 5.0.1 双端点](docs/phase5-0-1-endpoints.md)
- [Phase 5.3 MCP](docs/phase5-3-mcp.md)
- [Phase 5.4 质量分析](docs/phase5-4-quality.md)
- [Phase 5.5 PC PWA](docs/phase5-5-pwa.md)
- [Phase 5 收口报告](docs/phase5-closure.md)
- [双库规划（主库云端 / 敏感库本地）](docs/dual-library-plan.md)（Phase 6 候选）
- [Phase 5 规划讨论稿](docs/phase5-plan.md)（已被立项书取代）

## 边界

- 数据默认在浏览器 IndexedDB；可选自建同步服务（本仓库 `server/`，家用 ECS + Tailscale）。
- 备份加密包丢失口令/恢复码不可恢复。
- AI 默认关闭；远端端点需逐个授权（按 origin 绑定），关闭时不发任何请求。
- 敏感库（本地模型专用）仅规划，未实现（`docs/dual-library-plan.md`）。
- 密钥轮换（B-6）、服务器加密（B-5）、按设备 token（B-1）仍为后续增强项。
