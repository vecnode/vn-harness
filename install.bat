@echo off
rem ============================================================
rem  vn-harness installer (double-click friendly)
rem
rem  Installs the plugin pack into the DeepSeek Harness WEB
rem  profile only - the raw install used by "npx dsh web"
rem  (DSH_HOME or %USERPROFILE%\.dsh, profile web).
rem  DSH Desktop is not supported by this pack.
rem
rem  A plain run always (re-)adds the bundles from this repo at
rem  their current version - i.e. it behaves as if -Force had been
rem  passed - so a double-click always installs the latest edits,
rem  even when the profile already lists the same version. Passing
rem  -Force yourself is still accepted (it is not duplicated), and
rem  neither is added to a help request.
rem
rem  No administrator rights are needed or requested: the pack
rem  installs into the current user's harness home.
rem
rem  Flags (forwarded to scripts\install-all.ps1 - run with -Help
rem  for the full list):
rem    -Plugin <name>     install only the matching bundle(s)
rem    -DshHome <dir>     use this harness home instead of $DSH_HOME
rem    -ProfileName <n>   install into this profile (default: web)
rem    -DshVersion <ver>  override the pinned dsh version
rem    -Force             re-add even when the version is unchanged
rem    -NoPause           never hold this window open
rem    -NoTerminal        stay in this console; do not relaunch
rem    -Help / -h / /?    print the help and stop
rem
rem  The console this runs in - which window, which PowerShell, whether the
rem  window is held open - is decided in ONE place for every entry point in
rem  this repository: scripts\console\adapt.cmd. Read its header for why.
rem
rem  macOS and Linux: ./install.sh is the same installer in POSIX sh.
rem ============================================================
setlocal

rem The three lines adapt.cmd documents. The guard on the first one is what keeps
rem the real flags when Windows Terminal relaunches this file.
if not defined VN_HARNESS_CONSOLE set "VN_HARNESS_ARGV=%*"
call "%~dp0scripts\console\adapt.cmd" "%~f0" "vn-harness installer"
if errorlevel 10 exit /b 0
if errorlevel 2 goto :nopowershell

rem The two help spellings PowerShell itself cannot bind (-h would be read as a
rem parameter prefix, /? as a stray argument) are translated here. Only the FIRST
rem argument is inspected, so a -DshHome path that happens to contain "-h" cannot
rem turn an install into a help screen. -Help and --help need no translation.
set "VN_HELPREQ="
set "VN_FIRST="
for /f "tokens=1 delims= " %%A in ("%VN_HARNESS_ARGV%") do set "VN_FIRST=%%A"
if /I "%VN_FIRST%"=="-h" set "VN_HELPREQ=-Help"
if /I "%VN_FIRST%"=="/?" set "VN_HELPREQ=-Help"
if /I "%VN_FIRST%"=="--help" set "VN_HELPREQ=-Help"

rem If one of those was found, forward -Help and NOTHING else. Two reasons: the
rem spelling that was there cannot be bound by PowerShell at all, so leaving it in
rem would make it bind positionally and fail; and a help request has no use for
rem the other flags. Rewriting the whole argument string (rather than deleting the
rem spelling from it) is also what keeps this safe for a -DshHome path that
rem legitimately contains "-h".
if defined VN_HELPREQ set "VN_HARNESS_ARGS=-Help"

rem The implied -Force, skipped for a help request.
set "VN_EXTRA="
if not defined VN_HELPREQ if "%VN_HARNESS_ARGV:-Force=%"=="%VN_HARNESS_ARGV%" set "VN_EXTRA=-Force"

"%VN_HARNESS_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-all.ps1" %VN_HARNESS_ARGS% %VN_EXTRA%
set "VN_EXIT=%ERRORLEVEL%"

echo.
echo ============================================================
if "%VN_EXIT%"=="0" (
  echo [vn-harness] installed successfully.
) else (
  echo [vn-harness] install FAILED - see the messages above.
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
echo  PowerShell was not found on PATH, and this installer needs it.
echo  Windows PowerShell 5.1 ships with every supported version of
echo  Windows; if it is missing, install PowerShell 7 from
echo  https://aka.ms/powershell and run this file again.
echo.
echo  (macOS and Linux do not use PowerShell at all: run ./install.sh.)
echo.
if "%VN_HARNESS_PAUSE%"=="1" pause
exit /b 2
