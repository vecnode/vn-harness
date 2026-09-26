@echo off
rem ============================================================
rem  vn-harness DESKTOP launcher - Windows (double-click friendly).
rem
rem  The same harness run-web.bat shows in a Chrome tab, in a native
rem  window instead. The shell does the work scripts\run-web.ps1 does
rem  for the browser: it starts the pinned
rem  "npx @deepseek-ai/dsh@<pin> web --no-open" on a free loopback
rem  port, watches for the "dsh web:" ready line and shows THAT url in
rem  a WebView2 / WKWebView / WebKitGTK window. The launch token is a
rem  live credential: it is read IN MEMORY in Rust, never written to a
rem  file, never echoed (the ready line is printed with the token
rem  redacted) and never handed to a shell. A URL that does not name a
rem  loopback address is refused instead of opened.
rem
rem  This is deliberately ONE file, unlike run-web.bat -> scripts\
rem  run-web.ps1: the watching half is Rust here, so cmd never has to
rem  read a running child's output, and there is no PowerShell worker
rem  left to hold. The commands are the same either way - only the
rem  window differs.
rem
rem  WHERE IT RUNS FROM, AND WHY THAT IS CHECKED FIRST
rem  ------------------------------------------------
rem  A DISTRIBUTION has the built shell beside this file, so it runs it
rem  and needs nothing else - not even Rust. A SOURCE CHECKOUT has no
rem  built shell, so it builds one with cargo (a no-op while it is
rem  current, because cargo's own freshness check IS the cache).
rem
rem  The order is not a preference. A distribution also ships app\ -
rem  the shell's own source, so the folder is complete - which means
rem  "is there a Cargo.toml?" cannot tell the two apart. Only the
rem  presence of the built executable can, and building inside a
rem  distribution would demand a Rust toolchain from somebody who was
rem  only ever asked to click a file.
rem
rem  Flags (forwarded to the shell; the same set as run-web.bat):
rem    -Port <n>          listen on this port instead of a free one
rem    -DshHome <dir>     override DSH_HOME (default: $DSH_HOME, else ~/.dsh)
rem    -DshVersion <ver>  override the pinned dsh version from .dsh-version.json
rem    -Help / -h / /?    print the help and stop
rem  Plus three this launcher owns and never forwards:
rem    -NoBuild           never run cargo; use the binary already built
rem    -NoPause           never hold this window open
rem    -NoTerminal        stay in this console; do not relaunch
rem
rem  Requirements in a SOURCE CHECKOUT: the Rust toolchain
rem  (https://rustup.rs) and Node.js >= 22 on PATH. The FIRST build
rem  compiles the shell's dependencies and takes a few minutes. In a
rem  DISTRIBUTION: nothing - the folder carries its own runtime.
rem
rem  The console this runs in is decided in ONE place for every entry
rem  point: scripts\console\adapt.cmd.
rem ============================================================
setlocal

if not defined VN_HARNESS_CONSOLE set "VN_HARNESS_ARGV=%*"
call "%~dp0scripts\console\adapt.cmd" "%~f0" "vn-harness"
if errorlevel 10 exit /b 0
if errorlevel 2 goto :nopowershell

rem --- help, in every spelling ----------------------------------------------
rem -Help is unambiguous wherever it appears; -h and /? are checked on the FIRST
rem argument only, so a -DshHome path containing "-h" cannot print help instead
rem of starting the app.
if not "%VN_HARNESS_ARGS:-Help=%"=="%VN_HARNESS_ARGS%" goto :help
set "VN_FIRST="
for /f "tokens=1 delims= " %%A in ("%VN_HARNESS_ARGS%") do set "VN_FIRST=%%A"
if /I "%VN_FIRST%"=="-h" goto :help
if /I "%VN_FIRST%"=="/?" goto :help

rem --- the launcher's own flags must not reach the shell ---------------------
rem The Rust shell takes -Port/-DshHome/-DshVersion and nothing else: an unknown
rem flag exits 1 with the flag named (deliberately, so a typo is never ignored).
rem These three are ours, so they are removed before the hand-over.
set "VN_SHELL_ARGS=%VN_HARNESS_ARGS%"
set "VN_SHELL_ARGS=%VN_SHELL_ARGS:-NoPause=%"
set "VN_SHELL_ARGS=%VN_SHELL_ARGS:-NoTerminal=%"
set "VN_NOBUILD="
if not "%VN_HARNESS_ARGS:-NoBuild=%"=="%VN_HARNESS_ARGS%" set "VN_NOBUILD=1"
if not defined VN_NOBUILD goto :haverbuild
set "VN_SHELL_ARGS=%VN_SHELL_ARGS:-NoBuild=%"

:haverbuild
rem --- which artefact runs ---------------------------------------------------
set "VN_BUILT=%~dp0vn-harness.exe"
if exist "%VN_BUILT%" goto :run

set "VN_MANIFEST=%~dp0app\src-tauri\Cargo.toml"
if not exist "%VN_MANIFEST%" (
  echo [vn-harness] Neither vn-harness.exe nor app\src-tauri\Cargo.toml is here.
  echo   Run run-desktop.bat from the repository root, or from a distribution
  echo   folder assembled by distribute.bat.
  goto :failed
)

if defined VN_NOBUILD goto :afterbuild

where cargo >nul 2>nul
if errorlevel 1 (
  echo [vn-harness] cargo was not found on PATH, so the desktop shell cannot
  echo   be built. Install the Rust toolchain from https://rustup.rs and run
  echo   this file again - or run it from a distribution folder, which carries
  echo   the shell already built and needs no Rust at all.
  goto :failed
)

echo [vn-harness] Building app\src-tauri ^(cargo does nothing when it is current^)...
cargo build --release --manifest-path "%VN_MANIFEST%"
if errorlevel 1 goto :buildfailed

:afterbuild
set "VN_BUILT=%~dp0app\src-tauri\target\release\vn-harness-desktop.exe"
if not exist "%VN_BUILT%" (
  echo [vn-harness] The build reported success but the program is not at
  echo   %VN_BUILT%
  goto :failed
)

:run
echo.
echo [vn-harness] Starting the desktop shell. Ctrl+C stops it.
echo.
"%VN_BUILT%" %VN_SHELL_ARGS%
set "VN_EXIT=%ERRORLEVEL%"
if "%VN_EXIT%"=="1" goto :failed
exit /b %VN_EXIT%

:help
echo.
echo Usage: run-desktop.bat [flags]
echo.
echo   -Port ^<n^>          listen on this port instead of a free one
echo   -DshHome ^<dir^>     override DSH_HOME (default: %%DSH_HOME%%, else %%USERPROFILE%%\.dsh)
echo   -DshVersion ^<ver^>  override the pinned dsh version from .dsh-version.json
echo   -NoBuild           never run cargo; use the binary already built
echo   -NoPause           never hold this window open
echo   -NoTerminal        stay in this console; do not relaunch
echo   -Help              print this help
echo.
echo Runs the harness from the pinned dsh version in a native window instead of
echo a Chrome tab - same pin, same profile and same flags as run-web.bat.
echo.
echo From a distribution folder it runs the vn-harness.exe beside this file and
echo needs nothing installed. From a source checkout it builds app\src-tauri
echo with cargo first, which needs the Rust toolchain and Node.js 22 or newer.
echo.
echo macOS and Linux: the same shell builds with "cargo build --release" in
echo app/src-tauri and runs beside ./run-web.sh, the browser launcher.
echo.
if "%VN_HARNESS_PAUSE%"=="1" pause
exit /b 0

:buildfailed
echo.
echo [vn-harness] cargo build failed - see the errors above.
goto :failed

:nopowershell
echo.
echo ============================================================
echo  vn-harness could not start.
echo ============================================================
echo.
echo  PowerShell was not found on PATH, and this launcher needs it to
echo  set the console up. Windows PowerShell 5.1 ships with every
echo  supported version of Windows; if it is missing, install
echo  PowerShell 7 from https://aka.ms/powershell and run this again.
echo.
if "%VN_HARNESS_PAUSE%"=="1" pause
exit /b 2

:failed
echo.
echo ============================================================
echo  vn-harness desktop FAILED - see the messages above.
echo ============================================================
echo.
if "%VN_HARNESS_PAUSE%"=="1" pause
exit /b 1
