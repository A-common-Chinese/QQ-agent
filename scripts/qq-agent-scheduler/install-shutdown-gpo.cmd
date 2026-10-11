@echo off
rem Double-click this to install the Group Policy shutdown script.
rem It asks for administrator rights (UAC), runs the PowerShell installer, and keeps the
rem window open so you can read the result.
setlocal

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator rights...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-shutdown-gpo.ps1" -NoSelfElevate
echo.
echo --- done. Press any key to close. ---
pause >nul
