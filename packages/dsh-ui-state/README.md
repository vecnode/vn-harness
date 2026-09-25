# dsh-ui-state (alpha.1)

**UI state that outlives the process**, for the web GUI and the desktop window
alike. One host-owned settings section holds the things a reload would otherwise
forget, and one browser half binds it, restores the two column widths, and
publishes the **`uiState`** client service the pack's other halves write through:

```js
const uiState = ctx.get('uiState')
uiState.set('dockHeight', 340)     // durable, host-side, shared by both hosts
uiState.get('pageZoom')            // -> 125
uiState.subscribe(rerender)        // fires when an accepted section arrives
```

Alpha.

## Why this exists

Everything that survives a restart today survives because it already lives on the
**host**: `$DSH_HOME/sessions` holds the conversations (which is why a new chat
opens the last one), `$DSH_HOME/storages/workspace.json` holds the workspaces,
and `$DSH_HOME/settings.yaml` holds the shipped preferences. Everything the
interface forgets lives in the **browser**, and there it is per **origin** and per
browser **profile**:

- a Chrome tab and the desktop window's WebView2 are two different stores, so
  they can never share it — even at the same port;
- the desktop shell prefers port 3080 and falls back to a free one, so even one
  host loses it by moving a port;
- and `localStorage` is gone entirely if site data is cleared.

A settings section is one document both hosts read. That is the whole idea.

## What is remembered

| Field | Default | Owner |
|---|---|---|
| `pageZoom` | `100` | [`dsh-themes`](../dsh-themes) — the header's Page-zoom control |
| `theme` | `''` | [`dsh-themes`](../dsh-themes) — an **extension** theme id (Nord / Monokai) |
| `dockHeight` | `280` | [`dsh-terminal`](../dsh-terminal) — the bottom dock |
| `sidebarWidth` | `-1` | this package — the left column |
| `rightbarWidth` | `-1` | this package — the right bar |

The file is `$DSH_HOME/settings.yaml`, and a fresh install writes **no**
`vn-harness` section at all: every field carries a schema default, so only values
that actually differ from the contract land in the document.

```yaml
vn-harness:
  pageZoom: 125
  theme: nord
  dockHeight: 340
  sidebarWidth: 300
```

There is deliberately **no field for the terminal dock's open state**. The panel
is the window onto a *process*: after a reload the client holds no slots, so
reopening it would either show an empty panel or — once the server's five-minute
PTY retention has lapsed — **start a shell nobody asked for**. A height is a
preference; "a shell was running" is not.

Two conventions matter when reading it by hand:

- **A negative width means "never recorded"**, which is deliberately not `0` —
  for the sidebar `0` is a real state (collapsed). A remembered `0` is restored
  through ui-layout's toggle, because its width setter clamps to the drag range
  and `0` is not in it.
- **`theme` holds an extension theme only.** `light` / `dark` / `system` are
  already durable in ui-theme's own namespace, and duplicating a preference would
  give one setting two owners that could disagree.

Light/dark/system and the content font size are therefore **not** this package's
business — they already persist. What did not persist, and does now, is an
extension theme such as Nord or Monokai: ui-theme's durable schema accepts the
built-in three only, so those used to be an in-process choice that a reload threw
away.

## The `uiState` service

| Call | Answers |
|---|---|
| `uiState.get(field)` | the remembered value, or the contract default |
| `uiState.set(field, value)` | a Promise for the queued, durable write |
| `uiState.unset(field)` | a Promise for the queued clear — the field reads as inherited again |
| `uiState.subscribe(fn)` | `fn` after each accepted section; returns a disposer |
| `uiState.snapshot()` | `{ status, value, defaults }` |
| `uiState.status()` | `loading` / `ready` / `unavailable` / `absent` (no transport) |

`set` is safe before the transport is ready (the write is replayed when the first
section arrives) and safe with **no transport at all** (it resolves without
writing), which is what lets a consumer keep its own `localStorage` fallback for a
profile that installed it without this package.

**One binder, deliberately.** Three bundles binding `vn-harness` independently
would each hold their own revision, and a namespace write is fenced on the latest
known revision — so one package's write could be refused because another had
already moved it. The recovery for that is a reload of host state, which would
silently drop the write. One scope means one queue and one revision.

## The page zoom is applied before the first paint

A zoom that arrives after the client boots is a visible reflow of the whole
shell, so — exactly like ui-theme's own theme bootstrap — this package's Node half
inlines the remembered level as a script row **before the shell mounts**. It
writes both the `zoom` declaration and the `data-dsh-page-zoomed` marker, because
that marker is a contract rather than a decoration: `dsh-themes`' right-bar seam
fix is gated on it.

## Why the column widths are this package's job

ui-layout keeps them in a **transient** store — its own words — so a reload
returns the sidebar to its 280px contract default and the right bar to 45% of the
frame, and closing the sidebar forgets its drag width by design. `ctx.layout`
exposes no width setter, so the store is reached the way ui-layout's own
`AppFrame` reaches it: through the **`root` slot registration**, which carries the
store handle, and `store.create()` answers the same shared instance the frame
renders from. That is the one core store this pack writes, so it is guarded
twice — the handle must look like a layout store before anything is touched, and
a shape it does not recognise means "remember nothing" rather than "run blind".
Both widths go to the store's own setters **unclamped**: it clamps to its drag
range and to 70% of the frame itself.

## Why schema is resolved and not imported

This pack ships zero npm dependencies and every other Node half imports only
`node:*` builtins: the web profile installs each bundle as a **live link** into
this repo, so a bare `import '@deepseek-ai/schemastery'` resolves from the repo
folder and fails with `ERR_MODULE_NOT_FOUND` (measured). `settings.register` wants
a schemastery schema, so the module is loaded at runtime instead through the
anchors `packages/dsh-terminal/lib/pty.js` established for the harness's own
`node-pty` — the running entry, then `$DSH_HOME/profiles`, which `dsh-app-boot`
keeps as a mirror of the installation's dependency closure. The CJS build is what
makes `createRequire` work (`schemastery` is `type: module` but publishes
`exports.require`), and duck typing is what makes it safe: `dsh-settings` treats
the schema as a function and reads `schema.toJSON()`.

Should no copy be reachable, the row **warns and degrades** — nothing is
remembered, and the client falls back to its own defaults — rather than failing
the boot.

## Layout

```
cordis.patch.yml   bundle layer: inserts the 'ui-state' row (nothing else patched)
lib/index.js       Node half: registers the `vn-harness` namespace, inlines the remembered zoom
lib/client.js      Browser half: binds the namespace, restores the column widths, provides `uiState`
```

No route, no storage of its own, no fork, no core row disabled.

## Desktop window geometry

The desktop shell remembers its own window geometry separately, in
`$DSH_HOME/vn-harness/window.json` — written and read by the Rust shell itself
(`app/src-tauri/src/windowstate.rs`), because the size must be known *before* the
window is built. It is desktop-only state by nature: a Chrome tab has no window
geometry to share.

## Install / uninstall

The repo launcher (`install.bat` on Windows, `./install.sh` on macOS/Linux)
auto-discovers this package — it is a standard `dsh.bundle`. Adding a package
changes the profile's bundle set, and a bundle the profile does not list yet is
added by one plain launcher run (no `-Force` needed). The web profile links it
into this repo, so code edits only need a restart of `npx @deepseek-ai/dsh web`
plus a hard browser refresh.
