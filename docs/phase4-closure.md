# Phase 4 验收 / 收口报告（已收口，含 4.1–4.6 扩展）

日期：2026-11-12
工程：`D:\\code\\pke`
状态：**已于 2026-11-12 由项目负责人批准正式收口**（含收口后追加的 4.1–4.6 扩展）。

## 收口决定

- 批准人：项目负责人（用户）
- 批准日期：2026-11-12（原始 A1–A3 收口 + 当日「先收口 Phase 4」覆盖 4.1–4.6）
- 依据：A1–A3 完成并在真机验证；收口后追加的 4.1–4.6 全部完成、测试、部署；最终基线
  **20 个单元测试文件 / 82 条单元测试、36 条 E2E、52 条服务端断言**全绿。
- 结论：**Phase 4 关闭**。4.7（按设备独立 token）、4.8（自有域名入口）按负责人决定暂不做，
  移入 `docs/backlog.md`；Phase 5（AI）未立项，规划草稿见 `docs/phase5-plan.md`。

## 一、原始范围 A1–A3 + 入口

| 子项 | 内容 | 结果 | 证据 |
| --- | --- | --- | --- |
| A1 | ≤720px 单栏布局；选中笔记全屏编辑 + 「‹ 列表」返回 | 通过 | `tests/e2e/mobile-layout.spec.ts`（390×844） |
| A2 | 同步配置二维码 / 一键链接；扫码写入地址 + token | 通过 | `shareConfig.test.ts`、`sync-share.spec.ts`；PC 生成、手机扫码 |
| A3 | 附件下载进度 + 失败重试 | 通过 | `blobs.test.ts`（流式进度、失败返回 null）；真机进度条实测 |
| 入口 | 固定 HTTPS 入口（原计划临时隧道，实施中调整为 Tailscale） | 通过 | `https://pke.example-tailnet.ts.net/`，手机 `Redmi Turbo 3` 已在 tailnet |

## 二、扩展范围 4.1–4.6（收口后追加）

| 阶段 | 内容 | 结果 | 证据 |
| --- | --- | --- | --- |
| 4.1 | 设备吊销 / 恢复、清理旧记录 | 通过 | `phase4-1-device-revocation.md`；服务端 403 `device-revoked` + 面板撤销/恢复；线上冒烟 |
| 4.2 | 无限画布（REQ-201）：卡片/连线/布局持久化 | 通过 | `phase4-2-canvas.md`；schema v6 + 迁移测试；`canvas.spec.ts` |
| 4.3 | 附件下载自动退避（5s/15s/60s/300s） | 通过 | `phase4-3-attachment-retry.md`；`page.clock` 覆盖恢复与 4 次后停手 |
| 4.4 | 版本历史服务端分页 | 通过 | `phase4-4-version-pagination.md`；游标 `before/nextCursor`，线上真实数据抽查 |
| 4.5 | 手机首次配置引导页 | 通过 | `phase4-5-mobile-onboarding.md`；窄屏/无配置才弹，可跳过或去配置 |
| 4.6 | 附件批量预取 + 弱网模式 | 通过 | `phase4-6-attachment-prefetch.md`；并发 2 / 单篇 10 MB，弱网只提示 |

其中 **4.2 补齐了立项设想里 Phase 4 的原定 REQ-201**（REQ-202 全文搜索在 Phase 1 已提前完成），
至此 Phase 4 的原定功能范围完整。

## 三、最终测试基线（2026-11-12）

```text
npm run typecheck   -> 通过
npm test            -> 20 files, 82 tests passed
npm run build       -> PWA precache 131 entries / 3297.85 KiB
npx playwright test -> 36 passed
server verify       -> 52 assertions ALL PASS  (server/verify-pull-since.js)
```

对比原始收口时（61 单元 / 26 E2E / 26 断言）：单元 +21、E2E +10、服务端断言 +26。

## 四、部署记录

- 服务端改动 2 次：4.1（设备吊销）、4.4（版本分页）。均先备份、重启、跑线上回归。
  - 备份：`pke-sync.db.bak-20261112-013058`、`server.js.bak-20261112-013058`、
    `server.js.bak-20261112-022758`。
- 站点（前端）更新 5 次：4.2 / 4.3 / 4.4 / 4.5 / 4.6；每次保留旧目录
  `site.prev-*`（最近一次 `site.prev-20261112-023555`）。
- 当前线上：`https://pke.example-tailnet.ts.net/` 返回 200，
  加载 `assets/index-D5HBNxCN.js`（4.6 构建）。
- PC 同步已从 SSH 隧道改为 tailnet 直连（`lnan` = `10.0.0.20`），PC 可随时关机。

## 五、真机验收（2026-11-12）

| 验收点 | 实测 |
| --- | --- |
| 窄屏布局 | 390px 下列表整屏、选中笔记后编辑器占满、可返回列表 |
| 扫码配置 | PC 生成二维码 → 手机扫码 → 地址与 token 自动写入 |
| 附件下载进度 | 新增图片后手机显示进度，完成后图片显示 |
| 固定入口 | 手机打开 ts.net 同步成功 |
| 设备吊销（4.1） | 双端验收：撤销旧 Android 记录，面板可见「已撤销」，可恢复 |
| 手机引导（4.5） | 首次进入弹引导，跳过/去配置都正常，第二次不再弹 |

## 六、已知边界 / 遗留

1. **4.7 按设备独立 token**：暂缓（`docs/backlog.md` B-1）。当前 token 全局共享，吊销按 deviceId 拦截。
2. **4.8 自有域名 + Let's Encrypt**：暂不做（B-2），负责人明确暂不购买域名。
3. **画布布局是本机数据**：不同步、不进备份；连线（手动关系）同步（B-3）。
4. **附件预取只覆盖当前笔记**：没有跨笔记后台预取（B-4）。
5. **服务器明文存储**：OPEN-001=A 允许（B-5）。
6. **PC 端 PWA**：dev 模式无 Service Worker；PC PWA 化并入 Phase 5 计划（`docs/phase5-plan.md` 5-PWA）。
7. **性能 / 可访问性专项审计**未做（B-7）。
8. 手机仍需安装 Tailscale 客户端并登录 tailnet。

## 七、结论

Phase 4 从「手机能用」扩展为「移动端产品化 + 运维收口」：A1–A3 真机可用，4.1–4.6 全部实现、
测试并上线，原定的 REQ-201 已补齐，测试基线接近翻倍。Phase 4 正式关闭；后续工作进入
Phase 5（AI）立项，4.7/4.8 等未排期事项按 `docs/backlog.md` 的重启条件处理。
