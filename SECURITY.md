# Security Policy

**vn-harness** is a personal, MIT-licensed plugin pack for DeepSeek Harness. It
is built to be read: every behavior is a file in this repository, and the whole
point of the "bundle" model it uses is that nothing has to be taken on trust.
This document describes the surface the pack actually has, what guards it, and
what it deliberately does not do.

## The short version

- **No secrets in this repository.** API keys live in your own harness settings
  (`Settings > Models`); neither the plugins nor the installers ever read, write,
  prompt for, or transmit them. The credentials store under the harness home
  (`.credentials.yaml`) is never touched by this pack.
- **No core patching.** Every plugin is a standard dsh **bundle**
  (`dsh.bundle` + `cordis.patch.yml` + a `dsh.client` browser half). Nothing
  modifies DeepSeek core packages, harness profile internals beyond what
  `dsh plugin` itself does, or any key material. The pack owns its right bar by
  **forking** the shipped bar bundles into this repo and hard-disabling the core
  rows through its own bundle layer - a supported patch form, not a core edit.
  Forks are marked GENERATED and produced by `scripts/sync-vendored.ps1`, so
  what runs is always reviewable in this repository.
- **Pinned dependency line.** The pack is built and installed against exactly
  the harness version pinned in `.dsh-version.json`; installs always run
  through `npx @deepseek-ai/dsh@<pinned>`, never a floating `latest`.
- **Zero npm dependencies.** No package in `packages/` declares a runtime
  dependency, so installing the pack installs nothing new. The engines it needs
  (Mermaid, CodeMirror, xterm.js, `node-pty`, `ws`) are either vendored files in
  this repo or resolved from the harness installation that is already there.
- **No network egress of its own.** No plugin in this pack makes an outbound
  request: the TeX engine is run with auto-install disabled, `tectonic` is
  refused as an engine precisely because it downloads packages, and there is no
  telemetry, update check or remote fetch anywhere in the pack.
- **Loopback only.** The app binds `127.0.0.1` by default and its own `--host`
  rejects `0.0.0.0` on purpose; the pack's run launchers open only a loopback
  URL (see *The launch token* below).
- **Personal tooling, one trust domain.** Everything here assumes one person on
  one machine, using one harness profile. Do not run it multi-tenant, and do not
  expose the app to a network you do not control.

## What the pack adds to the trust boundary

Everything below is registered through the composition's own `connection`
service (or, for the one WebSocket, through `webServer.registerUpgrade` plus
`connection.requestRejection`), so it inherits the same browser authentication
and the same Host/Origin fence as the Web GUI itself. Every route is an EXACT
path, and the registry's method vocabulary is `GET | HEAD | POST` (which is why
a save is a `PUT` on the editor route only, and why every diagram write
including delete is a POST).

