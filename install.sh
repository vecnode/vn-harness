#!/bin/sh
# ============================================================
#  vn-harness installer (macOS / Linux; the Windows twin is install.bat)
#  Installs the plugin pack into the DeepSeek Harness WEB profile only - the
#  raw install used by "npx @deepseek-ai/dsh web" (DSH_HOME, else ~/.dsh,
#  profile web). DSH Desktop is not supported by this pack.
#
#  A plain run always (re-)adds the bundles from this repo at their current
#  version - i.e. it behaves as if -Force had been passed - so running it
#  again always installs the latest edits, even when the profile already
#  lists the same version. Passing -Force yourself is still accepted.
#
#  Needs Node.js (>= 22) with npm/npx - NOT PowerShell, ever. The work lives in
#  scripts/install-all.sh, which install.bat's PowerShell twin mirrors with
#  scripts/install-all.ps1.
#
#  Flags (forwarded to scripts/install-all.sh - run with -Help for the list):
#    -Plugin <name>     install only the matching bundle(s)
#    -DshHome <dir>     use this harness home instead of $DSH_HOME
#    -ProfileName <n>   install into this profile (default: web)
#    -DshVersion <ver>  override the pinned dsh version
#    -Force             re-add even when the version is unchanged
#    -NoPause           never hold this window open
#    -Help / -h / --help / /?   print the help and stop
#
#  No administrator rights are needed or requested: the pack installs into the
#  current user's harness home.
#
#  The colour decision - a terminal gets colour, a redirected log does not, and
#  NO_COLOR always wins - is made in ONE place for every POSIX entry point:
#  scripts/console/theme.sh, the twin of scripts/console/theme.ps1.
# ============================================================
set -u

case "$0" in
    */*) here=${0%/*} ;;
    *) here=. ;;
esac
here=$(CDPATH= cd -- "$here" && pwd)

# The console contract, shared with the Windows half. It never fails, so `set -u`
# is the only care needed here.
. "$here/scripts/console/theme.sh"

# -NoPause means never hold a window open. The Windows half reads the same
# convention (VN_HARNESS_PAUSE), so the flag behaves identically on both hosts.
case " $* " in *" -NoPause "*) VN_HARNESS_PAUSE=0 ;; esac

# The four help spellings every entry point answers. The WORKER owns the words,
# so this only routes: one help text per command, on both hosts.
if vn_wants_help "$@"; then
    exec sh "$here/scripts/install-all.sh" -Help
fi

# Same default as install.bat: force a re-add unless the caller asked already.
extra="-Force"
case " $* " in
    *" -Force "*|*" -force "*|*" --force "*) extra="" ;;
esac

# shellcheck disable=SC2086
sh "$here/scripts/install-all.sh" "$@" $extra
status=$?

# The same words, and the same rule, as install.bat: the rule is printed plain
# so it reads as a rule, the verdict in a colour when this is a terminal, and the
# window is held open only when it would otherwise vanish (never under -NoPause).
echo
vn_rule
if [ "$status" -eq 0 ]; then
    vn_good "installed successfully."
else
    vn_fail "install FAILED - see the messages above."
fi
vn_rule
echo
vn_pause
exit "$status"
