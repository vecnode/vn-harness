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
#  Needs Node.js (>= 22) with npm/npx - NOT PowerShell. The work lives in
#  scripts/install-all.sh, which install.bat's PowerShell twin mirrors with
#  scripts/install-all.ps1.
# ============================================================
set -u

case "$0" in
    */*) here=${0%/*} ;;
    *) here=. ;;
esac
here=$(CDPATH= cd -- "$here" && pwd)

# Same default as install.bat: force a re-add unless the caller asked already.
extra="-Force"
case " $* " in
    *" -Force "*|*" -force "*|*" --force "*) extra="" ;;
esac

# shellcheck disable=SC2086
sh "$here/scripts/install-all.sh" "$@" $extra
status=$?

echo
echo "============================================================"
if [ "$status" -eq 0 ]; then
    echo " vn-harness installed successfully."
else
    echo " vn-harness install FAILED - see the messages above."
fi
echo "============================================================"
echo
exit "$status"
