#!/bin/sh
# ============================================================================
#  scripts/dist.sh - build a vn-harness DISTRIBUTION folder and its archive
#  (macOS / Linux). The twin of scripts/dist.ps1, and the half
#  .github/workflows/distribute.yml runs on the macOS and Linux runners.
#
#  WHAT IT PRODUCES
#      dist/vn-harness-<version>-<rid>/       the folder: the built shell
#                                             (./vn-harness) beside the whole
#                                             pack it live-links from
#      dist/vn-harness-<version>-<rid>.zip    the same folder, zipped
#                                             (.tar.gz when zip is absent)
#
#  WHY A FOLDER AND NOT JUST A BINARY - app/ is a LAUNCHER. The shell walks up
#  for .dsh-version.json, runs the pinned
#  `npx @deepseek-ai/dsh@<pin> web --no-open` and shows THAT url in a
#  WKWebView / WebKitGTK window; the plugins are installed into the web profile
#  as LIVE LINKS into packages/. So the distribution IS this repository plus the
#  built binary: nothing is compiled into it, and the folder has to stay where
#  it is (re-run START-HERE.sh after moving it and it re-installs from there).
#
#  WHAT SHIPS is not decided here: scripts/dist-manifest.txt is the one list,
#  read by both halves and pinned by scripts/checks/check-dist-layout.mjs.
#
#  FLAGS (distribute.bat / scripts/dist.ps1 take the same ones)
#      -Version <v>      override the pack version used in the names
#      -SkipBuild        reuse the binary under app/src-tauri/target/release
#      -NoZip            assemble the folder only
#      -Run              assemble, then run the produced distribution
#      -Verify           assemble, then install into a throwaway DSH_HOME and
#                        boot the pinned harness from it, waiting for the ready
#                        line - the end-to-end check the CI job also runs
#      -KeepVerifyHome   keep that throwaway home for inspection
#      -Clean            delete dist/ first
#      -Help
#
#  THE LAUNCH TOKEN IS A LIVE CREDENTIAL: everything this script prints from the
#  ready line goes through the same redaction
#  app/src-tauri/src/readyline.rs applies (the value becomes REDACTED), and a
#  ready line that does not name a loopback address is refused, not trusted.
#
#  POSIX shell only - never PowerShell. Node.js 22+ is required (the harness
#  itself, and the JSON reads below).
# ============================================================================
set -u

