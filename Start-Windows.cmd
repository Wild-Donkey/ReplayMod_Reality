@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0.tools\node\node.exe" set "PATH=%~dp0.tools\node;%PATH%"
if exist "%~dp0.tools\node\bin\node.exe" set "PATH=%~dp0.tools\node\bin;%PATH%"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js LTS with npm, then run this file again.
  pause
  exit /b 1
)
node "%~dp0scripts\start\launch.cjs"
if errorlevel 1 (
  pause
  exit /b 1
)
endlocal
