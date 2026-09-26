# Deploying vn-harness

What stands between today's `distribute.bat` and a distribution somebody can run
on a machine that has never seen Node, plus the launcher contract, the state map
and the CI plan for the three operating systems.

Companion pages: [`PATHS.md`](PATHS.md) is the map of every location the app
touches, [`DISTRIBUTE.md`](DISTRIBUTE.md) is how the distributer works today,
[`../app/README.md`](../app/README.md) is the shell.

Every number below was measured on this machine or read from the harness's own
source; the source location is named so it can be re-verified after a pin bump.

---

## 1. What the current build already gets right

Keep all four; every change below has to preserve them.

| | |
|---|---|
| **One ship list** | `scripts/dist-manifest.txt`, read by both halves, with a tracked check that fails when a bundle appears under `packages/` that the list does not carry |
| **One implementation per host, no drift** | `distribute.bat` â†’ `scripts/dist.ps1` is literally the file `windows-latest` runs with `-Verify` |
| **`-Verify` is a real proof** | copies the folder elsewhere, installs from the copy into a throwaway home, asserts the profile lists every bundle the folder carries, boots the pinned harness, waits for the ready line, proves the port is free again |
| **The launch token rules** | read in memory, never written, echoed or shelled; a non-loopback ready line refused rather than opened (`Test-LoopbackUrl`, `readyline.rs`) |

The distribution is also honestly small today: **27.4 MB / 355 files** on disk and
about 7 MB zipped. Both properties are about to change, which is why Â§4 is a
ladder rather than a jump.

---

## 2. What is missing, in the order it matters

### G1 â€” the runtime lives outside the folder (the serious one)

`$DSH_HOME/profiles/node_modules` is a set of **junctions into the npm/npx cache**,
and the harness rebuilds them at every boot from an anchor relative to itself:

```js
// @deepseek-ai/dsh/lib/profile-boot-*.js
const INSTALL_ANCHOR = fileURLToPath(new URL("../package.json", import.meta.url));
```

Measured today:

```text
$DSH_HOME/profiles/node_modules/zod  ->  â€¦\npm-cache\_npx\1da1392061ab1944\node_modules\zod
```

So the app that runs is **the npm cache** plus a profile holding patch files and
`link:` junctions into `packages/`. Consequences:

- the distribution folder is not self-contained, and moving it does not move the
  installation;
- `npm cache clean --force`, a cache eviction or a different `npm_config_cache`
  leaves every junction dangling â€” a broken app with an intact-looking home;
- the AppData/`~/.npm` tree grows ~223 MB per pin, per user, for an app the user
  installed in a folder they chose.

### G2 â€” installing needs the network, for exactly two reasons

Both were traced to the code, and the second is smaller than the docs imply:

1. `npx @deepseek-ai/dsh@<pin>` downloads the whole installation on first run
   (measured: **223 MB, ~25 400 files**);
2. `install-all.ps1` / `.sh` bootstrap pnpm with
   `npm install --prefix ./tools pnpm@<major>` (measured: **13 MB**), because
   `dsh plugin add` is a thin forwarder that spawns **`pnpm` from PATH**
   (`dsh/lib/plugin-*.js`).

That is the whole list. **The registry is not consulted for the profile** â€”
`$DSH_HOME/profiles/web/pnpm-lock.yaml` contains *only* `link:` specs, with no
registry resolution anywhere, and `profiles/web/node_modules/.pnpm/` holds nothing
but `lock.yaml`. The base bundles (`@deepseek-ai/dsh-base`,
`@deepseek-ai/dsh-web-app`) are listed in `dsh.profile.bundles` but are **not**
installed into the profile: they resolve through the installation fallback. A
profile install therefore needs the installation closure and a pnpm, and nothing
else.

### G3 â€” the target machine needs Node.js 22+

`START-HERE.bat` refuses to run without it (`where node`), and the shell spawns
`npx.cmd` / `npx` (`app/src-tauri/src/main.rs`). Measured: `node.exe` is
**81.6 MB**; the official `node-v22.20.0-win-x64.zip` is **36 MB**. The macOS and
Linux archives are 26â€“31 MB.

### G4 â€” the target machine needs a pnpm it has never heard of

Even with Node present, `dsh plugin` wants `pnpm` on PATH. A reader who has never
used pnpm gets `error: pnpm not found on PATH` in the middle of an install the
pack started for them.

