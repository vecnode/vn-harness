#Requires -Version 5.1
<#
.SYNOPSIS
    Re-syncs the vendored DeepSeek Harness client bundles this pack forks.

.DESCRIPTION
    The pack owns its right bar: instead of depending on the shipped
    @deepseek-ai/dsh-client-ui-sidebar-right / -sidebar-files rows, it ships
    byte-for-byte copies (module-table client bundles) under its own package
    names, and its bundle layer hard-disables the core rows so only the pack's
    copies run.

    It owns the file-manager half of "Open In..." the same way: the shipped
    @deepseek-ai/dsh-client-ui-open-in-app browser bundle is forked into
    dsh-open-in-app with the module-table id rewritten AND a small documented
    patch list applied (each fork entry's Patches). The patch list is part of
    this script on purpose - a plain copy would be overwritten on the next
    re-sync, and a hand-edited vendored file would drift silently.

    Run this after bumping the pinned harness line to move the forks forward:
    it copies each core bundle from the harness installation, rewrites the
    module-table id to the pack's package name, applies that fork's patches,
    stamps a generated-file banner, and reports versions + hashes.

.PARAMETER CoreModules
    Directory holding the harness's own node_modules (the one with
    @deepseek-ai/dsh-client-ui-sidebar-right inside). Discovered automatically
    when omitted: the profile first, then the npx cache / global installs.

.PARAMETER DshHome
    Harness home to look in first (default: $env:DSH_HOME, else ~/.dsh).

.PARAMETER Check
    Report what would change without writing anything (exit 1 when out of sync).

.NOTES
    Runs on Windows PowerShell 5.1 and on PowerShell 7+ (pwsh) on Windows, macOS
    and Linux: paths are built with Join-Path, and the candidate roots cover the
    Windows npm cache as well as the POSIX ~/.npm/_npx and global module
    directories.
