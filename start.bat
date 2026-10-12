@echo off
setlocal
cd /d "%~dp0"
set ELECTRON_RUN_AS_NODE=
if not exist node_modules (
  where node >nul 2>nul
  if errorlevel 1 ( echo Node.js 20 or newer is required: https://nodejs.org & pause & exit /b 1 )
  echo Installing dependencies ^(first run only^)...
  call npm install
  if errorlevel 1 ( echo npm install failed & pause & exit /b 1 )
)
start "" "node_modules\electron\dist\electron.exe" .