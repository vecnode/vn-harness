# dsh-open-in-app (alpha.1)

**Open In: file managers.** The DeepSeek Harness web Session header carries an
**"Open In…"** split button (the shipped `@deepseek-ai/dsh-client-ui-open-in-app`
+ `@deepseek-ai/dsh-host-open-in-app` pair) that opens the session's workspace
directory in an installed editor, Git GUI, terminal or file manager. On a host
where the shipped **File Explorer** / **Finder** / **Files** entry does nothing —
the shipped launcher hands the directory to the OS shell's *open verb*
(`Invoke-Item` through `powershell.exe` on Windows), which reports success as soon
as the helper exits, even when nothing reached the desktop — this package takes
the file managers over and opens the OS's own file browser **directly**. Alpha.

## What changed, and what did not

| | |
|---|---|
| **Kept from the shipped plugin** | the whole UI (the split button, the remembered choice, the menu, the icons), and the application **catalog** — VS Code, Cursor, JetBrains IDEs, Git GUIs, Windows Terminal, Git Bash… still resolve and launch through the shipped host row, which stays mounted and untouched |
| **Taken over** | the three **file-manager** catalog ids (`explorer`, `finder`, `filemanager`): the forked browser bundle posts them to this package's own route |
| **Changed** | how that one launch happens: an argv spawn of the OS's file browser instead of the shell's open verb |

The package's bundle layer **hard-disables the shipped client row**
(`ui-open-in-app`) and inserts its own row, which owns both halves: the forked
browser bundle and a dependency-free Node route.

## The launch, per platform

| Platform | Command |
|---|---|
| Windows | `%SystemRoot%\explorer.exe <dir>` (absolute, so a hijacked PATH cannot shadow it; Explorer's delegated `exit 1` counts as handed over) |
| macOS | `open <dir>` |
| Linux | `xdg-open <dir>` |
| WSL | `wslpath -w <dir>` then the Windows `explorer.exe` |

The child is spawned **detached** with no stdio, and a short watch window
classifies the attempt: an early spawn error or a nonzero exit is reported as a
failure (HTTP 502, which the button paints as its red error state) instead of a
silent success; a child still running when the window closes counts as launched
and keeps running.

## The route

| Route | What it does |
|---|---|
| `POST /api/dsh-open-in-app/open` | `{app, path}` → opens `path` in this platform's file browser |

It registers through the composition's `connection` service like every other
pack route, so the browser authentication and the Host/Origin fence are the same
ones; on top of that the body is validated at the wire — a JSON object, one of
the three file-manager ids, and an **absolute path naming an existing
directory**. The launcher only ever spawns an argv array, never a command string.

## Layout

```
cordis.patch.yml   bundle layer: disables the shipped 'ui-open-in-app' row and
                   inserts the pack's 'native-open-in-app' row
lib/index.js       Node half: the launcher route above (node builtins only)
lib/client.js      Browser half: GENERATED fork of the shipped
                   @deepseek-ai/dsh-client-ui-open-in-app bundle, with the module
                   id rewritten and two documented patches applied
```

`lib/client.js` is **generated, never hand-edited**: `scripts/sync-vendored.ps1`
holds the fork's patch list (the pack route constant, the file-manager id set,
and the one line of `launch()` that chooses between the two routes) and fails
loudly when a harness bump moves the code it patches. Re-sync after a pin bump:

```sh
pwsh -NoProfile -File scripts/sync-vendored.ps1
pwsh -NoProfile -File scripts/sync-vendored.ps1 -Check
```

(Windows accepts the same commands through `powershell`; the script itself is
OS-neutral.)

## Install / uninstall

The repo launcher (`install.bat` on Windows, `./install.sh` on macOS/Linux)
auto-discovers this package - it is a standard `dsh.bundle`. Adding a package
changes the profile's bundle set, and a bundle the profile does not list yet is
added by one plain launcher run (no `-Force` needed); after that a plain run is
enough. Removing it with the
uninstaller also removes its patch layer, which brings the shipped client row
back on the next restart.