case "$0" in
  */*) script_dir=${0%/*} ;;
  *) script_dir=. ;;
esac
script_dir=$(CDPATH= cd -- "$script_dir" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

version_arg=''
skip_build=0
no_zip=0
run_dist=0
do_verify=0
keep_home=0
do_clean=0
show_help=0

usage() {
  printf '%s\n' \
    'Usage: ./distribute.sh [flags]' \
    '' \
    '  -Version <v>      override the pack version used in the names' \
    '  -SkipBuild        reuse the binary already under app/src-tauri/target/release' \
    '  -NoZip            assemble the folder only (no archive)' \
    '  -Run              assemble, then run the produced distribution' \
    '  -Verify           assemble, then install into a throwaway DSH_HOME and boot' \
    '                    the pinned harness from it (the CI end-to-end check)' \
    '  -KeepVerifyHome   keep that throwaway home for inspection' \
    '  -Clean            delete dist/ first' \
    '  -Help             print this help'
    '  -NoPause          never hold this window open' \
    '' \
    'Builds dist/vn-harness-<version>-<rid>/ from scripts/dist-manifest.txt plus the' \
    'built shell, and archives it beside itself. dist/ is never committed.'
}

step() { printf '\033[36m[vn-harness] %s\033[0m\n' "$1"; }
note() { printf '  %s\n' "$1"; }
fail() {
  printf '\n[vn-harness] %s\n' "$1" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    -Version|--version) shift; version_arg=${1:-} ;;
    -Version=*|--version=*) version_arg=${1#*=} ;;
    -SkipBuild|--skip-build) skip_build=1 ;;
    -NoZip|--no-zip) no_zip=1 ;;
    -Run|--run) run_dist=1 ;;
    -Verify|--verify) do_verify=1 ;;
    -KeepVerifyHome|--keep-verify-home) keep_home=1 ;;
    -Clean|--clean) do_clean=1 ;;
    -NoPause|--no-pause) ;;   # the entry point owns the window; accepted so it is never "unknown"
    -Help|--help|-h|-\?) show_help=1 ;;
    *) usage >&2; fail "Unknown flag: $1" ;;
  esac
  shift
done

if [ "$show_help" = 1 ]; then
  usage
  exit 0
fi

[ -d "$repo_root/packages" ] || fail "This is not the vn-harness repository root ($repo_root)."

# --- host facts -------------------------------------------------------------
platform=linux
case "$(uname -s)" in
  Darwin) platform=macos ;;
  Linux) platform=linux ;;
  *) fail "This host ($(uname -s)) is not one this pack supports; use scripts/dist.ps1 on Windows." ;;
esac
case "$platform:$(uname -m)" in
  macos:arm64|macos:aarch64) rid=mac-arm64 ;;
  macos:*) rid=mac-x64 ;;
  *:arm64|*:aarch64) rid=linux-arm64 ;;
  *) rid=linux-x64 ;;
esac
binary_name=vn-harness
cargo_binary_name=vn-harness-desktop
if [ "$platform" = windows ]; then
  binary_name=vn-harness.exe
  cargo_binary_name=vn-harness-desktop.exe
fi

tool_path() {
  for name in "$@"; do
    found=$(command -v "$name" 2>/dev/null) && { printf '%s\n' "$found"; return 0; }
  done
  return 1
}

# The host's SHA-256 tool. Defined here, above its first use, because a shell
# registers a function when it READS the definition - calling it earlier in the
# script would run with no such command.
sha256_of_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    openssl dgst -sha256 "$1" | awk '{ print $NF }'
  fi
}

node_bin=$(tool_path node) || fail 'node was not found on PATH. Node.js 22 or newer is required (https://nodejs.org).'
npx_bin=$(tool_path npx) || fail 'npx was not found on PATH.'
node_bin=$(CDPATH= cd -- "$(dirname -- "$node_bin")" && pwd)/$(basename -- "$node_bin")
npx_bin=$(CDPATH= cd -- "$(dirname -- "$npx_bin")" && pwd)/$(basename -- "$npx_bin")

# The pinned harness line, read with node: a JSON reader that every host has,
# rather than a grep that would break on a reformatted manifest.
pin=$(node -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(!j.dsh)process.exit(3);process.stdout.write(String(j.dsh))' "$repo_root/.dsh-version.json") \
  || fail '.dsh-version.json is missing from the repository root, or has no "dsh" pin.'
pack_version=$version_arg
if [ -z "$pack_version" ]; then
  pack_version=$(node -e 'process.stdout.write(String(require(process.argv[1]).version||""))' "$repo_root/package.json") \
    || fail 'package.json has no readable version.'
fi
[ -n "$pack_version" ] || fail 'package.json has no "version".'

artifact="vn-harness-$pack_version-$rid"
dist_root="$repo_root/dist"
dist_dir="$dist_root/$artifact"
zip_path="$dist_root/$artifact.zip"
tarball_path="$dist_root/$artifact.tar.gz"

step 'vn-harness distributer (build a distribution folder)'
step "Platform: $platform   Repo: $repo_root"
step "Pack version: $pack_version   Harness pin: $pin   Target: $rid"

if [ "$do_clean" = 1 ] && [ -d "$dist_root" ]; then
  step 'Cleaning dist/ ...'
  rm -rf "$dist_root"
fi

# --- 1. the shell binary ----------------------------------------------------
binary="$repo_root/app/src-tauri/target/release/$cargo_binary_name"
if [ "$skip_build" = 0 ]; then
  cargo_bin=$(tool_path cargo) || fail 'cargo was not found on PATH. Install the Rust toolchain from https://rustup.rs, or pass -SkipBuild to reuse an existing build.'
  step 'Building app/src-tauri (cargo does nothing when it is current)...'
  "$cargo_bin" build --release --manifest-path "$repo_root/app/src-tauri/Cargo.toml" \
    || fail 'cargo build failed - see the errors above.'
else
  step 'Skipping the build (-SkipBuild).'
fi
[ -f "$binary" ] || fail "The shell binary is not at $binary. Drop -SkipBuild so it gets built."
step "Shell binary: $binary"

# --- 2. the payload --------------------------------------------------------
manifest_file="$repo_root/scripts/dist-manifest.txt"
[ -f "$manifest_file" ] || fail 'scripts/dist-manifest.txt is missing - it is the one list of what ships.'

includes=''
skipdirs=''
skippaths=''
skipfiles=''
while IFS= read -r line; do
  line=$(printf '%s' "$line" | tr -d '\r')
  line=$(printf '%s' "$line" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  [ -n "$line" ] || continue
  case "$line" in \#*) continue ;; esac
  kind=${line%%[[:space:]]*}
  path=$(printf '%s' "$line" | sed -e 's/^[^[:space:]]*[[:space:]]*//')
  [ -n "$path" ] || fail "dist-manifest.txt: cannot read the rule '$line'."
  case "$path" in
    *..*) fail "dist-manifest.txt: '$path' reaches outside the repository." ;;
  esac
  case "$kind" in
    include) includes="$includes$path
