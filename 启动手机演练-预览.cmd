@echo off
setlocal
cd /d "%~dp0"
set "PATH=C:\\Program Files\\nodejs;%PATH%"
where npm >nul 2>nul
if errorlevel 1 (
  echo Node/npm not found.
  pause
  exit /b 1
)
echo Building Phase 1...
call npm run build
if errorlevel 1 (
  echo Build failed.
  pause
  exit /b 1
)
echo Starting preview at http://127.0.0.1:4273
echo Keep this window open. Then run the tunnel script in another window.
call npm run preview -- --host 127.0.0.1 --port 4273
endlocal
