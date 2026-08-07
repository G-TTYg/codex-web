@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-windows.ps1" %*

if errorlevel 1 (
  echo.
  echo codex-web Windows setup failed.
) else (
  echo.
  echo codex-web Windows setup completed.
)

echo.
echo Press any key to close this window.
pause >nul
