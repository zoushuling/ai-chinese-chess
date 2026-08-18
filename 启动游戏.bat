@echo off
setlocal EnableExtensions
rem ============================================================
rem  AI Chess Xiangqi - one-click launcher (pure ASCII, robust)
rem  Requires Node.js. Starts a local server and opens browser.
rem  Close this window to stop the server.
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"

set "PF=%ProgramFiles%"
set "PF86=%ProgramFiles(x86)%"
set "LAPPDATA=%LocalAppData%"
set "NODE_CMD=node"
set "HAS_NODE=0"

where node >nul 2>nul
if not errorlevel 1 set "HAS_NODE=1"
if "%HAS_NODE%"=="0" if exist "%PF%\nodejs\node.exe" (
  set "NODE_CMD=%PF%\nodejs\node.exe"
  set "HAS_NODE=1"
)
if "%HAS_NODE%"=="0" if exist "%PF86%\nodejs\node.exe" (
  set "NODE_CMD=%PF86%\nodejs\node.exe"
  set "HAS_NODE=1"
)
if "%HAS_NODE%"=="0" if exist "%LAPPDATA%\Programs\nodejs\node.exe" (
  set "NODE_CMD=%LAPPDATA%\Programs\nodejs\node.exe"
  set "HAS_NODE=1"
)
if "%HAS_NODE%"=="0" (
  echo.
  echo  [ERROR] Node.js was not found on this PC.
  echo  Please install it from https://nodejs.org  then run this file again.
  echo.
  pause
  exit /b 1
)

echo.
echo  ============================================
echo   AI Chess Xiangqi - starting local server
echo   Opening browser at http://localhost:8800
echo   Close this window to stop the server.
echo  ============================================
echo.

"%NODE_CMD%" scripts\serve.js
pause
