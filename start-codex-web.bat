@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-codex-web.ps1" %*

if errorlevel 1 (
  echo.
  echo codex-web exited with an error.
)

echo.
echo Press any key to close this window.
pause >nul
