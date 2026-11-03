@echo off
rem SYU guard console - startup entry.
rem Rules for this file: ASCII only, CRLF line endings, no parenthesized blocks,
rem no delayed expansion. cmd.exe mis-parses UTF-8 text and LF-only files.
chcp 65001 >nul
setlocal
cd /d "%~dp0"
set "PORT=8789"
set "BASE=http://127.0.0.1:%PORT%/"
set "NODE=D:\support\node\node.exe"
if not exist "%NODE%" set "NODE="
if defined NODE goto havenode
for /f "delims=" %%P in ('where node 2^>nul') do if not defined NODE set "NODE=%%P"
:havenode
if not defined NODE goto nonode
if /i "%~1"=="check" goto do_check
if /i "%~1"=="console" goto do_console
goto do_full

:do_check
echo node    = "%NODE%"
echo port    = "%PORT%"
echo url     = "%BASE%"
echo arg     = "%~1"
curl -sf -o nul -m 2 "%BASE%api/state" >nul 2>&1
if errorlevel 1 echo console = down
if not errorlevel 1 echo console = up
exit /b 0

:do_console
call :ensure_console
if errorlevel 1 goto console_failed
start "" "%BASE%"
exit /b 0

:ensure_console
curl -sf -o nul -m 2 "%BASE%api/state" >nul 2>&1
if not errorlevel 1 goto ensure_ok
start "SYU-Guard console" cmd /k ""%NODE%" src\console\server.ts"
set /a WAIT=0
:ensure_wait
ping -n 2 127.0.0.1 >nul
curl -sf -o nul -m 1 "%BASE%api/state" >nul 2>&1
if not errorlevel 1 goto ensure_ok
set /a WAIT+=1
if %WAIT% GEQ 20 goto ensure_fail
goto ensure_wait
:ensure_ok
echo console is up: "%BASE%"
exit /b 0
:ensure_fail
exit /b 1

:console_failed
echo.
echo Console did not come up within 20s.
echo Run this in a new window to see the error:
echo   "%NODE%" src\console\server.ts
pause
exit /b 1

:nonode
echo.
echo node.exe not found. Tried D:\support\node\node.exe and PATH.
pause
exit /b 1
:do_full
call :ensure_console
if errorlevel 1 goto console_failed
curl -s -X POST -H "x-syu-console: 1" "%BASE%api/napcat/start" >nul
echo NapCat start requested.
curl -s -X POST -H "x-syu-console: 1" "%BASE%api/bot/start" >nul
echo Guard start requested (needs GUARD_GROUP_IDS and OWNER_QQ in .env).
ping -n 4 127.0.0.1 >nul
start "" "%BASE%"
exit /b 0
