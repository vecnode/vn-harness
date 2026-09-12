#!/bin/sh
# ============================================================
#  vn-harness uninstaller (macOS / Linux; the Windows twin is uninstall.bat)
#  Removes this pack's bundles from the DeepSeek Harness web profile, together
#  with any retired bundle name it shipped before (dsh-focus, dsh-files).
#  Removing a bundle also removes its patch layer.
#
#  Needs Node.js (>= 22) with npm/npx - NOT PowerShell. The work lives in
#  scripts/uninstall-all.sh, which uninstall.bat's PowerShell twin mirrors with
#  scripts/uninstall-all.ps1.
# ============================================================
set -u

case "$0" in
    */*) here=${0%/*} ;;
    *) here=. ;;
esac
here=$(CDPATH= cd -- "$here" && pwd)

sh "$here/scripts/uninstall-all.sh" "$@"
status=$?

echo
echo "============================================================"
if [ "$status" -eq 0 ]; then
    echo " vn-harness removed successfully."
else
    echo " vn-harness removal FAILED - see the messages above."
fi
echo "============================================================"
echo
exit "$status"