#>
[CmdletBinding()]
param(
    [string]$CoreModules = '',
    [string]$DshHome = '',
    [switch]$Check
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

# ---------------------------------------------------------------------------
# Platform facts (Windows PowerShell 5.1 has no $IsWindows/$IsMacOS/$IsLinux)
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

function Write-Step($msg) { Write-Host "[sync-vendored] $msg" -ForegroundColor Cyan }

<#
    One run of `$n` tab characters: the bundles are tab-indented, and a
    here-string cannot carry a literal tab safely, so patch text is assembled
    from explicit pieces.
#>
function T($n) { return ("`t" * $n) }

# The fork's own Chinese `dock.splitPaneDisabled` label, built from code points
# so this script keeps its ASCII-only rule (see AGENTS.md): the bundle carries
# the literal characters, so a patch that matches (and rewrites) them has to
# produce the same characters without putting them in this file.
$splitCapTwo = (-join ([char[]](0x5DF2, 0x8FBE, 0x4E24, 0x683C, 0x4E0A, 0x9650)))
$splitCapFour = (-join ([char[]](0x5DF2, 0x8FBE, 0x56DB, 0x683C, 0x4E0A, 0x9650)))

# Vendored package -> the core package it forks, plus the patches applied after
# the module-table id is rewritten. A patch is a literal Find/Replace pair: the
# Find text must appear exactly once (tab-indented), and a re-sync that cannot
# place one fails loudly instead of shipping a fork that silently lost it.
$vendored = @(
    # The sidebar-right bundle caps its dock at TWO panes in five places, while
    # the docking kit it builds on allows `MAX_DOCK_PANES` (4) and offers all five
    # of its drop zones. These patches hand the limit back to the kit's own
    # `canSplit` (fewer than four), re-open the top/bottom bands - a tab dragged
    # into a pane's upper or lower quarter stacks a pane there, which is how a 2x2
    # is built, since the Split control itself always adds a column to the right -
    # and let the disabled Split hint name the ceiling that is actually in force.
    [pscustomobject]@{
        Name    = 'dsh-rightbar'
        Core    = '@deepseek-ai/dsh-client-ui-sidebar-right'
        Patches = @(
            [pscustomobject]@{
                Label   = 'lift the two-pane cap: the split intent is bounded by the kit own canSplit'
                Find    = '(0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(state).length >= 2 || '
                Replace = ''
            },
            [pscustomobject]@{
                Label   = 'lift the two-pane cap: an edge drop is bounded by the kit own canSplit, top and bottom included'
                Find    = (@(
                        ((T 7) + 'if (zone === "top" || zone === "bottom") return [];'),
                        ((T 7) + 'if (zone !== "center" && (0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(state).length >= 2) return [];'),
                        ''
                    ) -join "`n")
                Replace = ''
            },
            [pscustomobject]@{
                Label   = 'lift the two-pane cap: the dock surface is bounded by the kit own canSplit'
                Find    = '(0, _deepseek_ai_dsh_client_ui_dockkit.canSplit)(surface.layout) && (0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(surface.layout).length < 2'
                Replace = '(0, _deepseek_ai_dsh_client_ui_dockkit.canSplit)(surface.layout)'
            },
            [pscustomobject]@{
                Label   = 'offer every drop band a pane has, not left and right only'
                Find    = 'dropZones: "horizontal",'
                Replace = 'dropZones: "edges",'
            },
            [pscustomobject]@{
                Label   = 'lift the two-pane cap: the split command is bounded by the kit own canSplit'
                Find    = ' || (0, _deepseek_ai_dsh_client_ui_dockkit.dockPaneIds)(layout).length >= 2'
                Replace = ''
            },
            [pscustomobject]@{
                Label   = 'the disabled split hint names the kit own ceiling'
                Find    = '"dock.splitPaneDisabled": "Two panes is the limit",'
                Replace = '"dock.splitPaneDisabled": "Four panes is the limit",'
            },
            [pscustomobject]@{
                Label   = 'the Chinese disabled split hint names the same ceiling'
                Find    = '"dock.splitPaneDisabled": "' + $splitCapTwo + '",'
                Replace = '"dock.splitPaneDisabled": "' + $splitCapFour + '",'
            }
        )
    },
    [pscustomobject]@{
        Name    = 'dsh-rightbar-files'
        Core    = '@deepseek-ai/dsh-client-ui-sidebar-files'
        Patches = @()
    },
    [pscustomobject]@{
        Name    = 'dsh-open-in-app'
        Core    = '@deepseek-ai/dsh-client-ui-open-in-app'
        Patches = @(
            [pscustomobject]@{
                Label   = 'declare the pack launcher route and the file-manager catalog ids'
                Find    = (T 2) + 'const OPEN_IN_APP_OPEN_ROUTE = "/open-in-app/open";'
                # Every element is parenthesized: the comma operator binds tighter
                # than "+", so bare concatenations would collapse into one line.
                Replace = (@(
                        ((T 2) + 'const OPEN_IN_APP_OPEN_ROUTE = "/open-in-app/open";'),
                        ((T 2) + '/** dsh-open-in-app: the pack''s own cross-platform file-browser route. */'),
                        ((T 2) + 'const NATIVE_OPEN_ROUTE = "/api/dsh-open-in-app/open";'),
                        ((T 2) + '/** Catalog ids whose launch is a file manager, not an editor or terminal. */'),
                        ((T 2) + 'const NATIVE_FILE_MANAGER_APPS = new Set(["finder", "explorer", "filemanager"]);')
                    ) -join "`n")
            },
            [pscustomobject]@{
                Label   = 'send the file managers through the pack launcher, everything else unchanged'
                Find    = (T 4) + 'const response = await this.fetcher(new URL(OPEN_IN_APP_OPEN_ROUTE, hostBase()), {'
                Replace = (@(
                        ((T 4) + 'const route = NATIVE_FILE_MANAGER_APPS.has(appId) ? NATIVE_OPEN_ROUTE : OPEN_IN_APP_OPEN_ROUTE;'),
                        ((T 4) + 'const response = await this.fetcher(new URL(route, hostBase()), {')
                    ) -join "`n")
            }
        )
    }
)

function Write-Step($msg) { Write-Host "[sync-vendored] $msg" -ForegroundColor Cyan }

<#
    Candidate node_modules roots, best first: an explicit -CoreModules, the
    profile's own modules, then every npx cache / global install that carries
    the harness packages (newest first).
#>
function Get-CandidateRoots {
    param([string]$Explicit, [string]$HomeDir)
    $roots = @()
    if ($Explicit) { $roots += $Explicit }
    if (-not $HomeDir) { $HomeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path (Get-HomeDir) '.dsh' } }
    $roots += (Join-Path (Join-Path (Join-Path $HomeDir 'profiles') 'web') 'node_modules')
    # npm's on-demand cache lives in different places per platform: the Windows
    # Local/AppData roaming folders, and ~/.npm/_npx on macOS/Linux.
    $caches = @()
    if ($env:LOCALAPPDATA) { $caches += (Join-Path (Join-Path $env:LOCALAPPDATA 'npm-cache') '_npx') }
    if ($env:APPDATA) { $caches += (Join-Path (Join-Path $env:APPDATA 'npm-cache') '_npx') }
    $caches += (Join-Path (Join-Path (Get-HomeDir) '.npm') '_npx')
    foreach ($cache in $caches) {
        if (-not (Test-Path $cache)) { continue }
        $hits = Get-ChildItem $cache -Directory -ErrorAction SilentlyContinue |
            ForEach-Object { Join-Path $_.FullName 'node_modules' } |
            Where-Object { Test-Path (Join-Path $_ '@deepseek-ai') }
        foreach ($hit in $hits) { $roots += $hit }
    }
    # Global installs, the shape "npm i -g @deepseek-ai/dsh" leaves behind.
    $globals = @('/usr/local/lib/node_modules', '/usr/lib/node_modules')
    if ($env:APPDATA) { $globals += (Join-Path $env:APPDATA 'npm\node_modules') }
    foreach ($global in $globals) {
        if (Test-Path (Join-Path $global '@deepseek-ai')) { $roots += $global }
    }
    return ($roots | Select-Object -Unique)
}

