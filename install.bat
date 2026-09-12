@echo off
rem ============================================================
rem  vn-harness installer (double-click friendly)
rem  Installs the plugin pack into the DeepSeek Harness WEB
rem  profile only - the raw install used by "npx dsh web"
rem  (DSH_HOME or %USERPROFILE%\.dsh, profile web).
rem  DSH Desktop is not supported by this pack.
rem
rem  A plain run always (re-)adds the bundles from this repo at
rem  their current version - i.e. it behaves as if -Force had been
rem  passed - so a double-click always installs the latest edits,
rem  even when the profile already lists the same version. Passing
rem  -Force yourself is still accepted (it is not duplicated).
rem ============================================================
setlocal
set "EXTRA="
echo %* | findstr /I /C:"-Force" >nul
if errorlevel 1 set "EXTRA=-Force"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-all.ps1" %* %EXTRA%
set "EXITCODE=%ERRORLEVEL%"
echo.
echo ============================================================
if "%EXITCODE%"=="0" (
  echo  vn-harness installed successfully.
) else (
  echo  vn-harness install FAILED - see the messages above.
)
echo ============================================================
echo.
pause
exit /b %EXITCODE%
