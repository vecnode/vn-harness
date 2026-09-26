# ============================================================================
#  scripts/console/theme.ps1 - how the Windows workers talk to the console.
#
#  DOT-SOURCE IT, do not run it:
#
#      . (Join-Path $PSScriptRoot 'console\theme.ps1')
#      Initialize-VnConsole
#
#  It answers three questions once, for every worker, so install-all.ps1,
#  uninstall-all.ps1, run-web.ps1 and dist.ps1 cannot answer them differently:
#
#   1. WHICH ENCODING. Windows PowerShell 5.1 decodes a native child's stdout
#      with [Console]::OutputEncoding, which defaults to the OEM code page. The
#      harness is a Node program and prints UTF-8, so without this a path with an
#      accent - or any message with a non-ASCII character - arrives as mojibake.
#      This is the one genuinely functional fix in this file; the rest is dress.
#
#   2. WHETHER TO COLOUR. Colour is allowed only when there is a console to
#      colour, nobody asked for it to stop, and nothing is capturing the output.
#      NO_COLOR (the environment convention) and -NoColor both switch it off, and
#      a redirected stream switches it off by itself - a log file must never hold
#      escape sequences or a "colour" that is really a control character.
#
#   3. WHAT THE WORDS LOOK LIKE. One vocabulary - Step / Note / Good / Warn /
#      Fail - so the same event reads the same way in every entry point.
#
#  WHY -ForegroundColor AND NOT ANSI ESCAPES
#  ----------------------------------------
#  Write-Host -ForegroundColor goes through the console API, so it works on the
#  legacy console host AND in Windows Terminal, on Windows PowerShell 5.1 AND on
#  pwsh 7. Hand-written ANSI escapes need the console to have
#  VIRTUAL_TERMINAL_PROCESSING enabled, which cmd.exe does not do for you, so the
#  "modern" approach is the one that silently prints garbage on the one console
#  this file exists to stay readable on. The palette below is therefore names,
#  not codes.
#
#  This file must stay valid on Windows PowerShell 5.1 - the ONLY PowerShell
#  measured on the machine this was written on (`pwsh.exe` is not installed
#  there). No ternary operator, no `??`, no `-not` on a null-coalesced value.
# ============================================================================

# The console colours, by NAME so Write-Host owns the rendering.
$script:VnColorStep = 'Cyan'
$script:VnColorNote = 'DarkGray'
$script:VnColorGood = 'Green'
$script:VnColorWarn = 'Yellow'
$script:VnColorFail = 'Red'
$script:VnColorRule = 'DarkGray'

# $true when the console may be coloured. Set by Initialize-VnConsole; a worker
# that forgets to call it still behaves, because the writers treat $null as
# "plain", which is the safe direction.
$script:VnColor = $false

function Initialize-VnConsole {
    <#
    .SYNOPSIS
        Prepare this process's console: UTF-8 output, and the colour policy.
    .DESCRIPTION
        Safe to call more than once and safe to call where there is no console at
        all (a redirected run, a scheduler): every console touch is guarded,
        because a host without a real console throws on these and that must not
        be the reason an install fails.
    .PARAMETER NoColor
        Switch colour off regardless of the environment.
    #>
    [CmdletBinding()]
    param(
        [switch]$NoColor
    )

    # --- UTF-8 to the console and to native children ---------------------------
    # UTF8Encoding($false): no byte-order mark, which is what a console wants.
    try {
        $utf8 = New-Object System.Text.UTF8Encoding($false)
        [Console]::OutputEncoding = $utf8
        # Input too: a worker that ever prompts reads UTF-8 from a piped stream.
        [Console]::InputEncoding = $utf8
        $OutputEncoding = $utf8
    } catch {
        # No console, or a handle we may not touch. Output stays decodable, just
        # not in the encoding we would have chosen.
    }

    # --- the colour policy ----------------------------------------------------
    $color = $true
    if ($NoColor) { $color = $false }
    if ($env:NO_COLOR) { $color = $false }
    if ($env:VN_HARNESS_NO_COLOR) { $color = $false }
    try {
        # A redirected stream is a log, and a log wants the words, not the paint.
        if ([Console]::IsOutputRedirected) { $color = $false }
    } catch {
        $color = $false
    }
    $script:VnColor = $color
}

function Write-VnLine {
    <#
    .SYNOPSIS
        Print one line, in a colour when colour is allowed.
    .DESCRIPTION
        The single place that decides whether a colour is applied, so no writer
        below has to know the policy - which is what keeps a redirected run and a
        NO_COLOR run behaving identically.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Text,
        [string]$Color = ''
    )

    if ($script:VnColor -and $Color) {
        Write-Host $Text -ForegroundColor $Color
    } else {
        Write-Host $Text
    }
}

function Write-VnStep {
    <#
    .SYNOPSIS A thing the run is doing, prefixed so a log stays greppable.
    .PARAMETER Color
        Override the step colour. uninstall-all.ps1 uses this to keep the
        remover's steps in the caution colour they have always worn, rather than
        making every removal look like an installation.
    #>
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [string]$Color = ''
    )
    if (-not $Color) { $Color = $script:VnColorStep }
    Write-VnLine -Text "[vn-harness] $Message" -Color $Color
}

function Write-VnNote {
    <# .SYNOPSIS Detail under the step above it, indented and quiet. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Message)
    Write-VnLine -Text "  $Message" -Color $script:VnColorNote
}

function Write-VnGood {
    <# .SYNOPSIS Something worked. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-VnLine -Text "[vn-harness] $Message" -Color $script:VnColorGood
}

function Write-VnWarn {
    <# .SYNOPSIS Something is degraded but the run continues. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-VnLine -Text "[vn-harness] $Message" -Color $script:VnColorWarn
}

function Write-VnFail {
    <# .SYNOPSIS Something failed. The caller decides the exit code. #>
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Message)
    Write-VnLine -Text "[vn-harness] $Message" -Color $script:VnColorFail
}

function Write-VnRule {
    <# .SYNOPSIS The horizontal rule the entry points bracket a result with. #>
    [CmdletBinding()]
    param()
    Write-VnLine -Text '============================================================' -Color $script:VnColorRule
}

function Test-VnNoPause {
    <#
    .SYNOPSIS
        Whether a worker must NOT hold the window open at the end.
    .DESCRIPTION
        The batch entry points already decide this (scripts\console\adapt.cmd
        exports VN_HARNESS_PAUSE), and they own the window, so this exists only
        for a worker that has to make the same call on its own - and it reads the
        SAME variable rather than inventing a second rule.
    #>
    [CmdletBinding()]
    param()
    if ($env:VN_HARNESS_PAUSE -eq '0') { return $true }
    return $false
}