<#
    The first candidate root that carries every core package we vendor.
#>
function Resolve-CoreModules {
    param([string]$Explicit, [string]$HomeDir)
    foreach ($root in (Get-CandidateRoots -Explicit $Explicit -HomeDir $HomeDir)) {
        $ok = $true
        foreach ($item in $vendored) {
            $probe = Join-Path (Join-Path $root '@deepseek-ai') (Split-Path $item.Core -Leaf)
            if (-not (Test-Path (Join-Path $probe 'package.json'))) { $ok = $false; break }
        }
        if ($ok) { return $root }
    }
    throw 'Could not find a harness node_modules carrying the core sidebar packages. Pass -CoreModules "<harness>/node_modules".'
}

function Get-CorePackageDir {
    param([string]$Root, [string]$CoreName)
    return (Join-Path (Join-Path $Root '@deepseek-ai') (Split-Path $CoreName -Leaf))
}

function Get-Sha1 {
    param([byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA1]::Create()
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

$coreRoot = Resolve-CoreModules -Explicit $CoreModules -HomeDir $DshHome
Write-Step "core modules: $coreRoot"

$outOfSync = $false
foreach ($item in $vendored) {
    $coreDir = Get-CorePackageDir -Root $coreRoot -CoreName $item.Core
    $sourcePath = Join-Path (Join-Path $coreDir 'lib') 'client.js'
    $targetPath = Join-Path (Join-Path (Join-Path (Join-Path $repoRoot 'packages') $item.Name) 'lib') 'client.js'
    if (-not (Test-Path $sourcePath)) { throw "missing $sourcePath" }
    if (-not (Test-Path $targetPath)) { throw "missing $targetPath (create the package first)" }

    $coreVersion = 'unknown'
    try { $coreVersion = (Get-Content (Join-Path $coreDir 'package.json') -Raw | ConvertFrom-Json).version } catch {}

    $source = [System.IO.File]::ReadAllText($sourcePath, [System.Text.Encoding]::UTF8)
    # We only rewrite the module-table id: the CSS tag ids and the guide slot id
    # stay the core ones on purpose, so a vendored copy keeps its identity.
    $needle = 'id: "' + $item.Core + '"'
    if ($source.IndexOf($needle) -lt 0) { throw "could not find the module-table id in $sourcePath (layout changed?)" }
    $rewritten = $source.Replace($needle, 'id: "' + $item.Name + '"')

    # The fork's documented patches, applied in order. A Find that no longer
    # matches means the core bundle moved: fail here rather than ship a fork
    # that silently lost its behavior.
    $patchLabels = @()
    foreach ($patch in @($item.Patches)) {
        if ($null -eq $patch) { continue }
        if ($rewritten.IndexOf($patch.Find) -lt 0) {
            throw "could not apply the '$($patch.Label)' patch to $sourcePath (layout changed?)"
        }
        $rewritten = $rewritten.Replace($patch.Find, $patch.Replace)
        $patchLabels += $patch.Label
    }

    if ($patchLabels.Count -eq 0) {
        $banner = @"
// GENERATED - do not edit by hand.
//
// Byte-for-byte fork of $($item.Core)@$coreVersion
// (lib/client.js) with only the module-table id rewritten to "$($item.Name)".
// The pack's bundle layer disables the core row, so this copy is the one that
// runs. Re-sync with:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync-vendored.ps1
//
"@
    }
    else {
        $patchLines = ($patchLabels | ForEach-Object { '//   - ' + $_ }) -join "`n"
        $banner = @"
// GENERATED - do not edit by hand.
//
// Fork of $($item.Core)@$coreVersion (lib/client.js): the module-table id is
// rewritten to "$($item.Name)", and these patches from scripts\sync-vendored.ps1
// are applied on top:
$patchLines
// The pack's bundle layer disables the core row, so this copy is the one that
// runs. Re-sync with:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sync-vendored.ps1
//
"@
    }
    $banner = $banner.Replace("`r`n", "`n")
    # The here-string carries no trailing newline, and without one the banner
    # would comment out the bundle's first line.
    if (-not $banner.EndsWith("`n")) { $banner += "`n" }
    $next = $banner + $rewritten

    $nextBytes = [System.Text.Encoding]::UTF8.GetBytes($next)
    $currentBytes = [System.IO.File]::ReadAllBytes($targetPath)
    $nextHash = Get-Sha1 -Bytes $nextBytes
    $currentHash = Get-Sha1 -Bytes $currentBytes
    $same = ($nextHash -eq $currentHash)
    if ($same) {
        Write-Step "$($item.Name): in sync with $($item.Core)@$coreVersion ($nextHash)"
        continue
    }
    $outOfSync = $true
    if ($Check) {
        Write-Step "$($item.Name): OUT OF SYNC (core $coreVersion, $nextHash vs $currentHash)"
        continue
    }
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($targetPath, $next, $utf8NoBom)
    Write-Step "$($item.Name): updated from $($item.Core)@$coreVersion ($nextHash)"
}

if ($Check -and $outOfSync) { exit 1 }
Write-Step 'done.'
