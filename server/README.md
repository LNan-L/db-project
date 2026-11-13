# PKE sync / web server

服务端两个进程，都只绑回环：

| 组件 | 文件 | systemd | 端口 |
| --- | --- | --- | --- |
| 同步 API | `/opt/pke-sync/server.js`（= 仓库 `server/pke-sync-server.js`） | `pke-sync.service` | `127.0.0.1:3000` |
| 同源 Web | `/opt/pke-web/server.js`（= 仓库 `server/pke-web-server.js`） | `pke-web.service` | `127.0.0.1:8080` |

`pke-web` 静态目录默认 `/opt/pke-web/site`（放最新 `dist` 内容），`/api` 反代到 3000，用于手机同源访问。
手机公网入口靠临时隧道（systemd `pke-tunnel.service`，pinggy）。

## 必需环境

```text
PKE_TOKEN=<random 64 hex>
PKE_DB=/opt/pke-sync/pke-sync.db
PKE_HOST=127.0.0.1
PKE_PORT=3000
```

`pke-web` 额外：

```text
PKE_WEB_ROOT=/opt/pke-web/site
PKE_API_PORT=3000
PKE_WEB_PORT=8080
NODE_PATH=/opt/pke-sync/node_modules
```

## 增量同步游标（2026-11-11）

`pull` 的 `since` 与服务端的变更游标必须同为"服务端时间"，不能用笔记内容时间。
`notes.synced_at` 存服务端接收时刻，`pull` 用 `synced_at > since`；启动时自动给旧库补列并回填。

回归检查（临时库 + 随机端口，不碰生产库）：

```bash
cd /opt/pke-sync
NODE_PATH=/opt/pke-sync/node_modules node verify-pull-since.js --server /opt/pke-sync/server.js
```

脚本自带临时数据库、随机端口和临时附件目录，跑完自动清理，可重复执行
（37 条断言，含设备吊销链路）。

本机也能跑（`server/package.json` 让 Node 把 `server/*.js` 当 CommonJS，根 `package.json` 是 ESM）：

```bash
cd server && npm install
cd .. && node server/verify-pull-since.js
```

## 设备吊销（2026-11-12，Phase 4.1 运维增强）

| 方法 / 路径 | 作用 |
| --- | --- |
| `DELETE /api/v1/devices/:id` | 吊销：写 `revoked_devices` 并移出 `devices` |
| `DELETE /api/v1/revoked-devices/:id` | 恢复：允许该 deviceId 下次同步重新注册 |
| `GET /api/v1/devices` | 返回 `devices` + `revoked` 两组 |

被吊销设备的 `pull` / `push` 返回 `403 {error:'device-revoked'}`，拦截发生在
`touchDevice` 之前，所以旧记录不会在下一次同步时复活。吊销不影响笔记、版本和冲突基线。

局限：token 全局共享，吊销按 deviceId 拦截，不是强认证；按设备独立 token 属后续项。

## systemd

```ini
[Unit]
Description=PKE sync server
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/pke-sync
EnvironmentFile=/etc/pke-sync.env
ExecStart=/usr/bin/node /opt/pke-sync/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

## 本机访问

```bash
ssh -i <key> -N -L 3000:127.0.0.1:3000 root@<ecs-ip>
```

客户端服务器地址填 `http://127.0.0.1:3000`。

## 注意

- 不要把 3000 / 8080 直接开公网。
- `/etc/pke-sync.env` 权限 600。
- 改服务端后：`scp` 覆盖 → `systemctl restart pke-sync` → 跑上面的回归检查。
- 生产库迁移会打印 `synced_at backfilled for N notes`，属正常一次性动作。

## 审计日志（2026-11-12，5.3）

MCP 写操作会记录到 `audit_logs`：

```bash
TOKEN=...; H="Authorization: Bearer $TOKEN"
curl -s -X POST -H "$H" -H 'Content-Type: application/json' \
  -d '{"tool":"write_note","device":"mcp","paramsDigest":"ab12","result":"created","noteId":"..."}' \
  http://127.0.0.1:3000/api/v1/audit-logs
curl -s -H "$H" "http://127.0.0.1:3000/api/v1/audit-logs?limit=20"
```

## MCP（本机进程，不部署到 ECS）

```bash
PKE_SYNC_URL=https://pke.example-tailnet.ts.net \
PKE_TOKEN=<token> node /path/to/pke-phase1/server/mcp-server.js
```

回归：`node server/verify-mcp.js`（自带临时同步库，不碰生产库）。

手动试（默认 token 读 `D:\work\pke-secrets\sync-token.txt`）：

```bash
node server/mcp-call.js tools
node server/mcp-call.js search 实验
node server/mcp-call.js audit --limit 5
```
