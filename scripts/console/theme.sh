#!/bin/sh
# ============================================================================
#  scripts/console/theme.sh - the POSIX half of the console contract.
#
#  SOURCE it, never run it:
#
#      . "$(dirname -- "$0")/scripts/console/theme.sh"
#      vn_step "Installing the pack"
#
#  It is the mirror of scripts/console/theme.ps1 and exists for the same reason:
#  install.sh, uninstall.sh, run-web.sh and distribute.sh all have to answer the
#  same question - may I colour this output? - and four files answering it
#  themselves is four chances to disagree.
#
#  THE RULES, AND WHY THEY ARE THESE RULES
#  ---------------------------------------
#  Colour is ON only when ALL of these hold:
#    * stdout is a terminal (`[ -t 1 ]`) - a redirected stream is a log, and a
#      log must not hold escape sequences;
#    * TERM is set and is not "dumb";
#    * NO_COLOR is unset (the https://no-color.org convention) and
#      VN_HARNESS_NO_COLOR is unset.
#
#  Otherwise every helper prints the plain text and nothing else, so a CI log and
#  a terminal differ in paint only - never in words, and never in behaviour.
#
#  This file must stay POSIX: no bash arrays, no `[[ ]]`, no `local` outside a
#  function, no ANSI-C quoting (`$'...'` is a bashism). It is sourced by scripts
#  that run under dash on Debian and under the system sh on macOS, and AGENTS.md
#  is explicit that the macOS/Linux half never requires PowerShell - the reverse
#  holds too, and this file is where it would be broken.
# ============================================================================

# --- the capability decision, made once at source time ----------------------
VN_COLOR=0
if [ -t 1 ]; then
  VN_COLOR=1
fi
case "${TERM:-}" in
  '' | dumb) VN_COLOR=0 ;;
esac
if [ -n "${NO_COLOR:-}" ]; then VN_COLOR=0; fi
if [ -n "${VN_HARNESS_NO_COLOR:-}" ]; then VN_COLOR=0; fi

# --- the palette ------------------------------------------------------------
# Named, so the helpers below read as prose and a colour can be changed in one
# place. \033 is octal for ESC and works in every POSIX printf.
VN_C_OFF='\033[0m'
VN_C_STEP='\033[36m'
VN_C_NOTE='\033[90m'
VN_C_GOOD='\033[32m'
VN_C_WARN='\033[33m'
VN_C_FAIL='\033[31m'

# _vn_paint <colour> <text>
# Print text in a colour when allowed. The one place the policy is applied.
_vn_paint() {
  if [ "$VN_COLOR" = "1" ]; then
    printf '%s%s%s\n' "$1" "$2" "$VN_C_OFF"
  else
    printf '%s\n' "$2"
  fi
}

vn_step() { _vn_paint "$VN_C_STEP" "[vn-harness] $1"; }
vn_note() { _vn_paint "$VN_C_NOTE" "  $1"; }
vn_good() { _vn_paint "$VN_C_GOOD" "[vn-harness] $1"; }
vn_warn() { _vn_paint "$VN_C_WARN" "[vn-harness] $1"; }
vn_fail() { _vn_paint "$VN_C_FAIL" "[vn-harness] $1"; }
vn_rule() { _vn_paint "$VN_C_NOTE" "============================================================"; }

# vn_pause
# Hold a window open so its result can be read, and never hang a scripted run.
# POSIX has no "was this double-clicked", so the rule is explicit and shared with
# the Windows half: VN_HARNESS_PAUSE=0 means do not. A macOS .command window is
# the case this exists for - Finder closes it the moment the script exits.
vn_pause() {
  if [ "${VN_HARNESS_PAUSE:-1}" = "0" ]; then return 0; fi
  if [ ! -t 0 ] && [ ! -t 1 ]; then return 0; fi
  printf '\nPress Return to close this window. '
  read -r _vn_ignored || true
}

# vn_wants_help <args...>
# True when any argument is one of the help spellings every entry point answers.
# Batch translates these before calling a worker; the POSIX half reads them here
# so both hosts accept the same four.
vn_wants_help() {
  for _vn_arg in "$@"; do
    case "$_vn_arg" in
      -Help | --help | -h | -help | /? | /help) return 0 ;;
    esac
  done
  return 1
}
