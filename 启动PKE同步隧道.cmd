@echo off
chcp 65001 >nul
title PKE 同步隧道 127.0.0.1:3000
echo.
echo  应急用：PC 已改用 Tailscale 直连（同步地址 ts.net），平时不需要这条隧道。
echo  只有 Tailscale 掉线时，才把同步地址临时改回 http://127.0.0.1:3000 并运行本脚本。
echo.
echo  正在建立到 PKE 同步服务器的 SSH 隧道 ...
echo  保持此窗口打开；关闭窗口即断开隧道。
echo.
ssh -i "D:\work\pke-secrets\server-key\pke_deploy_key" -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -N -L 3000:127.0.0.1:3000 root@8.148.85.25
echo.
echo  隧道已断开（退出码 %ERRORLEVEL%）：
echo   - 若提示端口被占用，说明已经有一个隧道在跑。
echo   - 若连接超时，先确认网络能访问服务器 22 端口。
pause
