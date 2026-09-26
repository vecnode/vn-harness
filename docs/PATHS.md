# Where vn-harness keeps things

This page is the **map**: every location the app reads, writes or links to, on
Windows, macOS and Linux. It exists because a distribution is a *folder you
move*, and a folder can only be moved safely if what it depends on is known.

Two facts make the map much smaller than it looks:

1. **The app owns exactly one directory.** The harness keeps *all* user data
   under a single root, and that root has the same shape on all three
   operating systems: `homedir()/.dsh`. There is no XDG split, no
   `%APPDATA%`/`%LOCALAPPDATA%` split and no per-OS layout to remember.
2. **What is *not* in that directory is the problem.** Today the app's
   *runtime* â€” the harness itself, the packages it resolves, the pnpm that
   drives the profile â€” lives in the npm/npx cache and the pnpm store, both
   outside the home and outside the distribution folder. Â§3 lists those, and
   Â§5 states the rule that removes them.

Everything below was read from the harness's own source or measured on this
machine (Node 22.20.0, Windows 11); the source locations are named so a reader
can re-verify after a pin bump.

---

## 1. The one root: the harness home

Resolved by `@deepseek-ai/dsh-home-paths` (`resolveDshHome`), highest
precedence first:

| Precedence | Source | Windows | macOS / Linux |
|---|---|---|---|
| 1 | an explicit configured path (CLI `-DshHome`, desktop shell `-DshHome`) | as given | as given |
| 2 | `$DSH_HOME` (empty/whitespace counts as unset) | as given | as given |
| 3 | the default | `%USERPROFILE%\.dsh` | `$HOME/.dsh` |

`homedir()` is Node's, so the Windows half is `%USERPROFILE%` and never
`%APPDATA%`. `~` and `~/`/`~\` prefixes in a configured path are expanded
against that same home. **Nothing in the harness ever writes outside this
root** â€” with the three exceptions in Â§3.

### What lives under it

| Path (relative to the home) | What it is | Written by |
|---|---|---|
| `sessions/` | one file per conversation (the durable transcript) | `dsh-session-persistence-jsonl` |
| `storages/` | `workspace.json`, `session_projcache*` â€” host-side UI/workspace state | `dsh-storage-json`, host plugins |
| `settings.yaml` | every settings namespace, this pack's `vn-harness` section included (page zoom, theme, dock height, column widths) | `dsh-settings-file`, `dsh-ui-state` |
| `.credentials.yaml` | the model API key | `dsh-credentials-local` |
| `.anonymous-user-id` | one random id, created on first run | `dsh-anonymous-user-id` |
| `attachments/v1/files/â€¦` | files pasted/attached into a conversation | `dsh-attachment-local` |
| `skills/` | the pack's copied skills (`mermaid-diagrams`, `tikz-diagrams`, `pdf-analysis`), each under a `.vn-harness-<package>` marker | both installers |
| `profiles/<name>/` | the profile: `package.json`, `cordis.yml`, `cordis.patch.yml`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `node_modules/`, `.dsh-module-fallback/` | `dsh-app-boot`, pnpm, the installers |
| `profiles/node_modules/` | **junctions/symlinks into the installation** â€” see Â§2 | `healProfilesModuleFallback`, at every boot |
| `dsh-pdf/artifacts/<sha256>/â€¦` | PDF parse cache: `index.json`, `stats.json`, `pages/`, `ocr/`, `images/` | `dsh-pdf` |
| `dsh-diagrams/sessions/<session>.json`, `library.json`, `artifacts/â€¦` | diagram state and the shared library | `dsh-diagrams` |
| `vn-harness/window.json` | the desktop window's size/position (`{version,width,height,x,y,maximized}`) | the Rust shell (`app/src-tauri/src/windowstate.rs`) |

The last three are this pack's own, and they follow the harness's rule rather
than inventing one: a plugin's state goes under the harness home and nowhere
else. `dsh-pdf` and `dsh-diagrams` each keep a **content-addressed cache** under
it (LRU-capped at 512 MiB and 200 MiB) â€” so the home grows with use, and that
growth is bounded by design, not by luck.

### The profile is mostly links

`$DSH_HOME/profiles/web/node_modules` holds **two** kinds of entry:

- the pack's own bundles, as `link:` junctions into `packages/` (the
  distribution folder). Measured: `dsh-audio`, `dsh-editor`, â€¦ `dsh-vn-master`,
  15 of them;
- `.pnpm/`, which holds **only** `lock.yaml` â€” the profile has no
  registry-installed tree of its own.

`pnpm-lock.yaml` confirms it: every entry is a `link:` spec, with **no registry
resolution anywhere**. The base bundles (`@deepseek-ai/dsh-base`,
`@deepseek-ai/dsh-web-app`) are listed in `dsh.profile.bundles` but are *not*
installed into the profile â€” they resolve through the installation fallback
(Â§2). This is the single most useful fact on this page for the offline goal:
**a profile install needs no registry at all**, only the installation closure
and a pnpm to write the links.

---

## 2. The installation: what the profile actually resolves against

`$DSH_HOME/profiles/node_modules/` is not a second copy of the world. Each entry
is a **junction** (Windows) or symlink (macOS/Linux) into the *installation*.
Measured on this machine:

```text
$DSH_HOME/profiles/node_modules/zod
    -> C:\Users\â€¦\AppData\Local\npm-cache\_npx\1da1392061ab1944\node_modules\zod
