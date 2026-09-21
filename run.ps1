#Requires -Version 5.1
<#
.SYNOPSIS
    Starts the DeepSeek Harness web GUI and opens it in a browser.

.DESCRIPTION
    This is the WINDOWS half of the launcher; macOS and Linux run `run.sh`
    instead (plain POSIX shell - Node.js with npm/npx and no PowerShell at all).
    The two files are the whole launcher - there is no wrapper/worker split, and
    no `run.bat`: this script IS the entry point, so it sits at the repository
    root beside install.sh / uninstall.sh and reads .dsh-version.json from the
    same folder. Both halves do the same work with the same flags, print the
    same messages and put the same tab on screen, so keep them in step.

    It runs the pinned CLI exactly the way the installer does:

        npx --yes @deepseek-ai/dsh@<pin> web --no-open [--port <n>]

    and then WATCHES the app's own stdout for the URL line it prints once the
    server is listening:

        dsh web: http://127.0.0.1:3080/?token=<launch token> (LAN: ...)

    That exact URL - token included - is what gets opened, in Google Chrome when
    Chrome is installed and in the platform's default browser otherwise.
    `--no-open` is passed so the app itself does not also start a browser: this
    launcher owns the hand-off, and one URL must not open twice. Everything the
    app prints still reaches this console, and the harness runs in the
    foreground: Ctrl+C stops it.

    The token is a live credential for the running process (it is the value the
    server exchanges for the browser session cookie). It is therefore read from
    the app's own output IN MEMORY, never written to a file, never passed
    through a shell, and only ever handed to a browser after the URL has been
    checked to be a loopback address - a line that named any other host is
    refused instead of opened.

.PARAMETER Port
    Listen on this port instead of the app's default (3080). Useful when that
    one is already taken; the URL line then carries the port actually used.

.PARAMETER DshHome
    Override DSH_HOME for this run (default: $env:DSH_HOME, else ~/.dsh).

.PARAMETER DshVersion
    Override the pinned dsh version from .dsh-version.json.

.PARAMETER NoBrowser
    Start the server only: print the URL and open nothing.

.PARAMETER DefaultBrowser
    Skip Google Chrome and open the URL in the platform's default browser.

.PARAMETER Help
    Print the accepted flags and exit.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1 -Port 3099 -DefaultBrowser
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [string]$DshHome = '',
    [string]$DshVersion = '',
    [switch]$NoBrowser,
    [switch]$DefaultBrowser,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'
# This script lives at the repository root, so it is its own root.
$repoRoot = $PSScriptRoot

# ---------------------------------------------------------------------------
# Platform facts. Windows PowerShell 5.1 HAS no $IsWindows/$IsMacOS/$IsLinux,
# so the automatic variables are read defensively (the desktop edition is the
# reliable signal for 5.1).
# ---------------------------------------------------------------------------
$script:Platform = 'linux'
if ($PSVersionTable.PSEdition -ne 'Core') { $script:Platform = 'windows' }
elseif ($IsWindows) { $script:Platform = 'windows' }
elseif ($IsMacOS) { $script:Platform = 'macos' }
$script:IsWindowsHost = $script:Platform -eq 'windows'

<#
    The user's home directory without assuming Windows: HOME is what macOS/Linux
    (and pwsh on Windows) set, USERPROFILE is the Windows fallback, and the
    profile-folder API is the last resort on Windows.
#>
function Get-HomeDir {
    if ($env:HOME) { return $env:HOME }
    if ($env:USERPROFILE) { return $env:USERPROFILE }
    return [Environment]::GetFolderPath('UserProfile')
}

<#
    Resolve the first existing command from an ordered name list. Callers pass
    the platform's spellings (npx.cmd before npx on Windows; bare names
    elsewhere), so no call site has to know which OS it runs on.
#>
function Get-ToolPath {
    param([string[]]$Names)
    foreach ($name in $Names) {
        $found = Get-Command $name -ErrorAction SilentlyContinue
        if ($found) { return $found.Source }
    }
    return $null
}

# The command names one tool goes by on this platform.
function Get-ToolNames {
    param([string]$Name)
    if ($script:IsWindowsHost) { return @("$Name.cmd", "$Name.exe", $Name) }
    return @($Name)
}

function Write-Step($msg) { Write-Host "[vn-harness] $msg" -ForegroundColor Cyan }

