#Requires -Version 5.1
<#
.SYNOPSIS
    Removes the vn-harness bundle set from the DeepSeek Harness web profile,
    together with any retired bundle name this pack shipped before (dsh-focus,
    dsh-files). Removing a bundle also removes its patch layer.

.DESCRIPTION
    This is the WINDOWS half of the uninstaller. macOS and Linux run
    scripts/uninstall-all.sh instead (plain POSIX shell - Node.js with npm/npx
    and no PowerShell at all); both halves take the same flags and reach the same
    profile state.

    One target only: the raw CLI/web install used by "npx @deepseek-ai/dsh web"
    (DSH_HOME, else ~/.dsh, profile "web" by default). DSH Desktop is not
    supported by this pack.

    Runs on Windows PowerShell 5.1 and on PowerShell 7+ (pwsh); the launchers are
    uninstall-all.bat and the root uninstall.bat. Every path, executable name and
    the PATH separator is resolved per platform.

    pnpm handling: the harness profile stores its pnpm layout in
    node_modules/.modules.yaml. The matching local pnpm major is bootstrapped
    under ./tools and invoked with the profile's own virtual-store settings.
#>
[CmdletBinding()]
param(
    [ValidateSet('web', 'cli')]
    [string]$Target = 'web',
    [string]$Plugin = '',
    [string]$DshHome = '',
    [string]$ProfileName = '',
    [string]$DshVersion = ''
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

# ---------------------------------------------------------------------------
# Platform facts. Windows PowerShell 5.1 HAS no $IsWindows/$IsMacOS/$IsLinux
# (it exists only on Windows), so the automatic variables are read defensively:
# the desktop edition is the reliable signal for 5.1.
# ---------------------------------------------------------------------------
$script:Platform = 'linux'
if ($PSVersionTable.PSEdition -ne 'Core') { $script:Platform = 'windows' }
elseif ($IsWindows) { $script:Platform = 'windows' }
elseif ($IsMacOS) { $script:Platform = 'macos' }

$script:IsWindowsHost = $script:Platform -eq 'windows'
# ';' on Windows, ':' on macOS/Linux.
$script:PathListSeparator = [System.IO.Path]::PathSeparator

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

# The pnpm executable the local bootstrap drops into node_modules/.bin.
function Get-PnpmBinName {
    if ($script:IsWindowsHost) { return 'pnpm.cmd' }
    return 'pnpm'
}

function Write-Step($msg) { Write-Host "[vn-harness] $msg" -ForegroundColor Yellow }

function Get-DshPin {
    $manifest = Join-Path $repoRoot '.dsh-version.json'
    if (-not (Test-Path $manifest)) { throw "Missing $manifest" }
    $json = Get-Content $manifest -Raw | ConvertFrom-Json
    return $json.dsh
}

function Get-Packages {
    $packagesDir = Join-Path $repoRoot 'packages'
    $found = @()
    if (Test-Path $packagesDir) {
        foreach ($dir in (Get-ChildItem $packagesDir -Directory | Sort-Object Name)) {
            $pkgJson = Join-Path $dir.FullName 'package.json'
            if (Test-Path $pkgJson) {
                $json = Get-Content $pkgJson -Raw | ConvertFrom-Json
                if ($json.dsh -and $json.dsh.bundle) {
                    $found += [pscustomobject]@{ Name = $json.name; Version = $json.version; Folder = $dir.FullName }
                }
            }
        }
    }
    if ($Plugin) {
        $filtered = @($found | Where-Object { $_.Name -like "*$Plugin*" })
        if ($filtered.Count -eq 0) { throw "No bundle matches '$Plugin'." }
        $found = $filtered
    }
    return $found
}

function Assert-Tool($name) {
    if (-not (Get-ToolPath -Names (Get-ToolNames -Name $name))) { throw "Required tool '$name' not found on PATH." }
}

function Get-PnpmStoreInfo {
    param([string]$ProfileDir)
    $info = @{ Major = 9; MaxLength = $null }
    $yaml = Join-Path (Join-Path $ProfileDir 'node_modules') '.modules.yaml'
    if (-not (Test-Path $yaml)) { return $info }
    $text = Get-Content $yaml -Raw -ErrorAction SilentlyContinue
    if (-not $text) { return $info }
    $m = [regex]::Match($text, 'store[\\/]+v(\d+)')
    if ($m.Success) {
        $major = 0
        if ([int]::TryParse($m.Groups[1].Value, [ref]$major) -and $major -ge 10) { $info.Major = $major }
    }
    $len = [regex]::Match($text, 'virtualStoreDirMaxLength["\s:]+(\d+)')
    if ($len.Success) { $info.MaxLength = $len.Groups[1].Value }
    return $info
}

function Ensure-PnpmForMajor {
    param([int]$Major)
    $existing = Get-ToolPath -Names (Get-ToolNames -Name 'pnpm')
    if ($existing) {
        $vText = (& $existing --version 2>$null)
        $v = 0
        if ($vText -and [int]::TryParse(($vText -split '\.')[0], [ref]$v) -and $v -ge $Major) {
            return Split-Path $existing
        }
    }
    $prefix = Join-Path (Join-Path $repoRoot 'tools') ('pnpm' + $Major)
    $binDir = Join-Path (Join-Path $prefix 'node_modules') '.bin'
    $local = Join-Path $binDir (Get-PnpmBinName)
    if (-not (Test-Path $local)) {
        Write-Step "Bootstrapping local pnpm@$Major under ./tools (no admin needed)..."
        $npm = Get-ToolPath -Names (Get-ToolNames -Name 'npm')
        if (-not $npm) { throw 'npm was not found (install Node.js first).' }
        & $npm install --prefix $prefix "pnpm@$Major" --no-audit --no-fund 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $local)) { throw "Failed to bootstrap pnpm@$Major into ./tools." }
    }
    return $binDir
}

