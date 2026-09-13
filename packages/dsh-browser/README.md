# dsh-browser (alpha.1)

**Browser** is a **browser tab for the pack's right bar** — the address bar, back /
forward / reload / stop, a connection LED, and **Copy** and **Open** beside it.
The page underneath is drawn by the browser you are already looking at: the tab
mounts **one `<iframe>`**, so the harness ships **no engine and downloads
nothing** — no Chromium, no Playwright, no OS browser lookup.

That choice has one honest consequence, and the tab is built around it rather
than hiding it: **a cross-origin frame is opaque**, and **some sites refuse to be
embedded at all**. So the tab asks the host *before* it loads anything, and says
what it knows.

## How it plugs in

It is a **page type**, exactly like the Editor's page tab and History.

| Piece | Value |
|---|---|
| `id` / slot key | `dsh-browser` |
| `kind` / address | `browser` / `sidebar://browser` |
| `priority` | `builtin` |
| guide entry | **Browser**, `order: 40` — after Files (10), Editor (20) and History (30) |
| seats | the keyed `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` |
| services | `slots` + the bar's `sidebarRightTabs` (nothing else) |
| host surface | `GET /api/dsh-browser/probe?url=<address>` (the Node half's only route) |

The tab strip's **"+"** opens the Start page, which lists the guide entries;
picking **Browser** creates (or reveals) the page tab. An opener may also name the
first address: `openTab('browser', { params: { url } })`.

## What the tab does

- **Address bar.** Enter loads; `Escape` reverts to the address in force; `Ctrl+L`
  focuses it. A scheme is respected only when it is `http`/`https` (no
  `javascript:`, no `data:`, no `file:`). Without one, a loopback host —
  `localhost:3000`, `127.0.0.1:5173` — gets `http`, anything else that looks like a
  hostname gets `https`, and a bare word is refused instead of being sent to a
  search engine this pack has no business choosing.
- **Back / forward** replay the addresses *this tab* loaded. They are disabled
  honestly at both ends of the stack.
- **Reload / stop** share one slot, like a browser: it is `×` while a load is in
  flight and `↻` otherwise. On a refusal card, Reload re-asks the host — a site can
  change its mind.
- **The LED** is the surface's own health: grey *idle*, amber *loading*, green
  *loaded*, red *cannot be shown here*. It never claims more than the one signal a
  cross-origin frame gives (`load`), which is why a load that drags past 12 s
  becomes an explicit note instead of a lie.
- **Copy** puts the address in the clipboard (falling back to `execCommand` when
  `navigator.clipboard` is unavailable); **Open** hands it to a real browser tab via
  `window.open` — the escape hatch every refusal card offers.
- **The status line** keeps the page's `<title>` (resolved by the probe, which also
  resolves redirects), the HTTP status, and the version marker
  (`dsh-browser 0.1.0-alpha.1 · iframe`).

## What it cannot do, and why the tab says so

| Limitation | Why | What the tab does instead |
|---|---|---|
| A site can refuse to be framed (`X-Frame-Options`, CSP `frame-ancestors`) | Browsers enforce it; no page can override it | The **probe** catches it first and shows a card with the exact header, **Open in a new tab**, and **Try anyway** |
| In-frame navigation is invisible | A cross-origin frame cannot be read | Back/forward cover the addresses the tab loaded; the status line reports the last address it settled on |
| The page cannot be scripted, clicked through, or screenshotted by the harness | Same opacity — a tainted frame is not readable | The harness reads pages as **text** through its own `web_fetch`, and captures **pixels** through this pack's existing Screenshot control (`getDisplayMedia` photographs the whole window, the frame included) |

Only a **real** framing refusal blocks a load. A `401`, a DNS failure, a timeout
or a non-HTML answer is reported as a **note** and the address is handed to the
frame anyway — the frame uses *your* browser session and cookies, so an anonymous
host-side check must never decide for it.