" ;;
    skipdir) skipdirs="$skipdirs$path
" ;;
    skippath) skippaths="$skippaths$path
" ;;
    skipfile) skipfiles="$skipfiles$path
" ;;
    *) fail "dist-manifest.txt: unknown rule kind '$kind' on the line '$line'." ;;
  esac
done < "$manifest_file"
[ -n "$includes" ] || fail 'dist-manifest.txt has no include rules in it.'

# NOTE: every variable in these three matchers is uniquely named. A shell has no
# function-local scope by default, so a matcher that assigns `_rel` or `_name`
# would clobber the WALK's own variables - the first version of this file did
# exactly that and produced dist/app/src-tauri/src/app/src-tauri/... nesting.
skipdir_match() {
  _sd_name=$1
  _sd_ifs=$IFS
  IFS='
'
  for _sd_rule in $skipdirs; do
    if [ "$_sd_rule" = "$_sd_name" ]; then IFS=$_sd_ifs; return 0; fi
  done
  IFS=$_sd_ifs
  return 1
}

skippath_match() {
  _sp_rel=$1
  _sp_ifs=$IFS
  IFS='
'
  for _sp_rule in $skippaths; do
    if [ "$_sp_rel" = "$_sp_rule" ]; then IFS=$_sp_ifs; return 0; fi
    case "$_sp_rel" in "$_sp_rule"/*) IFS=$_sp_ifs; return 0 ;; esac
  done
  IFS=$_sp_ifs
  return 1
}

skipfile_match() {
  _sf_name=$1
  _sf_ifs=$IFS
  IFS='
'
  for _sf_rule in $skipfiles; do
    case "$_sf_name" in $_sf_rule) IFS=$_sf_ifs; return 0 ;; esac
  done
  IFS=$_sf_ifs
  return 1
}

# Copy one include root.
#
# `find` enumerates and the skip rules filter, rather than a hand-written
# recursive walk: a shell has no function-local scope, so a recursive walker
# reassigns its own parameters on the way back up. The first version of this
# file did that and nested scripts/install-all.ps1 into scripts/checks/ (the
# last directory it had descended into) while reporting success. Here the only
# loop is over find's output, and it runs in a subshell where the matchers
# cannot touch anything that matters.
#
# `$_cot_prune` is deliberately unquoted: it IS a list of find arguments, built
# from the manifest's skipdir names, which are fixed literals (node_modules,
# target, gen, tools, .scratch, .git, dist) and never contain a space.
copy_one_tree() {
  _cot_root=$1
  _cot_prefix=$2
  _cot_prune=''
  _cot_ifs=$IFS
  IFS='
'
  for _cot_name in $skipdirs; do
    _cot_prune="$_cot_prune -name $_cot_name -prune -o"
  done
  IFS=$_cot_ifs
  # shellcheck disable=SC2086
  find "$_cot_root" $_cot_prune -type f -print | LC_ALL=C sort | while IFS= read -r _cot_file; do
    _cot_rel=${_cot_file#"$_cot_root"/}
    _cot_dist="$_cot_prefix/$_cot_rel"
    if skipfile_match "${_cot_rel##*/}"; then continue; fi
    if skippath_match "$_cot_dist"; then continue; fi
    mkdir -p "$dist_dir/$(dirname -- "$_cot_dist")"
    cp -p "$_cot_file" "$dist_dir/$_cot_dist" || printf '[vn-harness] could not copy %s\n' "$_cot_file" >&2
  done
}

