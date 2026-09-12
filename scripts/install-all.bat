@echo off
rem vn-harness installer (console use). Double-click install.bat at the repo root instead for a friendlier prompt.
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-all.ps1" %*
exit /b %ERRORLEVEL%