function Show-Usage {
    Write-Host ''
    Write-Host 'Usage: powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1 [flags]'
    Write-Host ''
    Write-Host '  -Port <n>          listen on this port instead of the default (3080)'
    Write-Host '  -DshHome <dir>     override DSH_HOME (default: $env:DSH_HOME, else ~/.dsh)'
    Write-Host '  -DshVersion <ver>  override the pinned dsh version from .dsh-version.json'
    Write-Host '  -NoBrowser         start the server only; open nothing'
    Write-Host '  -DefaultBrowser    skip Google Chrome and use the default browser'
    Write-Host '  -Help              print this help'
    Write-Host ''
    Write-Host 'Run it from the repository root (it reads .dsh-version.json from there);'
    Write-Host 'macOS and Linux use ./run.sh, which does exactly the same thing.'
    Write-Host ''
}

function Get-DshPin {
    $manifest = Join-Path $repoRoot '.dsh-version.json'
    if (-not (Test-Path $manifest)) { throw "Missing $manifest" }
    $json = Get-Content $manifest -Raw | ConvertFrom-Json
    return $json.dsh
}

function Assert-Tool($toolName) {
    if (-not (Get-ToolPath -Names (Get-ToolNames -Name $toolName))) {
        throw "Required tool '$toolName' was not found on PATH. Install Node.js >= 22 first (https://nodejs.org)."
    }
}

# ---------------------------------------------------------------------------
# The URL line
# ---------------------------------------------------------------------------
<#
    The harness prints one ready line, on stdout, once the server is listening:

        dsh web: http://127.0.0.1:3080/?token=<token> (LAN: http://<ip>:<port>/?token=<token>)

    Pull the FIRST URL out of such a line. ANSI colour codes are stripped first
    (a profile can colour its own console output), and only a line that names
    `dsh web:` is considered, so no unrelated URL is ever mistaken for it.
#>
function Get-WebUrl {
    param([string]$Text)
    if (-not $Text) { return $null }
    $clean = [regex]::Replace($Text, ([string][char]27 + '\[[0-9;]*[A-Za-z]'), '')
    if ($clean.IndexOf('dsh web:') -lt 0) { return $null }
    $match = [regex]::Match($clean, 'https?://[^\s"'']+')
    if (-not $match.Success) { return $null }
    return $match.Value.TrimEnd('.', ',', ')', ']', '"', "'")
}

<#
    Only a loopback URL is opened. The app binds 127.0.0.1 by default and its
    own `--host` rejects 0.0.0.0 on purpose, so anything else in that line is a
    surprise, and a launch token must never be handed to a browser pointed at
    another host.
#>
function Test-LoopbackUrl {
    param([string]$Url)
    try { $uri = [System.Uri]$Url } catch { return $false }
    if ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') { return $false }
    $hostName = $uri.Host
    if ($hostName -eq 'localhost') { return $true }
    $address = $null
    if ([System.Net.IPAddress]::TryParse($hostName, [ref]$address)) {
        return [System.Net.IPAddress]::IsLoopback($address)
    }
    return $false
}

# ---------------------------------------------------------------------------
# The browser hand-off
# ---------------------------------------------------------------------------
<#
    Google Chrome, wherever this Windows keeps it: PATH first, then the three
    standard install locations, then the App Paths registry entry the installer
    itself writes (which is also what a per-user install uses).
