@echo off
rem ============================================================
rem  vn-harness uninstaller (double-click friendly)
rem ============================================================
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\uninstall-all.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
echo.
echo ============================================================
if "%EXITCODE%"=="0" (
  echo  vn-harness removed successfully.
) else (
  echo  vn-harness removal FAILED - see the messages above.
)
echo ============================================================
echo.
pause
exit /b %EXITCODE%