| Surface | What it can do | Guards |
|---|---|---|
| `GET/HEAD/PUT /api/dsh-editor/file` | read, save and CREATE text files inside the **session's own workspace folder** | the session root is resolved host-side (never named by the client); every path is resolved against it and **realpath-checked to stay inside** (absolute paths, drive letters, `..` and empty segments are refused; a symlinked parent cannot smuggle a write out); strict UTF-8 with no NUL; reads ≤ 2 MiB; writes are atomic (private temp + rename); a save echoes the mtime/size it opened with and a moved file answers 409 instead of clobbering; a create is create-exclusive (`409 EXISTS`) and never overwrites |
| `GET /api/dsh-editor/vendor` | serve the vendored CodeMirror 6 bundle | a static file from the package, ETag + `HEAD`, nothing else |
| `GET /api/dsh-gittree/state\|history\|commit` | **read-only** git queries in the session's workspace | only `rev-parse`/`status`/`ls-files`/`log`/`show`/`diff-tree`, spawned with argv arrays and no shell under a pinned env (`GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `--no-pager`); a commit id must match `/^[0-9a-fA-F]{4,40}$/` before it reaches argv (so `--all` is refused); 10 s kill, 8 MiB output cap; nothing in the package can write, stage, commit or check out |
| `/api/dsh-diagrams/*` (`health`, `state`, `diagram`, `artifact`, `export`, `render-report`, `vendor/mermaid.js`) | read the conversation's + the shared library's diagrams, store a diagram the user/model wrote, compile TikZ, export a format to the **Desktop** | state lives in one JSON file per conversation plus one library file under `$DSH_HOME/dsh-diagrams/**`, written atomically; session ids become file names only after sanitizing and a hash suffix; the TeX engine runs in a **private temp cwd** with `-no-shell-escape`, `MIKTEX_AUTOINSTALL=0`, `openin_any=p`/`openout_any=p` and a 20 s kill; sizes are capped (256 KiB per source, 4 MiB per conversation, 8 MiB per artifact, 64 diagrams); export formats are a whitelist and the client names a **format, never a path** - the Desktop is resolved per request and the file is written create-exclusively |
| `POST /api/dsh-themes/screenshot` | write one PNG to the **Desktop** of the machine running the app | requires `content-type: image/png`, a real PNG signature and ≤ 64 MiB; the Desktop is resolved per request (Windows plain or OneDrive-redirected, XDG on Linux, home as the last resort); the file name is host-generated (`vn-harness-<timestamp>.png`, `-2`, `-3`, ... on a collision) and written create-exclusively, so no file the user already had can be replaced and the client cannot ask for any other location |
| `WS /api/dsh-terminal/pty` (plus `GET /api/dsh-terminal/health`, `GET /api/dsh-terminal/vendor/*`) | attach the browser's terminal to a **real PTY** on the host, in the session's workspace folder | the upgrade is gated by `connection.requestRejection` (Host/Origin fence, then browser authentication) and a raw 401/403 is written into the socket **before** `ws` ever sees it; one PTY per (conversation, slot), 8 per conversation, detached sessions reaped after 5 minutes; control frames are NUL-prefixed so shell output can never be mistaken for one; past 4 MiB of unflushed socket bytes the PTY is paused rather than dropping output. **This is an unsandboxed shell**: it does NOT pass through the file policy or sandbox the model's tools obey. Anyone who can reach an authenticated browser session on this app has a shell with the privileges of the user running `dsh web`. That is what a terminal is; it is the single largest thing this pack adds, and the reason the app must stay on loopback |
| six diagram tools + the two bundled skills | let the model write, patch, verify, publish and delete diagrams, and read the two skill documents | a write is validated before it is stored (Mermaid through the vendored engine in a child process behind a DOM stub; TikZ through the machine's own engine), the tools cannot read arbitrary files - only the diagram source they own - and they cannot reach the network |
| browser halves | add tabs, buttons, dialogs and CSS to the Web GUI | they run in the harness's own module table (`window.__ModuleLoader__`), may `require("react")` only, take no Node imports, and reach every other service through `ctx.get(...)` after declaring it in `inject`; the only DOM they add is their own, and the only shipped thing one of them hides is a header menu the pack replaces on purpose (see `packages/dsh-themes/README.md` and `packages/dsh-editor/README.md`) |

Nothing else in the pack opens a file, starts a process or answers a request.

## The launch token

`npx @deepseek-ai/dsh web` prints one line once the server is listening:

```
dsh web: http://127.0.0.1:3080/?token=<launch token>
```

That token is the running process's **launch credential**: the server exchanges
it for the browser session cookie, and every request that follows rides the
cookie. Treat the line the way you would treat the cookie itself.

How the pack handles it (`run.ps1` on Windows, `run.sh` on macOS/Linux - one file
per host, no wrapper):

- it is **read in memory** from the app's own output and never written to a file
  (the POSIX half streams through an anonymous FIFO instead of a temp log for
  exactly this reason);
- it is **never echoed by the launchers** - they only report the origin they
  opened - and it is never put in a URL logged anywhere else;
- it reaches the browser as **one argv element**, never through a command
  string: no `cmd /c start`, no `sh -c`, so nothing in it can be read as a shell
  metacharacter;
- the URL is opened **only when it names a loopback address** (`127.0.0.1`,
  `::1`, `localhost`). Anything else is refused and reported;
- `--no-open` is passed to the app so the hand-off happens exactly once.

The token is process-scoped: it dies with the app. If a copy of it leaks (a
pasted terminal log, a screenshot), stop the app and start it again - the new
process has a new token. The pack itself never persists it.

## What this pack does not do

- No API keys, no credentials store access, no prompts for secrets.
- No global or administrator installs: pnpm is bootstrapped privately under
  `./tools`, and the pack writes only under `$DSH_HOME`, the session workspace
  folders you open, and the Desktop for the two features that save pictures
  there.
- No core-file or profile-file edits beyond what `dsh plugin add|remove` does.
  `.gitattributes` and the tracked checks are what keep the generated forks
  honest.
- No network access, no telemetry, no auto-update.
- No HTTPS server of its own; the app is a loopback HTTP server, and that is
  what makes the browser's screen-capture API available (`localhost` is a secure
  context).

## Supported versions

| Component | Supported |
|---|---|
| Repo default branch (`main`) | yes |
| Harness line pinned in `.dsh-version.json` (`0.1.5-rc.1`) | yes |
| Older pins / master APIs | no - upgrade the pin, then re-verify |

## Reporting a vulnerability

If you find a security issue in this pack (a plugin, the installer or run
launchers, the build, or the documentation):

1. **Do not open a public issue with exploit details.**
2. Report privately by opening a GitHub issue **without a PoC**, or by direct
   message to the maintainer (vecnode), and include:
   - affected package + version (`.dsh-version.json`),
   - a short description and the impact you observed,
   - steps that reproduce it, if you can share them safely.
3. You will get an acknowledgement; fixes land on `main` as alpha bumps
   (`-alpha.N`), and the issue stays closed until then.

## Hardening expectations

- Plugins stay **alpha** until the owner promotes them; every behavior change
  bumps the version and is re-installed with `-Force` before it is announced.
- The installer is **idempotent** and skips already-installed bundles unless
  forced; uninstall removes the bundle, its patch layer and only the skill
  folders it wrote (each carries a `.vn-harness-<package>` marker, so a skill a
  person wrote is never removed or overwritten).
- The pack targets the **web profile only**; it never installs into, or writes
  to, any other harness home.
- **Keep the app on loopback.** It is a personal tool with an unsandboxed
  terminal behind its authentication; binding it to a shared network interface -
  or running it on a machine other people can use - puts a shell behind a single
  cookie.
- Treat this pack as **personal tooling**: do not run it in multi-tenant or
  untrusted environments, and review any new dependency before it is added (the
  pack ships zero today, which is a property worth keeping).
