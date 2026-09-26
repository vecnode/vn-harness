# ðŸ¤– vn-harness

![Language: JavaScript](https://img.shields.io/badge/language-JavaScript-f7df1e?logo=javascript&logoColor=black)
![Language: Rust](https://img.shields.io/badge/language-Rust-000000?logo=rust&logoColor=white)    
![License: MIT](https://img.shields.io/badge/license-MIT-blue)
![DeepSeek Harness 0.1.5-rc.1](https://img.shields.io/badge/dsh-0.1.5--rc.1-4f8cff)
![Platforms: Windows | macOS | Linux](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey)

Agent Application with core [DSH](https://www.deepseek.com/harness/en/).

Native cross-platform app and standard **dsh bundles**. The plugins are
plain JavaScript, and the launchers run on **Windows, macOS and Linux** â€” the
Windows half is PowerShell, the macOS/Linux half is plain POSIX shell.

![print](assets/vn-harness-20260920-164101.png)

<p align="center">
  <img src="assets/vn-harness 26_09_2026 09_53_53.png" alt="The vn-harness desktop window while the pinned harness starts: a dark splash showing the mark, the name and a &quot;Starting the harnessâ€¦&quot; line" width="49%">
  <img src="assets/vn-harness-20260925-084844.png" alt="The same window once the harness is up, showing the pack's app in the light theme" width="49%">
  <br>
  <em><code>run-desktop.bat</code>: the shell's splash while <code>npx</code> works, and the same window once the harness is listening.</em>
</p>

## Plugins (all **alpha**)

Each package's own README is the reference for what it does, why it is built that
way and what it touches; the table below is the map.

| Package | What it does | Status |
|---|---|---|
| [`dsh-vn-master`](packages/dsh-vn-master/README.md) | [`README.md`](packages/dsh-vn-master/README.md) | alpha `0.1.0-alpha.1` |
| [`dsh-rightbar`](packages/dsh-rightbar/README.md) | [`README.md`](packages/dsh-rightbar/README.md) | alpha `0.1.0-alpha.2` |
| [`dsh-rightbar-files`](packages/dsh-rightbar-files/README.md) | [`README.md`](packages/dsh-rightbar-files/README.md) | alpha `0.1.0-alpha.1` |
| [`dsh-editor`](packages/dsh-editor/README.md) | [`README.md`](packages/dsh-editor/README.md) | alpha `0.1.0-alpha.13` |
| [`dsh-gittree`](packages/dsh-gittree/README.md) | [`README.md`](packages/dsh-gittree/README.md) | alpha `0.1.0-alpha.4` |
| [`dsh-image`](packages/dsh-image/README.md) | [`README.md`](packages/dsh-image/README.md) | alpha `0.1.0-alpha.1` |
| [`dsh-audio`](packages/dsh-audio/README.md) | [`README.md`](packages/dsh-audio/README.md) | alpha `0.1.0-alpha.2` |
| [`dsh-diagrams`](packages/dsh-diagrams/README.md) | [`README.md`](packages/dsh-diagrams/README.md) | alpha `0.1.0-alpha.6` |
| [`dsh-pdf`](packages/dsh-pdf/README.md) | [`README.md`](packages/dsh-pdf/README.md) | alpha `0.1.0-alpha.3` |
| [`dsh-terminal`](packages/dsh-terminal/README.md) | [`README.md`](packages/dsh-terminal/README.md) | alpha `0.1.0-alpha.9` |
| [`dsh-themes`](packages/dsh-themes/README.md) | [`README.md`](packages/dsh-themes/README.md) | alpha `0.1.0-alpha.19` |
| [`dsh-ui-state`](packages/dsh-ui-state/README.md) | [`README.md`](packages/dsh-ui-state/README.md) | alpha `0.1.0-alpha.1` |
| [`dsh-modal`](packages/dsh-modal/README.md) | [`README.md`](packages/dsh-modal/README.md) | alpha `0.1.0-alpha.1` |
| [`dsh-open-in-app`](packages/dsh-open-in-app/README.md) | [`README.md`](packages/dsh-open-in-app/README.md) | alpha `0.1.0-alpha.1` |

> The pack used to ship its own Files panel (`dsh-files`, earlier `dsh-focus`)
> with a private dock and header capsules; that was retired when the harness
> grew a real right Sidebar. Now the pack goes one step further and **owns the
> bar itself** by forking it â€” see `packages/dsh-rightbar/README.md` and the
> `scripts/sync-vendored.ps1` re-sync path. The same fork-and-disable scheme
> owns the **file-manager half of Open Inâ€¦** (`dsh-open-in-app`).
>
> The pack's **master** is a bundle of its own, `dsh-vn-master`, and it is
> deliberately blank: the bundle layer plus one no-op row, with no browser half,
> no service and no inject edge. So the right bar keeps only bar
> responsibilities, and the master â€” installed last â€” is where pack-wide patches
> go.

## Quick start

Three commands take you from a fresh clone to a running app. Everything else in
this repository is documentation.

**What you need:** Node.js 22 or newer, with `npm`/`npx`. That is the whole
requirement. Chrome is optional â€” the launcher falls back to your default
browser. Three features have optional extras: the **History** tab needs `git` on
`PATH`, TikZ diagrams need a TeX engine (`pdflatex`, `xelatex` or `lualatex`),
and **PDF page pictures** (`pdf_render`) need a rasterizer (`pdftoppm` from
poppler, `mutool`, or Ghostscript). Without them, the rest of the pack works
unchanged â€” reading and searching a PDF needs nothing at all, because the pdf.js
engine is vendored inside `dsh-pdf`.

**Windows** uses the `.bat` files, **macOS/Linux** the `.sh` ones â€” and the Unix
side never needs PowerShell.

| Step | Windows | macOS / Linux | What it does |
|---|---|---|---|
| **1. Install** | `install.bat` | `./install.sh` | adds every bundle under `packages/` to the web profile (`~/.dsh/profiles/web`) and copies the bundled skills into `~/.dsh/skills` |
| **2. Run** | `run-web.bat` (double-click) | `./run-web.sh` | starts `npx @deepseek-ai/dsh@<pin> web` and opens the URL it prints â€” token included â€” in **Chrome**, falling back to the default browser |
| **2b. Run (desktop)** | `run-desktop.bat` (double-click) | `cargo build --release` in `app/src-tauri` | the **same** harness in a native window instead of a browser tab: builds the small Rust/Tauri shell under `app/` when it is out of date, then starts the same pinned server on the harness's own default port when it is free (a free one otherwise) and shows it in a WebView2 / WKWebView / WebKitGTK window |
| **3. Remove** | `uninstall.bat` | `./uninstall.sh` | removes the bundles, their patch layers and the skills the installer copied |

```bat
:: Windows - install/uninstall/run are all double-click friendly
install.bat                  :: installs into the web profile (the only target)
run-web.bat                      :: starts the harness and opens it in Chrome
                             :: (the entry point; scripts\run-web.ps1 does the work)
run-desktop.bat              :: the same harness in a NATIVE WINDOW instead of a
                             :: browser tab (cargo builds app\src-tauri first)
uninstall.bat                :: removes the pack
```

```sh
# macOS / Linux - from the repo root
./install.sh                 # the web profile (the only target)
./run-web.sh                     # start the harness and open it in Chrome
./uninstall.sh               # remove the pack
```

The run launcher keeps the harness in the foreground of that terminal, so the
app's own output â€” including the `dsh web: http://127.0.0.1:3080/?token=â€¦`
line â€” stays visible and **Ctrl+C** stops it. Flags pass straight through:

- `-Port 3099` when port 3080 is already taken,
- `-DefaultBrowser` to skip Chrome,
- `-NoBrowser` to start the server without opening a browser at all.

The URL is opened only when it names a loopback address, and the launch token is
never written to a file â€” both rules are explained in [SECURITY.md](SECURITY.md).

**Prefer a window to a tab?** `run-desktop.bat` builds and runs the small
Rust/Tauri shell in [`app/`](app/README.md) and shows the harness in a native
WebView2 / WKWebView / WebKitGTK window. It is the same server, the same pin and
the same profile â€” nothing is bundled and no plugin knows the difference, so the
two launchers are interchangeable. The shell asks for the harness's **own default
port** when nothing holds it â€” the same origin a `run-web.bat` tab opens on, which is
what keeps the window's per-origin client state â€” and falls back to a free
loopback port when something already has it, so it never collides with a `run-web.bat`
server or the Web GUI. It opens its window immediately with a
splash while `npx` works, holds the launch token to the same two rules the
browser launcher does, and kills the harness when the window closes. It needs the
Rust toolchain ([rustup.rs](https://rustup.rs)) in addition to Node.js; the first
build compiles the shell's dependencies and takes a few minutes, after which it
is instant. The same shell compiles on macOS and Linux with
`cargo build --release` in `app/src-tauri`; only the Windows double-click wrapper
is committed so far.

Install flags: `-Force` re-adds bundles even when the versions match.
`-Plugin` / `-DshHome` / `-ProfileName` / `-DshVersion` / `-Target web|cli`
behave as documented in [`docs/INSTALL.md`](docs/INSTALL.md), which also has the
no-script path:

```powershell
:: Windows (direct)
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-all.ps1 -Force
```

```sh
# macOS / Linux (direct)
sh scripts/install-all.sh -Force
```

Both installer halves do the same work, and re-running them is safe:

1. pin the dsh version from `.dsh-version.json` and run everything through
   `npx @deepseek-ai/dsh@<pinned>`,
2. reuse a system pnpm when it is new enough for the profile, else bootstrap a
   private copy under `./tools` (no admin rights, nothing global),
3. resolve the web profile (`$DSH_HOME/profiles/web`, `$DSH_HOME` = env var or
   `~/.dsh`),
4. **prune retired bundle names** (`dsh-focus`, `dsh-files` â€” the pack's own
   Files panel, now shipped by the harness itself) so an upgrade cannot
   double-mount,
5. run `dsh plugin --profile web add <bundle>` for every package under
   `packages/` (bundles already at the repo version are skipped unless `-Force`),
6. **copy the skills a bundle ships** (`packages/<bundle>/skills/<name>/SKILL.md`)
   into `$DSH_HOME/skills`, where the harness' own filesystem skill provider
   reads them. Every folder the installer creates carries a marker file, so a
   person's own skill of the same name is never overwritten and uninstall only
   removes what it wrote,
7. print next steps. Neither half touches API keys â€” add yours in
   **Settings â†’ Models**.

To remove the pack, run **`uninstall.bat`** (Windows) or **`./uninstall.sh`**
(macOS/Linux); both take the same `-Plugin` / `-DshHome` / `-ProfileName`
switches. Removing a bundle also removes its patch layer.

## Security & license

- MIT â€” see [LICENSE](LICENSE). Plugins are authored by **vecnode**.
- Security policy (supported line, private reporting, hardening expectations):
  [SECURITY.md](SECURITY.md). This pack never touches API keys and never patches
  DeepSeek core files: it adds its own rows and (for the right bar) disables the
  shipped rows, then supplies its own copied bundles.