```

So the running application is: **the npm cache tree** (the installation) plus a
tiny profile that holds patch files and `link:` junctions to `packages/`.

The harness builds that link set itself, at every boot, from an anchor that is
**relative to its own location**:

```js
// node_modules/@deepseek-ai/dsh/lib/profile-boot-*.js
const INSTALL_ANCHOR = fileURLToPath(new URL("../package.json", import.meta.url));
```

`healProfilesModuleFallback({ installAnchor })` (`@deepseek-ai/dsh-app-boot`)
walks that manifest's dependency closure, links every package it finds, and
re-links anything that has drifted. It compares each existing entry against its
resolved target and *rewrites* what does not match, so a stale or dangling set
heals on the next boot â€” and it takes a cross-process lock while doing it.

Two consequences that matter here:

- **The installation is relocatable.** Wherever `@deepseek-ai/dsh` is run from
  *is* the installation; the junctions follow it. Vendoring the harness into the
  distribution folder therefore makes the folder the installation, with no
  harness change required. (The harness also has a second mode â€”
  `isPackagedExecutable()` writes ESM proxies instead of symlinks, for
  filesystems that cannot carry links. The distribution uses the symlink mode.)
- **Today that anchor points into the npm cache.** Delete or prune the cache
  (`npm cache clean --force`, a cache eviction, a different `npm_config_cache`)
  and every junction in `profiles/node_modules` dangles, which is a broken app
  with an intact-looking home. That is the concrete fragility Â§4 of the plan
  removes.

---

## 3. Outside the home: the three leaks

Everything the app needs at *runtime* should be in the home or the distribution
folder. Today three things are not.

| Location | Windows | macOS / Linux | Why it is there | Leak |
|---|---|---|---|---|
| **npm / npx cache** | `%LOCALAPPDATA%\npm-cache\_npx\<hash>` | `~/.npm/_npx/<hash>` | `npx @deepseek-ai/dsh@<pin>` unpacks the whole installation (measured: **223 MB, ~25 400 files**) here on first run | The profile's junctions point into it (Â§2). It is also outside the folder, so a distribution is not self-contained, and the first run needs the network. |
| **pnpm store** | `%LOCALAPPDATA%\pnpm\store\v3` | macOS `~/Library/pnpm/store`, Linux `~/.local/share/pnpm/store` (`$PNPM_HOME/store`, else `$XDG_DATA_HOME/pnpm/store`, win over these) | the store pnpm verified the profile against â€” the profile's own path is recorded in `profiles/web/node_modules/.modules.yaml` (`storeDir`) | Only needed to *install*; but the installer reads it, and the OS default differs, so a shipped store must pin `store-dir` itself. |
| **pnpm itself** | `<repo>/tools/pnpm<N>/` | same | `install-all.ps1`/`.sh` bootstrap pnpm with `npm install --prefix ./tools pnpm@<major>` (measured: 13 MB) because `dsh plugin add` is a thin forwarder to `pnpm` **on PATH** | Needs the network *and* npm on a machine that has neither yet. |

Two things are outside the home on purpose and are not leaks, but belong on the
map because "where did my file go" is the same question:

| Location | Resolution | Used by |
|---|---|---|
| **Desktop** | per request: `%USERPROFILE%\Desktop`, a OneDrive-redirected Desktop, `$XDG_DESKTOP_DIR`, the home folder last | `dsh-themes` screenshot route, `dsh-diagrams` export |
| **Temp / scratch** | `os.tmpdir()`; the distributer uses a private temp dir under it, and `dsh-pdf` rasterizes into one | `-Verify`, `pdf_render`, TikZ compiles |
| **Chrome** (browser launcher only) | `Chrome` on `PATH` â†’ the standard install folders â†’ the `App Paths` registry entry; `open -a "Google Chrome"`; `google-chrome` / `chromium`; the platform default last | `run-web.sh` / `scripts/run-web.ps1` |

`dsh-terminal` resolves a shell per host (`pwsh.exe` else `powershell.exe`;
`$SHELL` else `/bin/zsh` else `/bin/bash`) and inherits its cwd, and the editor,
git tree and terminal all resolve the **workspace folder** out of the session â€”
those are user paths, read not owned, so they are not on this map.

---

## 4. The per-OS table, in one place

| | Windows | macOS | Linux |
|---|---|---|---|
| user home (`homedir()`) | `%USERPROFILE%` | `$HOME` | `$HOME` |
| default harness home | `%USERPROFILE%\.dsh` | `$HOME/.dsh` | `$HOME/.dsh` |
| override | `DSH_HOME`, `-DshHome` | same | same |
| npm cache root | `%LOCALAPPDATA%\npm-cache` | `~/.npm` | `~/.npm` |
| pnpm store root | `%LOCALAPPDATA%\pnpm\store` | `~/Library/pnpm/store` | `~/.local/share/pnpm/store` |
| link kind for a junction | directory junction | symlink | symlink |
| webview runtime | WebView2 (present on Win 10/11) | WKWebView (system) | WebKitGTK 4.1 (a package) |

---

## 5. The rule this page exists to state

> **A distribution must be movable, and the only directory it may depend on
> outside itself is the harness home.**

Concretely, that means every one of these must hold, and `check-dist-layout.mjs`
is where they get pinned:

1. the **harness** runs from inside the folder, so `INSTALL_ANCHOR` â€” and with it
   every junction in `profiles/node_modules` â€” resolves inside the folder;
2. the **Node runtime** the harness runs on is inside the folder, so no host
   Node is required and no host npm/npx cache is touched;
3. the **pnpm** that writes the profile links is inside the folder, so the
   `./tools` npm bootstrap disappears;
4. **no step reaches the network except a model call** â€” the pinned harness, its
   whole dependency closure, pnpm and Node are all in the folder;
5. the home stays the only *writable* location the app owns, so moving the
   folder to another path and re-running the installer is always enough.

Â§3's first three rows are exactly what stands between the current build and that
rule. `docs/DEPLOY.md` is the plan for closing them, and its ladder is ordered so
that each rung is independently useful.
