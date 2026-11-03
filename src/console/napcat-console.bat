@echo off
rem Started by src/console/procs.ts via `start /b cmd /c`. Params: <launcher> <qqPath> <dll> [logPath]
rem chcp 65001 keeps NapCat's UTF-8 console output readable,
rem same as Dyu's napcat\launcher.bat does.
rem
rem Output is redirected HERE, not by procs.ts: `start` gives the launcher its own
rem console, so the parent's stdio redirect never reaches NapCat
rem (napcat.log stayed frozen at 11-02 12:35 until this line existed).
chcp 65001 >nul
if "%~4"=="" (
  "%~1" "%~2" "%~3" --no-sandbox
) else (
  "%~1" "%~2" "%~3" --no-sandbox >> "%~4" 2>&1
)
rem exit /b: the caller wraps this in `cmd /c`. `start` on a .bat would otherwise use
rem cmd /K — that shell outlived NapCat and left one dead console window per restart.
exit /b 0
