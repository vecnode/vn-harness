#!/bin/sh
# ============================================================
#  vn-harness launcher - macOS / Linux.
#
#  Starts the DeepSeek Harness web GUI and opens it in a browser:
#
#      npx --yes @deepseek-ai/dsh@<pin> web --no-open [--port <n>]
#
#  and then watches the app's own output for the URL line it prints once the
#  server is listening:
#
#      dsh web: http://127.0.0.1:3080/?token=<launch token> (LAN: ...)
#
#  That exact URL - token included - is what gets opened, in Google Chrome when
#  Chrome is installed and in the platform's default browser otherwise.
#  --no-open is passed so the app does not also start a browser: this launcher
#  owns the hand-off, and one URL must not open twice. The harness stays in the
#  foreground and Ctrl+C stops it.
#
#  The token is a live credential for the running process (the value the server
#  exchanges for the browser session cookie). It is read from the app's output
#  IN MEMORY, never written to a file, never passed through a shell, and only
#  handed to a browser after the URL has been checked to be a loopback address.
#
#  POSIX shell only: this script needs Node.js (>= 22) with npm/npx - never
#  PowerShell. The Windows half is `run.ps1` in this same folder; the two files
#  are the whole launcher, with no wrapper/worker split and no run.bat.
#
#  Usage:
#    ./run.sh [-Port <n>] [-DshHome <dir>] [-DshVersion <version>]
#             [-NoBrowser] [-DefaultBrowser]
# ============================================================
set -u

