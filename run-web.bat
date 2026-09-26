@echo off
rem ============================================================
rem  vn-harness launcher - Windows (double-click friendly).
rem
rem  The Windows entry point for the BROWSER half, and the pair of
rem  run-web.sh on macOS/Linux. It does no work of its own: every
rem  flag is forwarded to scripts\run-web.ps1, the worker that sits
rem  beside the installer scripts, which runs the pinned
rem  "npx @deepseek-ai/dsh@<pin> web --no-open", streams the app's
rem  output, reads the "dsh web:" line it prints once the server is
rem  listening and opens THAT url - launch token included - in
rem  Google Chrome, falling back to the default browser. The
rem  harness runs in the FOREGROUND of this window: Ctrl+C stops it.
rem
rem  The desktop window is the other half: run-desktop.bat starts
rem  the very same harness and shows that same url in a native
rem  window instead of a browser tab.
rem
rem  Why the split: a .bat is what Windows double-clicks, and a .bat
rem  is also what carries no execution-policy question, while the
rem  watching-and-opening half needs PowerShell - cmd's `for /f`
rem  reads a child's output only up to EOF, so a pure batch launcher
rem  cannot see the ready line while the harness is still running.
rem  The root stays clean: one entry point per host, the work beside
rem  the other scripts.
rem
rem  Flags (the same as ./run-web.sh):
rem    -Port <n>          listen on this port instead of the default (3080)
rem    -DshHome <dir>     override DSH_HOME (default: DSH_HOME, else USERPROFILE\.dsh)
rem    -DshVersion <ver>  override the pinned dsh version from .dsh-version.json
rem    -NoBrowser         start the server only; open nothing
rem    -DefaultBrowser    skip Google Chrome and use the default browser
rem    -NoPause           never hold this window open
rem    -NoTerminal        stay in this console; do not relaunch
rem    -Help / -h / /?    print the help and stop
rem
rem  The console this runs in is decided in ONE place for every
rem  entry point: scripts\console\adapt.cmd.
rem ============================================================
setlocal

if not defined VN_HARNESS_CONSOLE set "VN_HARNESS_ARGV=%*"
call "%~dp0scripts\console\adapt.cmd" "%~f0" "vn-harness"
if errorlevel 10 exit /b 0
if errorlevel 2 goto :nopowershell

rem -h and /? are the two spellings PowerShell cannot bind; see install.bat for
rem why only the first argument is inspected.
set "VN_HELPREQ="
set "VN_FIRST="
for /f "tokens=1 delims= " %%A in ("%VN_HARNESS_ARGV%") do set "VN_FIRST=%%A"
if /I "%VN_FIRST%"=="-h" set "VN_HELPREQ=-Help"
if /I "%VN_FIRST%"=="/?" set "VN_HELPREQ=-Help"
if /I "%VN_FIRST%"=="--help" set "VN_HELPREQ=-Help"

rem If one of those was found, forward -Help and NOTHING else: the spelling that
rem was there cannot be bound by PowerShell, and a help request has no use for the
rem other flags. Rewriting the whole string is what keeps this safe for a -DshHome
rem path that legitimately contains "-h". See install.bat.
if defined VN_HELPREQ set "VN_HARNESS_ARGS=-Help"

"%VN_HARNESS_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run-web.ps1" %VN_HARNESS_ARGS%
set "VN_EXIT=%ERRORLEVEL%"

rem Exactly 1 is how the worker reports its own failures - a missing manifest, a
rem missing node/npx, an unknown flag. Pausing there keeps a double-clicked window
rem open long enough to read it. A Ctrl+C stop exits with a large status instead,
rem so it closes the window without a misleading banner - and either way a
rem -NoPause run (a script, a scheduler) is never held open.
if "%VN_EXIT%"=="1" (
  echo.
  echo ============================================================
  echo  vn-harness run FAILED - see the messages above.
  echo ============================================================
  echo.
  if "%VN_HARNESS_PAUSE%"=="1" pause
)
exit /b %VN_EXIT%

:nopowershell
echo.
echo ============================================================
echo  vn-harness could not start.
echo ============================================================
echo.
echo  PowerShell was not found on PATH, and the browser launcher needs
echo  it to watch the harness start. Windows PowerShell 5.1 ships with
echo  every supported version of Windows; if it is missing, install
echo  PowerShell 7 from https://aka.ms/powershell and run this again.
echo.
echo  (macOS and Linux do not use PowerShell for this: run ./run-web.sh.)
echo.
if "%VN_HARNESS_PAUSE%"=="1" pause
exit /b 2