function Resolve-WebTarget {
    param([string]$HomeDir, [string]$Profile)
    if (-not $HomeDir) { $HomeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path (Get-HomeDir) '.dsh' } }
    if (-not $Profile) { $Profile = 'web' }
    return [pscustomobject]@{
        Label      = 'web'
        DshHome    = $HomeDir
        Profile    = $Profile
        ProfileDir = (Join-Path (Join-Path $HomeDir 'profiles') $Profile)
    }
}

function Get-DshInvoker {
    $npx = Get-ToolPath -Names (Get-ToolNames -Name 'npx')
    if (-not $npx) { throw 'npx was not found.' }
    return $npx
}

function Invoke-Dsh {
    param([string]$DshHome, [string]$ProfileDir, [string[]]$Arguments)
    $npx = Get-DshInvoker
    $spec = "@deepseek-ai/dsh@$DshVersion"

    $storeInfo = Get-PnpmStoreInfo -ProfileDir $ProfileDir
    $pnpmBin = Ensure-PnpmForMajor -Major $storeInfo.Major
    $oldPath = $env:PATH
    $oldHome = $env:DSH_HOME
    $oldLen = $env:npm_config_virtual_store_dir_max_length
    $oldRootCheck = $env:npm_config_ignore_workspace_root_check

    $env:PATH = $pnpmBin + $script:PathListSeparator + $oldPath
    $env:DSH_HOME = $DshHome
    if ($storeInfo.MaxLength) { $env:npm_config_virtual_store_dir_max_length = $storeInfo.MaxLength }
    $env:npm_config_ignore_workspace_root_check = 'true'
    Write-Verbose "DSH_HOME=$DshHome pnpm=$pnpmBin storeMajor=$($storeInfo.Major) maxLen=$($storeInfo.MaxLength)"
    # See install-all.ps1: stderr from a native command would otherwise become a
    # terminating NativeCommandError under $ErrorActionPreference 'Stop'.
    $prevEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $exitCode = 0
    try {
        & $npx --yes $spec @Arguments 2>&1 | Out-Host
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $prevEap
        $env:PATH = $oldPath
        $env:DSH_HOME = $oldHome
        $env:npm_config_virtual_store_dir_max_length = $oldLen
        $env:npm_config_ignore_workspace_root_check = $oldRootCheck
    }
    if ($exitCode -ne 0) { throw "dsh exited with code $exitCode (command: $spec $($Arguments -join ' '))" }
}

function Get-InstalledBundles {
    param([string]$ProfileDir)
    $pkgJson = Join-Path $ProfileDir 'package.json'
    if (-not (Test-Path $pkgJson)) { return @() }
    $json = Get-Content $pkgJson -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
    if (-not $json.dsh -or -not $json.dsh.profile -or -not $json.dsh.profile.bundles) { return @() }
    return @($json.dsh.profile.bundles)
}

function Remove-From-Profile {
    param($Target, $Packages)
    $installed = Get-InstalledBundles -ProfileDir $Target.ProfileDir
    Write-Host ''
    Write-Step "Target: $($Target.Label) - profile '$($Target.Profile)' at $($Target.ProfileDir)"
    if (-not (Test-Path $Target.ProfileDir)) { Write-Host '  (profile not present - nothing to do)'; return }
    # Retired bundles: this pack shipped the panel as 'dsh-focus' (renamed to
    # 'dsh-files' in alpha.10) and later as 'dsh-files', which the GUI now ships
    # natively; remove any stale retired name too.
    $legacyNames = @('dsh-focus', 'dsh-files')
    foreach ($legacy in $legacyNames) {
        if ($installed -contains $legacy) {
            Write-Host "  - removing retired bundle '$legacy' ..."
            Invoke-Dsh -DshHome $Target.DshHome -ProfileDir $Target.ProfileDir -Arguments @('plugin', '--profile', $Target.Profile, 'remove', $legacy)
            Write-Host "  - removed retired bundle '$legacy'"
        }
    }
    foreach ($pkg in $Packages) {
        if ($installed -notcontains $pkg.Name) {
            Write-Host "  - $($pkg.Name): not installed (skip)"
            continue
        }
        Write-Host "  - removing $($pkg.Name) ..."
        Invoke-Dsh -DshHome $Target.DshHome -ProfileDir $Target.ProfileDir -Arguments @('plugin', '--profile', $Target.Profile, 'remove', $pkg.Name)
        Write-Host "  - removed $($pkg.Name)"
    }
}

# ---------------------------------------------------------------------------

Write-Step 'DeepSeek Harness plugin pack uninstaller (web profile)'
Write-Step "Platform: $script:Platform (PowerShell $($PSVersionTable.PSVersion))"
$DshVersion = if ($DshVersion) { $DshVersion } else { Get-DshPin }
Assert-Tool 'node'
Assert-Tool 'npm'
$packages = Get-Packages

$web = Resolve-WebTarget -HomeDir $DshHome -Profile $ProfileName
Remove-From-Profile -Target $web -Packages $packages

Write-Host ''
Write-Step 'Uninstall finished. Restart the CLI app afterwards.'
