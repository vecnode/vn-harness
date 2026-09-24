#Requires -Version 5.1
<#
.SYNOPSIS
    Installs the vn-harness bundle set into the DeepSeek Harness web profile
    on this machine.

.DESCRIPTION
    This is the WINDOWS half of the installer. macOS and Linux run
    scripts/install-all.sh instead (plain POSIX shell - Node.js with npm/npx and
    no PowerShell at all); both halves do the same work with the same flags,
    print the same messages and reach the same profile state, so keep them in
    step.

    One target only: the raw CLI/web install used by "npx @deepseek-ai/dsh web"
    (DSH_HOME, else ~/.dsh, profile "web" by default). DSH Desktop is
    deliberately NOT supported by this pack: the desktop app runs its own frozen
    generation snapshot and is no longer installed into.

    Runs on Windows PowerShell 5.1 and on PowerShell 7+ (pwsh). The launchers are
    install-all.bat and the root install.bat; every path, executable name and the
    PATH separator is resolved per platform, so nothing here assumes a particular
    Windows layout.

    pnpm handling: the harness profile stores its pnpm layout in
    node_modules/.modules.yaml. The matching local pnpm major is bootstrapped
    under ./tools and invoked with the profile's own virtual-store settings.

.PARAMETER Target
    Kept for muscle memory: web | cli (both mean the same web profile).

.PARAMETER Plugin
    Only install bundles whose package name matches this substring.

.PARAMETER DshHome
    Override the DSH_HOME (default: $env:DSH_HOME, else ~/.dsh).

.PARAMETER ProfileName
    Override the profile name (default: web).

.PARAMETER DshVersion
    Override the pinned dsh version from .dsh-version.json.

.PARAMETER Force
    Re-run "add" even for bundles already listed in the profile.

.EXAMPLE
    .\install-all.ps1
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-all.ps1 -Force
#>
[CmdletBinding()]
param(
    [ValidateSet('web', 'cli')]
    [string]$Target = 'web',
    [string]$Plugin = '',
    [string]$DshHome = '',
    [string]$ProfileName = '',
    [string]$DshVersion = '',
    [switch]$Force
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
# '\' on Windows, '/' on macOS/Linux.
$script:DirSeparator = [System.IO.Path]::DirectorySeparatorChar

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

function Write-Step($msg) { Write-Host "[vn-harness] $msg" -ForegroundColor Cyan }

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
                    $found += [pscustomobject]@{
                        Name    = $json.name
                        Version = $json.version
                        Folder  = $dir.FullName
                    }
                }
            }
        }
    }
    if ($Plugin) {
        $filtered = @($found | Where-Object { $_.Name -like "*$Plugin*" })
        if ($filtered.Count -eq 0) {
            throw "No bundle under packages/ matches '$Plugin'. Available: $(($found | ForEach-Object Name) -join ', ')"
        }
        $found = $filtered
    }
    if ($found.Count -eq 0) { throw 'No dsh bundles found under packages/ (package.json with dsh.bundle).' }
    return $found
}

function Assert-Tool($name) {
    if (-not (Get-ToolPath -Names (Get-ToolNames -Name $name))) {
        throw "Required tool '$name' was not found on PATH. Install Node.js >= 22 first (https://nodejs.org)."
    }
}

