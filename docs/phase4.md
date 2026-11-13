# Phase 4 实施记录 — 移动端产品化

立项书：`docs/phase4-bootstrap.md`
状态：**A1 / A2 / A3 已完成并真机验证**；手机入口已切换为 Tailscale 固定 HTTPS。收口报告见 `docs/phase4-closure.md`（待批准）。

## A1 窄屏单栏布局（2026-11-11）

- `@media (max-width: 720px)`：侧栏与编辑器单栏；选中笔记时 `.workspace--editing` 隐藏侧栏，编辑器占满宽度，工具栏出现「‹ 列表」。
- 桌面布局不变（1280px 既有 21 条 E2E 作回归闸门）。
- 新增 `tests/e2e/mobile-layout.spec.ts`（390×844）：列表 → 编辑器占满（宽度 > 300px）→ 返回列表。

## A2 扫码配置（2026-11-11）

- `src/sync/shareConfig.ts`：把 `{serverUrl, token}` 编码进 URL **hash**（hash 不发给服务器），PC 侧生成 `<appUrl>#sync=...`。
- 同步面板「配置二维码」：懒加载 `qrcode` 渲染二维码 + 原始链接 + 「复制配置链接」。
- 手机扫码打开链接 → App 解析 hash → 写入本地配置 → 自动打开同步面板。
- 新增 `shareConfig.test.ts`（往返、拒绝非法载荷）；`sync-share.spec.ts`（二维码渲染、链接预填）。
- 依赖：`qrcode` + `@types/qrcode`（npm 镜像安装）。

## A3 附件下载进度与重试（2026-11-11）

- `downloadAttachmentBlobWithProgress()`：读 `response.body` 流，按字节回调进度（服务端 chunked，总量用元数据 size 兜底）。
- 编辑器显示「正在下载 樱花.jpg：45%」；失败显示「附件下载失败」+「重试」按钮（重试触发新一轮下载）。
- 新增 2 条单元测试（流式进度回调、失败返回 null 以便 UI 重试）。

## 测试基线（A3 完成后）

`text
npm run typecheck   -> 通过
npm test            -> 16 files, 61 tests passed
npm run build       -> PWA precache 131 entries / 3272.99 KiB
npx playwright test -> 24 passed
`

## 入口调整（2026-11-12）

- 原计划沿用临时隧道，实施中改为 **Tailscale**：手机 `Redmi Turbo 3` 加入 tailnet（10.0.0.30），固定地址 `https://pke.example-tailnet.ts.net/`。
- `pke-web` 绑定 `10.0.0.10:8080`（仅 tailnet 可达），`tailscale serve` 反代到它并提供证书。
- pinggy 隧道停用（`systemctl start pke-tunnel` 可应急恢复）。
- 手机端 APK 经 gh-proxy 镜像下载（GitHub 直连不可用）。

## 待办

- Phase 4 收口报告待批准（`docs/phase4-closure.md`）。
- 后续：自有域名入口、设备吊销、配置引导优化。