# The assembled folder has to look like the repository, not like a copy of it
# that went wrong: one sentinel per shipped family, so a walk that flattens or
# nests a tree fails HERE instead of shipping. (The first version of this file
# nested app/src-tauri/src inside itself and produced a 50-file distribution
# that looked fine in the log line.)
check_sentinels() {
  _sent_missing=''
  for _sent in \
    .dsh-version.json \
    README.md \
    scripts/install-all.ps1 \
    scripts/install-all.sh \
    docs/INSTALL.md \
    assets/vn-harness.svg \
    app/src-tauri/src/main.rs \
    app/src-tauri/tauri.conf.json \
    packages/dsh-vn-master/package.json \
    packages/dsh-vn-master/cordis.patch.yml \
    packages/dsh-rightbar/lib/client.js \
    packages/dsh-editor/lib/vendor/cm6.min.js \
    packages/dsh-terminal/lib/vendor/xterm.js \
    packages/dsh-diagrams/lib/vendor/mermaid.min.js \
    packages/dsh-pdf/lib/vendor/pdf.min.mjs \
    packages/dsh-pdf/skills/pdf-analysis/SKILL.md; do
    if [ ! -f "$dist_dir/$_sent" ]; then _sent_missing="$_sent_missing $_sent"; fi
  done
  if [ -n "$_sent_missing" ]; then
    fail "The assembled distribution is missing:$_sent_missing (dist-manifest.txt and the walk disagree)."
  fi
}

rm -rf "$dist_dir"
mkdir -p "$dist_dir"
step "Assembling $dist_dir from scripts/dist-manifest.txt ..."
include_count=0
_old_ifs=$IFS
IFS='
'
for include_path in $includes; do
  IFS=$_old_ifs
  include_count=$((include_count + 1))
  source_path="$repo_root/$include_path"
  if [ ! -e "$source_path" ]; then
    fail "dist-manifest.txt includes '$include_path', which does not exist in this repository."
  fi
  if [ -d "$source_path" ]; then
    copy_one_tree "$source_path" "$include_path"
  else
    if ! skipfile_match "${include_path##*/}"; then
      mkdir -p "$dist_dir/$(dirname -- "$include_path")"
      cp -p "$source_path" "$dist_dir/$include_path"
    fi
  fi
  IFS='
'
done
IFS=$_old_ifs

cp -p "$binary" "$dist_dir/$binary_name"
chmod 755 "$dist_dir/$binary_name"
note "$include_count include rules applied; the shell binary copied in as $binary_name."
check_sentinels

payload_files=$(find "$dist_dir" -type f | wc -l | tr -d ' ')
payload_bytes=$(find "$dist_dir" -type f -exec wc -c {} + | awk '$NF != "total" { sum += $1 } END { printf "%d\n", sum + 0 }')
rustc_version=$(rustc --version 2>/dev/null || printf 'unknown')
node_version=$("$node_bin" --version 2>/dev/null || printf 'unknown')
git_commit=$(git -C "$repo_root" rev-parse --short HEAD 2>/dev/null || printf '')
[ -n "$git_commit" ] || git_commit=unknown
if [ -n "$(git -C "$repo_root" status --porcelain 2>/dev/null)" ]; then dirty=true; else dirty=false; fi
built_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
shell_sha=$(sha256_of_file "$binary")