## The probe (Node half)

`GET /api/dsh-browser/probe?url=<address>` fetches the address from the host —
**Node's own TLS stack**, never system tools or an OS browser — follows redirects,
and answers:

```json
{ "ok": true, "url": "...", "finalUrl": "...", "status": 200, "title": "...",
  "contentType": "text/html; charset=utf-8",
  "frameable": false, "blockedBy": { "kind": "xfo", "value": "X-Frame-Options: DENY" },
  "note": "" }
```

- **One ranged `GET`** (`Range: bytes=0-65535`): the response headers are the whole
  framing verdict and the first 64 KiB are all the `<title>` needs — capped and
  cancelled, never returned whole, so a large page costs a bounded read rather than
  a download.
- `frame-ancestors` **wins over** `X-Frame-Options` when both are present, as
  browsers do. Source matching is approximate by design: `*`, `'self'`, `'none'`,
  host-sources with an optional scheme/port/`*.` wildcard are decided, a source's
  **path is ignored** — so the verdict can only be too permissive, never a false
  refusal.
- Typed failures: `NO_URL`, `URL_TOO_LONG`, `BAD_URL`, `BAD_SCHEME` (400/414),
  `TIMEOUT` (504), `UNREACHABLE` (502).
- The response is `no-store`, and the answers are cached client-side **per address
  per tab**, so a history step never re-blocks a page the user already saw.
- **Trust boundary:** the route makes the host request an address the client names.
  No cookies are sent, no request body is accepted, and the answer never carries
  more than a status, a content type and a capped title — and the gate is the same
  connection authentication every `/api/dsh-*` route here stands behind, against a
  harness that already mounts a full unsandboxed terminal (`dsh-terminal`).

## The seam (why an engine can be added later)

Everything above the render surface is **surface-neutral**: the toolbar, the
history stack, the LED, the probe, the tab type and its Start entry. A surface is
one factory returning five methods plus a state reporter:

```js
{ kind, mount(), goto(address), reload(), stop(), dispose() }   // + spec.onState(patch)
```

`iframe` is the one this alpha ships; it is one entry in a `SURFACES` map in
`lib/client.js`. A harness-owned engine — a pinned Chromium driven over CDP and
streamed into a `<canvas>`, which is the only way to drive *arbitrary* pages and
see them — is a **second entry in that map**, with the same `onState` shape and
the same five methods. Nothing else in the bundle changes, and the `sessionId`
every surface already receives is exactly what a per-conversation engine needs.

## Layout

```
cordis.patch.yml   bundle layer: inserts the 'browser' row (nothing else patched)
lib/index.js       Node half: the framing probe above
lib/client.js      Browser half: the page tab type + guide entry, the toolbar, the
                   address stack, and the SURFACES seam (module-table bundle, no
                   build step)
```

Nothing is forked and no core row is disabled: this package **adds** surface, so
`scripts/sync-vendored.ps1` has nothing to keep in sync for it.

## Verification

`scripts/checks/check-node-routes.mjs` drives the probe against a **real local
HTTP server** it starts: `DENY`/`SAMEORIGIN`, `frame-ancestors 'none'`/`*`,
CSP-over-XFO precedence, title decoding, a host that refuses HEAD, a closed port,
and the scheme/length guards. `scripts/checks/check-client-bundles.mjs` loads the
browser half through the module table and a real React runtime and checks the
registration, the guide order, the chip title, the idle card, the seam's shape and
the invariant that only `frameable === false` blocks a load.

## Install / uninstall

The repo launcher (`install.bat` on Windows, `./install.sh` on macOS/Linux)
auto-discovers this package — it is a standard `dsh.bundle`. Adding a package
changes the profile's bundle set, so the first install after it appeared needs one
plain launcher run (or `-Force`). The web profile links it into this repo, so code
edits only need a restart of `npx @deepseek-ai/dsh web` plus a hard browser
refresh.
