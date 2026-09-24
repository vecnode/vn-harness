@echo off
rem ============================================================
rem  vn-harness launcher - Windows (double-click friendly).
rem
rem  The Windows entry point, and the only launcher file at the
rem  repository root; macOS and Linux use ./run.sh. It does no work
rem  of its own: every flag is forwarded to scripts\run-web.ps1, the
rem  worker that sits beside the installer scripts, which runs the
rem  pinned "npx @deepseek-ai/dsh@<pin> web --no-open", streams the
rem  app's output, reads the "dsh web:" line it prints once the
rem  server is listening and opens THAT url - launch token included -
rem  in Google Chrome, falling back to the default browser. The
rem  harness runs in the FOREGROUND of this window: Ctrl+C stops it.
rem
rem  Why the split: a .bat is what Windows double-clicks, and a .bat
rem  is also what carries no execution-policy question, while the
rem  watching-and-opening half needs PowerShell - cmd's `for /f`
rem  reads a child's output only up to EOF, so a pure batch launcher
rem  cannot see the ready line while the harness is still running.
rem  The root stays clean: one entry point per host, the work beside
rem  the other scripts.
rem
rem  Flags (the same as ./run.sh):
rem    -Port <n>          listen on this port instead of the default (3080)
rem    -DshHome <dir>     override DSH_HOME (default: DSH_HOME, else USERPROFILE\.dsh)
rem    -DshVersion <ver>  override the pinned dsh version from .dsh-version.json
rem    -NoBrowser         start the server only; open nothing
rem    -DefaultBrowser    skip Google Chrome and use the default browser
rem    -Help              print the help
rem ============================================================
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-web.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
rem Exactly 1 is how the worker reports its own failures - a missing manifest, a
rem missing node/npx, an unknown flag. Pausing there keeps a double-clicked window
rem open long enough to read it. A Ctrl+C stop exits with a large status instead,
rem so it closes the window without a misleading banner.
if "%EXITCODE%"=="1" (
  echo.
  echo ============================================================
  echo  vn-harness run FAILED - see the messages above.
  echo ============================================================
  echo.
  pause
)
exit /b %EXITCODE%