# --- 3. the files a distribution generates for itself ----------------------
start_here="$dist_dir/START-HERE.sh"
{
  printf '%s\n' '#!/bin/sh'
  printf '%s\n' '# ============================================================'
  printf '%s\n' '#  vn-harness - START HERE'
  printf '%s\n' '#  Generated by scripts/dist.sh - do not edit; re-run the'
  printf '%s\n' '#  distributer in the source repository to change it.'
  printf '%s\n' '#'
  printf '%s\n' '#  Run it:  ./START-HERE.sh'
  printf '%s\n' '#  It makes sure the DeepSeek Harness web profile has this pack'
  printf '%s\n' '#  installed from THIS folder, then opens vn-harness in its own'
  printf '%s\n' '#  window.'
  printf '%s\n' '#'
  printf '%s\n' '#  Requirements: Node.js 22 or newer on PATH, and network access'
  printf '%s\n' '#  on the first run (the shell downloads the pinned harness'
  printf '%s\n' "#  $pin through npx, once)."
  printf '%s\n' '#'
  printf '%s\n' '#  It is safe to run again: the installer skips the bundles it'
  printf '%s\n' '#  already has at their current version and re-adds the ones'
  printf '%s\n' '#  whose version moved. If you installed the pack already and'
  printf '%s\n' '#  want to skip the check, run ./vn-harness directly.'
  printf '%s\n' '#'
  printf '%s\n' '#  The colour decision and the window rule come from the shipped'
  printf '%s\n' '#  scripts/console/theme.sh, exactly as they do for the other'
  printf '%s\n' '#  launchers: colour only on a real terminal, never in a'
  printf '%s\n' '#  redirected log, and the window held open only when it would'
  printf '%s\n' '#  otherwise vanish.'
  printf '%s\n' '# ============================================================'
  printf '%s\n' 'set -u'
  printf '%s\n' 'dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)'
  printf '%s\n' 'cd "$dir" || exit 1'
  printf '%s\n' '. ./scripts/console/theme.sh'
  printf '%s\n' 'command -v node >/dev/null 2>&1 || {'
  printf '%s\n' '  vn_fail "Node.js 22 or newer is required - https://nodejs.org"'
  printf '%s\n' '  vn_pause'
  printf '%s\n' '  exit 1'
  printf '%s\n' '}'
  printf '%s\n' 'vn_step "Making sure the harness web profile has this pack..."'
  printf '%s\n' 'sh ./scripts/install-all.sh "$@" || {'
  printf '%s\n' '  vn_fail "install FAILED - see the messages above."'
  printf '%s\n' '  vn_pause'
  printf '%s\n' '  exit 1'
  printf '%s\n' '}'
  printf '%s\n' 'vn_step "Starting vn-harness. Close the window to stop it."'
  printf '%s\n' 'exec ./vn-harness "$@"'
} > "$start_here"
chmod 755 "$start_here"

