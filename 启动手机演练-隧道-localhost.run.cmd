@echo off
setlocal
echo Starting localhost.run tunnel to http://127.0.0.1:4273
echo Copy the printed https://... URL to your Android phone.
echo Keep this window open.
ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -R 80:localhost:4273 nokey@localhost.run
echo Tunnel closed.
pause
endlocal
