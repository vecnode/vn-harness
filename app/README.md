# `app/` - the desktop shell

The vn-harness web profile, in a native window instead of a browser tab.

```bat
run-desktop.bat            :: Windows: builds this when needed, then runs it
cargo build --release      :: macOS / Linux (from app/src-tauri), then run the binary
```

## What it is, and what it is not

It is a **launcher**, not a desktop edition. It starts the same pinned
`npx @deepseek-ai/dsh@<pin> web --no-open` that `run.bat` / `./run.sh` start,
and shows **that** URL in a WebView2 / WKWebView / WebKitGTK window:

- no TypeScript is bundled or rebuilt - the web profile installs every bundle as
  a **live link** into the repository, so the app in this window is the same app
  the browser tab shows, served by the same process;
- nothing under `packages/` knows this directory exists, no installer touches it,
  no row is disabled and no profile file is written;
- the flags mirror `run.bat` (`-Port`, `-DshHome`, `-DshVersion`, `-Help`);
- it asks for the harness's **own default port** when nothing holds it  -  the same
  origin a `run.bat` tab opens on, which is what keeps the window's per-origin
  client state  -  and falls back to a free loopback port when something already has
  it, so it never collides with a `run.bat` server or the Web GUI.

Requires the **Rust toolchain** ([rustup.rs](https://rustup.rs)) to build, and
Node.js 22 or newer exactly as the browser launcher does.

## What it does

1. Finds the repository root by walking up from the executable for
   `.dsh-version.json`, and reads the pinned dsh version from it - so debug and
   release builds, and any `CARGO_TARGET_DIR`, all land on the same pin. There is
   no built-in fallback version: a stale hard-coded pin would mean this window
   quietly ran a different harness than `run.bat`.
2. Chooses the port: `-Port` when it was given, else the harness's own default
   (3080) if binding `127.0.0.1` there succeeds, else `127.0.0.1:0`  -  asking the OS
   for any free port  -  released again before the harness binds it. The URL loaded
   is the one the harness prints, so a wrong guess here costs the origin and
   nothing else.
3. Opens the window **immediately**, on its own splash (`ui/index.html`), because
   the first run of a dsh version spends a while inside `npx`. After 45 seconds
   the splash says the wait is long and points at the console.
4. Runs the pinned CLI, streaming its stdout and stderr to this console.
5. Watches that output for `dsh web: http://127.0.0.1:<port>/?token=<token>`,
   parses the URL and navigates the window there.
6. Kills the harness - and the `npx`/`node` processes under it - when the window
   closes, and closes the window if the harness exits first. On Windows the
   harness is ALSO placed in a **Job Object** with `KILL_ON_JOB_CLOSE`, so it dies
   with this shell even when the shell is killed outright (a crash, Task Manager)
   rather than closed - the case where the exit hook never runs at all. Closing the
   window is enough on macOS/Linux; an abrupt kill of the shell there can leave the
   harness running, because no equivalent is wired up for those platforms in this
   first cut.

## The harness home it opens, and why it never invents one

The window shows the same profile a `run.bat` tab shows, and the rule that keeps
it that way is deliberately narrow: the shell hands the child a `DSH_HOME` only
when `-DshHome` gave one or `DSH_HOME` was **inherited** from the environment. With
neither, it passes nothing at all and lets the harness apply its own default
(`~/.dsh`), exactly as the browser launcher does.

It must never derive one from `USERPROFILE` / `HOME`, because `DSH_HOME` names the
harness's own folder *under* the user's home  -  not the home itself. The first cut
did exactly that, and the harness accepted it: finding no profile at
`%USERPROFILE%`, it bootstrapped a fresh one holding only its own two base
bundles, so the window opened the **plain DeepSeek Harness**  -  no plugins, no
`vn-harness` branding, none of the user's sessions  -  and left a whole second home
beside the real `.dsh`. Unit tests in `src-tauri/src/main.rs` pin the rule
(`chosen_home`, `default_dsh_home`, `pick_home_variable`), and the console still
*reports* the resolved home  -  `~/.dsh` included  -  without exporting it.

## The two rules that are load-bearing

The ready line carries the **launch token**, a live credential for the running
process. Both rules are the ones the browser launcher already holds, and they are
pinned by unit tests in `src-tauri/src/readyline.rs` (`cargo test`):

1. **The token is read in memory.** It is never written to a file, never handed
   to a shell, and never echoed: the harness's own output is printed with the
   value replaced by `token=REDACTED`, so a start-up failure is still diagnosable
   from the console without leaking the credential into a scrollback buffer.
2. **Only a loopback URL is opened.** A ready line naming any other host is
   refused and reported, never loaded, because handing this credential to another
   host is the one mistake that cannot be walked back.

A link clicked *inside* the app is a separate matter and is handled the other
way round: anything that is not the harness's own origin opens in the system
browser, so a rendered document can never replace the app's only window.

## Files

| Path | What it is |
|---|---|
| `src-tauri/src/main.rs` | The supervisor: flags, the repository/pin lookup, the port and harness-home choices, spawning npx, the window, the exit hook |
| `src-tauri/src/readyline.rs` | The pure half - ANSI stripping, URL extraction, the loopback refusal, `redact` - and its tests |
| `src-tauri/Cargo.toml` | Two dependencies: `tauri`, and `serde_json` (already in the tree behind tauri) |
| `src-tauri/tauri.conf.json` | Identifier, the `ui/` folder as `frontendDist`, no declared window (it is built in Rust so the navigation filter can live with it), `bundle.active: false` |
| `ui/index.html` | The splash. One file, no request of any kind |
| `src-tauri/icons/` | **Generated** by `scripts/make-desktop-icon.mjs` from `assets/vn-harness.svg`, and committed so a clone builds without running the generator |

## Failures

There is no dialog plugin; the console is the log and the window title carries
the verdict. If the harness never becomes ready, the window is retitled
`vn-harness - the harness server did not start (see the console window)` and the
reason is printed - `npx` missing, the pin unreadable, no free port, or 90
seconds without a ready line. Because the shell is a **console** application on
purpose, `run-desktop.bat` runs it in the foreground and that output stays on
screen.

## What was actually verified

Measured on Windows 11 (Rust 1.94, Node 22.20, WebView2 153) rather than assumed:

- `cargo test`  -  22/22: the launch-token rules below plus the home and port rules;
- the port rule: a free port is chosen whenever 3080 is taken (61203, 62066, 60927
  across the runs that were measured while the Web GUI was serving 3080), and 3080
  itself is asked for first once nothing holds it;
- the ready line is found ~8 seconds into a warm run, the window is titled
  `vn-harness` and answering, and a `msedgewebview2.exe` process holds established
  connections to the harness port - so the app really loaded, rather than the
  window merely being pointed at the URL;
- **no token leaked**: every `token=` occurrence in either stream, across every
  run, read `token=REDACTED`;
- window close: the shell exits in ~1s, zero harness processes survive and the
  port has zero listeners;
- force-kill of the shell: the same result - which is exactly what the job object
  buys, because before it was added this test left two `node` processes and a
  listening port behind;
- `run-desktop.bat -Help` exits 0; an unknown flag exits 1 with the flag named.

## Rebuilding the icons

```sh
node scripts/make-desktop-icon.mjs
```

Reads `cx`, `cy`, `r` and the viewBox out of `assets/vn-harness.svg` and writes
`icon.ico` (16-256px) plus a 512px `icon.png`. It needs no image library: it
encodes the PNGs and the ICO directory itself. Re-run it only when the mark
changes, and commit the result.
