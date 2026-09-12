#!/bin/sh
# ============================================================
#  vn-harness uninstaller - macOS / Linux.
#
#  Removes this pack's bundles from the DeepSeek Harness WEB profile (DSH_HOME,
#  else ~/.dsh, profile "web" by default), together with any retired bundle name
#  it shipped before (dsh-focus, dsh-files). Removing a bundle also removes its
#  patch layer, so the docs/rows it carried come back on the next boot.
#
#  POSIX shell only: this script needs Node.js (>= 22), npm and npx - never
#  PowerShell; the Windows half is scripts/uninstall-all.ps1, driven by
#  uninstall-all.bat / uninstall.bat.
#
#  Usage:
#    sh scripts/uninstall-all.sh [-Plugin <substring>] [-DshHome <dir>]
#                                [-ProfileName <name>] [-DshVersion <version>]
#                                [-Target web|cli]
# ============================================================
set -u

case "$0" in
  */*) script_dir=${0%/*} ;;
  *) script_dir=. ;;
esac
script_dir=$(CDPATH= cd -- "$script_dir" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

plugin_arg=''
dsh_home_arg=''
profile_arg=''
dsh_version_arg=''
target_arg=''

usage() {
  printf '%s\n' \
    'Usage: sh scripts/uninstall-all.sh [-Plugin <substring>] [-DshHome <dir>]' \
    '                                    [-ProfileName <name>] [-DshVersion <version>]' \
    '                                    [-Target web|cli]' \
    '' \
    '  -Plugin <substring>  only remove bundles whose package name matches' \
    '  -DshHome <dir>       override DSH_HOME (default: $DSH_HOME, else ~/.dsh)' \
    '  -ProfileName <name>  override the profile name (default: web)' \
    '  -DshVersion <ver>    override the pinned dsh version from .dsh-version.json' \
    '  -Target web|cli      accepted for muscle memory; both mean the web profile'
}

while [ $# -gt 0 ]; do
  case "$1" in
    -Plugin|--plugin) shift; plugin_arg=${1:-} ;;
    -Plugin=*|--plugin=*) plugin_arg=${1#*=} ;;
    -DshHome|--dsh-home) shift; dsh_home_arg=${1:-} ;;
    -DshHome=*|--dsh-home=*) dsh_home_arg=${1#*=} ;;
    -ProfileName|--profile) shift; profile_arg=${1:-} ;;
    -ProfileName=*|--profile=*) profile_arg=${1#*=} ;;
    -DshVersion|--dsh-version) shift; dsh_version_arg=${1:-} ;;
    -DshVersion=*|--dsh-version=*) dsh_version_arg=${1#*=} ;;
    -Target|--target) shift; target_arg=${1:-} ;;
    -Target=*|--target=*) target_arg=${1#*=} ;;
    -h|--help) usage; exit 0 ;;
    *)
      printf 'vn-harness: unknown option "%s"\n' "$1" >&2
      printf 'Run "sh scripts/uninstall-all.sh --help" for the accepted options.\n' >&2
      exit 2
      ;;
  esac
  shift
done

case "$target_arg" in
  ''|web|cli) ;;
  *)
    printf 'vn-harness: -Target accepts only "web" or "cli" (both mean the web profile); got "%s".\n' "$target_arg" >&2
    printf 'DSH Desktop is not a target of this pack.\n' >&2
    exit 2
    ;;
esac

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

# One line per bundle under packages/: "name<TAB>version<TAB>folder".
list_bundles() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    const root = path.join(process.argv[1], "packages");
    const filter = String(process.argv[2] || "").toLowerCase();
    const found = [];
    for (const entry of fs.readdirSync(root).sort()) {
      const file = path.join(root, entry, "package.json");
      if (!fs.existsSync(file)) continue;
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!json.dsh || !json.dsh.bundle) continue;
      if (filter !== "" && String(json.name).toLowerCase().indexOf(filter) < 0) continue;
      found.push([json.name, json.version, path.join(root, entry)].join("\t"));
    }
    if (found.length === 0) {
      process.stderr.write("no dsh bundles found under packages/ (package.json with dsh.bundle)\n");
      process.exit(1);
    }
    process.stdout.write(found.join("\n"));
  ' "$repo_root" "$1"
}

# The bundle names the profile lists, one per line.
installed_bundles() {
  node -e '
    const fs = require("fs");
    let names = [];
    try {
      const json = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      const held = json && json.dsh && json.dsh.profile && json.dsh.profile.bundles;
      if (Array.isArray(held)) names = held;
    } catch (error) {
      names = [];
    }
    process.stdout.write(names.join("\n"));
  ' "$1/package.json"
}

# The pnpm major the profile was created with, and its virtual-store length:
# "major maxlen" (maxlen empty when the file does not carry one).
pnpm_store_info() {
  node -e '
    const fs = require("fs");
    let text = "";
    try {
      text = fs.readFileSync(process.argv[1], "utf8");
    } catch (error) {
      text = "";
    }
    const store = /store[\\/]+v(\d+)/.exec(text);
    const major = store && Number(store[1]) >= 10 ? store[1] : "9";
    const length = /virtualStoreDirMaxLength["\s:]+(\d+)/.exec(text);
    process.stdout.write(major + " " + (length ? length[1] : ""));
  ' "$1/node_modules/.modules.yaml"
}

find_system_pnpm() {
  if command -v pnpm >/dev/null 2>&1; then
    version=$(pnpm --version 2>/dev/null || printf '')
    major=${version%%.*}
    case "$major" in ''|*[!0-9]*) major=0 ;; esac
    if [ "$major" -ge "$1" ]; then
      path=$(command -v pnpm)
      printf '%s\n' "${path%/*}"
      return 0
    fi
  fi
  return 1
}

ensure_pnpm() {
  if find_system_pnpm "$1"; then
    return 0
  fi
  prefix="$repo_root/tools/pnpm$1"
  bin_dir="$prefix/node_modules/.bin"
  if [ ! -x "$bin_dir/pnpm" ]; then
    step "Bootstrapping local pnpm@$1 under ./tools (no admin needed)..."
    npm install --prefix "$prefix" "pnpm@$1" --no-audit --no-fund || return 1
    if [ ! -x "$bin_dir/pnpm" ]; then
      return 1
    fi
  fi
  printf '%s\n' "$bin_dir"
}

invoke_dsh() {
  PATH="$pnpm_bin_dir:$PATH"
  DSH_HOME="$dsh_home"
  export PATH DSH_HOME
  if [ -n "$vs_max_len" ]; then
    npm_config_virtual_store_dir_max_length="$vs_max_len"
    export npm_config_virtual_store_dir_max_length
  fi
  npm_config_ignore_workspace_root_check=true
  export npm_config_ignore_workspace_root_check
  npx --yes "@deepseek-ai/dsh@$dsh_version" "$@"
}

is_installed() {
  for held in $installed_names; do
    if [ "$held" = "$1" ]; then
      return 0
    fi
  done
  return 1
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

step 'DeepSeek Harness plugin pack uninstaller (web profile)'
step "Repo: $repo_root"

require_tool node
require_tool npm
require_tool npx

if [ -n "$dsh_version_arg" ]; then
  dsh_version="$dsh_version_arg"
else
  dsh_version=$(read_pin)
fi
[ -n "$dsh_version" ] || fail 'could not read the pinned dsh version from .dsh-version.json'

dsh_home="$dsh_home_arg"
if [ -z "$dsh_home" ]; then
  dsh_home=${DSH_HOME:-}
fi
if [ -z "$dsh_home" ]; then
  home_dir=${HOME:-}
  if [ -z "$home_dir" ]; then
    home_dir=$(CDPATH= cd -- ~ && pwd)
  fi
  dsh_home="$home_dir/.dsh"
fi
profile_name=${profile_arg:-web}
profile_dir="$dsh_home/profiles/$profile_name"

bundles=$(list_bundles "$plugin_arg") || exit 1

printf '\n'
step "Target: web - profile '$profile_name' at $profile_dir"
if [ ! -d "$profile_dir" ]; then
  printf '  (profile not present - nothing to do)\n'
  exit 0
fi

store_info=$(pnpm_store_info "$profile_dir")
store_major=${store_info%% *}
vs_max_len=${store_info#* }
pnpm_bin_dir=$(ensure_pnpm "$store_major") || fail "could not provide a pnpm >= $store_major (a system pnpm was not new enough and the local bootstrap failed)"

installed_names=$(installed_bundles "$profile_dir")

# Retired bundles: this pack shipped the panel as 'dsh-focus' (renamed to
# 'dsh-files' in alpha.10) and later as 'dsh-files', which the GUI now ships
# natively; remove any stale retired name too.
for legacy in dsh-focus dsh-files; do
  if is_installed "$legacy"; then
    printf "  - removing retired bundle '%s' ...\n" "$legacy"
    invoke_dsh plugin --profile "$profile_name" remove "$legacy" || fail "could not remove the retired bundle '$legacy'"
    printf "  - removed retired bundle '%s'\n" "$legacy"
    remaining=''
    for held in $installed_names; do
      if [ "$held" != "$legacy" ]; then
        remaining="$remaining $held"
      fi
    done
    installed_names=$remaining
  fi
done

tab=$(printf '\t')
while IFS="$tab" read -r name version folder; do
  [ -n "$name" ] || continue
  if ! is_installed "$name"; then
    printf '  - %s: not installed (skip)\n' "$name"
    continue
  fi
  printf '  - removing %s ...\n' "$name"
  invoke_dsh plugin --profile "$profile_name" remove "$name" || fail "dsh could not remove $name"
  printf '  - removed %s\n' "$name"
done <<EOF
$bundles
EOF

printf '\n'
step 'Uninstall finished. Restart the CLI app afterwards.'
