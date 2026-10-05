@echo off
rem MetaDesk production launcher shim: double-click friendly entry to metadesk.ps1
setlocal
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0metadesk.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0metadesk.ps1" %*
)
endlocal & exit /b %errorlevel%