{
  printf '%s\n' "vn-harness $pack_version - $rid"
  printf '%s\n' "Built $built_at from commit $git_commit."
  printf '\n'
  printf '%s\n' 'WHAT THIS IS'
  printf '%s\n' '  The DeepSeek Harness, with this pack installed into it, in a native'
  printf '%s\n' '  window instead of a browser tab.'
  printf '\n'
  printf '%s\n' '  The window is a LAUNCHER: ./vn-harness starts the pinned harness'
  printf '\n'
  printf '%s\n' "      npx @deepseek-ai/dsh@$pin web --no-open"
  printf '\n'
  printf '%s\n' '  on a free loopback port, reads the ready line it prints once the'
  printf '%s\n' '  server is listening, and shows THAT url in a WKWebView / WebKitGTK'
  printf '%s\n' '  window. The plugins are not compiled into the binary - the harness web'
  printf '%s\n' '  profile installs every bundle in packages/ as a LIVE LINK, which is'
  printf '%s\n' '  why this folder must stay where it is.'
  printf '\n'
  printf '%s\n' 'REQUIREMENTS'
  printf '%s\n' '  - Node.js 22 or newer on PATH .......... https://nodejs.org'
  printf '%s\n' '  - Network access on the first run ...... the shell downloads the'
  printf '%s\n' "    pinned harness $pin through npx, once (it is"
  printf '%s\n' '    cached afterwards).'
  printf '%s\n' '  - Linux: the WebKitGTK runtime the binary was built against'
  printf '%s\n' '    (libwebkit2gtk-4.1). macOS: nothing beyond Node.js.'
  printf '\n'
  printf '%s\n' 'CLICK THIS'
  printf '%s\n' '  ./START-HERE.sh'
  printf '\n'
  printf '%s\n' '  It installs this pack into the harness web profile (from THIS folder,'
  printf '%s\n' '  wherever it now is) and then opens the window. Already installed? Run'
  printf '%s\n' '  ./vn-harness and skip the check. If the executable bit was lost while'
  printf '%s\n' '  copying, run:  sh ./START-HERE.sh'
  printf '\n'
  printf '%s\n' '  The window shows the SAME profile a ./run-web.sh browser tab shows, so'
  printf '%s\n' '  sessions, settings and everything the pack remembers are shared.'
  printf '\n'
  printf '%s\n' 'THE LAUNCHERS'
  printf '%s\n' '  ./vn-harness                      the app in its native window'
  printf '%s\n' '  ./run-web.sh                      the app in a browser tab instead'
  printf '%s\n' '  ./install.sh                      install/re-install the pack, no window'
  printf '%s\n' '  ./uninstall.sh                    remove what this pack installed'
  printf '\n'
  printf '%s\n' '  All of them take -Help (also -h and --help), -NoPause and -NoTerminal,'
  printf '%s\n' '  and all of them decide their console in ONE shared place'
  printf '%s\n' '  (scripts/console/): colour appears only on a real terminal and never in'
  printf '%s\n' '  a redirected log, and the launch token is never written down.'
  printf '\n'
  printf '%s\n' 'THE FLAGS THE SHELL TAKES'
  printf '%s\n' '  -Port <n>          listen on this port instead of a free one'
  printf '%s\n' '  -DshHome <dir>     override DSH_HOME (default: $DSH_HOME, else ~/.dsh)'
  printf '%s\n' '  -DshVersion <ver>  override the pinned harness version'
  printf '%s\n' '  -Help              print the help'
  printf '\n'
  printf '%s\n' '  The launch token in the ready line is a live credential for the'
  printf '%s\n' '  running process: the shell prints that line with the token REDACTED,'
  printf '%s\n' '  holds the real one in memory only, and refuses to open a url that is'
  printf '%s\n' '  not a loopback address.'
  printf '\n'
  printf '%s\n' 'BUILDING ANOTHER COPY'
  printf '%s\n' '  This folder is the product, not the workshop: distribute.sh is'
  printf '%s\n' '  deliberately NOT here. A distribution is assembled in the repository it'
  printf '%s\n' '  came from (scripts/dist-manifest.txt lists exactly what ships).'
  printf '\n'
  printf '%s\n' 'VERIFY THIS COPY'
  printf '%s\n' '  SHA256SUMS.txt holds the SHA-256 of every file beside it:'
  printf '%s\n' '      sha256sum -c SHA256SUMS.txt      (or: shasum -a 256 -c SHA256SUMS.txt)'
  printf '%s\n' '  BUILD-INFO.json records the pack version, the harness pin, the commit'
  printf '%s\n' '  it was built from and the toolchain that built it.'
  printf '\n'
  printf '%s\n' 'UNINSTALL'
  printf '%s\n' '  ./uninstall.sh'
  printf '%s\n' '  It removes only what this pack installed; your sessions and settings'
  printf '%s\n' '  are untouched. Deleting this folder afterwards is the rest of it.'
} > "$dist_dir/DIST-README.txt"

{
  printf '%s\n' '{'
  printf '%s\n' '  "name": "vn-harness",'
  printf '%s\n' "  \"packVersion\": \"$pack_version\","
  printf '%s\n' "  \"artifact\": \"$artifact\","
  printf '%s\n' "  \"dshPin\": \"$pin\","
  printf '%s\n' "  \"rid\": \"$rid\","
  printf '%s\n' "  \"platform\": \"$platform\","
  printf '%s\n' "  \"arch\": \"${rid##*-}\","
  printf '%s\n' "  \"commit\": \"$git_commit\","
  printf '%s\n' "  \"dirty\": $dirty,"
  printf '%s\n' "  \"builtAt\": \"$built_at\","
  printf '%s\n' '  "builtBy": "scripts/dist.sh",'
  printf '%s\n' "  \"rustc\": \"$rustc_version\","
  printf '%s\n' "  \"node\": \"$node_version\","
  printf '%s\n' "  \"shellBinary\": \"$binary_name\","
  printf '%s\n' "  \"shellSha256\": \"$shell_sha\","
  printf '%s\n' "  \"payloadFiles\": $payload_files,"
  printf '%s\n' "  \"payloadBytes\": $payload_bytes"
  printf '%s\n' '}'
} > "$dist_dir/BUILD-INFO.json"

