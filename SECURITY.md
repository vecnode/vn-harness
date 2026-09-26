# Security Policy

**vn-harness** is a personal, MIT-licensed plugin pack for **DeepSeek Harness**.
It installs into exactly one place — the raw web profile
(`npx @deepseek-ai/dsh web`) — and everything it does is a file in this
repository: the pack ships standard dsh **bundles**, never a patched core file,
so nothing here has to be taken on trust.

The one rule that matters: **this app is built for one person on one machine.**
It listens on loopback unless you deliberately change that, it authenticates the
browser before it serves the UI or any API route, and it puts a real, unsandboxed
terminal behind that authentication. Read [**Lock it down**](#lock-it-down) if
you read nothing else, and use the
[verification commands](#verify-your-own-instance) to confirm your own instance
is in the state you think it is.

- [The short version](#the-short-version)
- [Supported versions](#supported-versions)
- [Reporting a vulnerability](#reporting-a-vulnerability)
- [Threat model](#threat-model)
- [How access control works](#how-access-control-works)
- [Lock it down](#lock-it-down)
- [Verify your own instance](#verify-your-own-instance)
- [What the pack adds to the trust boundary](#what-the-pack-adds-to-the-trust-boundary)
- [The launch token](#the-launch-token)
- [Supply chain](#supply-chain)
- [What this pack does not do](#what-this-pack-does-not-do)
- [Hardening expectations](#hardening-expectations)

## The short version

- **No secrets in this repository.** API keys live in your own harness settings
  (`Settings → Models`); no plugin or installer reads, writes, prompts for or
  transmits them. The pack writes no token, password or credential anywhere.
- **No core patching.** Every plugin is a standard dsh **bundle**
  (`dsh.bundle` + `cordis.patch.yml` + a `dsh.client` browser half). The pack owns
  its right bar by **forking** the shipped bar bundles into this repo and
  hard-disabling the core rows through its own bundle layer — a supported patch
  form, not a core edit. Forks are marked GENERATED and produced by
  `scripts/sync-vendored.ps1`, so what runs is always reviewable here.
- **Pinned dependency line.** The pack is built, tested and installed against
  exactly the harness version pinned in `.dsh-version.json` (`0.1.5-rc.1`).
  Installs run through `npx @deepseek-ai/dsh@<pinned>`, never a floating
  `latest`.
- **Zero npm dependencies.** No shipped package declares a runtime dependency, so
  installing the pack installs nothing new. The engines it needs are either
  vendored files in this repo (Mermaid, CodeMirror, pdf.js, xterm.js) or resolved
  from the harness installation already on disk (`node-pty`, `ws`).
- **No network egress of its own.** No plugin in this pack makes an outbound
  request: the TeX engine runs with auto-install disabled, `tectonic` is refused
  as an engine precisely because it downloads packages, and there is no
  telemetry, update check or remote fetch anywhere in the pack.
- **Loopback by default, and the harness itself refuses the unsafe bind.** The
  app binds `127.0.0.1`; `dsh web --host 0.0.0.0` is refused by the CLI outright.
- **Personal tooling, one trust domain.** Do not run it multi-tenant, and do not
  expose it to a network you do not control. A terminal is an unsandboxed shell;
  anyone who reaches an authenticated browser session has a shell with the
  privileges of the user running `dsh web`.

## Supported versions

| Component | Supported |
|---|---|
| Repo default branch (`main`) | yes |
| Harness line pinned in `.dsh-version.json` (`0.1.5-rc.1`) | yes |
| Other published harness lines (`0.1.5-rc.2`, `0.1.5-rc.3`, `0.1.7-alpha.1`, …) | **no** — not tested, and not claimed |
| Older pins / `master` APIs | no — upgrade the pin, then re-verify |

The pack is **not** a version-range product: it targets one harness line at a
time. `dsh-rightbar`, `dsh-rightbar-files` and `dsh-open-in-app` are forks of
that line's client bundles, so a line bump is a deliberate, reviewable step
(bump the pin, run `scripts/sync-vendored.ps1`, then re-verify) rather than
something that happens quietly.

Security fixes land on `main` as **alpha version bumps** and are noted in the
commit message; this repository has no separate maintenance branches, so the fix
for an old revision is the current one.

## Reporting a vulnerability

If you find a security issue in this pack — a plugin, the installers, the run
launchers, the tracked checks, or this documentation:

1. **Do not open a public issue with exploit details.** Open a private report
   instead: on GitHub, **Security → Report a vulnerability** in
   [`vecnode/vn-harness`](https://github.com/vecnode/vn-harness). If private
   reporting is not available to you, open a minimal public issue that says only
   that you have a security report and asks for a private channel.
2. **Include**: the affected package and version (`.dsh-version.json` plus the
   package's own `package.json`), the harness line you tested, the impact you
   observed, and steps to reproduce if you can share them safely.
3. **What to expect.** This is a personal project maintained on a best-effort
   basis; the aim is to acknowledge a report within **3 business days**, confirm
   or reject it after triage, and ship a fix as an alpha bump on `main`. Credit
   is given if you want it. Coordinated disclosure is appreciated rather than
   required.

**Safe harbour.** Good-faith security research on your own installation is
welcome. Test against a machine and an instance you own; do not attack other
people's instances, do not access data that is not yours, do not run
denial-of-service or destructive tests, and do not use social engineering. A
report made in that spirit will not be pursued.

**Out of scope for this repository** (report these upstream, to DeepSeek
Harness): bugs in `@deepseek-ai/dsh-*` core packages themselves, the model's
behaviour or responses, the LLM provider, and the harness's own sandbox and file
policy. Also out of scope: anything that requires root/administrator, physical
access, a compromised operating system or browser, a malicious browser
extension, or a machine where another user already has your unlocked OS session.

## Threat model

**What is worth protecting.** The app puts the user's own machine — the files
the model's tools can reach, the workspace, the conversation history, the model
API credentials in the harness settings, and the **unsandboxed shell** in the
terminal dock — behind one browser session. That is the asset.

**Trust boundary.** One human, one machine, one harness profile, one browser.
The transport is plain HTTP over **loopback** (which is a secure context for the
browser's own APIs precisely because it is loopback). Authentication is a browser
session cookie minted from a per-process launch token. Everything the pack adds
is mounted through the harness's own `connection` and `webServer` services, so it
inherits that gate rather than inventing one.

**Adversaries this design does defend against:**

| Adversary | Defence |
|---|---|
| A malicious page open in the same browser trying to call `127.0.0.1` (cross-site request forgery) | `SameSite=Strict`, `HttpOnly` cookies; the Host/Origin fence rejects `Sec-Fetch-Site: cross-site` and any `Origin` that is not the request's own authority; no CORS headers are served, so a cross-origin page cannot read responses either |
| A DNS-rebinding attack (attacker's domain resolves to `127.0.0.1`) | the Host header must be a loopback authority or an explicitly trusted one; the cookie's signed audience is bound to that authority |
| Someone who stumbles onto the port without a credential | the index and every `/api` route answer `401`; only the SPA's static asset files are public |
| A hostile model output or plugin input feeding a path/argument into the pack's routes | session roots are resolved host-side, paths are realpath-checked to stay inside the workspace, everything spawned gets argv arrays (never a shell), ids are pattern-checked before they reach `git`, exports are written create-exclusively to a host-chosen name |
| A leaked launch URL | the URL only works while that process is running and only from a loopback-reachable client; a leaked *cookie* is revoked by rotating the signing secret (see [Lock it down](#lock-it-down)) |

**Adversaries/exposures this design does not defend against:** root or
administrator on the machine, a compromised OS/browser/extension, a person with
your unlocked session, and — most importantly — **deliberate exposure**. If you
bind a LAN interface, forward the port, or put a tunnel or reverse proxy in front
of the app, you have moved an authenticated shell onto a network, and the browser
session is then the only thing between that network and your machine.

## How access control works

Five layers, in the order a request meets them. All of this is the pinned
harness line's own code, not the pack's invention; the pack only ever *registers
routes behind it*.

1. **The bind.** The web composition binds `127.0.0.1` (the pack's launchers
   never pass `--host` at all). The CLI refuses the all-interfaces bind with an
   explicit message — `--host 0.0.0.0 is intentionally not supported yet for
   safety: it would expose remote code execution to the network` — so exposing
   the app takes a deliberate configuration edit, not a typo.
   *Where:* `@deepseek-ai/dsh-web-app/lib/startup.js`.
2. **The launch token.** Each process mints one 32-byte random, base64url token
   in memory. The startup line prints a URL carrying it as the **only**
   authentication input. `GET /?token=<token>` on the exact root path, with
   exactly one token parameter, exchanges it (timing-safe comparison) for a
   session cookie and answers `303` to a clean `/` with `cache-control:
   no-store` and `referrer-policy: no-referrer`. The harness keeps the token in
   memory, and the pack's launchers never write it to a file.
   *Where:* `@deepseek-ai/dsh-client-connection/lib/index.js` (`BrowserAuth`).
3. **The browser session cookie.** Named `dsh-auth-<base64url(sha256(authority))>`
   and valued `v1.<payload>.<HMAC-SHA256(signing secret)>`. The payload binds the
   **authority** (`host:port`), issue time and expiry; the signature is checked
   with a timing-safe comparison and the audience must match the request's own
   Host. Attributes are `Path=/; HttpOnly; SameSite=Strict` with a `Max-Age`
   defaulting to **30 days** (`cookieMaxAgeDays` on the `connection` row, minimum
   1). A changed port or host means a different cookie name *and* audience, so
   old cookies stop matching.
4. **The Host/Origin fence on every `/api` request.** The Host header must name
   loopback (`localhost`, `[::1]`, or any `127.0.0.0/8` address) or an authority
   you explicitly trusted; `Sec-Fetch-Site: cross-site` is refused; if an
   `Origin` is attached it must equal the request's Host authority. A failed
   fence answers **`403`**; failed authentication answers **`401`** ("dsh web
   authentication required; reopen the URL printed by dsh web.").
   *Where:* `@deepseek-ai/dsh-client-connection/lib/index.js`
   (`isTrustedApiRequest`, `requestRejection`).
5. **The index gate.** The SPA's `index.html` is served only to an authenticated
   request; the remaining static assets (the JS/CSS bundles) are public by
   design and contain no secrets. An unauthenticated visitor gets the `401` text
   and nothing else.
   *Where:* `@deepseek-ai/dsh-host-frontend-static/lib/index.js`.

Everything the pack adds hangs off layer 4: its HTTP routes go through
`connection.fetch.register` on the shared `/api` channel (which applies
`requestRejection` before the handler runs), and its one WebSocket upgrade
(`/api/dsh-terminal/pty`) calls `connection.requestRejection` itself and writes a
bare `401`/`403` into the socket **before** `ws` ever sees it.

A sixth, quieter layer protects the credentials store: the browser-session
signing secret lives in `$DSH_HOME/.credentials.yaml`, which the provider writes
`0600` and **refuses to boot against** if the file is readable by group or other
on POSIX (`chmod 600` is the remedy it prints).
*Where:* `@deepseek-ai/dsh-credentials-local/lib/index.js`.

## Lock it down

Do these and the app is reachable by exactly one thing: a browser you control, on
the machine running it.

**1. Keep it on loopback — the default is already correct.**
Run it with the pack's launcher (`run.bat` / `./run.sh`) or
`npx @deepseek-ai/dsh@0.1.5-rc.1 web`. Do **not** pass `--host`, and do not pass
`--trusted-host`. Do not put the port behind a reverse proxy, an SSH `-L`
forward for someone else, a tunnel (ngrok, cloudflared, Tailscale `serve`),
your router's port forwarding, or a container's published port
(`docker run -p 3080:3080`). Loopback traffic does not cross a firewall, so
there is no firewall rule that "fixes" an exposed bind — not exposing it is the
control.

**2. Treat the printed URL as a password.**
It contains the launch token, and anyone who can reach the port can open that URL
and take a session. Do not paste it into a chat, an issue, a screenshot or a
recording. The launchers never write it to a file, never echo it, and never build
a command string out of it — it reaches the browser as a single argument — but
nothing stops a screen recording.

**3. Know what logs out, and what does not.**

| Action | Effect |
|---|---|
| Stop the app (Ctrl+C / closing the launcher) | nothing is listening any more; the **launch token** dies with the process |
| Delete this site's cookies in the browser | that browser loses its session immediately |
| Start the app on a **different port** (`-Port 3091`) | the cookie's name and signed audience are derived from `host:port`, so old cookies no longer match — temporary, and they match again if you go back to the old port |
| **Rotate the signing secret** | the strong one: every cookie ever issued, in every browser, becomes invalid at once |
| Restart the app only | **not** a logout. The signing secret is durable, so an already-issued cookie keeps working until it expires (30 days by default) |

To rotate the secret: stop the app, open `$DSH_HOME/.credentials.yaml` (default
`~/.dsh/.credentials.yaml`), delete **only** the `client-connection/browser-session`
entry — the file also holds your model API keys, so do not delete the file — save
it as valid YAML, and start the app again. A fresh secret is generated on boot,
and every previously issued cookie fails signature verification.

To shorten the session instead, override the `connection` row's config in your
profile patch (`$DSH_HOME/profiles/web/cordis.patch.yml`) — a patch replaces the
targeted row's whole `config`, so restate anything else you rely on:

```yaml
- id: connection
  config:
    cookieMaxAgeDays: 1
```

**4. Stop it when you are not using it.** A stopped app listens on nothing. On a
machine other people use, that is the only airtight control; consider not
auto-starting the app at login.

**5. Harden the machine, because loopback is only as private as the box.**
Every local process and every local user account can attempt a connection to
`127.0.0.1`; what stops them is the cookie and the fence, and what protects the
signing secret is the file mode. So: run the harness as your own user (never as
administrator/root), keep the OS and browser patched, use disk encryption on a
laptop, lock the screen, and prefer a dedicated OS account if the machine is
shared.

**6. Mind the two loud surfaces.** The terminal dock is a real shell with your
privileges and it does not go through the model's file-policy sandbox; the editor
writes files, though only inside the session workspace. Close the dock (and any
sensitive editor tab) before screen-sharing, and remember that anything the model
runs through those surfaces is your user account doing it.

**7. What "locked" does not mean.** It does not hide the app from a local
attacker who can already read your user profile, it does not protect a session
you left open on an unlocked screen, and it does not sandbox the model's tools —
that is the harness's own file policy, and it is a separate control. Locking the
app means: nobody who is not already on this machine, as you, with your browser
session, can reach it.

## Verify your own instance

Nothing here needs a tool other than `curl` and the OS's own network commands.
Run the app, then:

```sh
# 1. It listens on loopback and nothing else. Expect 127.0.0.1 (never 0.0.0.0).
ss -ltnp | grep 3080                     # Linux
lsof -nP -iTCP:3080 -sTCP:LISTEN         # macOS
```

```powershell
# Windows (PowerShell)
Get-NetTCPConnection -LocalPort 3080 -State Listen |
  Select-Object LocalAddress, LocalPort, OwningProcess
# ...or: netstat -ano | findstr :3080
```

```sh
# 2. Unauthenticated access is refused. Expect 401 and a one-line body.
curl -i http://127.0.0.1:3080/api/dsh-terminal/health
curl -i http://127.0.0.1:3080/            # the index answers 401 too

# 3. The Host fence works. Expect 403 for a foreign authority...
curl -i -H 'Host: evil.example' http://127.0.0.1:3080/api/dsh-terminal/health
# ...and 403 for a page claiming to be cross-site.
curl -i -H 'Sec-Fetch-Site: cross-site' http://127.0.0.1:3080/api/dsh-terminal/health
```

```sh
# 4. The session cookie carries its flags and its 30-day expiry.
#    In the browser: DevTools -> Application -> Cookies -> the dsh-auth-… entry
#    must show HttpOnly, SameSite=Strict, Path=/, and an Expires ~30 days out.
```

A `401` on step 2 and a `403` on step 3 are the whole access-control model
working. The pack's own checks pin the parts that belong to it: the editor's
workspace containment ("nothing escaped the workspace"), the create-exclusive
writes, and the terminal's refusal of an unauthenticated upgrade all run in

```sh
node scripts/checks/check-node-routes.mjs
```

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
| `/api/dsh-diagrams/*` (`health`, `state`, `diagram`, `artifact`, `export`, `render-report`, `vendor/mermaid.js`) | read the conversation's + the shared library's diagrams, store a diagram the user/model wrote, compile TikZ, export a format to the **Desktop** | state lives in one JSON file per conversation plus one library file under `$DSH_HOME/dsh-diagrams/**`, written atomically; session ids become file names only after sanitizing and a hash suffix; the TeX engine runs in a **private temp cwd** with `-no-shell-escape`, `MIKTEX_AUTOINSTALL=0`, `openin_any=p`/`openout_any=p` and a 20 s kill; sizes are capped (256 KiB per source, 4 MiB per conversation, 8 MiB per artifact, 64 diagrams); export formats are a whitelist and the client names a **format, never a path** — the Desktop is resolved per request and the file is written create-exclusively |
| `GET/HEAD /api/dsh-pdf/state\|health`, `GET/HEAD /api/dsh-pdf/file`, `GET/HEAD /api/dsh-pdf/list`, `POST /api/dsh-pdf/scan`, `GET/HEAD /api/dsh-pdf/vendor/*`, plus the five `pdf_*` tools and the bundled `pdf-analysis` skill | read a document's facts and text, **scan** the pages that are a picture of text, serve the vendored pdf.js engine, list the workspace's PDFs, and show a PDF in the reader tab | **read-only** - no tool modifies, merges, splits, rotates, fills or signs a document; extraction runs in a child process (argv only, a 25 s deadline, a 512 MiB heap cap, an 8 MiB stdout cap) that gates the parser itself (`isEvalSupported:false` - a document's embedded JavaScript is never evaluated - `useWorkerFetch:false` with no URL fetching anywhere, `enableXfa:false`, `useSystemFonts:false`); a session-relative path is realpath-checked to stay inside the workspace (a symlink out is refused) while an absolute path is read directly, and either way the target must be a regular `.pdf` within the ceiling (512 MiB for the tools, 256 MiB for the tab); `pdf_render` writes only NEW PNGs, create-exclusively, under a host-generated name in a caller-named directory; the optional rasterizer (`pdftoppm`/`mutool`/Ghostscript) and `tesseract` are spawned with argv arrays under a pinned environment and killed on a deadline |
| `POST /api/dsh-themes/screenshot` | write one PNG to the **Desktop** of the machine running the app | requires `content-type: image/png`, a real PNG signature and ≤ 64 MiB; the Desktop is resolved per request (Windows plain or OneDrive-redirected, XDG on Linux, home as the last resort); the file name is host-generated (`vn-harness-<timestamp>.png`, `-2`, `-3`, ... on a collision) and written create-exclusively, so no file the user already had can be replaced and the client cannot ask for any other location |
| `POST /api/dsh-open-in-app/open` | open a **file-manager window** on a directory the client names | the app id must be one of the file managers the pack supports (editor and terminal ids are refused), the path must be absolute and must exist; the OS launcher is spawned with an argv array, never a shell string |
| `WS /api/dsh-terminal/pty` (plus `GET /api/dsh-terminal/health`, `GET /api/dsh-terminal/activity`, `GET /api/dsh-terminal/vendor/*`) | attach the browser's terminal to a **real PTY** on the host, in the session's workspace folder | the upgrade is gated by `connection.requestRejection` (Host/Origin fence, then browser authentication) and a raw 401/403 is written into the socket **before** `ws` ever sees it; one PTY per (conversation, slot), 8 per conversation, detached sessions reaped after 5 minutes; control frames are NUL-prefixed so shell output can never be mistaken for one; past 4 MiB of unflushed socket bytes the PTY is paused rather than dropping output. **This is an unsandboxed shell**: it does NOT pass through the file policy or sandbox the model's tools obey. Anyone who can reach an authenticated browser session on this app has a shell with the privileges of the user running `dsh web`. That is what a terminal is; it is the single largest thing this pack adds, and the reason the app must stay on loopback |
| six diagram tools + the two bundled skills | let the model write, patch, verify, publish and delete diagrams, and read the two skill documents | a write is validated before it is stored (Mermaid through the vendored engine in a child process behind a DOM stub; TikZ through the machine's own engine), the tools cannot read arbitrary files — only the diagram source they own — and they cannot reach the network |
| browser halves | add tabs, buttons, dialogs and CSS to the Web GUI | they run in the harness's own module table (`window.__ModuleLoader__`), may `require("react")` only, take no Node imports, and reach every other service through `ctx.get(...)` after declaring it in `inject`; the only DOM they add is their own, and the only shipped thing one of them hides is a header seat/menu the pack replaces on purpose (see `packages/dsh-themes/README.md` and `packages/dsh-editor/README.md`) |

Nothing else in the pack opens a file, starts a process or answers a request.

## The launch token

`npx @deepseek-ai/dsh web` prints one line once the server is listening:

```
dsh web: http://127.0.0.1:3080/?token=<launch token>
```

That token is the running process's **launch credential**: the server exchanges
it for the browser session cookie, and every request that follows rides the
cookie. Treat the line the way you would treat the cookie itself.

How the pack handles it (`run.bat` on Windows, `run.sh` on macOS/Linux — the two
entry points; on Windows `run.bat` forwards to `scripts/run-web.ps1`, which holds
the work):

- it is **read in memory** from the app's own output and never written to a file
  (the POSIX half streams through an anonymous FIFO instead of a temp log for
  exactly this reason);
- it is **never echoed by the launchers** — they only report the origin they
  opened — and it is never put in a URL logged anywhere else;
- it reaches the browser as **one argv element**, never through a command string:
  macOS/Linux hand the URL to `open` / `xdg-open` as an argument, and Windows
  hands it to `Start-Process -FilePath <chrome> -ArgumentList @($Url)` inside
  `scripts/run-web.ps1` — no `cmd /c start`, no `sh -c`, so nothing in it can be
  read as a shell metacharacter. The root `run.bat` never sees the URL: it only
  forwards flags to the worker;
- the URL is opened **only when it names a loopback address** (`127.0.0.1`,
  `::1`, `localhost`; on Windows only a literal `127.x.x.x` address counts, so a
  name that merely starts with `127.`, such as `127.evil.com`, is refused too).
  Anything else is refused and reported, because the line can also carry a LAN
  URL when a deployment binds a LAN interface on purpose;
- `--no-open` is passed to the app so the hand-off happens exactly once.

**Lifetimes, precisely.** The *token* is process-scoped: it dies with the app,
and stopping and restarting gives you a new one. The *cookie* is not: it is
signed with a durable secret stored under `$DSH_HOME`, so restarting the app
does **not** log a browser out (see [Lock it down](#lock-it-down) for the real
revocation steps). If a token leaks, restart the app — that URL is dead. If a
cookie leaks, rotate the signing secret.

## Supply chain

- **No npm dependencies to trust at install time.** No shipped package declares
  a runtime dependency; the profile installs these bundles as live links, so
  nothing is fetched on your behalf.
- **Vendored engines are pinned and hashed.** `dsh-editor`'s CodeMirror 6,
  `dsh-diagrams`' Mermaid (`mermaid@11.17.2`, hash recorded in
  `lib/vendor/VERSION.json`), `dsh-pdf`'s pdf.js (`pdfjs-dist@6.3.289`, every
  file's bytes+sha256 in its own `lib/vendor/VERSION.json`) and
  `dsh-terminal`'s `@xterm/xterm@5.5.0` + `@xterm/addon-fit@0.10.0` are built
  from their `vendor/` folders and served by the packages themselves — no CDN,
  no runtime download.
- **Generated files are marked and checked.** The three forked bundles carry a
  `GENERATED - do not edit by hand` banner; `scripts/sync-vendored.ps1 -Check`
  reports drift without writing, and `.gitattributes` pins their line endings so
  a Windows checkout cannot create phantom drift.
- **Behaviour is pinned by tracked checks** (`scripts/checks/*.mjs`), including
  the security-relevant ones: workspace containment, create-only writes, the
  option-injection guard on git, the screenshot write refusals, the diagram
  budget, and the terminal's refusal of an unauthenticated upgrade.

## What this pack does not do

- No API keys, no credentials store access beyond the harness's own
  browser-session record, no prompts for secrets.
- **No way to weaken the harness's authentication.** The pack mounts every route
  it owns inside the harness's gated `/api` channel, and this repository has no
  flag, setting or environment variable that turns the session check off. The
  pack adds capability *behind* that check — never a way around it.
- No global or administrator installs: pnpm is bootstrapped privately under
  `./tools`, and the pack writes only under `$DSH_HOME`, the session workspace
  folders you open, and the Desktop for the two features that save pictures
  there.
- No core-file or profile-file edits beyond what `dsh plugin add|remove` does.
- No network access, no telemetry, no auto-update.
- No HTTPS server of its own; the app is a loopback HTTP server, and loopback is
  what makes the browser's screen-capture API available at all (`localhost` is a
  secure context).

## Hardening expectations

- Plugins stay **alpha** until the owner promotes them; every behaviour change
  bumps the version and is re-installed with `-Force` before it is announced.
- The installer is **idempotent** and skips already-installed bundles unless
  forced; uninstall removes the bundle, its patch layer and only the skill
  folders it wrote (each carries a `.vn-harness-<package>` marker, so a skill a
  person wrote is never removed or overwritten).
- The pack targets the **web profile only**; it never installs into, or writes
  to, any other harness home.
- **Keep the app on loopback.** It is a personal tool with an unsandboxed
  terminal behind its authentication; binding it to a shared network interface —
  or running it on a machine other people can use — puts a shell behind a single
  cookie.
- Treat this pack as **personal tooling**: do not run it in multi-tenant or
  untrusted environments, and review any new dependency before it is added (the
  pack ships zero today, which is a property worth keeping).