# ---------------------------------------------------------------------------
# pnpm helpers
# ---------------------------------------------------------------------------
function Get-PnpmStoreInfo {
    # Reads node_modules/.modules.yaml for the pnpm major (store vN) and the
    # virtual-store-dir-max-length the profile was created with.
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
    # Bootstraps a local pnpm of the requested major under ./tools (no admin).
    param([int]$Major)
    $existing = Get-ToolPath -Names (Get-ToolNames -Name 'pnpm')
    if ($existing) {
        # System pnpm is fine when it is new enough for the requested major.
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

# ---------------------------------------------------------------------------
# Target resolution
# ---------------------------------------------------------------------------
function Resolve-WebTarget {
    param([string]$HomeDir, [string]$Profile)
    if (-not $HomeDir) {
        $HomeDir = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path (Get-HomeDir) '.dsh' }
    }
    if (-not $Profile) { $Profile = 'web' }
    $profileDir = Join-Path (Join-Path $HomeDir 'profiles') $Profile
    return [pscustomobject]@{
        Label      = 'web'
        DshHome    = $HomeDir
        Profile    = $Profile
        ProfileDir = $profileDir
    }
}

# ---------------------------------------------------------------------------
# dsh invocation
# ---------------------------------------------------------------------------
function Get-DshInvoker {
    $npx = Get-ToolPath -Names (Get-ToolNames -Name 'npx')
    if (-not $npx) { throw 'npx was not found (is Node.js installed?).' }
    return $npx
}

function Invoke-Dsh {
    param([string]$DshHome, [string]$ProfileDir, [string[]]$Arguments)
    $npx = Get-DshInvoker
    $spec = "@deepseek-ai/dsh@$DshVersion"

    # Use the pnpm major + virtual-store length the profile was created with.
    $storeInfo = Get-PnpmStoreInfo -ProfileDir $ProfileDir
    $pnpmBin = Ensure-PnpmForMajor -Major $storeInfo.Major
    $oldPath = $env:PATH
    $oldHome = $env:DSH_HOME
    $oldLen = $env:npm_config_virtual_store_dir_max_length
    # dsh profiles are pnpm workspace roots ("packages: [.]"); pnpm >= 9 refuses
    # a bare `add` there unless the root-check is opted out.
    $oldRootCheck = $env:npm_config_ignore_workspace_root_check

    $env:PATH = $pnpmBin + $script:PathListSeparator + $oldPath
    $env:DSH_HOME = $DshHome
    if ($storeInfo.MaxLength) { $env:npm_config_virtual_store_dir_max_length = $storeInfo.MaxLength }
    $env:npm_config_ignore_workspace_root_check = 'true'
    Write-Verbose "DSH_HOME=$DshHome"
    Write-Verbose "pnpm=$pnpmBin  storeMajor=$($storeInfo.Major) maxLen=$($storeInfo.MaxLength)"
    Write-Verbose "dsh $($Arguments -join ' ')"
    # A native command writing to stderr (npm warnings do this constantly)
    # becomes a terminating NativeCommandError under $ErrorActionPreference
    # 'Stop' as soon as its output is merged. Keep this call non-terminating and
    # judge it by its exit code alone.
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

function Get-NodeModulePath {
    param([string]$ProfileDir, [string]$Name)
    $path = Join-Path $ProfileDir 'node_modules'
    foreach ($part in ($Name -split '/')) { $path = Join-Path $path $part }
    return $path
}

function Get-EffectiveInstalledVersion {
    # The version the profile actually runs: the installed package's own version.
    param($Target, [string]$Name)
    try {
        $nm = Get-NodeModulePath -ProfileDir $Target.ProfileDir -Name $Name
        $nmPkg = Join-Path $nm 'package.json'
        if (Test-Path $nmPkg) {
            $pkg = Get-Content $nmPkg -Raw -ErrorAction Stop | ConvertFrom-Json
            if ($pkg.version) { return [string]$pkg.version }
        }
    }
    catch {
        return $null
    }
    return $null
}

function Test-LiveLink {
    # True when the profile resolves the bundle straight into this repo's
    # packages folder (a pnpm link/junction). Code edits then already apply to
    # the installed bundle and a restart alone reloads them.
    param($Target, [string]$Name, [string]$RepoPackagesRoot)
    try {
        $nm = Get-NodeModulePath -ProfileDir $Target.ProfileDir -Name $Name
        if (-not (Test-Path $nm)) { return $false }
        $item = Get-Item $nm -Force -ErrorAction Stop
        $resolved = $item.FullName
        if ($item.LinkType) {
            try { $resolved = $item.Target } catch { $resolved = $item.FullName }
        }
        $root = [System.IO.Path]::GetFullPath($RepoPackagesRoot).TrimEnd($script:DirSeparator)
        $check = [System.IO.Path]::GetFullPath($resolved).TrimEnd($script:DirSeparator)
        # Windows compares paths case-insensitively; macOS/Linux must not.
        if ($script:IsWindowsHost) {
            return ($check -ieq $root) -or $check.StartsWith($root + $script:DirSeparator, [System.StringComparison]::OrdinalIgnoreCase)
        }
        return ($check -ceq $root) -or $check.StartsWith($root + $script:DirSeparator, [System.StringComparison]::Ordinal)
    }
    catch {
        return $false
    }
}

# ---------------------------------------------------------------------------
# The master stays the profile's LAST bundle
# ---------------------------------------------------------------------------
<#
    dsh-vn-master is the pack's final layer: its row is the slot where a
    pack-wide patch can restate any other row, and that only holds if it is
    applied last. `dsh plugin add` APPENDS a bundle the profile does not know
    yet, so a profile that gains a package after the master was installed ends up
    with the master in front of it (the alphabetical first-install order happens
    to put the master last, which is why this only shows up on an upgrade).

    Re-assert the order with the CLI's own commands - never by editing the
    profile's package.json. The master is a blank no-op row, so removing and
    re-adding it costs nothing and changes no state.
#>
function Assert-MasterLast {
    param($Target, $Packages)
    $installed = Get-InstalledBundles -ProfileDir $Target.ProfileDir
    if ($installed.Count -eq 0) { return }
    if ($installed -notcontains 'dsh-vn-master') { return }
    if ($installed[$installed.Count - 1] -eq 'dsh-vn-master') { return }
    # Only reorder when this run actually carries the master: removing a bundle
    # this run could not add back would leave the profile without it.
    $master = @($Packages | Where-Object { $_.Name -eq 'dsh-vn-master' })[0]
    if (-not $master) {
        Write-Host '  - dsh-vn-master is not the profile''s last bundle (this run does not carry it; a full install re-asserts the order)'
        return
    }
    Write-Host "  - dsh-vn-master is not the profile's last bundle - re-adding it so the master stays the final layer ..."
    Invoke-Dsh -DshHome $Target.DshHome -ProfileDir $Target.ProfileDir -Arguments @('plugin', '--profile', $Target.Profile, 'remove', 'dsh-vn-master')
    Invoke-Dsh -DshHome $Target.DshHome -ProfileDir $Target.ProfileDir -Arguments @('plugin', '--profile', $Target.Profile, 'add', $master.Folder)
    Write-Host '  - dsh-vn-master is the last bundle again'
}

# ---------------------------------------------------------------------------
# Skills a bundle ships
# ---------------------------------------------------------------------------
<#
    Copy the skill folders a bundle carries into the harness' own skills root.

    A package may ship `skills/<name>/SKILL.md`. The row registers those skills
    at runtime from its own folder, so they work either way - but copying them
    into <DshHome>/skills also puts them where the harness' filesystem skill
    provider looks (and where a person can read or edit them without touching
    this repository).

    Ownership is explicit: every folder this installer creates gets a marker
    file, and a target folder WITHOUT the marker is left alone - a person's own
    skill of the same name is never overwritten, and uninstall only removes what
    this installer wrote.
#>
function Copy-PackSkills {
    param($Target, $Packages)
    $skillsRoot = Join-Path $Target.DshHome 'skills'
    $copied = @()
    foreach ($pkg in $Packages) {
        $skillsDir = Join-Path $pkg.Folder 'skills'
        if (-not (Test-Path $skillsDir)) { continue }
        foreach ($skill in (Get-ChildItem $skillsDir -Directory | Sort-Object Name)) {
            $manifest = Join-Path $skill.FullName 'SKILL.md'
            if (-not (Test-Path $manifest)) { continue }
            $dest = Join-Path $skillsRoot $skill.Name
            $marker = Join-Path $dest ('.vn-harness-' + $pkg.Name)
            if ((Test-Path $dest) -and -not (Test-Path $marker)) {
                Write-Host "  - skills: left '$($skill.Name)' alone (it is not one of ours; delete it to take the bundled copy)"
                continue
            }
            New-Item -ItemType Directory -Force -Path $dest | Out-Null
            Copy-Item -Path (Join-Path $skill.FullName '*') -Destination $dest -Recurse -Force
            Set-Content -Path $marker -Value $pkg.Name -Encoding ASCII
            $copied += $skill.Name
        }
    }
    if ($copied.Count -gt 0) {
        Write-Host "  - skills: copied $($copied -join ', ') into $skillsRoot"
    }
    return $copied
}

function Install-To-Profile {
    param($Target, $Packages)    $installed = Get-InstalledBundles -ProfileDir $Target.ProfileDir
    $packagesRoot = Join-Path $repoRoot 'packages'
    Write-Host ''
    Write-Step "Target: $($Target.Label) - profile '$($Target.Profile)' at $($Target.ProfileDir)"
    if (-not (Test-Path $Target.ProfileDir)) { Write-Host "  (profile directory does not exist yet; 'dsh plugin add' initializes it)" }

    # Retired bundles: this pack used to ship the panel as 'dsh-focus' (row id
    # 'focus', renamed to 'dsh-files' in alpha.10) and then as 'dsh-files' (row
    # id 'files'), which the GUI now ships natively - the right Sidebar has its
    # own Files tab, so this pack no longer contributes one. A profile still
    # listing a retired name would keep its bundle and patch layer mounted next
    # to the current one, so drop it before adding.
    $legacyNames = @('dsh-focus', 'dsh-files')
    foreach ($legacy in $legacyNames) {
        if ($installed -contains $legacy) {
            Write-Host "  - removing retired bundle '$legacy' ..."
            Invoke-Dsh -DshHome $Target.DshHome -ProfileDir $Target.ProfileDir -Arguments @('plugin', '--profile', $Target.Profile, 'remove', $legacy)
            Write-Host "  - removed retired bundle '$legacy'"
        }
    }

    foreach ($pkg in $Packages) {
        $already = $installed -contains $pkg.Name
        if ($already -and -not $Force) {
            $liveLink = Test-LiveLink -Target $Target -Name $pkg.Name -RepoPackagesRoot $packagesRoot
            $effective = Get-EffectiveInstalledVersion -Target $Target -Name $pkg.Name
            $versionChanged = [bool]$effective -and ($effective -ne $pkg.Version)
            if (-not $versionChanged) {
                if ($liveLink) {
                    Write-Host "  - $($pkg.Name) $($pkg.Version): installed as a LIVE LINK into this repo - code edits already apply. Just restart the app to load them (no re-add needed)."
                }
                else {
                    Write-Host "  - $($pkg.Name) $($pkg.Version): already installed and up to date (skip; use -Force to re-add)."
                }
                continue
            }
            Write-Host "  - $($pkg.Name): installed version '$effective' is behind repo version '$($pkg.Version)' - re-adding to sync..."
        }
        elseif (-not $already -and -not $Force) {
            Write-Host "  - adding $($pkg.Name) $($pkg.Version) (first install) ..."
        }
        else {
            Write-Host "  - adding $($pkg.Name) $($pkg.Version) (-Force) ..."
        }
        Invoke-Dsh -DshHome $Target.DshHome -ProfileDir $Target.ProfileDir -Arguments @('plugin', '--profile', $Target.Profile, 'add', $pkg.Folder)
        Write-Host "  - added $($pkg.Name)"
    }
}

# ---------------------------------------------------------------------------

Write-Step 'DeepSeek Harness plugin pack installer (web profile)'
Write-Step "Platform: $script:Platform (PowerShell $($PSVersionTable.PSVersion))"
Write-Step "Repo: $repoRoot"

$DshVersion = if ($DshVersion) { $DshVersion } else { Get-DshPin }
Write-Step "Pinned dsh version: $DshVersion"

Assert-Tool 'node'
Assert-Tool 'npm'
$packages = Get-Packages
Write-Step ("Bundles to install: " + (($packages | ForEach-Object { $_.Name + '@' + $_.Version }) -join ', '))

$web = Resolve-WebTarget -HomeDir $DshHome -Profile $ProfileName
Install-To-Profile -Target $web -Packages $packages
Assert-MasterLast -Target $web -Packages $packages
Copy-PackSkills -Target $web -Packages $packages | Out-Null

Write-Host ''
Write-Step 'Done.'
Write-Host ''
Write-Host 'Next steps:'
Write-Host '  - START it with run.ps1 (Windows) or ./run.sh (macOS/Linux): that is'
Write-Host '    "npx @deepseek-ai/dsh web" plus the browser hand-off - it opens the'
Write-Host '    URL the app prints, token included, in Chrome (default browser as'
Write-Host '    the fallback) and keeps the harness in that terminal. On Windows:'
Write-Host '    powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1'
Write-Host '  - RESTART the app to load the changes. Stop the running'
Write-Host '    "npx @deepseek-ai/dsh web" (Ctrl+C), start it again, then'
Write-Host '    HARD-REFRESH the browser tab (Ctrl+F5). The client bundle'
Write-Host '    is read once at app boot, so a restart is required after every'
Write-Host '    code change.'
Write-Host '  - Open the right Sidebar with the conversation header expand button.'
Write-Host '    Click a text/code file in its Files tab to edit it, or use the tab'
Write-Host '    strip "+" -> Editor to start a blank file: Save asks for its name'
Write-Host '    (extension included) and creates it in the conversation folder.'
Write-Host '  - Markdown opens in that editor; its toolbar Preview button shows the'
Write-Host '    rendered page, and the page carries an Edit button back to the editor.'
Write-Host '  - "Open In..." in the conversation header keeps using the shipped'
Write-Host '    entries for editors/terminals; its file-browser entries are the'
Write-Host '    pack''s own cross-platform launcher (see packages/dsh-open-in-app).'
Write-Host '  - The Themes button sits in that same header group, immediately left of'
Write-Host '    "Open In...": it switches Light / Dark / System, the same preference'
Write-Host '    Settings > General > Appearance owns (see packages/dsh-themes).'
Write-Host '  - The camera button, left of the Themes button, screenshots the whole'
Write-Host '    window: the browser captures the tab and the pack writes the PNG to'
Write-Host '    this machine''s Desktop as vn-harness-<timestamp>.png.'
Write-Host '  - Diagrams (see packages/dsh-diagrams): ask for one in the chat - Mermaid'
Write-Host '    or TikZ - and it renders inline, with a link that opens it as its own'
Write-Host '    tab. "+" -> Diagrams lists this conversation and the shared library; the'
Write-Host '    tab has a source drawer and an export menu (mmd/md/tex/pdf/svg/png saved'
Write-Host '    to this machine''s Desktop, never the conversation folder). TikZ needs a'
Write-Host '    TeX engine (pdflatex and friends); without one TikZ diagrams are still'
Write-Host '    stored and exported as .tex.'
Write-Host '  - PDFs (see packages/dsh-pdf): the agent can read them - pdf_info says what'
Write-Host '    a document is and flags pages that are scans with no text layer, pdf_read'
Write-Host '    returns a page range in reading order or in reconstructed layout (use'
Write-Host '    layout for invoices, statements and two-column papers), pdf_find searches'
Write-Host '    without reading everything, and pdf_render writes page pictures as PNGs.'
Write-Host '    pdf_scan RECOGNIZES the scanned pages: with no page range it takes exactly'
Write-Host '    the pages that have no text layer, draws each one and reads it with OCR,'
Write-Host '    caching the result per page, language, resolution and segmentation mode.'
Write-Host '    Clicking a .pdf in the Files tab opens the pack''s own reader (zoom, page'
Write-Host '    navigation, rotation, selectable text, find in document), with a panel for'
Write-Host '    page thumbnails and the document''s own bookmarks; every page with'
Write-Host '    no text layer says so under itself and offers a one-click scan whose text'
Write-Host '    appears right there, labelled as a transcription rather than extracted'
Write-Host '    text. Strip "+" -> PDFs lists every PDF in this workspace, with an'
Write-Host '    optional page count. The reader replaces the shipped bare PDF view while'
Write-Host '    every other file type keeps its surface. Reading needs nothing installed;'
Write-Host '    page pictures and scanning need poppler (pdftoppm), mutool or Ghostscript'
Write-Host '    on the server host, and OCR needs tesseract with the language data - the'
Write-Host '    tools say which one is missing instead of failing. PDFs attached to the'
Write-Host '    chat (under <DshHome>/attachments) are read by their absolute path.'
Write-Host '  - API keys are never touched by this installer - add your key in Settings > Models.'
