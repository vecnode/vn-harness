@echo off
rem ============================================================
rem  vn-harness uninstaller (double-click friendly)
rem
rem  Removes what this pack installed into the DeepSeek Harness
rem  web profile: the bundles it added and the patch layer that
rem  came with them, plus the skill folders it copied. It removes
rem  ONLY what it wrote - a bundle or skill a person added
rem  themselves is left alone, and no session, setting or
rem  credential is touched.
rem
rem  No administrator rights are needed or requested.
rem
rem  Flags (forwarded to scripts\uninstall-all.ps1 - run with
rem  -Help for the full list):
rem    -Plugin <name>     remove only the matching bundle(s)
rem    -DshHome <dir>     use this harness home instead of $DSH_HOME
rem    -ProfileName <n>   remove from this profile (default: web)
rem    -DshVersion <ver>  override the pinned dsh version
rem    -NoPause           never hold this window open
rem    -NoTerminal        stay in this console; do not relaunch
rem    -Help / -h / /?    print the help and stop
rem
rem  The console this runs in is decided in ONE place for every
rem  entry point: scripts\console\adapt.cmd.
rem
rem  macOS and Linux: ./uninstall.sh is the same remover in POSIX sh.
rem ============================================================
setlocal

if not defined VN_HARNESS_CONSOLE set "VN_HARNESS_ARGV=%*"
call "%~dp0scripts\console\adapt.cmd" "%~f0" "vn-harness uninstaller"
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

"%VN_HARNESS_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall-all.ps1" %VN_HARNESS_ARGS%
set "VN_EXIT=%ERRORLEVEL%"

echo.
echo ============================================================
if "%VN_EXIT%"=="0" (
  echo [vn-harness] removed successfully.
) else (
  echo [vn-harness] removal FAILED - see the messages above.
)
echo ============================================================
echo.
if "%VN_HARNESS_PAUSE%"=="1" pause
exit /b %VN_EXIT%

:nopowershell
echo.
echo ============================================================
echo  vn-harness could not start.
echo ============================================================
echo.
echo  PowerShell was not found on PATH, and this remover needs it.
echo  Windows PowerShell 5.1 ships with every supported version of
echo  Windows; if it is missing, install PowerShell 7 from
echo  https://aka.ms/powershell and run this file again.
echo.
echo  (macOS and Linux do not use PowerShell at all: run ./uninstall.sh.)
echo.
if "%VN_HARNESS_PAUSE%"=="1" pause
exit /b 2
