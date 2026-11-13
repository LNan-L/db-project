# OPEN-011 B — 加密跨故障域备份（Phase 1 生产实现）

- 决策：项目负责人选择 **B 跨故障域备份**（2026-11-09）。
- 实现工程：`D:\\code\\pke`。
- 状态：**加密备份 + Android 跨设备恢复 + 原生目录选择器写入已通过；密钥轮换未做（非基线项）。**

## 已实现

- AES-256-GCM 加密 ZIP；PBKDF2-SHA256 200,000 次派生。
- 随机 DEK；口令和一次性恢复码各自包裹 DEK；导入可用任一。
- 加密包格式：`PKEB1` + version + salts/ivs/wrapped keys + iv + ciphertext。
- 导出：口令 ≥12 位；下载 `.pke.enc`；显示一次性恢复码和加密包 SHA-256。
- 网盘目录：`showDirectoryPicker({mode:'readwrite'})` 写 `.pke.enc`；不支持时回退下载。
- 导入：识别加密包，口令/恢复码解密后再做 manifest/附件 hash 校验。
- GCM 认证 + manifest/附件 hash 双重校验。
- 测试：29 个单元测试 + 13 个 E2E 通过。

## 跨设备演练证据（2026-11-09）

- 设备：Android 手机；网络：手机流量；PC：网线。
- 通道：localhost.run HTTPS 隧道（旧 URL 失效后换新 URL）。
- 备份：`open-011-b-drill-2026-11-09.pke.enc`，SHA-256 `668c564cea49d4ffcb5a90ca1a0bc699db53cc96c174992e5a39e7fbec9cfebf`。
- 结果：项目负责人确认手机导入成功；测试笔记/正文可见。
- 备注：口令与恢复码不写入仓库；隧道已关闭。

## 目录选择器证据（2026-11-09）

- 通过 Edge `showDirectoryPicker` 选择 `D:\work\pke-backup-drill`。
- Chrome 弹出「允许此站点编辑文件?」并获授权。
- 成功写出 `pke-backup-2026-11-09T02-58-24-632Z.pke.enc`（937 bytes）。
- SHA-256：`bb9508be606c89c981ce95222589ac700cee5662b3a15b68886e30052c516bfa`。
- 说明：验证的是目录选择/写入 API；未绑定具体网盘 provider，实际同步由用户选择的目录负责。

## 恢复码可用性（2026-11-09 补）

- 支持「下载恢复码 .txt」「复制恢复码」。
- 关闭数据面板前，若未勾选“已保存恢复码”，会弹确认；取消则留在面板。
- 仍没有密钥轮换/恢复码重置流程。

## 仍未完成 / 增强项

1. 没有密钥轮换/恢复码重置流程（非 B 基线项）。
2. 加密备份只覆盖当前 production package schema=2。
3. 未绑定具体网盘 provider；实际云同步由用户选择的目录负责。

## 结论

B 基线要求已满足：加密密钥/恢复码、用户指定目录、不同设备恢复演练、hash/GCM 校验。
**OPEN-011 B 验收通过（2026-11-09）**；密钥轮换列为后续增强项。
