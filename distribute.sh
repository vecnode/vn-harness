#!/bin/sh
# ============================================================
#  vn-harness DISTRIBUTER - macOS / Linux.
#
#  The twin of distribute.bat: builds the distribution folder you
#  can hand to somebody (or run yourself) as ONE thing -
#
#      dist/vn-harness-<version>-<rid>/     <- click this one
#      dist/vn-harness-<version>-<rid>.zip  <- or hand this over
#
#  - and dist/ is gitignored on purpose: it is a COPY of this
#  repository (minus the trees named in scripts/dist-manifest.txt)
#  plus the built shell, so it is build output, never content.
#
#  All the work is scripts/dist.sh, which is the SAME file
#  .github/workflows/distribute.yml runs on the macOS and Linux
#  runners - so a local run and a CI run cannot drift.
#
#  Usage:
#    ./distribute.sh [-Version <v>] [-SkipBuild] [-NoZip] [-Run]
#                    [-Verify] [-KeepVerifyHome] [-Clean] [-NoPause] [-Help]
#
#  Run it with the shell if the executable bit was lost in a copy:
#    sh ./distribute.sh
#
#  Requirements: the Rust toolchain (https://rustup.rs) for the build
#  step (skip it with -SkipBuild), Node.js 22+ for -Verify.
#
#  This file only finds the repository and hands the flags over; the
#  console contract (colour on a terminal, NO_COLOR honoured, the same
#  words the Windows half prints) is scripts/console/theme.sh.
# ============================================================
set -u

case "$0" in
  */*) script_dir=${0%/*} ;;
  *) script_dir=. ;;
esac
script_dir=$(CDPATH= cd -- "$script_dir" && pwd)

. "$script_dir/scripts/console/theme.sh"

# -NoPause means never hold the window open; it is also accepted (and ignored)
# by scripts/dist.sh, so a stray copy of it is never "an unknown flag".
case " $* " in *" -NoPause "*) VN_HARNESS_PAUSE=0 ;; esac

# The distributer is a long foreground job with its own progress output, so it is
# NOT wrapped in a banner the way install.sh is: the worker owns the words. The
# window is held open only if it would otherwise vanish, and never under
# -NoPause - which is what makes this file safe to call from CI.
sh "$script_dir/scripts/dist.sh" "$@"
status=$?
vn_pause
exit "$status"
