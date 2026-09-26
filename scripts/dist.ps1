<#
    scripts/dist.ps1 - build a vn-harness DISTRIBUTION folder and its zip.

    WHAT IT PRODUCES
        dist/vn-harness-<version>-<rid>/       the folder you CLICK: the built
                                               shell (vn-harness.exe) beside the
                                               whole pack it live-links from
        dist/vn-harness-<version>-<rid>.zip    the same folder, for handing to
                                               somebody else

    WHY A FOLDER AND NOT JUST AN .exe
        app/ is a LAUNCHER, not a bundle. The shell walks up for
        .dsh-version.json, runs the pinned `npx @deepseek-ai/dsh@<pin> web
        --no-open` and shows THAT url in a native window; the plugins are
        installed into the web profile as LIVE LINKS into packages/. So the
        distribution IS this repository plus the built binary - nothing is
        compiled into it, and the folder has to stay where it is. Move it and the
        profile's links point at folders that are no longer there; re-running
        START-HERE.bat re-installs from wherever the folder now lives.

    THE SAME FILE CI RUNS
        .github/workflows/distribute.yml calls exactly this script on
        windows-latest and scripts/dist.sh on the macOS/Linux runners, so a local
        run and a CI run cannot drift: one implementation, the same flags, the
        same layout. `distribute.bat -Verify` runs the same end-to-end check the
        workflow runs after assembling, so a green local run means the CI step
        has nothing new to discover.

    WHAT SHIPS is not decided here: it is scripts/dist-manifest.txt, read by both
    halves of this feature (and pinned by scripts/checks/check-dist-layout.mjs).

    FLAGS (distribute.sh takes the same ones)
        -Version <v>      override the pack version used in the names
                          (default: package.json's version)
        -SkipBuild        reuse the binary under app/src-tauri/target/release
        -NoZip            assemble the folder only
        -Run              assemble, then RUN the produced distribution
                          (foreground: the shell's console output stays here)
        -Verify           assemble, then install into a throwaway DSH_HOME and
                          boot the pinned harness from it, waiting for the ready
                          line - the end-to-end check the CI job also runs
        -KeepVerifyHome   keep that throwaway home for inspection
        -Clean            delete dist/ first
        -Help

    THE LAUNCH TOKEN IS A LIVE CREDENTIAL. The ready line the harness prints
    carries one, so everything this script reports from that line goes through
    the same redaction app/src-tauri/src/readyline.rs applies: the value becomes
    REDACTED, and a line that does not name a loopback address is refused rather
    than reported as good.
#>
[CmdletBinding()]
param(
    [string]$Version = '',
    [switch]$SkipBuild,
    [switch]$NoZip,
    [switch]$Run,
    [switch]$Verify,
    [switch]$KeepVerifyHome,
    [switch]$Clean,
    [switch]$NoPause,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

# The console contract - UTF-8 output, the colour policy, the shared wording -
# is defined ONCE, in scripts\console\theme.ps1, and dot-sourced by every worker.
. (Join-Path $PSScriptRoot 'console\theme.ps1')
Initialize-VnConsole

# ---------------------------------------------------------------------------
# Host facts. Windows PowerShell 5.1 has no $IsWindows ($IsMacOS/$IsLinux), so
# the edition is the reliable signal for 5.1 - the same shape install-all.ps1
# uses, for the same reason.
# ---------------------------------------------------------------------------
$script:RepoRoot = Split-Path -Parent $PSScriptRoot
$script:Platform = 'linux'
if ($PSVersionTable.PSEdition -ne 'Core') { $script:Platform = 'windows' }
elseif ($IsWindows) { $script:Platform = 'windows' }
elseif ($IsMacOS) { $script:Platform = 'macos' }
$script:IsWindowsHost = $script:Platform -eq 'windows'
$script:Sep = [System.IO.Path]::DirectorySeparatorChar

# The shipped name of the binary: Windows needs the suffix, and the pack's docs
# name the folder launcher without it.
$script:BinaryName = 'vn-harness.exe'
if (-not $script:IsWindowsHost) { $script:BinaryName = 'vn-harness' }
# What cargo names it (Cargo.toml's package name).
$script:CargoBinaryName = 'vn-harness-desktop.exe'
if (-not $script:IsWindowsHost) { $script:CargoBinaryName = 'vn-harness-desktop' }

function Write-Step($Message) { Write-VnStep $Message }
function Write-Note($Message) { Write-VnNote $Message }

function Assert-Tool {
    param([string]$Name)
    $found = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $found) {
        throw "$Name was not found on PATH. Node.js 22 or newer is required (https://nodejs.org)."
    }
    return $found.Source
}

# The command names one tool goes by on this platform: npx.cmd before npx on
# Windows, the bare name elsewhere.
function Get-ToolPath {
    param([string[]]$Names)
    foreach ($name in $Names) {
        $found = Get-Command $name -ErrorAction SilentlyContinue
        if ($found) { return $found.Source }
    }
    return $null
}

function Get-ToolNames {
    param([string]$Name)
    if ($script:IsWindowsHost) { return @("$Name.cmd", "$Name.exe", $Name) }
    return @($Name)
}

function Show-Usage {
    Write-Host ''
    Write-Host 'Usage: distribute.bat [flags]'
    Write-Host ''
    Write-Host '  -Version <v>      override the pack version used in the names'
    Write-Host '  -SkipBuild        reuse the binary already under app/src-tauri/target/release'
    Write-Host '  -NoZip            assemble the folder only (no .zip)'
    Write-Host '  -Run              assemble, then run the produced distribution'
    Write-Host '  -Verify           assemble, then install into a throwaway DSH_HOME and boot'
    Write-Host '                    the pinned harness from it (the CI end-to-end check)'
    Write-Host '  -KeepVerifyHome   keep that throwaway home for inspection'
    Write-Host '  -Clean            delete dist/ first'
    Write-Host '  -NoPause          never hold this window open'
    Write-Host '  -Help / -h / /?   print this help'
    Write-Host ''
    Write-Host 'Builds dist/vn-harness-<version>-<rid>/ from scripts/dist-manifest.txt plus the'
    Write-Host 'built shell, and zips it beside itself. dist/ is never committed.'
    Write-Host 'macOS/Linux: ./distribute.sh is the same thing in POSIX shell.'
    Write-Host ''
}

# ---------------------------------------------------------------------------
# The repository facts a distribution has to carry
# ---------------------------------------------------------------------------
function Get-DshPin {
    $manifest = Join-Path $script:RepoRoot '.dsh-version.json'
    if (-not (Test-Path -LiteralPath $manifest)) {
        throw ".dsh-version.json is missing from $script:RepoRoot - the shell reads its pin from the folder it is run in, and it has no fallback."
    }
    $json = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if (-not $json.dsh) { throw '.dsh-version.json has no "dsh" pin.' }
    return [string]$json.dsh
}

function Get-PackVersion {
    $manifest = Join-Path $script:RepoRoot 'package.json'
    if (-not (Test-Path -LiteralPath $manifest)) { throw "package.json is missing from $script:RepoRoot." }
    $json = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
    if (-not $json.version) { throw 'package.json has no "version".' }
    return [string]$json.version
}

# windows-x64, mac-arm64, linux-x64 ... - the suffix that tells two artifacts of
# the same version apart in a download folder.
function Get-HostRid {
    $arch = ''
    if ($script:IsWindowsHost) {
        $arch = [string]$env:PROCESSOR_ARCHITECTURE
        if ($arch -eq 'ARM64') { return 'win-arm64' }
        return 'win-x64'
    }
    $machine = (& uname -m 2>$null)
    if (-not $machine) { $machine = 'x86_64' }
    $machine = ([string]$machine).Trim().ToLowerInvariant()
    $isArm = $machine -eq 'arm64' -or $machine -eq 'aarch64'
    if ($script:Platform -eq 'macos') {
        if ($isArm) { return 'mac-arm64' }
        return 'mac-x64'
    }
    if ($isArm) { return 'linux-arm64' }
    return 'linux-x64'
}

function Get-UtcStamp { return (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }

function Invoke-Quiet {
    param([string]$File, [string[]]$Arguments)
    try {
        $output = & $File @Arguments 2>$null
        if ($LASTEXITCODE -ne 0) { return '' }
        return ([string]($output | Select-Object -First 1)).Trim()
    }
    catch { return '' }
}

# ---------------------------------------------------------------------------
# The ship list
# ---------------------------------------------------------------------------
function Get-ManifestRules {
    $file = Join-Path $script:RepoRoot 'scripts/dist-manifest.txt'
    if (-not (Test-Path -LiteralPath $file)) { throw "scripts/dist-manifest.txt is missing - it is the one list of what ships." }
    $rules = New-Object System.Collections.ArrayList
    foreach ($line in (Get-Content -LiteralPath $file)) {
        $text = ([string]$line).Trim()
        if (-not $text) { continue }
        if ($text.StartsWith('#')) { continue }
        $parts = $text -split '\s+', 2
        if ($parts.Count -lt 2) { throw "dist-manifest.txt: cannot read the rule '$text' (expected '<include|skipdir|skippath|skipfile> <path>')." }
        $kind = $parts[0].ToLowerInvariant()
        if (@('include', 'skipdir', 'skippath', 'skipfile') -notcontains $kind) {
            throw "dist-manifest.txt: unknown rule kind '$kind' on the line '$text'."
        }
        $path = $parts[1].Trim().Replace('\', '/')
        if ($path.Contains('..')) { throw "dist-manifest.txt: '$path' reaches outside the repository." }
        [void]$rules.Add([pscustomobject]@{ Kind = $kind; Path = $path })
    }
    if ($rules.Count -eq 0) { throw 'dist-manifest.txt has no rules in it.' }
    return $rules
}

# Skip rules win over include rules, whatever order they appear in the file.
function Test-Skip {
    param([string]$Relative, [bool]$IsDirectory, [object[]]$Rules)
    $name = $Relative
    $slash = $Relative.LastIndexOf('/')
    if ($slash -ge 0) { $name = $Relative.Substring($slash + 1) }
    foreach ($rule in $Rules) {
        if ($rule.Kind -eq 'skipdir') {
            if ($IsDirectory -and ($name -eq $rule.Path)) { return $true }
        }
        elseif ($rule.Kind -eq 'skippath') {
            if (($Relative -eq $rule.Path) -or $Relative.StartsWith("$($rule.Path)/")) { return $true }
        }
        elseif ($rule.Kind -eq 'skipfile') {
            if ((-not $IsDirectory) -and ($name -like $rule.Path)) { return $true }
        }
    }
    return $false
}

# The relative paths are kept POSIX-shaped ('/') for rule matching, and turned
# back into the host's separator only when a file is written.
#
# `Prefix` is where this include rule's root sits inside the distribution
# ('packages' for `include packages`), and it is part of the DESTINATION as well
# as the name the skip rules see - without it a walked tree would be flattened
# into the distribution root.
function Copy-Tree {
    param([string]$SourceRoot, [string]$Prefix, [string]$Relative, [string]$Destination, [object[]]$Rules)
    $source = $SourceRoot
    if ($Relative) { $source = Join-Path $SourceRoot $Relative }
    foreach ($entry in (Get-ChildItem -LiteralPath $source -Force)) {
        $walk = $entry.Name
        if ($Relative) { $walk = "$Relative/$($entry.Name)" }
        $rel = $walk
        if ($Prefix) { $rel = "$Prefix/$walk" }
        if ($entry.PSIsContainer) {
            if (Test-Skip -Relative $rel -IsDirectory $true -Rules $Rules) { continue }
            Copy-Tree -SourceRoot $SourceRoot -Prefix $Prefix -Relative $walk -Destination $Destination -Rules $Rules
        }
        else {
            if (Test-Skip -Relative $rel -IsDirectory $false -Rules $Rules) { continue }
            $target = Join-Path $Destination $rel.Replace('/', $script:Sep)
            $parent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
            Copy-Item -LiteralPath $entry.FullName -Destination $target -Force
        }
    }
}

function Copy-Payload {
    param([string]$Destination, [object[]]$Rules)
    $copied = 0
    foreach ($rule in $Rules) {
        if ($rule.Kind -ne 'include') { continue }
        $source = Join-Path $script:RepoRoot $rule.Path.Replace('/', $script:Sep)
        if (-not (Test-Path -LiteralPath $source)) {
            throw "dist-manifest.txt includes '$($rule.Path)', which does not exist in this repository."
        }
        $item = Get-Item -LiteralPath $source -Force
        if ($item.PSIsContainer) {
            Copy-Tree -SourceRoot $source -Prefix $rule.Path -Relative '' -Destination $Destination -Rules $Rules
        }
        else {
            if (Test-Skip -Relative $rule.Path -IsDirectory $false -Rules $Rules) { continue }
            $target = Join-Path $Destination $rule.Path.Replace('/', $script:Sep)
            $parent = Split-Path -Parent $target
            if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
            Copy-Item -LiteralPath $source -Destination $target -Force
        }
        $copied = $copied + 1
    }
    return $copied
}

# The bundle names this distribution carries - read from the copies themselves,
# so the list is the shipped tree's own claim and not a second manifest.
# The assembled folder has to look like the repository, not like a copy of it
# that went wrong: one sentinel per shipped family, so a walk that flattens or
# nests a tree fails HERE instead of shipping. The POSIX half checks the same
# list (scripts/checks/check-dist-layout.mjs fails when the two lists drift).
function Assert-Sentinels {
    param([string]$DistDir)
    $sentinels = @(
        '.dsh-version.json',
        'README.md',
        'scripts/install-all.ps1',
        'scripts/install-all.sh',
        'docs/INSTALL.md',
        'assets/vn-harness.svg',
        'app/src-tauri/src/main.rs',
        'app/src-tauri/tauri.conf.json',
        'packages/dsh-vn-master/package.json',
        'packages/dsh-vn-master/cordis.patch.yml',
        'packages/dsh-rightbar/lib/client.js',
        'packages/dsh-editor/lib/vendor/cm6.min.js',
        'packages/dsh-terminal/lib/vendor/xterm.js',
        'packages/dsh-diagrams/lib/vendor/mermaid.min.js',
        'packages/dsh-pdf/lib/vendor/pdf.min.mjs',
        'packages/dsh-pdf/skills/pdf-analysis/SKILL.md'
    )
    $missing = New-Object System.Collections.ArrayList
    foreach ($sentinel in $sentinels) {
        if (-not (Test-Path -LiteralPath (Join-Path $DistDir $sentinel.Replace('/', $script:Sep)))) {
            [void]$missing.Add($sentinel)
        }
    }
    if ($missing.Count -gt 0) {
        throw "The assembled distribution is missing: $($missing -join ', ') (dist-manifest.txt and the copy disagree)."
    }
}

function Get-DistBundleNames {
    param([string]$DistDir)
    $names = New-Object System.Collections.ArrayList
    $packages = Join-Path $DistDir (Join-Path 'packages' '*')
    foreach ($dir in (Get-ChildItem -Path $packages -Directory -Force -ErrorAction SilentlyContinue)) {
        $manifest = Join-Path $dir.FullName 'package.json'
        if (-not (Test-Path -LiteralPath $manifest)) { continue }
        try {
            $json = Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
        }
        catch { continue }
        if ($json.dsh -and $json.dsh.bundle -and $json.name) { [void]$names.Add([string]$json.name) }
    }
    return $names
}

function Measure-Tree {
    param([string]$Root)
    $files = 0
    $bytes = 0
    foreach ($item in (Get-ChildItem -LiteralPath $Root -Recurse -File -Force)) {
        $files = $files + 1
        $bytes = $bytes + $item.Length
    }
    return [pscustomobject]@{ Files = $files; Bytes = $bytes }
}

function Get-Sha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

<#
    Line endings are part of the artefact, not a detail:
      - a .bat file wants CRLF (cmd.exe's own parser and `goto :label` are
        unhappy with a lone LF),
      - a .sh file and SHA256SUMS.txt want LF (a CRLF shebang breaks `sh`, and
        sha256sum reads a trailing CR as part of the file name),
    so every generated file says which one it wants instead of taking whatever
    Set-Content happens to do on this PowerShell version.
#>
function Write-TextFile {
    param([string]$Path, [string[]]$Lines, [string]$Newline)
    $text = ($Lines -join $Newline) + $Newline
    [System.IO.File]::WriteAllText($Path, $text, (New-Object System.Text.ASCIIEncoding))
}

# ---------------------------------------------------------------------------
# The files a distribution generates for itself
# ---------------------------------------------------------------------------
function New-StartHere {
    param([string]$DistDir, [string]$DshPin)
    if ($script:IsWindowsHost) {
        $lines = @(
            '@echo off',
            'rem ============================================================',
            'rem  vn-harness - START HERE',
            'rem  Generated by scripts/dist.ps1 - do not edit; re-run the',
            'rem  distributer in the source repository to change it.',
            'rem',
            'rem  Double-click this file. It makes sure the DeepSeek Harness',
            "rem  web profile has this pack installed from THIS folder, then",
            'rem  opens vn-harness in its own window.',
            'rem',
            'rem  Requirements: Node.js 22 or newer on PATH, and network',
            "rem  access on the first run (the shell downloads the pinned",
            "rem  harness $DshPin through npx, once).",
            'rem',
            'rem  It is safe to run again: the installer skips the bundles it',
            'rem  already has at their current version and re-adds the ones',
            'rem  whose version moved. If you installed the pack already and',
            'rem  want to skip the check, run vn-harness.exe directly - or',
            'rem  run-desktop.bat, which finds and runs that same binary.',
            'rem',
            'rem  The console this runs in is decided by the shipped',
            'rem  scripts\console\adapt.cmd, exactly as it is for the other',
            'rem  launchers: Windows Terminal when it is there, colour only on a',
            'rem  real terminal, and the window held open only when it would',
            'rem  otherwise vanish.',
            'rem ============================================================',
            'setlocal',
            'cd /d "%~dp0"',
            'where node >nul 2>nul',
            'if errorlevel 1 (',
            '  echo [vn-harness] Node.js 22 or newer was not found on PATH.',
            '  echo   Install it from https://nodejs.org and run this file again.',
            '  goto :failed',
            ')',
            'if not defined VN_HARNESS_CONSOLE set "VN_HARNESS_ARGV=%*"',
            'call "%~dp0scripts\console\adapt.cmd" "%~f0" "vn-harness"',
            'if errorlevel 10 exit /b 0',
            'if errorlevel 2 (',
            '  echo [vn-harness] PowerShell was not found on PATH, and the installer',
            '  echo   needs it. It ships with every supported version of Windows.',
            '  goto :failed',
            ')',
            'echo [vn-harness] Making sure the harness web profile has this pack...',
            '"%VN_HARNESS_PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-all.ps1" %VN_HARNESS_ARGS%',
            'if errorlevel 1 goto :failed',
            'echo.',
            'echo [vn-harness] Starting vn-harness. Close the window to stop it.',
            'echo.',
            '"%~dp0vn-harness.exe" %VN_HARNESS_ARGS%',
            'if errorlevel 1 goto :failed',
            'exit /b 0',
            ':failed',
            'echo.',
            'echo ============================================================',
            'echo  vn-harness FAILED - see the messages above.',
            'echo ============================================================',
            'echo.',
            'if "%VN_HARNESS_PAUSE%"=="1" pause',
            'exit /b 1'
        )
        Write-TextFile -Path (Join-Path $DistDir 'START-HERE.bat') -Lines $lines -Newline "`r`n"
        return
    }

    $lines = @(
        '#!/bin/sh',
        '# ============================================================',
        '#  vn-harness - START HERE',
        '#  Generated by scripts/dist.sh - do not edit; re-run the',
        '#  distributer in the source repository to change it.',
        '#',
        '#  Run it:  ./START-HERE.sh',
        '#  It makes sure the DeepSeek Harness web profile has this pack',
        '#  installed from THIS folder, then opens vn-harness in its own',
        '#  window.',
        '#',
        '#  Requirements: Node.js 22 or newer on PATH, and network access',
        '#  on the first run (the shell downloads the pinned harness',
        "#  $DshPin through npx, once).",
        '#',
        '#  It is safe to run again: the installer skips the bundles it',
        '#  already has at their current version and re-adds the ones',
        '#  whose version moved. If you installed the pack already and',
        '#  want to skip the check, run ./vn-harness directly.',
        '#',
        '#  The colour decision and the window rule come from the shipped',
        '#  scripts/console/theme.sh, exactly as they do for the other',
        '#  launchers: colour only on a real terminal, never in a',
        '#  redirected log, and the window held open only when it would',
        '#  otherwise vanish.',
        '# ============================================================',
        'set -u',
        'dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
        'cd "$dir" || exit 1',
        '. ./scripts/console/theme.sh',
        'command -v node >/dev/null 2>&1 || {',
        '  vn_fail "Node.js 22 or newer is required - https://nodejs.org"',
        '  vn_pause',
        '  exit 1',
        '}',
        'vn_step "Making sure the harness web profile has this pack..."',
        'sh ./scripts/install-all.sh "$@" || {',
        '  vn_fail "install FAILED - see the messages above."',
        '  vn_pause',
        '  exit 1',
        '}',
        'vn_step "Starting vn-harness. Close the window to stop it."',
        'exec ./vn-harness "$@"'
    )
    $target = Join-Path $DistDir 'START-HERE.sh'
    Write-TextFile -Path $target -Lines $lines -Newline "`n"
    try { & chmod 755 $target | Out-Null } catch { }
}

function New-DistReadme {
    param([string]$DistDir, [string]$Version, [string]$DshPin, [string]$Rid, [string]$BuiltAt, [string]$Commit)
    $lines = @(
        "vn-harness $Version - $Rid",
        "Built $BuiltAt from commit $Commit.",
        '',
        'WHAT THIS IS',
        '  The DeepSeek Harness, with this pack installed into it, in a native',
        '  window instead of a browser tab.',
        '',
        '  The window is a LAUNCHER: vn-harness.exe (./vn-harness on macOS and',
        '  Linux) starts the pinned harness',
        '',
        "      npx @deepseek-ai/dsh@$DshPin web --no-open",
        '',
        '  on a free loopback port, reads the ready line it prints once the',
        '  server is listening, and shows THAT url in a WebView2 / WKWebView /',
        '  WebKitGTK window. The plugins are not compiled into the binary - the',
        '  harness web profile installs every bundle in packages/ as a LIVE LINK,',
        '  which is why this folder must stay where it is.',
        '',
        'REQUIREMENTS',
        '  - Node.js 22 or newer on PATH .......... https://nodejs.org',
        '  - Network access on the first run ...... the shell downloads the',
        "    pinned harness $DshPin through npx, once (it is",
        '    cached afterwards).',
        '  - Windows: the WebView2 runtime (present on Windows 10 and 11).',
        '  - macOS/Linux: nothing beyond Node.js.',
        '',
        'CLICK THIS',
        '  Windows:      START-HERE.bat',
        '  macOS/Linux:  ./START-HERE.sh',
        '',
        '  Both install this pack into the harness web profile (from THIS',
        '  folder, wherever it now is) and then open the window. Already',
        '  installed? Run vn-harness.exe (./vn-harness) and skip the check.',
        '',
        '  The window shows the SAME profile a run-web.bat / ./run-web.sh browser tab',
        '  shows, so sessions, settings and everything the pack remembers are',
        '  shared with it.',
        '',
        'THE LAUNCHERS',
        '  vn-harness.exe | ./vn-harness    the app in its native window',
        '  run-desktop.bat                  the same, started from a console - and',
        '                                   it needs no Rust, because it runs the',
        '                                   binary sitting beside it',
        '  run-web.bat | ./run-web.sh       the app in a browser tab instead',
        '  install.bat | ./install.sh       install/re-install the pack, no window',
        '  uninstall.bat | ./uninstall.sh   remove what this pack installed',
        '',
        '  All of them take -Help (also -h and /?), -NoPause and -NoTerminal, and',
        '  all of them decide their console in ONE shared place (scripts/console/):',
        '  a double-click opens in Windows Terminal when it is installed, colour',
        '  appears only on a real terminal and never in a redirected log, and the',
        '  launch token is never written down.',
        '',
        'THE FLAGS THE SHELL TAKES',
        '  -Port <n>          listen on this port instead of a free one',
        '  -DshHome <dir>     override DSH_HOME (default: $DSH_HOME, else ~/.dsh)',
        '  -DshVersion <ver>  override the pinned harness version',
        '  -Help              print the help',
        '',
        '  The launch token in the ready line is a live credential for the',
        '  running process: the shell prints that line with the token REDACTED,',
        '  holds the real one in memory only, and refuses to open a url that is',
        '  not a loopback address.',
        '',
        'BUILDING ANOTHER COPY',
        '  This folder is the product, not the workshop: distribute.bat is',
        '  deliberately NOT here. A distribution is assembled in the repository it',
        '  came from (scripts/dist-manifest.txt lists exactly what ships).',
        '',
        'VERIFY THIS COPY',
        '  SHA256SUMS.txt holds the SHA-256 of every file beside it.',
        '      Windows:        Get-FileHash (or certutil -hashfile <file> SHA256)',
        '      macOS/Linux:    sha256sum -c SHA256SUMS.txt  (shasum -a 256 -c)',
        '  BUILD-INFO.json records the pack version, the harness pin, the commit',
        '  it was built from and the toolchain that built it.',
        '',
        'UNINSTALL',
        '  Windows:      uninstall.bat',
        '  macOS/Linux:  ./uninstall.sh',
        '  Both remove only what this pack installed; your sessions and settings',
        '  are untouched. Deleting this folder afterwards is the rest of it.'
    )
    Write-TextFile -Path (Join-Path $DistDir 'DIST-README.txt') -Lines $lines -Newline "`n"
}

# One flat JSON object, written with an explicit key order so the Windows and
# the POSIX half produce the same document for the same facts.
function New-BuildInfo {
    param([string]$DistDir, [string]$Version, [string]$DshPin, [string]$Rid, [string]$Artifact,
        [string]$Commit, [bool]$Dirty, [string]$BuiltAt, [string]$Builder, [string]$Rustc,
        [string]$Node, [int]$PayloadFiles, [long]$PayloadBytes, [string]$ShellSha)
    $lines = @(
        '{',
        "  `"name`": `"vn-harness`",",
        "  `"packVersion`": `"$Version`",",
        "  `"artifact`": `"$Artifact`",",
        "  `"dshPin`": `"$DshPin`",",
        "  `"rid`": `"$Rid`",",
        "  `"platform`": `"$script:Platform`",",
        "  `"arch`": `"$($Rid.Split('-')[-1])`",",
        "  `"commit`": `"$Commit`",",
        "  `"dirty`": $(if ($Dirty) { 'true' } else { 'false' }),",
        "  `"builtAt`": `"$BuiltAt`",",
        "  `"builtBy`": `"$Builder`",",
        "  `"rustc`": `"$Rustc`",",
        "  `"node`": `"$Node`",",
        "  `"shellBinary`": `"$script:BinaryName`",",
        "  `"shellSha256`": `"$ShellSha`",",
        "  `"payloadFiles`": $PayloadFiles,",
        "  `"payloadBytes`": $PayloadBytes",
        '}'
    )
    Write-TextFile -Path (Join-Path $DistDir 'BUILD-INFO.json') -Lines $lines -Newline "`n"
}

function New-Sums {
    param([string]$DistDir)
    $lines = New-Object System.Collections.ArrayList
    foreach ($item in (Get-ChildItem -LiteralPath $DistDir -Recurse -File -Force | Sort-Object FullName)) {
        $rel = $item.FullName.Substring($DistDir.Length).TrimStart('\', '/').Replace('\', '/')
        if ($rel -eq 'SHA256SUMS.txt') { continue }
        [void]$lines.Add("$(Get-Sha256 -Path $item.FullName)  $rel")
    }
    Write-TextFile -Path (Join-Path $DistDir 'SHA256SUMS.txt') -Lines ([string[]]$lines) -Newline "`n"
    return $lines.Count
}

# Forward slashes in the entry names, and the top folder inside the archive, so
# extracting the zip makes one folder and never a puddle of files.
function New-ZipArchive {
    param([string]$SourceDir, [string]$ZipPath, [string]$RootName)
    if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
    # Two assemblies on Windows PowerShell 5.1: ZipFile lives in
    # System.IO.Compression.FileSystem, ZipArchiveMode in System.IO.Compression
    # (on PowerShell 7 the type is already loaded and both are no-ops).
    try { Add-Type -AssemblyName System.IO.Compression } catch { }
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::Open($ZipPath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        $prefix = "$RootName/"
        foreach ($file in (Get-ChildItem -LiteralPath $SourceDir -Recurse -File -Force | Sort-Object FullName)) {
            $rel = $file.FullName.Substring($SourceDir.Length).TrimStart('\', '/').Replace('\', '/')
            $entry = $archive.CreateEntry($prefix + $rel, [System.IO.Compression.CompressionLevel]::Optimal)
            try { $entry.LastWriteTime = [System.DateTimeOffset]$file.LastWriteTime } catch { }
            $target = $entry.Open()
            try {
                $source = [System.IO.File]::OpenRead($file.FullName)
                try { $source.CopyTo($target) } finally { $source.Dispose() }
            }
            finally { $target.Dispose() }
        }
    }
    finally { $archive.Dispose() }
}

# ---------------------------------------------------------------------------
# The ready line, and the two rules that are load-bearing
# ---------------------------------------------------------------------------
<#
    The harness prints one ready line, on stdout, once the server is listening:

        dsh web: http://127.0.0.1:3080/?token=<token> (LAN: http://<ip>:<port>/?token=<token>)

    ANSI colour codes are stripped first (a profile can colour its own console
    output) and only a line naming `dsh web:` is considered, so no unrelated url
    is ever mistaken for it. This is the same reader scripts/run-web.ps1 uses.
#>
function Get-ReadyUrl {
    param([string]$Text)
    if (-not $Text) { return $null }
    $clean = [regex]::Replace($Text, ([string][char]27 + '\[[0-9;]*[A-Za-z]'), '')
    if ($clean.IndexOf('dsh web:') -lt 0) { return $null }
    $match = [regex]::Match($clean, 'https?://[^\s"'']+')
    if (-not $match.Success) { return $null }
    return $match.Value.TrimEnd('.', ',', ')', ']', '"', "'")
}

function Test-LoopbackUrl {
    param([string]$Url)
    try { $uri = [System.Uri]$Url } catch { return $false }
    if ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') { return $false }
    if ($uri.Host -eq 'localhost') { return $true }
    $address = $null
    if ([System.Net.IPAddress]::TryParse($uri.Host, [ref]$address)) {
        return [System.Net.IPAddress]::IsLoopback($address)
    }
    return $false
}

# The token is a live credential: it is replaced wherever this script prints a
# ready line, so a scrollback buffer or a CI log never holds one.
function Get-Redacted {
    param([string]$Text)
    if (-not $Text) { return '' }
    return [regex]::Replace($Text, 'token=[^\s&"'']*', 'token=REDACTED')
}

function Get-FreePort {
    $listener = New-Object -TypeName System.Net.Sockets.TcpListener -ArgumentList @([System.Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = $listener.LocalEndpoint.Port
    $listener.Stop()
    return $port
}

function Test-PortFree {
    param([int]$Port)
    try {
        $listener = New-Object -TypeName System.Net.Sockets.TcpListener -ArgumentList @([System.Net.IPAddress]::Loopback, $Port)
        $listener.Start()
        $listener.Stop()
        return $true
    }
    catch { return $false }
}

# ---------------------------------------------------------------------------
# -Verify: install this distribution into a throwaway home and boot it
# ---------------------------------------------------------------------------
<#
    The one check that proves the FOLDER works rather than the build: it runs the
    distribution's own installer against a temporary DSH_HOME, asserts the
    profile now lists every bundle the folder carries, then starts the pinned
    harness with that home and waits for the ready line. It never opens a window
    (a CI runner has no screen) - the window is what `-Run` is for - so this is
    the same check a local run and the workflow can both afford.
#>
function Invoke-Verify {
    param([string]$DistDir, [string]$DshPin)

    # The distribution's OWN installer, in the host's own flavour: verifying the
    # other half's installer would prove nothing about this folder.
    $installerName = 'install-all.ps1'
    if (-not $script:IsWindowsHost) { $installerName = 'install-all.sh' }

    $tempHome = Join-Path ([System.IO.Path]::GetTempPath()) ('vn-harness-dist-verify-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $tempHome | Out-Null
    Write-Step "Verify: throwaway DSH_HOME $tempHome"

    <#
        The check runs against a COPY of the distribution, and that is the point:
        a distribution is a folder somebody extracts somewhere else, so a copy in
        a temp folder is exactly the thing being promised. It also keeps the real
        folder pristine - the installer bootstraps its own pnpm under a LOCAL
        tools/ when the machine has none, and running it in place would leave
        that tree inside the distribution after the archive was already made.
    #>
    $probe = Join-Path $tempHome 'distribution'
    Copy-Item -LiteralPath $DistDir -Destination $probe -Recurse -Force
    Write-Step 'Verify: copied the distribution to a temp folder (as if it had been moved).'

    $installer = Join-Path $probe (Join-Path 'scripts' $installerName)
    if (-not (Test-Path -LiteralPath $installer)) { throw "The distribution has no scripts/$installerName in it." }

    $savedHome = $env:DSH_HOME
    try {
        Write-Step 'Verify: installing the distribution into that home...'
        # A native command writing to stderr becomes a terminating
        # NativeCommandError under 'Stop' - and the installer drives npx, which
        # reports progress on stderr. Judged by its exit code alone, exactly as
        # scripts/run-web.ps1 does around the same call.
        $previousEap = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            if ($script:IsWindowsHost) {
                & powershell -NoProfile -ExecutionPolicy Bypass -File $installer -DshHome $tempHome
            }
            else {
                & sh $installer -DshHome $tempHome
            }
            $installExit = $LASTEXITCODE
        }
        finally { $ErrorActionPreference = $previousEap }
        if ($installExit -ne 0) { throw "The distribution's installer exited with code $installExit." }

        $profileManifest = Join-Path (Join-Path (Join-Path $tempHome 'profiles') 'web') 'package.json'
        if (-not (Test-Path -LiteralPath $profileManifest)) { throw "The installer did not create a web profile at $profileManifest." }
        $profile = Get-Content -LiteralPath $profileManifest -Raw | ConvertFrom-Json
        $installed = @($profile.dsh.profile.bundles)
        $missing = New-Object System.Collections.ArrayList
        foreach ($bundle in (Get-DistBundleNames -DistDir $DistDir)) {
            if ($installed -notcontains $bundle) { [void]$missing.Add($bundle) }
        }
        if ($missing.Count -gt 0) {
            throw "The profile did not end up listing: $($missing -join ', ')."
        }
        Write-Step "Verify: the profile lists all $(@(Get-DistBundleNames -DistDir $DistDir).Count) bundles this folder carries."

        Assert-Tool 'node' | Out-Null
        $npx = Get-ToolPath -Names (Get-ToolNames -Name 'npx')
        if (-not $npx) { throw 'npx was not found on PATH.' }

        $port = Get-FreePort
        $log = Join-Path $tempHome 'boot.log'
        $err = Join-Path $tempHome 'boot.err'
        $spec = "@deepseek-ai/dsh@$DshPin"
        Write-Step "Verify: booting the pinned harness from the distribution (port $port)..."

        $env:DSH_HOME = $tempHome
        $arguments = @('--yes', $spec, 'web', '--no-open', '--port', [string]$port)
        $process = Start-Process -FilePath $npx -ArgumentList $arguments -RedirectStandardOutput $log -RedirectStandardError $err -PassThru -NoNewWindow

        $deadline = (Get-Date).AddSeconds(180)
        $ready = $null
        while ((Get-Date) -lt $deadline) {
            if (Test-Path -LiteralPath $log) {
                $text = Get-Content -LiteralPath $log -Raw -ErrorAction SilentlyContinue
                $ready = Get-ReadyUrl -Text $text
                if ($ready) { break }
            }
            $process.Refresh()
            if ($process.HasExited) { break }
            Start-Sleep -Milliseconds 750
        }

        try {
            if ($script:IsWindowsHost) { & taskkill /PID $process.Id /T /F 2>$null | Out-Null }
            else { & kill -TERM $process.Id 2>$null | Out-Null }
            Start-Sleep -Milliseconds 700
            try { $process.Kill() } catch { }
        }
        catch { }        # The window is gone; make sure nothing is still holding the port, or a
        # CI runner would carry a listening server into the next step.
        $free = $false
        for ($i = 0; $i -lt 20; $i++) {
            if (Test-PortFree -Port $port) { $free = $true; break }
            if ($script:IsWindowsHost) {
                try {
                    foreach ($owner in (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
                        & taskkill /PID $owner.OwningProcess /T /F 2>$null | Out-Null
                    }
                }
                catch { }
            }
            Start-Sleep -Milliseconds 500
        }

        if (-not $ready) {
            Write-Host ''
            Write-Step 'Verify FAILED: no "dsh web:" ready line within 180 seconds.'
            if (Test-Path -LiteralPath $log) {
                $tail = Get-Content -LiteralPath $log -Tail 20 -ErrorAction SilentlyContinue
                if ($tail) { Write-Note (Get-Redacted ($tail -join "`n")) }
            }
            if (Test-Path -LiteralPath $err) {
                $tail = Get-Content -LiteralPath $err -Tail 20 -ErrorAction SilentlyContinue
                if ($tail) { Write-Note (Get-Redacted ($tail -join "`n")) }
            }
            throw 'The distribution never became ready.'
        }

        if (-not (Test-LoopbackUrl -Url $ready)) {
            throw "The ready line did not name a loopback address (refused rather than trusted): $(Get-Redacted $ready)"
        }
        $uri = [System.Uri]$ready
        Write-Step "Verify PASSED: the distribution booted and answered at $($uri.Scheme)://$($uri.Host):$($uri.Port)/?token=REDACTED"
        Write-Note "The harness served the web profile installed from this folder."
        if (-not $free) {
            Write-Note "Warning: 127.0.0.1:$port was still listening after the stop; check for a stray node process."
        }
    }
    finally {
        if ($null -eq $savedHome) { Remove-Item Env:\DSH_HOME -ErrorAction SilentlyContinue }
        else { $env:DSH_HOME = $savedHome }
        if ($KeepVerifyHome) {
            Write-Note "Kept the throwaway home: $tempHome"
        }
        else {
            Remove-Item -LiteralPath $tempHome -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# ===========================================================================
# main
# ===========================================================================
if ($Help) { Show-Usage; exit 0 }

Write-Step 'vn-harness distributer (build a distribution folder)'
Write-Step "Platform: $script:Platform (PowerShell $($PSVersionTable.PSVersion))"
Write-Step "Repo: $script:RepoRoot"

$pin = Get-DshPin
$packVersion = $Version
if (-not $packVersion) { $packVersion = Get-PackVersion }
$rid = Get-HostRid
$artifact = "vn-harness-$packVersion-$rid"
$distRoot = Join-Path $script:RepoRoot 'dist'
$distDir = Join-Path $distRoot $artifact
$zipPath = Join-Path $distRoot "$artifact.zip"

Write-Step "Pack version: $packVersion   Harness pin: $pin   Target: $rid"

if ($Clean -and (Test-Path -LiteralPath $distRoot)) {
    Write-Step 'Cleaning dist/ ...'
    Remove-Item -LiteralPath $distRoot -Recurse -Force
}

# --- 1. the shell binary ---------------------------------------------------
$binary = Join-Path $script:RepoRoot (Join-Path 'app/src-tauri' (Join-Path 'target/release' $script:CargoBinaryName))
if (-not $SkipBuild) {
    $cargo = Get-Command cargo -ErrorAction SilentlyContinue
    if (-not $cargo) {
        throw 'cargo was not found on PATH. Install the Rust toolchain from https://rustup.rs, or pass -SkipBuild to reuse an existing build.'
    }
    Write-Step 'Building app/src-tauri (cargo does nothing when it is current)...'
    $manifest = Join-Path $script:RepoRoot 'app/src-tauri/Cargo.toml'
    & cargo build --release --manifest-path $manifest
    if ($LASTEXITCODE -ne 0) {
        # The failure a person actually hits: Windows locks a RUNNING binary, so
        # a window that is open makes cargo's relink fail with a bare "Access is
        # denied" that names the .exe and nothing else. Say what it means.
        $running = @(Get-Process -Name 'vn-harness-desktop' -ErrorAction SilentlyContinue)
        if ($running.Count -gt 0) {
            $pids = ($running | ForEach-Object { $_.Id }) -join ', '
            throw "cargo build failed (exit $LASTEXITCODE), and vn-harness is RUNNING right now (PID $pids). Windows does not let a build replace a binary that is in use, which is what 'Access is denied' on vn-harness-desktop.exe means. Close the vn-harness window and run this again, or pass -SkipBuild to package the binary already under app/src-tauri/target/release."
        }
        throw "cargo build failed (exit $LASTEXITCODE) - see the errors above."
    }
}
else {
    Write-Step 'Skipping the build (-SkipBuild).'
}
if (-not (Test-Path -LiteralPath $binary)) {
    throw "The shell binary is not at $binary. Drop -SkipBuild so it gets built."
}
$shellSha = Get-Sha256 -Path $binary
Write-Step "Shell binary: $binary ($([math]::Round((Get-Item -LiteralPath $binary).Length / 1MB, 1)) MB)"

# --- 2. the payload --------------------------------------------------------
$rules = Get-ManifestRules
if (Test-Path -LiteralPath $distDir) { Remove-Item -LiteralPath $distDir -Recurse -Force }
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
Write-Step "Assembling $distDir from scripts/dist-manifest.txt ..."
$included = Copy-Payload -Destination $distDir -Rules $rules
Copy-Item -LiteralPath $binary -Destination (Join-Path $distDir $script:BinaryName) -Force
if (-not $script:IsWindowsHost) { try { & chmod 755 (Join-Path $distDir $script:BinaryName) | Out-Null } catch { } }
Write-Note "$included include rules applied; the shell binary copied in as $($script:BinaryName)."
Assert-Sentinels -DistDir $distDir

$payload = Measure-Tree -Root $distDir
$node = (Invoke-Quiet -File 'node' -Arguments @('--version'))
$rustc = (Invoke-Quiet -File 'rustc' -Arguments @('--version'))
$commit = (Invoke-Quiet -File 'git' -Arguments @('-C', $script:RepoRoot, 'rev-parse', '--short', 'HEAD'))
if (-not $commit) { $commit = 'unknown' }
$status = (Invoke-Quiet -File 'git' -Arguments @('-C', $script:RepoRoot, 'status', '--porcelain'))
$dirty = [bool]$status
$builtAt = Get-UtcStamp

# --- 3. the files it generates for itself ----------------------------------
New-StartHere -DistDir $distDir -DshPin $pin
New-DistReadme -DistDir $distDir -Version $packVersion -DshPin $pin -Rid $rid -BuiltAt $builtAt -Commit $commit
New-BuildInfo -DistDir $distDir -Version $packVersion -DshPin $pin -Rid $rid -Artifact $artifact `
    -Commit $commit -Dirty $dirty -BuiltAt $builtAt -Builder 'scripts/dist.ps1' `
    -Rustc $rustc -Node $node -PayloadFiles $payload.Files -PayloadBytes $payload.Bytes -ShellSha $shellSha
$summed = New-Sums -DistDir $distDir
Write-Note "Generated START-HERE, DIST-README.txt, BUILD-INFO.json and SHA256SUMS.txt ($summed files hashed)."

$total = Measure-Tree -Root $distDir
Write-Step ("Distribution: {0} files, {1:N1} MB" -f $total.Files, ($total.Bytes / 1MB))

# --- 4. the zip ------------------------------------------------------------
if ($NoZip) {
    Write-Step 'Skipping the zip (-NoZip).'
}
else {
    Write-Step "Zipping into $zipPath ..."
    New-ZipArchive -SourceDir $distDir -ZipPath $zipPath -RootName $artifact
    Write-Step ("Zip: {0} ({1:N1} MB)" -f $zipPath, ((Get-Item -LiteralPath $zipPath).Length / 1MB))
}

# --- 5. what was asked for next -------------------------------------------
if ($Verify) {
    Write-Host ''
    Invoke-Verify -DistDir $distDir -DshPin $pin
}

Write-Host ''
Write-Step 'Done.'
Write-Note "Folder to click: $distDir"
if ($script:IsWindowsHost) { Write-Note "  double-click START-HERE.bat (it installs the pack, then opens the window)" }
else { Write-Note "  ./START-HERE.sh (it installs the pack, then opens the window)" }
if (-not $NoZip) { Write-Note "Zip to hand over: $zipPath" }
Write-Note 'dist/ is gitignored on purpose: it is build output, and it is a copy - re-run this after editing a plugin.'

if ($Run) {
    Write-Host ''
    Write-Step "Running the distribution: $(Join-Path $distDir $script:BinaryName)"
    & (Join-Path $distDir $script:BinaryName)
    exit $LASTEXITCODE
}
exit 0
