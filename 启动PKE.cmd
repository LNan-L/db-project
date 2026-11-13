@echo off
setlocal
cd /d "%~dp0"
set "PATH=C:\\Program Files\\nodejs;%PATH%"

where npm >nul 2>nul
if errorlevel 1 (
  echo Node/npm not found.
  echo Expected: C:\\Program Files\\nodejs
  pause
  exit /b 1
)

echo Starting PKE (main app, port 5273)...
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:5273/'"
call npm run dev -- --host 127.0.0.1 --port 5273 --strictPort
endlocal