# Every file beside it, in a stable order, so `sha256sum -c` works from inside
# the folder and the archive carries the same statement.
(
  cd "$dist_dir" || exit 1
  find . -type f ! -name SHA256SUMS.txt | sed -e 's|^\./||' | LC_ALL=C sort | while IFS= read -r rel; do
    printf '%s  %s\n' "$(sha256_of_file "$dist_dir/$rel")" "$rel"
  done
) > "$dist_dir/SHA256SUMS.txt"

total_files=$(find "$dist_dir" -type f | wc -l | tr -d ' ')
# Summed line by line, not by taking the last "total": find batches its -exec
# when the command line would be too long, and then wc prints one total per
# batch - the first version reported 8 MB for a 20 MB folder.
total_bytes=$(find "$dist_dir" -type f -exec wc -c {} + | awk '$NF != "total" { sum += $1 } END { printf "%d\n", sum + 0 }')
step "Distribution: $total_files files, $((total_bytes / 1048576)) MB"

# --- 4. the archive --------------------------------------------------------
archive_path=''
if [ "$no_zip" = 0 ]; then
  if command -v zip >/dev/null 2>&1; then
    rm -f "$zip_path"
    ( cd "$dist_root" && zip -q -r -X "$artifact.zip" "$artifact" ) || fail 'zip failed.'
    archive_path=$zip_path
  else
    rm -f "$tarball_path"
    ( cd "$dist_root" && tar -czf "$artifact.tar.gz" "$artifact" ) || fail 'tar failed.'
    archive_path=$tarball_path
  fi
  step "Archive: $archive_path"
else
  step 'Skipping the archive (-NoZip).'
fi

# ---------------------------------------------------------------------------
# -Verify: install this distribution into a throwaway home and boot it
# ---------------------------------------------------------------------------
redact() { printf '%s' "$1" | sed -e 's/token=[^ &]*/token=REDACTED/'; }

