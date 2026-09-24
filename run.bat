@echo off
rem ============================================================
rem  vn-harness launcher - Windows (double-click friendly).
rem
rem  This is the WINDOWS half of the run launcher and the only
rem  file it needs; macOS and Linux run ./run.sh instead. Both
rem  halves do the same work with the same flags, print the same
rem  messages and put the same tab on screen, so keep them in step.
rem
rem  It runs the pinned CLI exactly the way the installer does:
rem
rem      npx --yes @deepseek-ai/dsh@<pin> web --no-open [--port <n>]
rem
rem  streams the app's own output into this console, and watches it
rem  for the URL line the app prints once the server is listening:
rem
rem      dsh web: http://127.0.0.1:3080/?token=<launch token> (LAN: ...)
rem
rem  That exact URL - token included - is what gets opened, in
rem  Google Chrome when Chrome is installed and in the platform's
rem  default browser otherwise. --no-open is passed so the app does
rem  not also start a browser: this launcher owns the hand-off, and
rem  one URL must not open twice. The harness runs in the FOREGROUND
rem  of this window: Ctrl+C stops it.
rem
rem  THE TOKEN IS A LIVE CREDENTIAL - the value the server exchanges
rem  for the browser session cookie. It is read from the app's own
rem  output IN MEMORY, never written to a file and never echoed by
rem  this script. Cmd has no argv hand-off, so the URL reaches the
rem  browser as ONE QUOTED ARGUMENT of `start`, i.e. through cmd's
rem  own parser: because that argument is quoted, a token would have
rem  to contain a double quote to break out of it, and the harness's
rem  launch tokens are hex/base64url. That argv guarantee is the one
rem  thing given up against the PowerShell launcher this file
rem  replaced - the no-file, no-echo and loopback-only rules are the
rem  same.
rem
rem  Only a loopback URL is opened. The host is parsed out of the URL
rem  and must be `localhost`, a 127.x.x.x address or `[::1]`; a line
rem  naming any other host is REFUSED and nothing is opened.
rem
rem  Known differences from that PowerShell launcher, so nobody is
rem  surprised: `for /f` DROPS BLANK LINES from the app's output (the
rem  text of every line is otherwise passed through untouched), and
rem  after Ctrl+C cmd itself may ask "Terminate batch job (Y/N)?" -
rem  answer Y.
rem
rem  Flags (the same as ./run.sh):
rem    -Port <n>          listen on this port instead of the default (3080)
rem    -DshHome <dir>     override DSH_HOME (default: DSH_HOME, else USERPROFILE\.dsh)
rem    -DshVersion <ver>  override the pinned dsh version from .dsh-version.json
rem    -NoBrowser         start the server only; open nothing
rem    -DefaultBrowser    skip Google Chrome and use the default browser
rem    -Help              print this help
rem ============================================================
setlocal EnableExtensions DisableDelayedExpansion
set "REPO=%~dp0"
set "SHOWROOT=%REPO:~0,-1%"
set "PORT=0"
set "NOBROWSER="
set "DEFAULTBROWSER="
set "DSHHOME="
set "VERSION="
set "SHOWHELP="
set "CHROME="
set "OPENED="
set "SAID="
set "RC="

rem ---------------------------------------------------------------------------
rem Flags. Case-insensitive, like the PowerShell parameter names they mirror,
rem and each one is consumed together with the value that follows it.
rem ---------------------------------------------------------------------------
rem Each flag is DISPATCHED to its own label rather than handled inline: inside a
rem parenthesised block, `if cond cmd1 & cmd2` skips cmd2 entirely, so a compact
rem one-line handler for a flag that takes a value cannot be written that way.
:parse
if "%~1"=="" goto parsed
set "ARG=%~1"
if /i "%ARG%"=="-help" goto takehelp
if /i "%ARG%"=="-nobrowser" goto takenobrowser
if /i "%ARG%"=="-defaultbrowser" goto takedefaultbrowser
if /i "%ARG%"=="-port" goto takeport
if /i "%ARG%"=="-dshhome" goto takedshhome
if /i "%ARG%"=="-dshversion" goto takedshversion
echo [vn-harness] Unknown flag: %ARG%
call :usage
exit /b 2

:takehelp
set "SHOWHELP=1"
goto parsed

:takenobrowser
set "NOBROWSER=1"
shift
goto parse

:takedefaultbrowser
set "DEFAULTBROWSER=1"
shift
goto parse

:takeport
if "%~2"=="" goto needvalue
set "PORT=%~2"
shift
shift
goto parse

:takedshhome
if "%~2"=="" goto needvalue
set "DSHHOME=%~2"
shift
shift
goto parse

:takedshversion
if "%~2"=="" goto needvalue
set "VERSION=%~2"
shift
shift
goto parse

:needvalue
echo [vn-harness] %ARG% needs a value.
call :usage
exit /b 2

:parsed
if defined SHOWHELP ( call :usage & exit /b 0 )