#>
function Get-ChromePath {
    $found = Get-ToolPath -Names (Get-ToolNames -Name 'chrome')
    if ($found) { return $found }
    $candidates = @()
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe') }
    $programFilesX86 = ${env:ProgramFiles(x86)}
    if ($programFilesX86) { $candidates += (Join-Path $programFilesX86 'Google\Chrome\Application\chrome.exe') }
    if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe') }
    foreach ($key in @(
            'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe',
            'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe')) {
        try {
            $value = (Get-ItemProperty -Path $key -ErrorAction Stop).'(default)'
            if ($value) { $candidates += $value }
        }
        catch {
            # No such registration: the other candidates decide.
        }
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    return $null
}

<#
    Open one URL and answer the browser's name for the console line. Chrome is
    started with the URL as a SINGLE argument (argv, never a command string), so
    nothing in the URL can be read as a shell metacharacter; the default browser
    goes through ShellExecute.
#>
function Open-WebUrl {
    param([string]$Url)
    if (-not $DefaultBrowser) {
        $chrome = Get-ChromePath
        if ($chrome) {
            Start-Process -FilePath $chrome -ArgumentList @($Url) | Out-Null
            return 'Google Chrome'
        }
    }
    Start-Process -FilePath $Url | Out-Null
    return 'the default browser'
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if ($Help) {
    Show-Usage
    exit 0
}

Write-Step 'DeepSeek Harness plugin pack launcher (web GUI)'
Write-Step "Platform: $script:Platform (PowerShell $($PSVersionTable.PSVersion))"
Write-Step "Repo: $repoRoot"

$DshVersion = if ($DshVersion) { $DshVersion } else { Get-DshPin }
Write-Step "Pinned dsh version: $DshVersion"

Assert-Tool 'node'
Assert-Tool 'npx'

if ($DshHome) {
    $env:DSH_HOME = $DshHome
    Write-Step "DSH_HOME: $DshHome"
}

# A friendly nudge, never a refusal: the app runs fine without the pack, so a
# profile that never had it installed still starts - it just starts unadorned.
$harnessHome = $DshHome
if (-not $harnessHome) { $harnessHome = $env:DSH_HOME }
if (-not $harnessHome) { $harnessHome = Join-Path (Get-HomeDir) '.dsh' }
$profileDir = Join-Path (Join-Path $harnessHome 'profiles') 'web'
$profileManifest = Join-Path $profileDir 'package.json'
$packInstalled = $false
if (Test-Path $profileManifest) {
    try {
        $profileJson = Get-Content $profileManifest -Raw | ConvertFrom-Json
        $held = @($profileJson.dsh.profile.bundles)
        $packInstalled = $held -contains 'dsh-rightbar'
    }
    catch {
        $packInstalled = $false
    }
}
if (-not $packInstalled) {
    Write-Host "  - the web profile at $profileDir does not list this pack's bundles yet."
    Write-Host '    Run install.bat (or ./install.sh) first if you expected the pack to be there.'
}

$npx = Get-ToolPath -Names (Get-ToolNames -Name 'npx')
$spec = "@deepseek-ai/dsh@$DshVersion"
$appArgs = @('--yes', $spec, 'web', '--no-open')
if ($Port -gt 0) { $appArgs += @('--port', [string]$Port) }

Write-Host ''
if ($NoBrowser) {
    Write-Step 'Starting the harness; no browser will be opened (the URL line below carries a live token).'
}
else {
    Write-Step 'Starting the harness; the first "dsh web:" line opens in Chrome (default browser as the fallback).'
}
Write-Host '  Keep this window open - the harness runs in it. Ctrl+C stops it.'
Write-Host ''

$opened = $null
$exitCode = 0
$prevEap = $ErrorActionPreference
# A native command writing to stderr becomes a terminating NativeCommandError
# under 'Stop'. stderr is deliberately NOT merged into the pipeline (the URL
# line is on stdout), so this call is judged by its exit code alone.
$ErrorActionPreference = 'Continue'
try {
    & $npx @appArgs | ForEach-Object {
        $text = [string]$_
        Write-Host $text
        if ($null -eq $opened -and -not $NoBrowser) {
            $url = Get-WebUrl -Text $text
            if ($url) {
                if (Test-LoopbackUrl -Url $url) {
                    try {
                        $opened = Open-WebUrl -Url $url
                        Write-Host ''
                        Write-Step "Opened the harness in $opened."
                        Write-Host ''
                    }
                    catch {
                        $opened = 'failed'
                        Write-Step "Could not open a browser ($($_.Exception.Message)); open the URL printed above."
                    }
                }
                else {
                    $opened = 'refused'
                    Write-Step 'The URL line did not name a loopback address; it was NOT opened.'
                }
            }
        }
    }
    $exitCode = $LASTEXITCODE
}
finally {
    $ErrorActionPreference = $prevEap
}

Write-Host ''
if ($null -eq $opened -and -not $NoBrowser) {
    Write-Step 'The app never printed a "dsh web:" URL line, so no browser was opened.'
    Write-Host '  (A profile with printUrl disabled prints none; the URL is also in the output above.)'
}
if ($exitCode -eq 0) {
    Write-Step 'The harness stopped.'
}
else {
    Write-Step "The harness exited with code $exitCode."
}
exit $exitCode
