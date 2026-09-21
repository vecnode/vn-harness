#!/bin/sh
# ============================================================
#  vn-harness installer - macOS / Linux.
#
#  Installs this pack's bundles into the DeepSeek Harness WEB profile: the raw
#  install used by "npx @deepseek-ai/dsh web" (DSH_HOME, else ~/.dsh, profile
#  "web" by default). DSH Desktop is deliberately NOT a target of this pack.
#
#  POSIX shell only. This script needs Node.js (>= 22), npm and npx - never
#  PowerShell; the Windows half is scripts/install-all.ps1, driven by
#  install-all.bat / install.bat.
#
#  Usage:
#    sh scripts/install-all.sh [-Force] [-Plugin <substring>]
#                              [-DshHome <dir>] [-ProfileName <name>]
#                              [-DshVersion <version>] [-Target web|cli]
#
#  A plain run re-adds every bundle whose repo version moved and skips the ones
#  already at that version; -Force re-adds regardless. The web profile installs
#  each bundle as a LIVE LINK into this repo, so a linked bundle is always
#  current and is reported instead of re-added.
# ============================================================
set -u

case "$0" in
  */*) script_dir=${0%/*} ;;
  *) script_dir=. ;;
esac
script_dir=$(CDPATH= cd -- "$script_dir" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)

# The Windows spellings PowerShell also accepts (-Force, -DshHome, ...) are kept
# as aliases so muscle memory and the docs work on every platform.
force=0
plugin_arg=''
dsh_home_arg=''
profile_arg=''
dsh_version_arg=''
target_arg=''

usage() {
  printf '%s\n' \
    'Usage: sh scripts/install-all.sh [-Force] [-Plugin <substring>]' \
    '                                  [-DshHome <dir>] [-ProfileName <name>]' \
    '                                  [-DshVersion <version>] [-Target web|cli]' \
    '' \
    '  -Force               re-add bundles the profile already lists' \
    '  -Plugin <substring>  only install bundles whose package name matches' \
    '  -DshHome <dir>       override DSH_HOME (default: $DSH_HOME, else ~/.dsh)' \
    '  -ProfileName <name>  override the profile name (default: web)' \
    '  -DshVersion <ver>    override the pinned dsh version from .dsh-version.json' \
    '  -Target web|cli      accepted for muscle memory; both mean the web profile'
}

while [ $# -gt 0 ]; do
  case "$1" in
    -Force|--force|-f) force=1 ;;
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
      printf 'Run "sh scripts/install-all.sh --help" for the accepted options.\n' >&2
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

# ---------------------------------------------------------------------------
# Node helpers: the profile's package.json, each bundle's package.json and
# pnpm's .modules.yaml are JSON/YAML-ish, and node is already a prerequisite,
# so the parsing lives in node rather than in fragile grep/sed pipelines.
# ---------------------------------------------------------------------------

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

# The version the profile actually runs for one bundle ("" when it is absent).
effective_version() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    try {
      const file = path.join(process.argv[1], "node_modules", ...String(process.argv[2]).split("/"), "package.json");
      const json = JSON.parse(fs.readFileSync(file, "utf8"));
      process.stdout.write(String(json.version || ""));
    } catch (error) {
      process.stdout.write("");
    }
  ' "$1" "$2"
}

# "1" when the profile resolves the bundle straight into this repo (a symlink).
is_live_link() {
  node -e '
    const fs = require("fs");
    const path = require("path");
    let real = "";
    try {
      real = fs.realpathSync(path.join(process.argv[1], "node_modules", ...String(process.argv[2]).split("/")));
    } catch (error) {
      process.stdout.write("0");
      process.exit(0);
    }
    let root = "";
    try {
      root = fs.realpathSync(process.argv[3]);
    } catch (error) {
      process.stdout.write("0");
      process.exit(0);
    }
    const inside = real === root || real.indexOf(root + path.sep) === 0;
    process.stdout.write(inside ? "1" : "0");
  ' "$1" "$2" "$3"
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

# ---------------------------------------------------------------------------
# pnpm: the profile stores its pnpm layout in node_modules/.modules.yaml, and
# `dsh plugin add` runs pnpm underneath. A system pnpm new enough for the
# profile is reused; otherwise a private copy is bootstrapped under ./tools.
# ---------------------------------------------------------------------------
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

# Every dsh/pnpm call runs with the profile's own pnpm on PATH and the profile
# environment exported, so nothing here depends on the caller's shell state.
invoke_dsh() {
  PATH="$pnpm_bin_dir:$PATH"
  DSH_HOME="$dsh_home"
  export PATH DSH_HOME
  if [ -n "$vs_max_len" ]; then
    npm_config_virtual_store_dir_max_length="$vs_max_len"
    export npm_config_virtual_store_dir_max_length
  fi
  # dsh profiles are pnpm workspace roots ("packages: [.]"); pnpm >= 9 refuses a
  # bare `add` there unless the root check is opted out.
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
# The master stays the profile's LAST bundle
# ---------------------------------------------------------------------------
# dsh-vn-master is the pack's final layer: its row is the slot where a pack-wide
# patch can restate any other row, and that only holds if it is applied last.
# `dsh plugin add` APPENDS a bundle the profile does not know yet, so a profile
# that gains a package after the master was installed ends up with the master in
# front of it (the alphabetical first-install order happens to put the master
# last, which is why this only shows up on an upgrade).
#
# Re-assert the order with the CLI's own commands - never by editing the
# profile's package.json. The master is a blank no-op row, so removing and
# re-adding it costs nothing and changes no state.
#   usage: assert_master_last <profile-name> <master-folder-or-empty>
assert_master_last() {
  profile_name=$1
  master_folder=$2
  last=$(installed_bundles "$profile_dir" | tail -n 1)
  case " $(installed_bundles "$profile_dir") " in
    *" dsh-vn-master "*) ;;
    *) return 0 ;;
  esac
  [ "$last" = 'dsh-vn-master' ] && return 0
  if [ -z "$master_folder" ]; then
    printf '  - dsh-vn-master is not the profile'"'"'s last bundle (this run does not carry it; a full install re-asserts the order)\n'
    return 0
  fi
  printf '  - dsh-vn-master is not the profile'"'"'s last bundle - re-adding it so the master stays the final layer ...\n'
  invoke_dsh plugin --profile "$profile_name" remove dsh-vn-master || fail 'could not reorder dsh-vn-master'
  invoke_dsh plugin --profile "$profile_name" add "$master_folder" || fail 'could not re-add dsh-vn-master'
  printf '  - dsh-vn-master is the last bundle again\n'
}

# ---------------------------------------------------------------------------
# Skills a bundle ships
# ---------------------------------------------------------------------------
# Copy the skill folders a bundle carries into the harness' own skills root.
#
# A package may ship `skills/<name>/SKILL.md`. The row registers those skills at
# runtime from its own folder, so they work either way - but copying them into
# <DshHome>/skills also puts them where the harness' filesystem skill provider
# looks (and where a person can read or edit them without touching this repo).
#
# Ownership is explicit: every folder this installer creates gets a marker file,
# and a target folder WITHOUT the marker is left alone - a person's own skill of
# the same name is never overwritten, and uninstall only removes what this
# installer wrote.
#   usage: install_skills <skills-root> <package-name> <package-folder>
install_skills() {
  skills_root=$1
  name=$2
  folder=$3
  [ -d "$folder/skills" ] || return 0
  for skill in "$folder"/skills/*/; do
    [ -f "$skill/SKILL.md" ] || continue
    skill_name=$(basename "$skill")
    dest="$skills_root/$skill_name"
    marker="$dest/.vn-harness-$name"
    if [ -d "$dest" ] && [ ! -f "$marker" ]; then
      printf "  - skills: left '%s' alone (it is not one of ours; delete it to take the bundled copy)\n" "$skill_name"
      continue
    fi
    mkdir -p "$dest"
    cp -R "$skill". "$dest"/
    printf '%s\n' "$name" >"$marker"
    if [ -n "$skills_copied" ]; then
      skills_copied="$skills_copied, $skill_name"
    else
      skills_copied="$skill_name"
    fi
  done
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