rem ---------------------------------------------------------------------------
rem The port is a number or it is the default; `--port` is only passed when the
rem caller asked for one, exactly like the PowerShell half did. checkport is a
rem subroutine, so its exit status - not its `exit /b` - has to stop the script.
rem ---------------------------------------------------------------------------
if not "%PORT%"=="0" call :checkport
if not "%PORT%"=="0" if errorlevel 1 exit /b 2

echo [vn-harness] DeepSeek Harness plugin pack launcher (web GUI)
echo [vn-harness] Platform: windows (cmd.exe, %COMSPEC%)
echo [vn-harness] Repo: %SHOWROOT%

rem ---------------------------------------------------------------------------
rem The pinned dsh version: the flag when given, else .dsh-version.json in this
rem file's own folder, which is why this script lives at the repository root.
rem ---------------------------------------------------------------------------
if defined VERSION ( set "PIN=%VERSION%" ) else ( call :readpin )
if not defined PIN (
  echo [vn-harness] Could not read the pinned dsh version from %REPO%.dsh-version.json
  exit /b 1
)
echo [vn-harness] Pinned dsh version: %PIN%

where node >nul 2>nul
if errorlevel 1 goto nonode
where npx >nul 2>nul
if errorlevel 1 goto nonpx

if defined DSHHOME ( set "DSH_HOME=%DSHHOME%" & echo [vn-harness] DSH_HOME: %DSHHOME% )

rem ---------------------------------------------------------------------------
rem A friendly nudge, never a refusal: the app runs fine without the pack, so a
rem profile that never had it installed still starts - it just starts unadorned.
rem ---------------------------------------------------------------------------
set "HARNESS=%DSHHOME%"
if not defined HARNESS set "HARNESS=%DSH_HOME%"
if not defined HARNESS set "HARNESS=%USERPROFILE%\.dsh"
set "PROFILE=%HARNESS%\profiles\web"
set "PACKLISTED="
if not exist "%PROFILE%\package.json" goto packchecked
findstr /c:"dsh-rightbar" "%PROFILE%\package.json" >nul 2>nul && set "PACKLISTED=1"
:packchecked
if not defined PACKLISTED if exist "%PROFILE%\package.json" (
  echo   - the web profile at %PROFILE% does not list this pack's bundles yet.
  echo     Run install.bat - or ./install.sh - first if you expected the pack to be there.
)

set "APP=npx --yes @deepseek-ai/dsh@%PIN% web --no-open"
if defined PORT if not "%PORT%"=="0" set "APP=%APP% --port %PORT%"

echo.
if defined NOBROWSER echo [vn-harness] Starting the harness; no browser will be opened - the URL line below carries a live token.
if not defined NOBROWSER echo [vn-harness] Starting the harness; the first "dsh web:" line opens in Chrome, default browser as the fallback.
echo   Keep this window open - the harness runs in it. Ctrl+C stops it.
echo.

