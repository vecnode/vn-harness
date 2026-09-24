@echo off
rem ============================================================
rem  vn-harness run launcher (double-click friendly)
rem
rem  Starts the pinned DeepSeek Harness web GUI and opens it in
rem  a browser:
rem
rem      npx --yes @deepseek-ai/dsh@<pin> web --no-open [--port <n>]
rem
rem  then watches the app's own output for the URL line it prints
rem  once the server is listening and opens THAT url - launch
rem  token included - in Chrome, falling back to the default
rem  browser.
rem
rem  This file is a WRAPPER ONLY and does no work of its own: the
rem  Windows half of the launcher is run.ps1, right here in the
rem  repo root, and this file forwards every flag to it verbatim.
rem  macOS/Linux run ./run.sh instead. Because it only delegates,
rem  the behaviour, messages and flags are exactly those of
rem      powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1
rem
rem  A .bat is double-clickable where a .ps1 is not - that is the
rem  only reason this file exists. Run it from the repo root (it
rem  reads .dsh-version.json from this folder). The harness stays
rem  in the foreground: Ctrl+C stops it (cmd may then ask
rem  "Terminate batch job (Y/N)?" - answer Y).
rem ============================================================
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
if not "%EXITCODE%"=="0" (
  echo.
  echo ============================================================
  echo  vn-harness run FAILED - exit code %EXITCODE% ^(see above^).
  echo ============================================================
  echo.
  pause
)
exit /b %EXITCODE%
