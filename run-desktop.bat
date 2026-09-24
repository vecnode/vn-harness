@echo off
rem ============================================================
rem  vn-harness DESKTOP launcher - Windows (double-click friendly).
rem
rem  The same harness run.bat shows in a Chrome tab, in a native
rem  window instead. This file builds the small Rust/Tauri shell in
rem  app\ - a no-op when it is already current, because cargo's own
rem  freshness check IS the cache - and then runs it in the
rem  FOREGROUND of this window, so the harness's output stays
rem  readable here. Ctrl+C stops it.
rem
rem  The shell does the work scripts\run-web.ps1 does for the
rem  browser: it starts the pinned
rem  "npx @deepseek-ai/dsh@<pin> web --no-open" on a free loopback
rem  port, watches for the "dsh web:" ready line and shows THAT url
rem  in a WebView2 / WKWebView / WebKitGTK window. The launch token
rem  is a live credential: it is read IN MEMORY in Rust, never
rem  written to a file, never echoed (the ready line is printed with
rem  the token redacted) and never handed to a shell. A URL that does
rem  not name a loopback address is refused instead of opened.
rem
rem  This is deliberately ONE file, unlike run.bat -> scripts\
rem  run-web.ps1: the watching half is Rust here, so cmd never has to
rem  read a running child's output, and there is no PowerShell worker
rem  left to hold. The commands are the same either way - only the
rem  window differs.
rem
rem  Requirements: the Rust toolchain (https://rustup.rs) and Node.js
rem  >= 22 on PATH. The FIRST build compiles the shell's dependencies
rem  and takes a few minutes; after that it is instant, and a rebuild
rem  only happens when something under app\ actually changed.
rem
rem  Flags (forwarded to the shell; the same set as run.bat):
rem    -Port <n>          listen on this port instead of a free one
rem    -DshHome <dir>     override DSH_HOME (default: DSH_HOME, else %USERPROFILE%\.dsh)
rem    -DshVersion <ver>  override the pinned dsh version from .dsh-version.json
rem    -Help              print the help
rem ============================================================
setlocal
set "ROOT=%~dp0"
set "MANIFEST=%ROOT%app\src-tauri\Cargo.toml"
set "EXE=%ROOT%app\src-tauri\target\release\vn-harness-desktop.exe"

if /I "%~1"=="-Help" goto :help
if /I "%~1"=="--help" goto :help
if /I "%~1"=="-h" goto :help
if /I "%~1"=="/?" goto :help

if not exist "%MANIFEST%" (
  echo [vn-harness] %MANIFEST% is missing.
  echo   Run run-desktop.bat from the repository root, where run.bat lives.
  goto :failed
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [vn-harness] cargo was not found on PATH.
  echo   Install the Rust toolchain from https://rustup.rs and run this again.
  echo   Node.js 22 or newer is needed as well, for the harness itself.
  goto :failed
)

echo [vn-harness] Building app\src-tauri ^(cargo does nothing when it is current^)...
cargo build --release --manifest-path "%MANIFEST%"
if errorlevel 1 goto :buildfailed

if not exist "%EXE%" (
  echo [vn-harness] The build reported success but the program is not at
  echo   %EXE%
  goto :failed
)

echo.
echo [vn-harness] Starting the desktop shell. Ctrl+C stops it.
echo.
"%EXE%" %*
set "EXITCODE=%ERRORLEVEL%"
if "%EXITCODE%"=="1" goto :failed
exit /b %EXITCODE%

:help
echo.
echo Usage: run-desktop.bat [flags]
echo.
echo   -Port ^<n^>          listen on this port instead of a free one
echo   -DshHome ^<dir^>     override DSH_HOME (default: %%DSH_HOME%%, else %%USERPROFILE%%\.dsh)
echo   -DshVersion ^<ver^>  override the pinned dsh version from .dsh-version.json
echo   -Help              print this help
echo.
echo Builds app\src-tauri (Rust/Tauri) when it is out of date, then runs the
echo harness from the pinned dsh version in a native window instead of Chrome.
echo Same pin, same profile and same flags as run.bat.
echo.
echo macOS and Linux: the same shell builds with "cargo build --release" in
echo app/src-tauri and runs beside ./run.sh, which is the browser launcher.
echo.
exit /b 0

:buildfailed
echo.
echo [vn-harness] cargo build failed - see the errors above.
goto :failed

:failed
echo.
echo ============================================================
echo  vn-harness desktop FAILED - see the messages above.
echo ============================================================
echo.
pause
exit /b 1
