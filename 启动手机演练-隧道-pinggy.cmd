@echo off
setlocal
echo Starting pinggy tunnel to http://127.0.0.1:4273
echo Copy the printed https://... URL to your Android phone.
echo Keep this window open.
ssh -p 443 -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R0:localhost:4273 a.pinggy.io
echo Tunnel closed.
pause
endlocal
