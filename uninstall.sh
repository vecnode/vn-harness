#!/bin/sh
# ============================================================
#  vn-harness uninstaller (macOS / Linux; the Windows twin is uninstall.bat)
#  Removes this pack's bundles from the DeepSeek Harness web profile, together
#  with any retired bundle name it shipped before (dsh-focus, dsh-files).
#  Removing a bundle also removes its patch layer.
#
#  It removes ONLY what this pack wrote: a bundle or skill somebody added
#  themselves is left alone, and no session, setting or credential is touched.
#
#  Needs Node.js (>= 22) with npm/npx - NOT PowerShell, ever. The work lives in
#  scripts/uninstall-all.sh, which uninstall.bat's PowerShell twin mirrors with
#  scripts/uninstall-all.ps1.
#
#  Flags (forwarded to scripts/uninstall-all.sh - run with -Help for the list):
#    -Plugin <name>     remove only the matching bundle(s)
#    -DshHome <dir>     use this harness home instead of $DSH_HOME
#    -ProfileName <n>   remove from this profile (default: web)
#    -DshVersion <ver>  override the pinned dsh version
#    -NoPause           never hold this window open
#    -Help / -h / --help / /?   print the help and stop
#
#  No administrator rights are needed or requested.
#
#  The colour decision is made in ONE place for every POSIX entry point:
#  scripts/console/theme.sh, the twin of scripts/console/theme.ps1.
# ============================================================
set -u

case "$0" in
    */*) here=${0%/*} ;;
    *) here=. ;;
esac
here=$(CDPATH= cd -- "$here" && pwd)

. "$here/scripts/console/theme.sh"

case " $* " in *" -NoPause "*) VN_HARNESS_PAUSE=0 ;; esac

if vn_wants_help "$@"; then
    exec sh "$here/scripts/uninstall-all.sh" -Help
fi

sh "$here/scripts/uninstall-all.sh" "$@"
status=$?

echo
vn_rule
if [ "$status" -eq 0 ]; then
    vn_good "removed successfully."
else
    vn_fail "removal FAILED - see the messages above."
fi
vn_rule
echo
vn_pause
exit "$status"