rem ---------------------------------------------------------------------------
rem Run it. The app's stdout flows through the pipe line by line, so the console
rem keeps up live; its stderr is deliberately NOT merged, so it reaches this
rem console directly. `cmd /v:on` is here for one reason: the sentinel line
rem appended after the app is what carries the app's OWN exit code back,
rem because ERRORLEVEL after a `for /f` loop is the body's, not the child's.
rem The sentinel is consumed below and never printed.
rem ---------------------------------------------------------------------------
for /f "eol= delims=" %%L in ('cmd /v:on /c "%APP% & echo __VNRUN_RC__=!ERRORLEVEL!"') do (
  set "LINE=%%L"
  for /f "eol= tokens=1,2 delims==" %%a in ("%%L") do (
    if /i "%%a"=="__VNRUN_RC__" (
      set "RC=%%b"
    ) else (
      echo(%%L
      if not defined NOBROWSER if not defined OPENED call :capture
    )
  )
  if defined OPENED if not defined SAID call :announce
)

if not defined RC set "RC=0"
echo.
if not defined OPENED if not defined NOBROWSER echo [vn-harness] The app never printed a "dsh web:" URL line, so no browser was opened.
if not defined OPENED if not defined NOBROWSER echo   A profile with printUrl disabled prints none; the URL is also in the output above.
if "%RC%"=="0" echo [vn-harness] The harness stopped.
if not "%RC%"=="0" echo [vn-harness] The harness exited with code %RC%.

if not "%RC%"=="0" (
  echo.
  echo ============================================================
  echo  vn-harness run FAILED - exit code %RC% - see above.
  echo ============================================================
  echo.
  pause
)
exit /b %RC%

rem ---------------------------------------------------------------------------
rem An open browser window
rem ---------------------------------------------------------------------------
:capture
setlocal EnableDelayedExpansion
if defined OPENED ( endlocal & exit /b 0 )
rem Every line is considered; only one that names `dsh web:` carries the URL.
set "REST=!LINE:*dsh web:=!"
if "!REST!"=="!LINE!" ( endlocal & exit /b 0 )
for /f "tokens=1 delims= " %%u in ("!REST!") do set "URL=%%u"
if not defined URL ( endlocal & exit /b 0 )
if /i "!URL:~0,7!"=="http://" goto urlok
if /i "!URL:~0,8!"=="https://" goto urlok
rem Not a URL at all - a coloured or reformatted line. Say nothing and keep
rem reading: a later line may still carry one.
endlocal
exit /b 0

:urlok
rem Strip the scheme, then take the host: everything before the first `:` or `/`.
set "AUTH=!URL:http://=!"
set "AUTH=!AUTH:https://=!"
for /f "tokens=1 delims=/:" %%h in ("!AUTH!") do set "HOST=%%h"
set "LOOPBACK="
if /i "!HOST!"=="localhost" set "LOOPBACK=1"
rem The bracketed IPv6 literal, in both the compressed and the expanded spelling
rem that ./run.sh also accepts (a URL must bracket an IPv6 host).
if /i "!AUTH:~0,5!"=="[::1]" set "LOOPBACK=1"
if /i "!AUTH:~0,17!"=="[0:0:0:0:0:0:0:1]" set "LOOPBACK=1"
if not defined LOOPBACK call :checkip
if not defined LOOPBACK (
  endlocal & set "OPENED=refused"
  exit /b 0
)
if defined DEFAULTBROWSER goto opendefault
call :findchrome
if defined CHROME goto openchrome
:opendefault
start "" "!URL!"
endlocal & set "OPENED=the default browser"
exit /b 0
:openchrome
start "" "!CHROME!" "!URL!"
endlocal & set "OPENED=Google Chrome"
exit /b 0

rem A dotted-quad host is loopback only when it is 127.<digits and dots>; a name
rem such as 127.example.com starts with the same four characters and is not.
:checkip
set "DOTS=!HOST:.=!"
set "NONDIGIT="
for /f "delims=0123456789" %%z in ("!DOTS!") do set "NONDIGIT=%%z"
if defined NONDIGIT exit /b 0
if /i "!HOST:~0,4!"=="127." set "LOOPBACK=1"
exit /b 0

:announce
set "SAID=1"
if /i "%OPENED%"=="refused" echo [vn-harness] The URL line did not name a loopback address; it was NOT opened.
if /i "%OPENED%"=="Google Chrome" echo [vn-harness] Opened the harness in Google Chrome.
if /i "%OPENED%"=="the default browser" echo [vn-harness] Opened the harness in the default browser.
exit /b 0

rem ---------------------------------------------------------------------------
rem Google Chrome, wherever this Windows keeps it: PATH first, then the three
rem standard install locations, then the App Paths registry entry the installer
rem itself writes - which is also what a per-user install uses.
rem ---------------------------------------------------------------------------
:findchrome
for /f "delims=" %%p in ('where chrome.exe 2^>nul') do if not defined CHROME set "CHROME=%%p"
if defined CHROME exit /b 0
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if defined CHROME exit /b 0
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set "CHROME=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if defined CHROME exit /b 0
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set "CHROME=%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"
if defined CHROME exit /b 0
call :regchrome "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
if defined CHROME exit /b 0
call :regchrome "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe"
exit /b 0

:regchrome
set "CAND="
for /f "tokens=2,*" %%a in ('reg query "%~1" /ve 2^>nul ^| findstr /i "REG_SZ"') do set "CAND=%%b"
if not defined CAND exit /b 0
for /f "tokens=* delims= " %%c in ("%CAND%") do set "CAND=%%c"
if exist "%CAND%" set "CHROME=%CAND%"
exit /b 0

rem ---------------------------------------------------------------------------
rem The pinned version, read with node so the JSON in .dsh-version.json is
rem really parsed - node is a prerequisite of this launcher anyway.
rem ---------------------------------------------------------------------------
:readpin
set "PIN="
for /f "usebackq delims=" %%v in (`node -p "require(process.argv[1]).dsh" "%REPO%.dsh-version.json"`) do set "PIN=%%v"
exit /b 0

:checkport
set "NONDIGIT="
for /f "delims=0123456789" %%z in ("%PORT%") do set "NONDIGIT=%%z"
if not defined NONDIGIT exit /b 0
echo [vn-harness] -Port needs a number, not "%PORT%".
exit /b 2

:usage
echo.
echo Usage: run.bat [flags]
echo.
echo   -Port ^<n^>          listen on this port instead of the default (3080)
echo   -DshHome ^<dir^>     override DSH_HOME (default: DSH_HOME, else USERPROFILE\.dsh)
echo   -DshVersion ^<ver^>  override the pinned dsh version from .dsh-version.json
echo   -NoBrowser         start the server only; open nothing
echo   -DefaultBrowser    skip Google Chrome and use the default browser
echo   -Help              print this help
echo.
echo Run it from the repository root (it reads .dsh-version.json from there);
echo macOS and Linux use ./run.sh, which does exactly the same thing.
echo.
exit /b 0

:nonode
echo [vn-harness] Required tool 'node' was not found on PATH.
echo   Install Node.js (v22 or newer) first: https://nodejs.org
exit /b 1

:nonpx
echo [vn-harness] Required tool 'npx' was not found on PATH.
echo   It ships with Node.js (v22 or newer): https://nodejs.org
exit /b 1
