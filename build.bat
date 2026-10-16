@echo off
setlocal
cd /d "%~dp0"
title hyper-ide - build installer
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required: https://nodejs.org
  pause
  exit /b 1
)
if not exist node_modules (
  echo Installing dependencies ^(first run only^)...
  call npm install
  if errorlevel 1 ( echo npm install failed & pause & exit /b 1 )
)
echo.
echo Building the installer and the portable zip...
call npm run dist
if errorlevel 1 ( echo Build failed & pause & exit /b 1 )
echo.
echo Packing the source zip...
call npm run zip:source
echo.
echo Done. Everything is in the "release" folder:
dir /b release\*.exe release\*.zip 2>nul
start "" explorer "%~dp0release"
pause