step 'DeepSeek Harness plugin pack installer (web profile)'
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
step "Pinned dsh version: $dsh_version"

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
names_line=''
tab=$(printf '\t')
while IFS="$tab" read -r name version folder; do
  [ -n "$name" ] || continue
  if [ -n "$names_line" ]; then
    names_line="$names_line, $name@$version"
  else
    names_line="$name@$version"
  fi
done <<EOF
$bundles
EOF
step "Bundles to install: $names_line"

printf '\n'
step "Target: web - profile '$profile_name' at $profile_dir"
if [ ! -d "$profile_dir" ]; then
  printf "  (profile directory does not exist yet; 'dsh plugin add' initializes it)\n"
fi

# Read the profile's pnpm layout before any pnpm call needs it.
store_info=$(pnpm_store_info "$profile_dir")
store_major=${store_info%% *}
vs_max_len=${store_info#* }
pnpm_bin_dir=$(ensure_pnpm "$store_major") || fail "could not provide a pnpm >= $store_major (a system pnpm was not new enough and the local bootstrap failed)"
step "pnpm: $pnpm_bin_dir (store major $store_major)"

installed_names=$(installed_bundles "$profile_dir")

# Retired bundles: this pack used to ship the panel as 'dsh-focus' (row id
# 'focus', renamed to 'dsh-files' in alpha.10) and then as 'dsh-files', which the
# GUI now ships natively - the right Sidebar has its own Files tab. A profile
# still listing a retired name would keep its bundle and patch layer mounted next
# to the current one, so drop it before adding.
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

while IFS="$tab" read -r name version folder; do
  [ -n "$name" ] || continue
  if is_installed "$name"; then
    if [ "$force" -eq 0 ]; then
      live=$(is_live_link "$profile_dir" "$name" "$repo_root/packages")
      current=$(effective_version "$profile_dir" "$name")
      if [ -n "$current" ] && [ "$current" != "$version" ]; then
        printf "  - %s: installed version '%s' is behind repo version '%s' - re-adding to sync...\n" "$name" "$current" "$version"
      else
        if [ "$live" = "1" ]; then
          printf "  - %s %s: installed as a LIVE LINK into this repo - code edits already apply. Just restart the app to load them (no re-add needed).\n" "$name" "$version"
        else
          printf "  - %s %s: already installed and up to date (skip; use -Force to re-add).\n" "$name" "$version"
        fi
        continue
      fi
    else
      printf "  - adding %s %s (-Force) ...\n" "$name" "$version"
    fi
  elif [ "$force" -eq 0 ]; then
    printf "  - adding %s %s (first install) ...\n" "$name" "$version"
  else
    printf "  - adding %s %s (-Force) ...\n" "$name" "$version"
  fi
  invoke_dsh plugin --profile "$profile_name" add "$folder" || fail "dsh could not add $name"
  printf "  - added %s\n" "$name"
done <<EOF
$bundles
EOF

# The bundled skills land in <DshHome>/skills, where the harness' own
# filesystem skill provider reads them (see install_skills).
skills_copied=''
master_folder=''
while IFS="$tab" read -r name version folder; do
  [ -n "$name" ] || continue
  if [ "$name" = 'dsh-vn-master' ]; then
    master_folder=$folder
  fi
  install_skills "$dsh_home/skills" "$name" "$folder"
done <<EOF
$bundles
EOF
assert_master_last "$profile_name" "$master_folder"
if [ -n "$skills_copied" ]; then
  step "skills: copied $skills_copied into $dsh_home/skills"
fi

printf '\n'
step 'Done.'
printf '\n'
printf 'Next steps:\n'
printf '  - START it with ./run.sh (or run.ps1 on Windows): that is\n'
printf '    "npx @deepseek-ai/dsh web" plus the browser hand-off - it opens the\n'
printf '    URL the app prints, token included, in Chrome (default browser as\n'
printf '    the fallback) and keeps the harness in that terminal.\n'
printf '  - RESTART the app to load the changes. Stop the running\n'
printf '    "npx @deepseek-ai/dsh web" (Ctrl+C), start it again, then\n'
printf '    HARD-REFRESH the browser tab (Ctrl+F5). The client bundle\n'
printf '    is read once at app boot, so a restart is required after every\n'
printf '    code change.\n'
printf '  - Open the right Sidebar with the conversation header expand button.\n'
printf '    Click a text/code file in its Files tab to edit it, or use the tab\n'
printf '    strip "+" -> Editor to start a blank file: Save asks for its name\n'
printf '    (extension included) and creates it in the conversation folder.\n'
printf '  - Markdown opens in that editor; its toolbar Preview button shows the\n'
printf '    rendered page, and the page carries an Edit button back to the editor.\n'
printf '  - "Open In..." in the conversation header keeps using the shipped\n'
printf '    entries for editors/terminals; its file-browser entries are the\n'
printf "    pack's own cross-platform launcher (see packages/dsh-open-in-app).\n"
printf '  - The Themes button sits in that same header group, immediately left of\n'
printf '    "Open In...": it switches Light / Dark / System, the same preference\n'
printf '    Settings > General > Appearance owns (see packages/dsh-themes).\n'
printf '  - The camera button, left of the Themes button, screenshots the whole\n'
printf '    window: the browser captures the tab and the pack writes the PNG to\n'
printf '    this machine'"'"'s Desktop as vn-harness-<timestamp>.png.\n'
printf '  - Diagrams (see packages/dsh-diagrams): ask for one in the chat - Mermaid\n'
printf '    or TikZ - and it renders inline, with a link that opens it as its own\n'
printf '    tab. "+" -> Diagrams lists this conversation and the shared library; the\n'
printf '    tab has a source drawer and an export menu (mmd/md/tex/pdf/svg/png saved\n'
printf "    to this machine's Desktop, never the conversation folder). TikZ needs a\n"
printf '    TeX engine (pdflatex and friends); without one TikZ diagrams are still\n'
printf '    stored and exported as .tex.\n'
printf '  - API keys are never touched by this installer - add your key in Settings > Models.\n'