### G5 â€” the launchers are not adaptive

The current batch files are correct but plain: they hardcode `powershell` (5.1),
never set a code page, print no colour, always `pause`, and open in `conhost`
even when Windows Terminal is the default terminal application. `run-desktop.bat`
is worse than the others â€” it is **not shipped in the distribution at all** (it is
absent from `dist-manifest.txt`, verified in the built folder), it embeds its own
build logic in batch, and its echo wording differs from the other four. Â§5 is the
contract that fixes this.

### G6 â€” no map of where things live

Answered by [`PATHS.md`](PATHS.md), which is new in this change. It also states
the rule (Â§5 of that page) the rest of this plan implements.

### G7 â€” the CI matrix cannot run as written

`.github/workflows/distribute.yml` names `macos-13` for `mac-x64`. That image no
longer exists â€” the current runner list has no macOS 13, and `macos-14` is
deprecated ([actions/runner-images](https://github.com/actions/runner-images)). The
first run of the workflow as pushed would fail on the Intel macOS leg. The
Windows Server 2025 image is `windows-latest`; ARM64 runners exist for all three
OSes (`windows-11-arm`, `macos-15`, `ubuntu-22.04-arm`). Â§7 is the corrected
matrix.

Two smaller workflow gaps: `run-desktop.bat` is not in the `paths:` filter (a push
touching only it rebuilds nothing), and the 60-minute timeout is thin once each
leg installs a 223 MB closure that no cache currently holds.

### G8 â€” release hygiene

The whole distribution feature is **untracked** (`git status`: `.github/`,
`distribute.bat`, `distribute.sh`, `docs/DISTRIBUTE.md`, `scripts/dist.ps1`,
`scripts/dist.sh`, `scripts/dist-manifest.txt`,
`scripts/checks/check-dist-layout.mjs`), on `main` at `origin`
`https://github.com/vecnode/vn-harness.git`. Nothing CI-related has ever run.
Code signing, notarization, `.msi`/`.dmg`/`.deb` and a `.app` bundle stay
deliberately out of scope (`bundle.active: false`) â€” that is a decision to
revisit, not an oversight to fix here.

---

## 3. The two questions, answered

### 3.1 Should the distribution ship a Node engine?

**Yes â€” as rung 2 of the ladder, not as the first move.** The argument is about
what the folder *promises*:

- today the folder promises "a launcher for an app you must already have
  installed" â€” three prerequisites (Node, npm/npx, pnpm) to satisfy before the app
  runs at all;
- with a vendored runtime it promises "run me" â€” which is what the built
  `vn-harness.exe` already looks like to the person who double-clicks it.

Costs, measured, all six targets:

| RID | official Node 22.20.0 archive | size |
|---|---|---|
| `win-x64` | `node-v22.20.0-win-x64.zip` | 36 MB |
| `win-arm64` | `node-v22.20.0-win-arm64.zip` | 31 MB |
| `mac-x64` | `node-v22.20.0-darwin-x64.tar.xz` | 27 MB |
| `mac-arm64` | `node-v22.20.0-darwin-arm64.tar.xz` | 26 MB |
| `linux-x64` | `node-v22.20.0-linux-x64.tar.xz` | 31 MB |
| `linux-arm64` | `node-v22.20.0-linux-arm64.tar.xz` | 30 MB |

Rules that keep this honest:

- **Only `node` is shipped.** `npm`, `npx` and `corepack` are not needed at
  runtime once the harness is vendored (Â§4), and dropping them saves the bulk of
  the launcher scripts and a few MB.
- **Verify the download.** The official `SHASUMS256.txt` is the source of truth;
  the build fails on a mismatch rather than shipping an unverified binary.
- **Never shadow the user's Node on PATH.** The launcher runs the vendored
  interpreter by absolute path, and only falls back to `node` on PATH when
  `runtime/node/` is absent (which is the source checkout case â€” Â§8).
- **Say what it is.** `DIST-README.txt` and `BUILD-INFO.json` record the exact
  Node version and its checksum, so a reader can audit the runtime they are
  running.

### 3.2 Should the app carry the pinned dsh code inside itself?

**Yes, and the harness is already built for exactly this.** `INSTALL_ANCHOR` is
relative to the dsh package (Â§2 G1), so *wherever `@deepseek-ai/dsh` is run from
is the installation*: put the closure in the distribution folder, run the CLI from
there, and `healProfilesModuleFallback` links the profile into **your folder**
instead of the npm cache. No harness change, no patching, no core file touched â€”
the same rule the pack already holds everywhere else.

What "vendoring dsh" concretely means, measured:

| | |
|---|---|
| the tree | `runtime/dsh/node_modules/{@deepseek-ai/dsh, â€¦}` plus the rest of the closure |
| size (Windows x64) | **223 MB / ~25 400 files** |
| produced by | `npm install --prefix runtime/dsh @deepseek-ai/dsh@<pin> --omit=dev --no-audit --no-fund`, run **on each OS in CI** â€” not copied between them |
| why per-OS | the closure contains native modules: `node-pty` (26.8 MB, the terminal dock), `sharp` + `@img/sharp-win32-x64` (28.0 MB), `koffi` (1.6 MB). A win-x64 tree cannot serve a mac-arm64 machine |

Three traps worth writing down before starting:

1. **Native modules must be built/fetched on the target OS.** `npm install` on the
   runner does the right thing; a tree copied from another OS does not.
2. **Do not prune by guess.** The large members are `@deepseek-ai/*` (32.7 MB),
   `@img` (27.3 MB), `node-pty` (26.8 MB), `@opentelemetry` (20.3 MB),
   `@google`/`openai`/`@anthropic-ai`/`@octokit` (8â€“14 MB each). Some are optional
   in principle (telemetry) and some are load-bearing (the terminal's PTY), and
   the only safe way to shrink the tree is to remove one thing, run `-Verify`, and
   keep the change only if the boot and the profile are still green.
3. **`node_modules/.bin` shims and `package.json` `bin` entries point at the CLI.**
   Run `node runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js â€¦` explicitly â€”
   do not rely on a shebang or a `.cmd` shim surviving the copy.

The payoff is large and immediate: the folder becomes the installation, the
profile's junctions point inside it, and **the whole app becomes relocatable** â€”
which is the property `DIST-README.txt` already claims ("this folder must stay
where it is") and the one `PATHS.md` Â§5 turns into a rule.

---

## 4. The self-containment ladder

Each rung is independently useful and independently verifiable, so they can ship
one at a time. Sizes are the folder on disk; the archive figure is an estimate
from the current 27.4 MB â†’ ~7 MB ratio.

| Rung | What changes | Folder | Archive | Host needs | Network to install |
|---|---|---|---|---|---|
| **L0** today | â€” | 27.4 MB | ~7 MB | Node 22+, npm/npx, pnpm | yes (npx + pnpm bootstrap) |
| **L1** | vendor the dsh closure into `runtime/dsh/`; launchers run it by absolute path, `npx` only as the source-checkout fallback | ~250 MB | ~70â€“80 MB | Node 22+ | **no** |
| **L2** | vendor the Node runtime into `runtime/node/` (per RID, checksum-verified, npm/npx/corepack trimmed) | ~350 MB | ~100â€“115 MB | **nothing** | no |
| **L3** | vendor pnpm into `runtime/pnpm/`, point the installer at it, keep the store inside `$DSH_HOME` and run the profile install `--offline` | ~365 MB | ~105â€“120 MB | nothing | **no â€” the model is the only thing that talks to the internet** |

The ladder is ordered so that the *goal* (L3) is reached by two changes that each
pay for themselves, and so the expensive one (the 223 MB closure) lands first
because it removes the worst fragility (G1) rather than the loudest symptom (G3).

### The gate at each rung

`-Verify` grows an **offline mode**, and it is the single most valuable new piece
of machinery in this plan:

```sh
sh scripts/dist.sh -Verify -Offline          # macOS / Linux
distribute.bat -Verify -Offline              # Windows
```

`-Offline` runs the whole existing verify â€” copy the folder, install from the
copy into a throwaway home, boot the pinned harness, read the ready line â€” with
the network closed on purpose:

- `npm_config_registry=http://127.0.0.1:9/` and `npm_config_offline=true` in the
  child environment, so any attempt to fetch fails loudly instead of silently
  succeeding on a runner that happens to have internet;
- `HOME`/`USERPROFILE` pointed at a scratch directory for the npm and pnpm caches,
  so a warm developer cache cannot hide a network dependency;
- a tracked grep that the launch path contains **no `npx`** invocation when
  `runtime/dsh` exists.

At L0 that gate fails by design; at L1 it passes for the harness; at L2 it passes
with `node` removed from `PATH`; at L3 it passes with the network closed from the
first byte to the ready line. That is a test that can only pass for the right
reason, which is the point.

---

## 5. The launcher contract

The five Windows entry points should behave like the install files of a serious
program, and behave the *same* way â€” that sameness is what makes them learnable.
The POSIX halves (`*.sh`) mirror the behaviour, never the mechanism: plain
`/bin/sh`, no PowerShell, ever.

### Files, and what each one is for

| File | Host | Role |
|---|---|---|
| `install.bat` / `install.sh` | both | add this folder's bundles to the web profile; no admin, ever |
| `uninstall.bat` / `uninstall.sh` | both | remove only what this pack added |
| `run-web.bat` / `run-web.sh` | both | start the pinned harness and open it in Chrome (default browser as fallback) |
| `run-desktop.bat` | Windows | the same harness in the native window (`vn-harness.exe`) |
| `distribute.bat` / `distribute.sh` | both | maintainer only â€” build/assemble/verify a distribution; not shipped |
| `START-HERE.bat` / `START-HERE.sh` | generated | install, then run â€” the one file a recipient double-clicks |

> **Naming — DECIDED, and done.** The browser launcher is now `run-web.bat` /
> `run-web.sh`: clearer beside `run-desktop.bat`, and it matches the flag split
> already in the code (`scripts/run-web.ps1`). The rename was taken all the way,
> with **no `run.bat` forwarder** — so `AGENTS.md`'s rule that the root entry
> point sits beside its twin now names `run-web.bat`.

### The adaptive rules (Windows `.bat`)

1. **The console it opens in.** If the process is not already inside Windows
   Terminal (`WT_SESSION` unset) and `wt.exe` resolves, re-launch itself inside
   it â€” `wt.exe -w 0 nt --title "vn-harness" cmd /c ""%~f0" %*` â€” with a marker
   variable set so the child does not recurse, then `exit /b` **without** pausing
   (the new window owns the output). Otherwise continue in `conhost`. On Windows
   11 with Terminal as the default terminal application this is a no-op; on a
   machine where it is not, it is the difference between a 1995 install and a
   current one.
2. **The shell it runs the worker with.** Prefer `pwsh.exe` (PowerShell 7) and
   fall back to `powershell.exe` (5.1). The workers keep the `Get-ToolPath` /
   `Get-ToolNames` / `$PSVersionTable` discipline they already have, so no
   unguarded `$IsWindows` and no hardcoded `npx.cmd`.
3. **Encoding.** `chcp 65001 >nul` in the batch half; `[Console]::OutputEncoding`
   and `$OutputEncoding` to UTF-8 in the worker. A path with an accent, a Chinese
   username or a `â†’` in a message is then not mojibake.
4. **Colour only where it exists.** Emit ANSI only when the console reports virtual
   terminal support (`$Host.UI.SupportsVirtualTerminal`, `WT_SESSION`, `TERM`),
   honour `NO_COLOR`, and emit none at all when stdout is redirected. Status
   lines keep the existing `[vn-harness]` prefix so a piped log is still readable.
5. **`pause` only when the window would vanish.** Pause on failure when the file
   was double-clicked (stdin is a console and the parent is Explorer); never with
   `-NoPause` / `-Quiet`, never when stdin is not a terminal, and never after a
   Ctrl+C (the current `run-web.bat` already gets this right by keying on exit code
   1 â€” keep that trick, it is the correct one).
6. **No elevation.** The install is per-user. Say so once, in the banner. If the
   user happens to be elevated, note it and carry on â€” never ask for admin.
7. **Flags, uniformly.** `-Help`, `--help`, `-h`, `/?` all print the same help in
   every file (today `run-desktop.bat` handles more spellings than the others);
   add `-Quiet` and `-NoPause` everywhere, and `-NoBuild` to `run-desktop.bat`.
8. **One exit-code vocabulary**, documented in each help and in `DIST-README.txt`:
   `0` success, `1` own failure/usage, `2` preflight (a required tool is missing),
   `3` install failure, `4` verify failure. A caller can then tell "you used a bad
   flag" from "your machine is missing something".
9. **One implementation of the above.** Batch has no `include`, but it has `call`:
   `scripts/console/adapt.cmd` holds the console/shell decisions and
   `scripts/console/theme.ps1` the colour/width ones, dot-sourced by the workers.
   The five entry files stay thin forwarders, and `check-dist-layout.mjs` pins the
   parity â€” five copies of a 15-line header is exactly how launchers drift.
10. **`run-desktop.bat` finally ships**, and it does the *right* thing in a
    distribution: when `vn-harness.exe` is present and `app/src-tauri/target/`
    (or a Rust toolchain) is not, it runs the binary directly â€” no cargo, no
    build, no error. In a source checkout it builds as it does today.
11. **macOS double-click parity (optional).** Finder does not run `.sh`. If
    double-click parity is wanted on macOS, ship `START-HERE.command` and
    `install.command` next to the `.sh` files â€” same scripts, Finder-run wrapper.
    Listed as an open decision in Â§10.

---

## 6. The state map

[`PATHS.md`](PATHS.md) is the map, and it states the rule this plan implements:

> A distribution must be movable, and the only directory it may depend on outside
> itself is the harness home.

What each rung changes on that map:

| Rung | Map change |
|---|---|
| L0 | three runtime locations outside the home: the npm/npx cache (into which every profile junction points), the pnpm store, `<folder>/tools/pnpm<N>` |
| L1 | the npm cache **leaves the map**: `profiles/node_modules` junctions point into `<folder>/runtime/dsh/â€¦` |
| L2 | host Node leaves the map; `runtime/node/` is added, and the launcher resolves `runtime/node` â†’ PATH |
| L3 | the pnpm store and the `./tools` bootstrap leave the map; the store moves inside the home (`$DSH_HOME/.pnpm-store`, pinned by the installer rather than inherited from the OS default) so the *only* writable location the app owns stays the home |

After L3 the map reads: **`$DSH_HOME` (all state, all caches, all profiles) plus
the distribution folder (code and runtime), plus the Desktop for exports.** That
is the state the page should be edited to describe, and each rung's PR updates it
in the same commit â€” the map is only "well defined" while it is current.

---

## 7. CI on the three operating systems

One workflow, one matrix, the same two scripts the developer runs. Three changes
to what exists.

### 7.1 The matrix (G7)

| rid | runner | note |
|---|---|---|
| `win-x64` | `windows-2022` | Server 2025 (`windows-latest`) also works; 2022 keeps the Tauri/WebView2 story boring |
| `win-arm64` | `windows-11-arm` | new: WASM/ARM desktop has no distribution today |
| `mac-x64` | `macos-15-intel` | **replaces the retired `macos-13`** |
| `mac-arm64` | `macos-15` | replaces the deprecated `macos-14` |
| `linux-x64` | `ubuntu-22.04` | the oldest glibc, on purpose â€” keep |
| `linux-arm64` | `ubuntu-22.04-arm` | new |

Note that `check-dist-layout.mjs` currently *requires* the retired labels â€”
it fails when `macos-13` or `macos-14` is absent from the workflow â€” so the check
and the matrix have to move in the same commit, which is exactly the property that
made the check worth writing.

`fail-fast: false` stays. Recommended staging: keep the four existing rids
required, and let the two ARM64 legs start as `continue-on-error` targets so a
toolchain surprise on a preview image cannot block a release â€” then promote them
once they have been green twice.

### 7.2 Caching, and the new timeout math

Each leg now installs a 223 MB closure and downloads a 26â€“36 MB Node archive.
Without caching, L2 costs ~4â€“8 minutes of pure download per leg.

- cache `runtime/dsh` keyed on `<OS>-<rid>-<dsh pin>`; cache the downloaded Node
  archive keyed on `<rid>-<node version>` (the archive, not the extracted tree);
- `Swatinem/rust-cache` for `app/src-tauri` stays as it is;
- raise `timeout-minutes` to 90 for the build job â€” a cold macOS Intel leg
  compiling Tauri *and* populating a 25 000-file tree is not a 60-minute job.

### 7.3 The checks job grows the new invariants

`check-dist-layout.mjs` already guards the ship list, the two halves' flags and
sentinels, and `dist/` being ignored. It should also assert:

- the workflow's runner labels are ones that exist (the `macos-13` failure would
  have been caught here rather than on `main`);
- `run-desktop.bat` and the console helpers are in `dist-manifest.txt`, and every
  shipped entry point appears in the workflow's `paths:` filter;
- the launch path contains no `npx` **when `runtime/dsh` exists**, and
  `dist-manifest.txt` carries `runtime/dsh`, `runtime/node` and `runtime/pnpm` at
  the rungs where they exist;
- the vendored Node's `SHASUMS256.txt` line is recorded in `BUILD-INFO.json`.

### 7.4 Triggers and release

Unchanged in shape, extended in reach: `workflow_dispatch` (with the `-Offline`
input), `push` to `main` on the shipping paths, and `release: published` with the
tag-equals-`package.json`-version guard. Two additions worth making:

- the release job attaches a per-OS `SHA256SUMS.txt` and records the Node version
  and checksum it shipped, so a recipient can audit the runtime they run;
- an **`smoke` job on `windows-2022` and `macos-15`** that runs the *launcher*
  (`START-HERE` with a throwaway home and a browser suppressed) for ten seconds
  and asserts the app answered on its port. `-Verify` boots the harness but not
  the launcher, which is the part a person actually touches.

### 7.5 What CI still cannot do

An unsigned Windows binary and an unquarantined macOS binary behave differently
on a runner than on a desktop: SmartScreen and Gatekeeper do not fire for a
headless run. The first-launch experience stays a manual check on a real machine
(recorded in `DISTRIBUTE.md` Â§5), and signing/notarization stays the deliberate
next step it is.

---

## 8. Keeping the Windows development loop exactly as it is

The rule that makes this safe:

> **`runtime/` is a distribution tree, never a repository tree.**

`runtime/dsh`, `runtime/node` and `runtime/pnpm` are produced by the distributer
into `dist/`, are gitignored, and never appear in a clone. Every launcher
therefore resolves in this order:

| Need | First | Fallback |
|---|---|---|
| the interpreter | `<root>/runtime/node/node[.exe]` | `node` on PATH |
| the harness | `<root>/runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js` | `npx --yes @deepseek-ai/dsh@<pin>` |
| pnpm | `<root>/runtime/pnpm/â€¦` | `pnpm` on PATH, else the `./tools` bootstrap |

In the repository, `runtime/` is absent, so every fallback is taken and the loop
is byte-for-byte what it is today:

- `npx @deepseek-ai/dsh@<pin> web` serves the pack, and the packages are live
  links, so an edit to a `client.js` is already "installed";
- `install.bat` / `run-web.bat` / `run-desktop.bat` behave as they do now, including
  `-Force`, the `-SkipBuild` fast path and the cargo freshness cache;
- `distribute.bat -Verify` remains the one command that proves a change end to end;
- optional host engines (TeX, poppler/mutool/Ghostscript, tesseract) stay optional
  and keep degrading in a sentence;
- nothing in `packages/` learns that a distribution exists.

The only visible change in the repository is the launchers' console behaviour
(Â§5) â€” which is improvement, not a new workflow.

---

## 9. The ordered work plan

Each step lands on its own, with its own proof. Steps 1â€“2 need no architectural
decision; step 3 is the big one.

| # | Work | Proof |
|---|---|---|
| 1 | **Fix the matrix** (`macos-13` â†’ `macos-15-intel`, `macos-14` â†’ `macos-15`), add `run-desktop.bat` to the `paths:` filter, raise the timeout, teach `check-dist-layout.mjs` to validate runner labels | `node scripts/checks/check-dist-layout.mjs`; a `workflow_dispatch` run that goes green on four legs |
| 2 | **The launcher contract** (Â§5): `scripts/console/adapt.cmd` + `theme.ps1`, rewrite the five entry points, ship `run-desktop.bat`, add `-Quiet` / `-NoPause`, unify help and exit codes, keep the POSIX halves PowerShell-free | a new tracked check for parity + flag coverage; a manual double-click pass on Windows (Terminal present and absent) |
| 3 | **L1 â€” vendor the harness**: `runtime/dsh` built per OS in CI, launchers resolve it first, manifest carries it, `-Verify -Offline` gate added | `distribute.bat -Verify -Offline` green, and `profiles/node_modules` junctions visibly pointing inside the folder |
| 4 | **L2 â€” vendor the Node runtime** per RID, checksum-verified against the official `SHASUMS256.txt`, npm/npx/corepack trimmed, `BUILD-INFO.json` records version + hash | `-Verify -Offline` green with `node` removed from `PATH` |
| 5 | **L3 â€” vendor pnpm**, point the installer at it, pin the store inside `$DSH_HOME`, run the profile install `--offline` | `-Verify -Offline` green from a cold scratch home with the registry pointed at a dead address |
| 6 | **Shrink the closure** â€” measure, prune one package at a time (telemetry first), keep only what `-Verify` still passes with | size reported per run; the verify is the only acceptance test |
| 7 | **Docs sweep**: `PATHS.md` (Â§6 table), `DISTRIBUTE.md` (requirements, sizes, the ladder), `README.md`, `AGENTS.md` (the launcher/Naming decision, the `runtime/` rule) | `node scripts/checks/check-dist-layout.mjs` + a read-through |
| 8 | **First release**: commit the feature, tag == `package.json` version, `gh release create`, six archives + checksums attached | the release page, and the per-OS smoke job green |

Step 3 is where the folder stops being a launcher-with-prerequisites and becomes
the application; steps 4â€“5 are what make it run on a machine with nothing
installed at all.

---

## 10. Decisions and what is left

**Decided and delivered (steps 1–2):**

1. **The rename — done.** `run-web.bat` / `run-web.sh`, taken fully, no forwarder.
   Every mention across the repo moved with it, and `AGENTS.md` now records it.
2. **The ladder target — L2.** Vendor the harness closure *and* a Node runtime, so
   a bare machine can run the folder with no prerequisites at all (~100–115 MB
   zipped). L3 (offline pnpm) follows as its own step.
3. **ARM64 legs — staged.** `windows-11-arm` and `ubuntu-22.04-arm` are in the
   matrix, marked `experimental` and `continue-on-error`, so a preview-image or
   Tauri-on-ARM surprise cannot block a release. Promotion is deleting one line
   per leg once it has been green twice.

Delivered in this change, with the tracked check extended to pin it: the corrected
runner matrix, `run-desktop.bat` in the ship list, the shared console layer
(`scripts/console/adapt.cmd` + `theme.ps1` + `theme.sh`), all five Windows entry
points and all four POSIX ones on it, `-NoPause` / `-NoTerminal` / four help
spellings everywhere, the generated `START-HERE` and `DIST-README` updated, and
the distributer explicitly excluded from its own output.

**Deferred, with the reason:**

4. **`-Quiet`.** Dropped from this step on purpose: doing it properly means
   auditing every `Write-Host` and `Out-Host` in four workers plus the Rust shell's
   own echo, and a half-working quiet mode is worse than none. `-NoPause` covers
   the scripting need; `-Quiet` is its own step.
5. **The POSIX workers' internal messages** still print with plain `printf`
   rather than the `theme.sh` writers the entry points use. Behaviour parity
   (flags, help, exit codes, no PowerShell) is complete; colour parity inside
   `install-all.sh` / `uninstall-all.sh` / `run-web.sh` / `dist.sh` is polish that
   can be adopted incrementally, because `theme.sh` is already sourced where it
   matters.

**Still open:**

6. **macOS double-click.** Add `.command` wrappers so Finder can run the
   entry points, or document `chmod +x` / `./START-HERE.sh` as the path?
7. **Signing.** Stay unsigned (documented, SmartScreen/Gatekeeper warnings
   accepted), or turn on `bundle.active` and take on the icon ladder, signing
   identities and notarization as a separate project?
8. **One portable archive?** Today each RID ships only its own half of
   `START-HERE` (a Windows build has no `START-HERE.sh` — deliberate, and
   verified). A single "anywhere" zip would have to carry both halves *and* both
   runtimes, which is a different product.
9. **Windows Terminal always, or only sometimes?** The relaunch is a no-op on a
   stock Windows 11 and the real fix on Windows 10. If a machine has Terminal
   installed but the user deliberately chose the legacy console as their default
   terminal application, this overrides that choice — `-NoTerminal` and
   `VN_HARNESS_NO_WT=1` are the escape, but respecting the OS default instead is a
   defensible alternative.
