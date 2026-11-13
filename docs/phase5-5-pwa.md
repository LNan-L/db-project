# Phase 5.5 实施记录 — PC 端 PWA 与收口准备

日期：2026-11-12
工程：`D:\\code\\pke`
状态：**已实现、通过本地验收并部署**（2026-11-12 21:30）。

## 一、范围

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| 5.5-a | 可安装性：manifest 完整（name/short_name/display/start_url/icons） | 完成 |
| 5.5-b | PNG 图标 192/512（由 `public/icon.svg` 栅格化，Chromium 渲染） | 完成 |
| 5.5-c | Service Worker 注册与接管（`navigator.serviceWorker.controller`） | 完成 |
| 5.5-d | 离线读写（既有 E2E 保持通过） | 完成 |
| 5.5-e | 安装入口（apple-touch-icon、theme-color、standalone） | 完成 |
| 5.5-f | 收口报告 `docs/phase5-closure.md` | 完成 |

## 二、实现

**`vite.config.ts`**

- `includeAssets` 增加 PNG 图标，保证进入 precache；
- manifest `icons` 增加 `192x192` / `512x512` PNG（Chrome 安装条件要求 192 与 512）；
- `globPatterns` 增加 `png`。

**`public/icon-192.png` / `icon-512.png`**

- 用 Edge（Chromium）以 512×512 视口渲染既有 `icon.svg` 截图生成，保留透明边角；
- 源 SVG 不变，改图标只需重跑同一脚本。

**`index.html`**

- 增加 `apple-touch-icon` 与 `apple-mobile-web-app-capable`；
- `theme-color` 与 manifest 保持一致（`#0f172a`）。

## 三、验收与测试

```text
npm run typecheck   -> 通过
npm test            -> 26 files, 126 tests passed
npx playwright test -> 49 passed（新增 pwa.spec.ts 1 条）
server verify       -> 52 assertions ALL PASS（服务端无改动）
```

- 新增 `tests/e2e/pwa.spec.ts`：读取 `link[rel=manifest]` → 断言 name/short_name/display/start_url/
  icons 含 192 与 512；逐个请求图标均返回 200；`serviceWorker.ready` 后 reload，
  `navigator.serviceWorker.controller` 为真（真正被 SW 接管）。
- 既有 `offline.spec.ts` 仍通过：断网 reload 后仍能读、改、保存。

## 四、线上验证（部署后）

```text
GET /sw.js                 -> 200
GET /manifest.webmanifest  -> name=Personal Knowledge Engine, display=standalone
GET /icon-512.png          -> 200
precache                   -> 143 entries (3347 KiB)
```

## 五、安装步骤（PC）

1. 打开 `https://pke.example-tailnet.ts.net`（或本地 `npm run build && npm run preview` 的 `127.0.0.1:4273`）；
2. 地址栏右侧出现安装图标（Edge：`…` → 应用 → 安装此站点为应用；Chrome：地址栏安装按钮）；
3. 安装后以独立窗口运行，断网仍可打开与编辑，联网后自动同步。

## 六、已知边界

1. 安装体验依赖浏览器判定（首次访问需 SW 激活并刷新一次）；没有做自定义安装引导条。
2. 图标只有一种样式，没有 maskable 安全区变体；Android 上可能被裁切圆角。
3. iOS 上 PWA 的 IndexedDB 可能被系统回收，敏感/重要内容仍需备份（Phase 6 加密备份议题）。
4. 本地 `preview` 与线上 `*.ts.net` 是两个 origin，IndexedDB 不共享；迁移需先同步（见 `docs/phase5-plan.md` 第 3 节）。

## 七、部署记录（2026-11-12 21:30）

- 纯前端：`/opt/pke-web/site`（旧站点 `site.prev-20261112-213048`），线上 `assets/index-Covi47Bx.js`；
- 服务端未改动。

## 八、下一步

Phase 5 收口：`docs/phase5-closure.md`（范围、验收对照、遗留项、Phase 6 入口）。