case "$0" in
  */*) script_dir=${0%/*} ;;
  *) script_dir=. ;;
esac
# This script lives at the repository root, so it is its own root.
script_dir=$(CDPATH= cd -- "$script_dir" && pwd)
repo_root=$script_dir

port_arg=''
dsh_home_arg=''
dsh_version_arg=''
no_browser=0
default_browser=0

usage() {
  printf '%s\n' \
    'Usage: sh run.sh [-Port <n>] [-DshHome <dir>] [-DshVersion <version>]' \
    '                 [-NoBrowser] [-DefaultBrowser]' \
    '' \
    '  -Port <n>          listen on this port instead of the default (3080)' \
    '  -DshHome <dir>     override DSH_HOME (default: $DSH_HOME, else ~/.dsh)' \
    '  -DshVersion <ver>  override the pinned dsh version from .dsh-version.json' \
    '  -NoBrowser         start the server only; open nothing' \
    '  -DefaultBrowser    skip Google Chrome and use the default browser' \
    '' \
    'Run it from the repository root (it reads .dsh-version.json from there);' \
    'the Windows half is run.ps1, which does exactly the same thing.'
}

while [ $# -gt 0 ]; do
  case "$1" in
    -Port|--port) shift; port_arg=${1:-} ;;
    -Port=*|--port=*) port_arg=${1#*=} ;;
    -DshHome|--dsh-home) shift; dsh_home_arg=${1:-} ;;
    -DshHome=*|--dsh-home=*) dsh_home_arg=${1#*=} ;;
    -DshVersion|--dsh-version) shift; dsh_version_arg=${1:-} ;;
    -DshVersion=*|--dsh-version=*) dsh_version_arg=${1#*=} ;;
    -NoBrowser|--no-browser) no_browser=1 ;;
    -DefaultBrowser|--default-browser) default_browser=1 ;;
    -h|--help) usage; exit 0 ;;
    *)
      printf 'vn-harness: unknown option "%s"\n' "$1" >&2
      printf 'Run "sh run.sh --help" for the accepted options.\n' >&2
      exit 2
      ;;
  esac
  shift
done

step() { printf '[vn-harness] %s\n' "$1"; }
fail() {
  printf 'vn-harness: %s\n' "$1" >&2
  exit 1
}

require_tool() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "required tool \"$1\" was not found on PATH. Install Node.js >= 22 first (https://nodejs.org)."
  fi
}

# The pinned dsh version from .dsh-version.json.
read_pin() {
  node -e '
    const fs = require("fs");
    const json = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(json.dsh || ""));
  ' "$repo_root/.dsh-version.json"
}

# ---------------------------------------------------------------------------
# The URL line
# ---------------------------------------------------------------------------
# Pull the first URL out of a "dsh web: <url>" line. Only a line naming
# "dsh web:" is considered, so no unrelated URL is ever mistaken for the app's
# own ready line, and the URL ends at the first space (the LAN URL that can
# follow it is deliberately not the one opened).
url_from_line() {
  line=$1
  case "$line" in
    *'dsh web:'*) ;;
    *) return 1 ;;
  esac
  rest=${line#*dsh web:}
  while [ -n "$rest" ] && [ "$rest" != "${rest# }" ]; do
    rest=${rest# }
  done
  url=${rest%% *}
  case "$url" in
    http://*|https://*) printf '%s' "$url"; return 0 ;;
  esac
  return 1
}

# Only a loopback URL is opened: the app binds 127.0.0.1 by default and its own
# --host rejects 0.0.0.0 on purpose, so anything else in that line is a
# surprise - and a launch token must never reach a browser pointed elsewhere.
is_loopback_url() {
  url=$1
  case "$url" in
    http://*|https://*) ;;
    *) return 1 ;;
  esac
  authority=${url#*://}
  authority=${authority%%/*}
  case "$authority" in
    \[*\]*) host=${authority%%\]*}; host=${host#\[} ;;
    *) host=${authority%%:*} ;;
  esac
  case "$host" in
    127.0.0.1|localhost|::1|0:0:0:0:0:0:0:1|127.*) return 0 ;;
  esac
  return 1
}

# ---------------------------------------------------------------------------
# The browser hand-off
# ---------------------------------------------------------------------------
# Google Chrome, wherever this host keeps it: the app bundle on macOS, the
# usual command names on Linux.
chrome_command() {
  for candidate in google-chrome google-chrome-stable chromium chromium-browser chrome; do
    if command -v "$candidate" >/dev/null 2>&1; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

# Open one URL and print the browser's name for the console line. The URL is a
# single argv element, never a command string, so nothing in it can be read as
# a shell metacharacter; the opener runs in the background so a slow launcher
# cannot stall the app's output.
open_url() {
  open_target=$1
  if [ "$default_browser" -eq 0 ]; then
    if [ "$(uname -s 2>/dev/null)" = 'Darwin' ] && [ -d '/Applications/Google Chrome.app' ] && command -v open >/dev/null 2>&1; then
      open -a 'Google Chrome' "$open_target" >/dev/null 2>&1 &
      printf '%s' 'Google Chrome'
      return 0
    fi
    if chrome=$(chrome_command); then
      "$chrome" "$open_target" >/dev/null 2>&1 &
      printf '%s' 'Google Chrome'
      return 0
    fi
  fi
  if command -v open >/dev/null 2>&1; then
    open "$open_target" >/dev/null 2>&1 &
    printf '%s' 'the default browser'
    return 0
  fi
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$open_target" >/dev/null 2>&1 &
    printf '%s' 'the default browser'
    return 0
  fi
  return 1
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
step 'DeepSeek Harness plugin pack launcher (web GUI)'
step "Repo: $repo_root"

require_tool node
require_tool npx

if [ -n "$dsh_version_arg" ]; then
  dsh_version=$dsh_version_arg
else
  dsh_version=$(read_pin)
fi
[ -n "$dsh_version" ] || fail 'could not read the pinned dsh version from .dsh-version.json'
step "Pinned dsh version: $dsh_version"

if [ -n "$port_arg" ]; then
  case "$port_arg" in
    ''|*[!0-9]*) fail "-Port expects a number, got \"$port_arg\"." ;;
  esac
fi

if [ -n "$dsh_home_arg" ]; then
  DSH_HOME=$dsh_home_arg
  export DSH_HOME
  step "DSH_HOME: $dsh_home_arg"
fi

# A friendly nudge, never a refusal: the app runs fine without the pack, so a
# profile that never had it installed still starts - it just starts unadorned.
harness_home=${dsh_home_arg:-${DSH_HOME:-}}
if [ -z "$harness_home" ]; then
  harness_home=${HOME:-}
  if [ -z "$harness_home" ]; then
    harness_home=$(CDPATH= cd -- ~ && pwd)
  fi
  harness_home="$harness_home/.dsh"
fi
if [ -f "$harness_home/profiles/web/package.json" ]; then
  if ! node -e '
    const fs = require("fs");
    const json = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const held = json && json.dsh && json.dsh.profile && json.dsh.profile.bundles;
    process.exit(Array.isArray(held) && held.indexOf("dsh-rightbar") >= 0 ? 0 : 1);
  ' "$harness_home/profiles/web/package.json" >/dev/null 2>&1; then
    printf "  - the web profile at %s does not list this pack's bundles yet.\n" "$harness_home/profiles/web"
    printf '    Run ./install.sh first if you expected the pack to be there.\n'
  fi
fi

# The app's output is piped through a FIFO, not a file and not a shell pipeline:
# a FIFO keeps the token off the disk, and reading it from this shell (instead
# of a pipeline's subshell) lets `wait` report the harness' own exit status.
tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/vn-harness-run.XXXXXX") || fail 'could not create a temporary directory'
fifo="$tmp_dir/out"
if ! mkfifo "$fifo"; then
  rm -rf "$tmp_dir"
  fail 'mkfifo is not available on this host.'
fi

child=''
cleanup() {
  if [ -n "$child" ]; then
    kill "$child" 2>/dev/null || true
  fi
  rm -rf "$tmp_dir"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

printf '\n'
if [ "$no_browser" -eq 1 ]; then
  step 'Starting the harness; no browser will be opened (the URL line below carries a live token).'
else
  step 'Starting the harness; the first "dsh web:" line opens in Chrome (default browser as the fallback).'
fi
printf '  Keep this window open - the harness runs in it. Ctrl+C stops it.\n\n'

if [ -n "$port_arg" ]; then
  npx --yes "@deepseek-ai/dsh@$dsh_version" web --no-open --port "$port_arg" >"$fifo" 2>&1 &
else
  npx --yes "@deepseek-ai/dsh@$dsh_version" web --no-open >"$fifo" 2>&1 &
fi
child=$!

opened=''
while IFS= read -r line; do
  printf '%s\n' "$line"
  if [ -z "$opened" ] && [ "$no_browser" -eq 0 ]; then
    if url=$(url_from_line "$line"); then
      if is_loopback_url "$url"; then
        if browser=$(open_url "$url"); then
          opened=$browser
          printf '\n[vn-harness] Opened the harness in %s.\n\n' "$browser"
        else
          opened='none'
          printf '[vn-harness] could not find a browser; open the URL above yourself.\n'
        fi
      else
        opened='refused'
        printf '[vn-harness] the URL line did not name a loopback address; it was NOT opened.\n'
      fi
    fi
  fi
done < "$fifo"

status=0
wait "$child" || status=$?
child=''

printf '\n'
if [ -z "$opened" ] && [ "$no_browser" -eq 0 ]; then
  step 'The app never printed a "dsh web:" URL line, so no browser was opened.'
  printf '  (A profile with printUrl disabled prints none; the URL is also in the output above.)\n'
fi
if [ "$status" -eq 0 ]; then
  step 'The harness stopped.'
else
  step "The harness exited with status $status."
fi
exit "$status"