verify_distribution() {
  temp_home=$(mktemp -d "${TMPDIR:-/tmp}/vn-harness-dist-verify-XXXXXX") || fail 'mktemp failed.'
  step "Verify: throwaway DSH_HOME $temp_home"

  # The check runs against a COPY of the distribution, and that is the point: a
  # distribution is a folder somebody extracts somewhere else, so a copy in a
  # temp folder is exactly the thing being promised. It also keeps the real
  # folder pristine - the installer bootstraps its own pnpm under a LOCAL tools/
  # when the machine has none, and running it in place would leave that tree
  # inside the distribution after the archive was already made.
  probe="$temp_home/distribution"
  cp -R "$dist_dir" "$probe" || fail 'Could not copy the distribution into the throwaway home.'
  step 'Verify: copied the distribution to a temp folder (as if it had been moved).'

  installer="$probe/scripts/install-all.sh"
  [ -f "$installer" ] || fail 'The distribution has no scripts/install-all.sh in it.'

  step 'Verify: installing the distribution into that home...'
  sh "$installer" -DshHome "$temp_home" || fail "The distribution's installer failed."

  profile_manifest="$temp_home/profiles/web/package.json"
  [ -f "$profile_manifest" ] || fail "The installer did not create a web profile at $profile_manifest."
  installed=$("$node_bin" -e 'const fs=require("fs");const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(((j.dsh&&j.dsh.profile&&j.dsh.profile.bundles)||[]).join("\n"))' "$profile_manifest")
  carried=$("$node_bin" -e '
const fs = require("fs"), path = require("path");
const root = process.argv[1];
for (const dir of fs.readdirSync(path.join(root, "packages"))) {
  const manifest = path.join(root, "packages", dir, "package.json");
  if (!fs.existsSync(manifest)) continue;
  const json = JSON.parse(fs.readFileSync(manifest, "utf8"));
  if (json.dsh && json.dsh.bundle && json.name) console.log(json.name);
}' "$dist_dir")
  missing=''
  _old_ifs=$IFS
  IFS='
'
  for bundle in $carried; do
    IFS=$_old_ifs
    hit=0
    for held in $installed; do
      if [ "$held" = "$bundle" ]; then hit=1; break; fi
    done
    if [ "$hit" = 0 ]; then missing="$missing $bundle"; fi
    IFS='
'
  done
  IFS=$_old_ifs
  [ -z "$missing" ] || fail "The profile did not end up listing:$missing"
  carried_count=$(printf '%s\n' "$carried" | grep -c . || true)
  step "Verify: the profile lists all $carried_count bundles this folder carries."

  port=$("$node_bin" -e 'const net=require("net");const s=net.createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})')
  log="$temp_home/boot.log"
  err="$temp_home/boot.err"
  step "Verify: booting the pinned harness from the distribution (port $port)..."

  if command -v setsid >/dev/null 2>&1; then
    DSH_HOME="$temp_home" setsid "$npx_bin" --yes "@deepseek-ai/dsh@$pin" web --no-open --port "$port" > "$log" 2> "$err" &
  else
    DSH_HOME="$temp_home" "$npx_bin" --yes "@deepseek-ai/dsh@$pin" web --no-open --port "$port" > "$log" 2> "$err" &
  fi
  server_pid=$!

  ready=''
  deadline=$(( $(date +%s) + 180 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ -s "$log" ]; then
      ready=$(grep -a 'dsh web:' "$log" 2>/dev/null | head -n 1 \
        | sed -e 's/\x1b\[[0-9;]*[A-Za-z]//g' \
        | sed -n 's/.*\(http:\/\/[^[:space:]]*\).*/\1/p' \
        | sed -e 's/[.,)"'"'"']*$//' | head -n 1)
      [ -n "$ready" ] && break
    fi
    kill -0 "$server_pid" 2>/dev/null || break
    sleep 1
  done

  # Stop it, the whole group when setsid gave us one, and then prove the port is
  # free - a runner must not carry a listening server into the next step.
  kill -TERM "-$server_pid" 2>/dev/null || kill -TERM "$server_pid" 2>/dev/null || true
  if command -v pkill >/dev/null 2>&1; then pkill -TERM -P "$server_pid" 2>/dev/null || true; fi
  sleep 1
  kill -KILL "-$server_pid" 2>/dev/null || kill -KILL "$server_pid" 2>/dev/null || true
  free=0
  i=0
  while [ "$i" -lt 20 ]; do
    if "$node_bin" -e 'const net=require("net");const s=net.createServer();s.once("error",()=>process.exit(1));s.listen(Number(process.argv[1]),"127.0.0.1",()=>{s.close();process.exit(0)})' "$port"; then
      free=1
      break
    fi
    if command -v lsof >/dev/null 2>&1; then
      holders=$(lsof -ti "tcp:$port" 2>/dev/null || true)
      if [ -n "$holders" ]; then
        for holder in $holders; do kill -KILL "$holder" 2>/dev/null || true; done
      fi
    fi
    i=$((i + 1))
    sleep 1
  done

  if [ -z "$ready" ]; then
    step 'Verify FAILED: no "dsh web:" ready line within 180 seconds.'
    [ -s "$log" ] && note "$(tail -n 20 "$log" | redact)"
    [ -s "$err" ] && note "$(tail -n 20 "$err" | redact)"
    fail 'The distribution never became ready.'
  fi

  case "$ready" in
    http://127.0.0.1:*|http://localhost:*|http://\[::1\]:*) ;;
    *) fail "The ready line did not name a loopback address (refused rather than trusted): $(redact "$ready")" ;;
  esac
  step "Verify PASSED: the distribution booted and answered at $(redact "$ready")"
  note 'The harness served the web profile installed from this folder.'
  if [ "$free" = 0 ]; then
    note "Warning: 127.0.0.1:$port was still listening after the stop; check for a stray node process."
  fi

  if [ "$keep_home" = 1 ]; then
    note "Kept the throwaway home: $temp_home"
  else
    rm -rf "$temp_home"
  fi
}

if [ "$do_verify" = 1 ]; then
  printf '\n'
  verify_distribution
fi

printf '\n'
step 'Done.'
note "Folder to click: $dist_dir"
note '  ./START-HERE.sh (it installs the pack, then opens the window)'
if [ -n "$archive_path" ]; then note "Archive to hand over: $archive_path"; fi
note 'dist/ is gitignored on purpose: it is build output, and it is a copy - re-run this after editing a plugin.'

if [ "$run_dist" = 1 ]; then
  printf '\n'
  step "Running the distribution: $dist_dir/$binary_name"
  cd "$dist_dir" || fail "Cannot enter $dist_dir."
  exec "./$binary_name"
fi

exit 0
