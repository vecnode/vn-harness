# ARCHITECTURE.md - vn-harness deep dive

This document explains how the repo, the installer, and the Editor plugin
actually work against the DeepSeek Harness line they target
(`@deepseek-ai/dsh@0.1.5-rc.1`). Start with `AGENTS.md` for the short version.

## 1. The install target

DeepSeek Harness runs from a "profile": a directory that composes an ordered
stack of plugin-bundle layers. `dsh` discovers profiles under
`$DSH_HOME/profiles/<name>`.

| Target | DSH_HOME | Profile | Notes |
|---|---|---|---|
| web / CLI (`npx @deepseek-ai/dsh web`) | `DSH_HOME` env, else `~/.dsh` (Windows: `%USERPROFILE%\.dsh`) | `web` | the only target; the profile holds its own pnpm modules (store v3, virtual-store max length 120, pnpm 9) |

DSH Desktop (the Electron app's harness home under
`%APPDATA%\dsh-desktop\harness`) is **deliberately not supported**: it launches
a frozen generation snapshot of its plugin set that only refreshes on app
relaunch, which made every code change a two-step dance. The installer, the
uninstaller and their docs target the web profile alone. Profiles that still
carry this pack's bundles from that era can be cleaned with
`uninstall.bat -DshHome "%APPDATA%\dsh-desktop\harness"` (or
`./uninstall.sh -DshHome ...`) if it is ever needed - but nothing in this repo
does that automatically any more.

## 2. How a plugin ships (bundle / profile / patch)

A **bundle** is an npm package whose `package.json` declares:

```jsonc
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },  // this package is a layer
  "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-locale", "..."] }
}
```

- `cordis.patch.yml` is a YAML array of rows. It can restate an existing row
  (a patch replaces the row's whole `config`) or `insert` new rows. Rows name
  their module by package name so Node resolution finds installed code.
- `dsh.client` makes the browser half of the package join the GUI. The host
  scans active Loader entries for this declaration, composes a boot graph
  (`window.__DSH_BOOT__`), and serves the package's `exports["./client"]`
  bundle over `/plugins`.
- Installation = `dsh plugin --profile <name> add <folder|npm|git>` which
  pnpm-installs the package into the profile and appends it to
  `dsh.profile.bundles` (order matters: later layers win per row).

A UI plugin therefore has **two halves in one package** - and the pack has one
master (a blank base layer, `dsh-vn-master`) plus the bar and the sub-plugins
that live in it:

```
packages/dsh-vn-master/           # the master: the bundle layer alone, no client half
  package.json        # dsh.bundle ONLY (no dsh.client): a layer, and nothing else
  cordis.patch.yml    # inserts the no-op 'master' row; no disables, no overrides
  lib/index.js        # Node half: no-op row (the master is browser-free)
packages/dsh-rightbar/            # the bar: the pack's own right bar
  package.json        # dsh.bundle + dsh.client
  cordis.patch.yml    # disables ui-sidebar-right / ui-sidebar-files, inserts 'rightbar'
  lib/index.js        # Node half: no-op row (the bar is browser-only)
  lib/client.js       # GENERATED fork of the shipped sidebar-right bundle
packages/dsh-rightbar-files/      # the Files tab type (same fork scheme)
packages/dsh-editor/              # sub-plugin: the editor tab type
  package.json        # name, version, dsh.bundle + dsh.client, exports
  cordis.patch.yml    # inserts the 'editor' row (nothing else patched)
  lib/index.js        # Node half: authenticated /api/dsh-editor routes (file + vendor)
  lib/client.js       # browser half (module-table bundle; hand-written, no build)
  lib/vendor/cm6.min.js   # GENERATED vendored CodeMirror 6 classic bundle (commit it)
  vendor/entry.js, package.json  # reproducible CM6 build inputs (see its README)
packages/dsh-modal/               # sub-plugin: the shared dialog surface
  package.json        # dsh.bundle + dsh.client
  cordis.patch.yml    # inserts the 'modal' row (nothing else patched)
  lib/index.js        # Node half: no-op row (the overlay is browser-only)
  lib/client.js       # browser half: body-level overlay + the `modals` client service
packages/dsh-themes/              # sub-plugin: the header's page-zoom, capture, theme and download controls
  package.json        # dsh.bundle + dsh.client
  cordis.patch.yml    # inserts the 'themes' row (nothing else patched)
  lib/index.js        # Node half: the screenshot route (writes the client's PNG to this machine's Desktop)
  lib/client.js       # browser half: page zoom (one `zoom` on <html>), the Screenshot button, the Light/Dark/System
                      # button + registered themes over ctx.get('theme'), and the Session-log download seat
packages/dsh-ui-state/            # sub-plugin: the state a reload would otherwise forget (see section 17)
  package.json        # dsh.bundle + dsh.client
  cordis.patch.yml    # inserts the 'ui-state' row (nothing else patched)
  lib/index.js        # Node half: registers the `vn-harness` settings namespace, inlines the remembered page zoom
  lib/client.js       # browser half: binds that namespace once, restores the two column widths, provides `uiState`
packages/dsh-open-in-app/         # the file-manager half of the Open In button
  package.json        # dsh.bundle + dsh.client (forks the shipped client bundle)
  cordis.patch.yml    # disables ui-open-in-app, inserts 'native-open-in-app'
  lib/index.js        # Node half: POST /api/dsh-open-in-app/open (node builtins only)
  lib/client.js       # GENERATED + PATCHED fork of the shipped open-in-app client
```

**The master is a separate, blank bundle.** `dsh-vn-master` carries the pack's
bundle layer and nothing else: no `dsh.client` (so it contributes no node to the
boot graph), no service, no `inject` edge and no core-row disables. That is what
makes it safe to own pack-wide patches. The `sidebarRightTabs` / `sidebarRight`
services stay in the generated fork of the bar, so introducing the master cannot
touch the tab-type chain. It is also installed **last** - its name is the only one
here that sorts after every other, and `dsh plugin add` appends a new bundle -
which makes its layer the profile's final word per row. The core-row disables
deliberately stay with the packages that replace those rows: a disable belongs
next to the insertion that supersedes it, so `-Plugin dsh-rightbar` on its own
still mounts exactly one bar.

> History: the pack shipped its own right-hand panel as `dsh-focus` (row
> `focus`) through alpha.9, then as `dsh-files` (row `files`) from alpha.10,
> where it grew a tab-strip dock and published `window.__dshFilesHost` so a
> second bundle could register a tab into it. The harness has since shipped a
> **right Sidebar with a tab-type registry**, so that panel - dock, header
> capsules, host bridge and the `file-reference-local` row override - was
> retired in the editor's alpha.2, and the pack moved to registering tab types
> into the shipped bar. It now goes further and **owns the bar itself** by
> forking it (see §4). Both install scripts carry
> `$legacyNames = @('dsh-focus','dsh-files')` and prune those names from every
> profile they touch, so an upgrade cannot leave a stale bundle mounted.

## 3. The browser bundle format (no build step)

Every core client package ships its browser half as a module-table entry:

```js
window.__ModuleLoader__.load({
  id: "dsh-editor",              // package name
  factory: (require) => {
    var module = { exports: {} };
    // ... code, using require("react") for React and hooks ...
    exports.name = "dsh-editor";
    exports.inject = ["slots", "sidebarRightTabs"];
    exports.apply = apply;                          // cordis apply(ctx)
    return module.exports;
  },
});
```

Rules learned from core consumers (ui-sidebar-right, ui-sidebar-files,
ui-sidebar-documentpreview, ui-chat):

- Services are fetched with `ctx.get("<service>")`; each service used must be
  named in the exported `inject` array (activation waits for them). The
  right-Sidebar registry is the cordis service **`sidebarRightTabs`** and the
  navigation controller is **`sidebarRight`** - both provided by
  `dsh-rightbar` (the fork of `@deepseek-ai/dsh-client-ui-sidebar-right`).
- A service another bundle provides can also be resolved **lazily, at use time**,
  when a hard dependency would be wrong: `dsh-editor` reads `modals` only when a
  save-as dialog is actually needed, so it keeps working (browser `prompt`
  fallback) on a profile that never installed `dsh-modal`.
- Registration is disposed through `ctx.effect(() => disposer, label)`: a tab
  type lives exactly as long as the plugin that contributed it.
- `require` of core packages is possible only for modules the browser seed
  provides (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
  `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`,
  `@deepseek-ai/dsh-client-ui-slots`, `-ui-primitives`, `-ui-dockkit`).
  `react-dom/client`'s `createRoot` is what lets `dsh-modal` own a body-level
  overlay without occupying a slot.

**Why these client bundles are plain JavaScript, not TypeScript.** The format
above is the only one the harness serves: a single hand-written module-table
file per package, no build step. A TS pipeline would insert a compile between
every edit and the running GUI (there is no HMR unless a `pnpm run dev:web`
watcher from the harness repo runs), and would type against a client surface
that is still evolving. Plain JS + JSDoc keeps the edit -> restart loop instant
and the code greppable against the shipped core bundles.

## 4. The right bar (the pack owns it)

The GUI has a real right column: the conversation header's expand button
(`conversation.session.header.corner`) opens a per-session docking surface with
a tab strip, a "+" add control, splits and floating panels. Its strip starts
with the **Start** tab - the *guide* page, whose body lists one entry capsule
per registered tab type - and the **Files** tab with the session workspace tree.

**That bar is this pack's.** `dsh-rightbar` ships a fork of the shipped
`@deepseek-ai/dsh-client-ui-sidebar-right` bundle (module-table id rewritten to
`dsh-rightbar`, plus the patch list in `scripts/sync-vendored.ps1` applied on
top), and `dsh-rightbar-files` does the same for
`@deepseek-ai/dsh-client-ui-sidebar-files`. The bar's bundle layer then
hard-disables the two core rows:

```yaml
- id: ui-sidebar-right
  disabled: true
- id: ui-sidebar-files
  disabled: true
- insert:
    - id: rightbar
      name: 'dsh-rightbar'
```

Why a fork: the pack can then change any part of the column (chrome, tab
handling, guide, Files tree) without editing an installed core file, and
without waiting for a new seam. The two mechanisms that make it safe:

- **Row disable is a supported patch form.** The CLI itself disables its
  telemetry row with exactly `{ id, disabled: true }` (see
  `resolveTelemetryPatch` in `dsh/lib/profile-boot-*.js`). A disabled row is not
  an active Loader entry, so `dsh-client-modules` never puts its client bundle
  in the boot graph - verified: the boot HTML lists `dsh-rightbar`,
  `dsh-rightbar-files` and `dsh-editor`, and **zero** occurrences of the two
  disabled packages.
- **The bar's runtime dependencies are static modules of the shell.** The Vite
  shell seeds `react`, `react/jsx-runtime`, `react-dom`, `@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
  `@deepseek-ai/dsh-client-ui-primitives` and
  `@deepseek-ai/dsh-client-ui-dockkit` for every bundle
  (`staticModules()` in the frontend's index chunk), so a copied bundle keeps
  resolving them. Nothing else is required at runtime: a package's
  `dsh.client.inject` list is only an ordering hint, and the client graph walk
  skips a named dependency that is not in the graph - which is why the shipped
  `ui-sidebar-documentpreview` row (deliberately left enabled) still loads and
  still finds the `sidebarRightTabs` service, now provided by the pack.

**The only behavioral patch so far: four docked panes, not two** (alpha.2). The
docking kit itself allows `MAX_DOCK_PANES = 4` - its `canSplit` means *fewer than
four* - and resolves five drop zones per pane (`center`/`left`/`right` as the
`row` axis, `top`/`bottom` as the `column` axis), rendering any tree depth with
`splitRow`/`splitColumn`, per-split dividers and `planResizeSplit`. The shipped
sidebar-right bundle caps that at two in five places, and the fork had inherited
it verbatim. The patch list lifts all five and switches the surface from
`dropZones: "horizontal"` to `"edges"` (the kit's default), so the ceiling is the
kit's own again:

| Enforced in core | Now |
|---|---|
| the `splitPane` store intent: `dockPaneIds(state).length >= 2` | the kit's `canSplit` only |
| the `dropTab` store intent: refuses `top`/`bottom`, and any edge drop at two panes | the kit's `planDropTab`, which checks `canSplit` itself |
| the surface's `canSplit` prop: `canSplit(layout) && dockPaneIds(layout).length < 2` | `canSplit(layout)` |
| the `split()` command guard: `canSplit(layout) \|\| … >= 2 \|\| !canSplitPane(target)` | `canSplit(layout) \|\| !canSplitPane(target)` |
| the `dock.splitPaneDisabled` hint: "Two panes is the limit" / the zh twin | "Four panes is the limit" / its zh twin |

Two consequences worth knowing. The **Split control is still row-only** - the
kit's `planSplitPane` hardcodes `axis: "row", direction: "after"` - so a 2×2 is
built by **dragging a tab into a pane's top or bottom quarter**; the hints for
those bands ("Add top split" / "Add bottom split") and their glyphs were already
in the core bundle and its locale dictionaries, and only the fork's own refusal
kept them from ever being drawn. And **room still beats count**: the kit hides the
Split control and refuses a drop when a pane cannot hold two strips
(`SPLIT_MINIMUMS` ≈ 100px chip + 48px body each side), so four panes want a
widened bar or the panel's fullscreen mode. Floating panels were never counted
against the dock ceiling, so they remain the way past four.

The contract other plugins use is unchanged (the fork's patches move one limit,
never the contract) and is the seam the pack's own sub-plugins use:

```ts
ctx.sidebarRightTabs.register({
  id,            // this implementation's identity, unique; also the slot key
  kind,          // the tab kind (what openTab names)
  patterns?,     // dsh-resource:// addresses this type recognizes (omit for a page type)
  priority?,     // 'extension' | 'builtin' | 'fallback' (default: extension)
  canOpen?,      // veto an address the patterns matched
  title(address),// the chip text captured at open time
  guide?,        // entry capsules the "+" / Start page lists
})
```

- **Two-stage registration.** The definition above is stage one; stage two is
  the *keyed* body and title:
  `ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({ name, key: id, inject }, Body))`
  and the same for `sidebar.right.pane.tab.title`. A kind with no registrant
  renders the "nothing can view this yet" notice, so a missing body is a visible
  defect rather than an empty pane.
- **Addresses, not files.** Everything the column opens is an address:
  resources as `dsh-resource://<type>/...` (files are
  `dsh-resource://file/session/<sessionId>/<path>`), pages as
  `sidebar://<kind>`. A tab's `contentId` IS its address, which is what makes
  re-opening the same file reveal the same tab.
- **The "+" control opens the guide** (`openTab('guide', { revealIfOpened: false })`),
  and the guide renders `registry.guide()` - every registered type's `guide`
  entries, in `order`. Picking a capsule calls
  `tab.actions.openTab(entry.kind, { replaceTab: true })`.
- **Priority bands decide who draws a file.** `extension` (the default, meant
  for types from outside the product) outranks every `builtin` viewer and the
  `fallback` plain-text viewer. A third-party type therefore has to *veto* what
  it does not want in `canOpen`, or it silently takes files away from the
  shipped previews.
- **A body gets its runtime from the framework, not from props it invented:**
  `useTabInfo()` returns the tab record (`contentId`, `navigation.params`,
  `title`, `signal`, `actions`), and session-scoped seats additionally receive
  `sessionId` and the `useSessions` reader.

**Keeping the fork honest.** `scripts/sync-vendored.ps1` copies both core
bundles from the harness `node_modules` (profile first, then the npx cache),
rewrites their module ids, stamps a GENERATED banner and prints hashes;
`-Check` reports drift with a non-zero exit. The republished copies are
generated files - never hand-edit them, and review the diff after a harness-line
bump, because a fork does not track upstream by itself.

## 5. The Files tab (the pack's `dsh-rightbar-files`)

`dsh-rightbar-files` is the second half of the fork: the same bundle the product
ships as `@deepseek-ai/dsh-client-ui-sidebar-files`, with the core row disabled
and this one in its place. It registers the `files` tab kind (guide entry
`order: 10`) and lists the session workspace through the `remote.workspaceFiles`
Remote (`list(sessionId, path, signal)`), one level at a time; a file row calls
`tabActions.openResource(fileAddressFor(sessionId, root, path))`. Routing that
address to a viewer is the registry's job - which is exactly the hook §6 uses.

That Remote is read-only: `read`, `readBytes`, `readAll`, `readRelated`,
`stat`, `list`, `changes` - and **no mutation operation**. The editor's save
path therefore needs a route of its own (§6).

## 6. The editor tab type (dsh-editor)

A **sub-plugin** of the bar: one bundle, two halves, no core patches. Its client
half is hand-written (the pack's own code, not a fork); its Node half owns the
pack's file routes.

**Browser half** (`lib/client.js`) registers the type:

| Piece | Value |
|---|---|
| `id` | `dsh-editor` (also the slot key of its body and title) |
| `kind` | `editor` |
| `patterns` | `["dsh-resource://file/**"]` |
| `priority` | `extension` - text files open editable instead of in the shipped read-only preview |
| `canOpen` | session-scoped address, path stays inside the workspace, extension not owned by a shipped preview (html/images/pdf/office/archive/media/binary) - **Markdown is claimed** since alpha.6: it is text, and the toolbar hands it to the rendered view on demand |
| `guide` | one entry, `order: 20` (right after Files' 10): "Editor" -> creates an editor tab |
| body | `EditorView` for a file address, and the same `EditorView` with `file: null` for the page address `sidebar://editor` (a blank, unnamed document) |
| title | the label the surface last set (the file name, adopted or on the record) or the captured basename, plus a dirty dot, fed by a module-level per-tab store |

Behaviours that follow from that table:

- Clicking a `.ts`, `.json`, `.py`, `.md`, … anywhere the Sidebar opens files
  (the Files tree, a file link in the conversation) claims to this type and shows
  the editor. Re-opening the same address reveals the same tab.
- Clicking a `.png`, `.pdf`, `.html`, … is vetoed, so the shipped preview keeps
  it. Paths outside the session workspace (including `absolute/…` addresses,
  which carry no authorizing session) are vetoed too.
- **Markdown is editable, and `Preview` is the way back** (alpha.6). The toolbar
  button (shown only while an `md`/`markdown` file is open) asks the right bar's
  controller for `openResource(address, { kind, replaceTab: tabId })`, where
  `kind` is **the kind the shipped document preview registered under, read from
  the tab-type registry** (never hardcoded), so the rendered document takes the
  editor tab's place and the pair cannot drift from the file. It must be the
  controller (`ctx.get('sidebarRight')`, resolved lazily), not the tab record's
  `openResource` action: that action drops `options.kind`, and the registry's
  ranking would hand the address straight back to this `extension`-band type. The
  hand-off refuses while the document is dirty - the preview reads the file from
  disk, and showing the older text silently would be a lie.
- **The rendered page undoes the plain-text scrollport** (alpha.8). The shadow
  body lives inside `[data-textpreview-body]`, which the shipped preview styles
  for its *plain-text* renderer: `white-space:pre` and a monospace font stack.
  The shipped Markdown body reset both in its own wrapper - the wrapper this
  package's shadow body replaces - so the pack's `.dse-mdviewPaper` does the same
  (`white-space:normal`, and the app's UI font on the **Edit** pill). Without the
  reset a source newline is a hard break and every blank line renders as a full
  empty line, which is what made a Markdown document look double-spaced on the
  white page, and the pill inherited the monospace face unlike every button
  around it. Both regressions came in with the alpha.7 shadow body and are fixed
  by CSS in this package, not by touching the shipped preview.
- **The rendered page has one viewer** (with dsh-themes alpha.3): the preview
  header builds its viewer menu from *every* candidate implementation it resolved
  for the file - the Markdown body plus the shipped plain-text fallback - so
  `dsh-themes` hides that menu on Markdown tabs and the page's **Edit** button is
  the one way back to the text.
- "+" -> Start -> **Editor** creates the empty **page** tab, whose body is a
  blank CodeMirror document - nothing is read from disk, and there is no file
  browser inside the tab. **Save** (or Ctrl+S) on that document opens the shared
  dialog (`dsh-modal`) for a file name **with its extension**, `PUT`s it with
  `create: true` into the session workspace root (the folder the tab was opened
  in), and then decides the tab's fate from the SAME ranking a Files-tree click
  uses (`canOpenFile(address)`): a text/code file the editor claims is handed to
  `tab.actions.openResource(address, { replaceTab: tab.id })`, so the record
  becomes that file's tab (restorable, chip named from the record), while an
  extension a shipped preview owns **stays in the editor surface** with the file
  adopted and the chip label set from the per-tab store - because the preview
  cannot edit the file and this tab is the only place that can.

**Node half** (`lib/index.js`) owns the authenticated routes on the
`connection` service - the same mechanism the shipped session-log-export plugin
uses for its ZIP download:

| Route | Behavior |
|---|---|
| `GET /api/dsh-editor/file?session&path` | resolves the session's workspace root, realpath-containment inside it; strict UTF-8 decode + NUL rejection (`NOT_TEXT`); ≤ 2 MiB; returns `{text, version, mtimeMs, size}` |
| `PUT /api/dsh-editor/file` | same containment; atomic temp-file + rename; optimistic guard - the echoed `mtimeMs`/`size` must match or it answers `409 CHANGED_ON_DISK` instead of clobbering |
| `PUT /api/dsh-editor/file` with `{create: true}` | **create** a new file: the PARENT folder must exist inside the workspace and is realpath-checked (a symlinked folder cannot smuggle the write out), the target must not exist (`409 EXISTS`), and the publish is create-exclusive (hard link, then a `COPYFILE_EXCL` copy fallback) so a create never replaces a file the user did not open |
| `GET /api/dsh-editor/vendor` | streams the vendored CodeMirror 6 classic bundle (committed `lib/vendor/cm6.min.js`, generated from `vendor/entry.js`, see the package README) |

The session id in the URL is what the tab's address already carries; the
**host** resolves the workspace root - live session header first
(`ctx.get('sessions').get(id).header.cwd`), stored header second
(`ctx.get('sessionPersistence').stat(id).header.cwd`), a typed `NO_WORKSPACE`
failure otherwise - mirroring how `@deepseek-ai/dsh-api-workspace-files`
resolves its own reads. The client never names a root, and the row declares
only `inject: ["connection"]` so a missing optional service degrades instead of
blocking activation.

The plain-fs row deliberately avoids the tool-layer fs sandbox/policy state
and only ever touches paths the owner's own GUI asks for, inside the session's
own workspace.

**Lazy engine.** CodeMirror 6 is vendored ONCE as a classic IIFE
(`window.DSHEditorCM`) and fetched over the plugin's own route on the first
file open, so an idle GUI never pays for the editor. `lib/client.js` is
hand-written module-table code with **no build step**; only the CM6 artifact is
generated (when the version set changes).

**Engine and bundle stay in step (alpha.12).** The engine is one generated
artifact at one stable URL and the two halves load independently, so they can
skew - and alpha.11 shipped exactly that: the route cached the artifact in memory
for the life of the process and served it with `public, max-age=3600`, the
browser kept it, and a newer client bundle then asked a stale engine for a `rust`
mode it did not carry. `StreamLanguage.define(undefined)` dereferences the mode
it is handed, so the tab died with *"Cannot read properties of undefined (reading
'languageData')"* instead of opening unhighlighted. Four rules come out of it:
the engine is requested at a **version-qualified URL** (`?v=<bundle version>`;
the fetch registry matches on `pathname`, so the query is free), the route
**never offers a freshness window** (`cache-control: no-cache` over a
content-hash ETag - revalidation is a 304, never a re-download), the route
**re-`stat`s the artifact per request** and re-reads it when the stamp changed so
a rebuild or a `git pull` needs no restart, and every language lookup is wrapped by
**one guarded call site** that returns `null` - no language - with a single console
warning when the engine lacks the name. The tracked checks pin all four.

**That last rule only held for half the map until alpha.13.** alpha.12 guarded the
five **stream** modes and left the seven **Lezer** ones called straight off the
engine (`CM.javascript()`, `CM.json()`, `CM.markdown()`, `CM.python()`,
`CM.html()`, `CM.css()`, `CM.yaml()`), so an engine older than its bundle answered
`CM.yaml is not a function` and `openFile`'s `catch` turned that into the very
"Editor unavailable" tab the alpha.12 work exists to prevent - the claim above was
broader than the code. One lookup now serves both families: `engineLanguage(CM,
name)` answers `null` and reports once when the engine exports no factory of that
name, `lezerLanguage` builds through it (with the flags a `javascript()` call
takes), and `streamLanguage` wraps a stream mode through it, so
`languageExtensionFor` contains **no direct `CM.<name>(...)` call at all** - and the
tracked check fails on a bare `return CM.<name>(` reappearing, which is how a future
mapping would add the bug back. The warning's remedy was stale in the same way: it
still told the reader the route "caches the artifact in memory for the life of the
harness process, so RESTART `dsh web`", which alpha.12 had just made false - a
restart cannot help when the artifact **on disk** is the old one. It now names the
rebuild command and says a restart is neither needed nor useful. The check also
compares the client's `PLUGIN_VERSION` with `package.json`'s version, because the
version-qualified URL is only worth anything while the two agree (alpha.10 shipped a
client whose constant still said alpha.9).

**Languages.** The map from file extension to a CodeMirror language lives in
`languageExtensionFor` and has two kinds of entry. The Lezer parsers vendored as
`@codemirror/lang-*` cover js/ts/jsx/tsx, json, markdown, python, html, css and
yaml. The languages with **no Lezer parser in the vendored set** ride on
`StreamLanguage` instead, over CM5-style stream modes: `shell` (sh/bash/zsh/ksh/
dash) and `powerShell` (ps1/psm1/psd1) from `@codemirror/legacy-modes`, `batch`
(bat/cmd) from the hand-written `vendor/batch-mode.js` (CM5 and CM6 never shipped
one), and - since alpha.11 - `rust` (rs) and `toml` (toml), which legacy-modes
also carries and which CM6 has no parser for either. StreamLanguage translates a
mode's CM5 token names onto Lezer highlight tags, so `defaultHighlightStyle`
(light) and oneDark (dark) colour all five exactly as they colour a `.js`; the
only build step a new one needs is re-exporting it from `vendor/entry.js` and
rebuilding `lib/vendor/cm6.min.js`, which the tracked client check verifies by
loading the bundle and wrapping each name (a stale artifact fails there).

**Color scheme.** The editor is the one surface that cannot simply read the
`--dsw-*` tokens: CodeMirror wants a palette of its own, and oneDark paints an
opaque dark canvas no token can lighten. The surface therefore configures
**oneDark only while the app is dark** and a transparent light layer otherwise,
inside a CodeMirror `Compartment`, and it re-configures on the fly when the
appearance flips. The text colour is `--dsw-alias-label-primary` in both modes,
which is what keeps a document with **no syntax language** (`.ps1`,
`.gitignore`, `.txt` — its colour comes from that token, not from a highlight
style) readable; before alpha.5 it painted the light theme's near-black text on
oneDark's dark canvas. Scheme truth order: the shipped
`@deepseek-ai/dsh-client-ui-theme` snapshot (`active.colorScheme`, resolved
lazily through `ctx.get('theme')` and followed via its `theme/change` event),
else the `body[data-ds-dark-theme]` marker ui-layout writes (also observed, for
a profile where ui-theme never lands), else `prefers-color-scheme`, else dark.
The header control that switches the preference itself is §9.

## 7. The History tab (dsh-gittree)

The pack's second tab type beside the editor, and the first one that is **pure
addition**: it forks nothing, disables no core row, and ships no vendored code.

It is a **page type** - no `patterns` - so it never competes for a file address:
`sidebar://gittree` is its only address. It registers one guide entry (`order: 30`,
after Files at 10 and Editor at 20), and both the chip and the guide capsule read
"History" - the label only: the package, the row, the kind and the address keep the `dsh-gittree` / `gittree` name. The body is registered in the keyed `sidebar.right.pane.tab` seat under
the same id, so it follows the two-stage contract every other type follows (§4).

**What it shows.** The **commit history** of the tab’s own conversation folder:
short id, subject, author and date per row, newest first. Picking a commit opens its
full id, author, date, message body and the files it touched, each of which opens that
file in whatever claims it. The file bar above the list carries the branch, the short
HEAD - the current commit - ahead/behind, how many files git reports as changed, and
the version marker. There is no working-tree listing: the Files tab already browses the
folder, and the tab reads the state route with `brief=1`, so no file list is ever built
into an answer it would not show.

**How a row opens a file.** Every file row - a commit’s changed file - opens the same way a click in the Files tab does: the tab
record's own `openResource` action with a `dsh-resource://file/session/<id>/<path>`
address and **no options**, so the registry's ranking decides - the editor for
text, a shipped preview for an image or a PDF. The package therefore depends on
neither, and it publishes no service of its own.

**Where the data comes from.** Its Node half owns three authenticated,
**read-only** routes registered through `connection.fetch` - the mechanism §6
uses for the editor's file routes:

| Route | Git behind it |
|---|---|
| `state` (`brief=1` is the tab’s form) | `rev-parse --show-toplevel` / `--short HEAD`, `status --porcelain=v2 -z --untracked-files=all --branch`; `ls-files -z` and the entry merge only in the full form |
| `history` | `log -n N --date=short --pretty=format:...`, scoped with `-- <workspace>` when the workspace is a subfolder |
| `commit` | `show -s --pretty=format:...` plus `diff-tree --root --no-commit-id --name-status -r -z` |

The rules that make that safe to own:

- **Read-only by construction.** The only subcommands reachable are `rev-parse`,
  `status`, `ls-files`, `log`, `show` and `diff-tree`. Nothing stages, commits,
  checks out, fetches or writes a config value, so no request - however malformed -
  can change a repository.
- **argv, never a shell.** `spawn('git', [...])`, with every element a literal in
  `lib/index.js` plus at most a commit id validated against
  `/^[0-9a-fA-F]{4,40}$/`; `--all` and friends are refused as `BAD_REQUEST`, so a
  client string can never become a git option.
- **A pinned environment and real bounds.** `GIT_OPTIONAL_LOCKS=0`,
  `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `--no-pager`, a 10 s kill, an 8 MiB output
  cap, and typed failures (`NO_WORKSPACE`, `NOT_A_REPO`, `GIT_MISSING`,
  `TIMEOUT`, `TOO_LARGE`, `GIT_FAILED`) that the surface renders as a headline
  instead of "failed".
- **Scope by realpath.** When the conversation folder is a subfolder of the
  repository, the tree and the history are scoped to it and every path is
  reported workspace-relative. Both sides of that comparison are resolved with
  `realpath` first: a session header can carry a Windows 8.3 short path
  (`LUISAR~1`) or a symlinked path while git answers with the long one, and
  `path.relative` across two spellings of the same folder produces nonsense - it
  produced an empty tree and a `git log` that rejected its own pathspec during
  development, which is exactly what the tracked check now pins.
- **Parsed as wire format, not string-matched.** `status --porcelain=v2 -z` is
  walked as NUL-separated tokens (a rename's source path is the *next* token, and
  a path may contain spaces), and `diff-tree -z` yields `STATUS\0path\0` pairs.
  `--root` is what makes a repository's first commit list its files at all.
- **Tokens, not effect cleanups.** Every request carries a `useRef` token and applies
  its answer only while it is still the newest one. alpha.1 returned a cleanup from the
  effect instead, so the next render - the one its own `setState` caused - ran that
  cleanup, marked the request stale and dropped the answer, and the panel sat on
  "Reading the history…" forever. That is the shape the request code in
  `lib/client.js` warns about.
- **Lazy.** Nothing runs until the tab is shown, and the History request waits for
  the History view. Every answer is `no-store`.

**Why a separate package and not a view inside the editor.** The editor is a
document surface with its own lifecycle (CodeMirror, the save path, the rendered
Markdown body); the git tree is a read-only browser of the same folder. Separate
packages mean separate rows, separate versions and separate checks - and a profile
can install one without the other.

## 8. The shared dialog surface (dsh-modal)

Alpha.4 gave the editor a save-as dialog, and the same dialog is what any other
plugin of this pack (or a deployment's own) should reach for, so it lives in its
own bundle instead of inside the editor. `dsh-modal` provides one client service:

```js
const modals = ctx.get('modals')          // provided with ctx.reflect.provide
await modals.open({ title, message, fields, validate, submit })
await modals.alert('Saved.')              // single-button acknowledgement
if (await modals.confirm({ message })) {} // true only on the confirm button
const name = await modals.prompt({ label: 'Name' })
```

Design points worth keeping:

- **One dialog at a time, FIFO.** A second `open()` while a dialog is up is
  queued and shown when the first settles, so two racing callers cannot replace
  each other's UI. `open()` resolves with `null` on cancel, otherwise the field
  values (or whatever `submit` returned).
- **`submit` runs while the dialog is open.** This is the whole point: work that
  can fail (create a file, rename, POST) reports its failure IN the dialog, the
  user keeps everything typed, and only a success closes it. A thrown error is
  shown verbatim; `validate` covers the cheap, synchronous checks.
- **No slot, no ordering.** The host creates its own container on
  `document.body` and renders it with `react-dom/client`'s `createRoot` (both
  seeded by the shell). There is no layout contribution and no inject edge, so
  the surface is callable from every plugin at any point in the boot.
- **Escape belongs to the dialog** while it is up: the keydown listener runs in
  the capture phase and stops propagation, so the pane underneath never also
  reacts to the same key. Mask click and Cancel cancel; none of them fires while
  `submit` is in flight.

## 9. The conversation header (dsh-themes)

`dsh-themes` is the pack's **conversation-header package**: it owns the four
controls described below — the Themes button, the Session-log download seat, the
Screenshot control and the Page-zoom control — plus the appearance overrides that
dress the bar and the frame.

The conversation header's right-hand group is a slot list
(`conversation.session.header.utilities`): the shipped **Open In…** split button
registers there at `order: -10`, the Session-log download seat at the default `0`
(that seat used to draw a three-dot button — see the download seat below), the
**Screenshot** control at **`-30`**, the Themes control at **`-20`** and the
**Page-zoom** control at **`-40`**, the leftmost of the pack's four. The list
renders in ascending order, so the row reads zoom | capture | themes | download
next to Open In. Nothing shipped is patched or reordered.

**The Themes control.** One icon button with a `Menu`:

| Piece | Value |
|---|---|
| `id` | `dsh-themes` (the occupant's slot id) |
| slot | `conversation.session.header.utilities` (list, session scope) |
| `order` | `-20` — left of Open In (-10), right of the capture and zoom controls |
| body | one icon button (28×28, 28px radius, 6px padding, 15px glyph, and the group's `.5px` hairline ring since alpha.9) opening a `Menu` of Light / Dark / System plus **every theme registered into the shipped registry** (alpha.12). The button wears one static appearance mark (a half-filled disc), not the active preference's sun/moon |
| state | the shipped `theme` client service's snapshot, read through `ctx.get('theme')` |
| write | `theme.setTheme(id)` — the same call the Settings → General → Appearance row makes |

**Why a thin control and not a second theme system: the preference has one
owner.** `@deepseek-ai/dsh-client-ui-theme` (row `ui-theme` in the web roster)
persists the choice in the `ui-theme` settings namespace, resolves `system`
through `prefers-color-scheme`, and publishes immutable snapshots; ui-layout's
presenter applies each snapshot to the document
(`body[data-ds-dark-theme]`, `color-scheme`, the `--dsw-*` overrides). A private
copy of that preference would duplicate the persistence path and could drift
from Settings, so this package reads and writes the same service instead.

Design points worth keeping:

- **The service is optional and resolved lazily.** `theme` is read with
  `ctx.get('theme')` at use time and is NOT in the exported `inject` list — the
  same rule `dsh-editor` follows for `modals`. A profile that never mounts
  ui-theme keeps its header: the button renders disabled with "The theme service
  is unavailable", and a write throws instead of silently doing nothing.
- **Live state.** The control subscribes to ui-theme's `theme/change` event, so
  a switch made in Settings (or an OS flip while the preference is `system`)
  repaints the label; the store also reads a written value back after `setTheme`
  so the control cannot lag a synchronous publish, and a microtask after boot
  picks the snapshot up when ui-theme provides the service a tick late. It
  observes no DOM: the resolved palette is ui-layout's business, not this
  control's.
- **The button wears one static mark** (alpha.12, a half-filled disc drawn in the
  bundle): the menu and the tooltip carry the choice, and a registered palette has
  no shipped glyph to wear. The tooltip still names the active theme, so the
  control is never ambiguous about what is on.
- **Themes are ADDED by registering them** (alpha.12). `ctx.theme.register({ id,
  colorScheme, tokens })` is ui-theme's documented third-party surface: the
  presenter writes the definition's alias tokens as inline `body` variables over
  the base palette `colorScheme` selects, and `getTheme().themes` publishes the
  registry. The control iterates that list and appends `system` last, so
  `THEME_EXTENSIONS` (this package's **Nord**, **Monokai** since alpha.13 — the
  classic TextMate palette — and **Hacker** since alpha.19, the phosphor terminal,
  all registered in that order in the same 93-token shape)
  is the only place a palette is declared — and a theme another plugin registers
  shows up too, named by its id with the generic mark. Registration is idempotent
  and retried on the post-boot microtask and on every `theme/change`, because
  ui-theme may provide its service a tick after this row. An extension theme is
  IN-PROCESS by the shipped design: the durable preference schema accepts
  `light` / `dark` / `system` only, so a reload returns to the stored built-in.
- **Only seeded modules at runtime.** The bundle requires `react` and
  `@deepseek-ai/dsh-client-ui-primitives` (`Menu`, `Tooltip` and the three
  appearance glyphs), so it adds one entry to the boot graph and no new module
  resolution.

**The Markdown paper (alpha.2).** The same package carries the pack's appearance
*overrides*: rules that hold one surface on a fixed palette whatever the app
theme is. The first is the rendered Markdown view, which the user wants white in
either appearance.

The shipped document preview draws Markdown into a container marked
`data-document-markdown` and paints it from `--dsw-*` tokens. ui-theme declares
the light palette on `body{}` and **overrides** it on `body[data-ds-dark-theme]{}`
(the static palette too: 73 `--dsw-static-*`, 79 `--dsw-alias-*`, and shiki.css's
nine literal `--shiki-token-*`), so a subtree cannot un-dark itself by
referencing the tokens - it inherits the dark values. The paper is therefore one
injected rule that **re-declares ui-theme's own light declarations** on that
container and paints it white:

```css
body [data-document-markdown]{ /* the theme's light layer, verbatim */ background:#fff; … }
```

- **Read, not hardcoded.** The light layer is copied at boot out of the theme
  package's own stylesheets (`document.styleSheets` entries whose
  `data-plugin`/`data-pluginCss` starts with `@deepseek-ai/dsh-client-ui-theme`,
  every top-level `:root` / `body` rule that is not the dark one), so a palette
  change on a harness bump carries over instead of freezing today's hex values.
  The read enumerates the rule's declared custom properties and falls back to the
  rule's text where an engine does not expose them - either path yields the same
  declarations.
- **All or nothing.** If nothing is readable, nothing is injected: forcing white
  without the light tokens would paint light text on a white page, which is worse
  than leaving the view on the app theme.
- **Scoped to the rendered document.** Chat Markdown and every other surface keep
  following the app theme; a second selector (`[data-textpreview-body]` matched
  with `:has([data-document-markdown])`) paints the preview's own scrollport
  white too, so a short document does not sit on the dark canvas underneath
  (unsupported `:has()` simply drops that one rule). Because
  `--dsl-code-block-*` and `--shiki-*` resolve *inside* the document (the block
  declares them with `var()` on its own element), the copied tokens give the code
  blocks, inline code, links and lists their light styling for free - no second
  palette for those.
- **Kept current.** Installed at boot, on the tick after it (ui-theme's sheets may
  land late), and again on every `theme/change` (a palette swap re-registers the
  sheets); the style tag is reused, so repeated installs are idempotent.

The way to this view for a Markdown file is the editor's **Preview** button (§6).

**The Markdown chrome (alpha.3).** The same package carries the pack's second
appearance override, and it is about shape rather than palette: a rendered
Markdown page has exactly **one** viewer, but the shipped preview header builds its
viewer menu from *every* candidate implementation it resolved for the file - the
Markdown body plus the plain-text fallback - so a Markdown tab offered
"Markdown" / "Plain text". The pack's answer to that file is the editor (the
**Edit** button on the page, §6), never a second renderer, so the menu is hidden:

```css
body [data-document-preview="@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown"]
  [data-document-viewer-menu]{display:none}
```

- **Scoped by the selected renderer, not by guesswork.** The preview stamps the
  chosen implementation's id into `data-document-preview` on the document root, so
  a code or plain-text tab keeps its menu - there the choice between renderers is
  real and the pack has no opinion about it.
- **Static CSS, installed once, in its own tag** (`dsh-themes/markdown-chrome.css`):
  there is no palette to read, so it does not need the paper's refresh cycle and
  does not depend on the paper's read succeeding.
- **Only that one control goes.** The path, the reload tool, the document and the
  page's **Edit** button are untouched - and a profile that never installs
  `dsh-editor` still renders Markdown, just with no way back to a text surface,
  which is the shipped behaviour anyway.

**The VN branding (alpha.6).** The left bar's top row carries the product's mark
and name, and both are **slots**: `sidebar.brand.mark` and `sidebar.brand.name`,
each `single`, which the shipped `@deepseek-ai/dsh-client-ui-brand-official` row
fills (and which fall back to the layout's own `FishLogo` when no brand plugin is
mounted). The pack replaces that art with its own: a plain **24px black disc**
where the mark was, and the product text **vn-harness** (alpha.14; it read **VN Harness** through alpha.13).

- **An override, not a slot registration.** A `single` slot has one occupant, and
  the shipped brand row already holds both of them: a second registration would
  be a fight over a seat rather than a replacement. The row is `aria-hidden`
  decoration inside the band this package already owns (alpha.4), so it is hidden
  and redrawn there.
- **Whatever the occupant is.** The shipped brand plugin wraps each occupant in
  `<div data-slot="sidebar.brand.mark" style="display: contents">`, so the rule
  hides *children* - `display:none!important` - rather than assuming an `<svg>`
  from one particular provider. That also covers the layout's own fallback label.
- **The replacements are drawn, not inserted**: a `::before` carrying the **app
  icon** (`assets/vn-harness.svg` at the pack root, inlined as a data URI) at the
  slot's own 24px on `.hHd-Xa_brandMark`, the same icon on the collapsed rail's
  `.hHd-Xa_railMark`, and `content:"vn-harness"` on `.hHd-Xa_brandName`. Being in
  the same pinned rule set as the band, they are installed once and need no refresh
  on `theme/change`.
- **The icon carries its own margin, and that is the point** (alpha.8). The mark is
  painted into boxes the app declares `overflow:hidden` - the sidebar's brand button
  is exactly 24px tall - so an edge-to-edge circle loses a fraction of a pixel on
  each side, which is what alpha.7's drawn disc looked like. `assets/vn-harness.svg`
  is a black circle centred on (12,12) with a 1px transparent margin inside its
  24px box, so no container can shave it. The check compares the inlined copy's
  viewBox and circle geometry against that file, so the two cannot drift; the
  asset lives at the repository root because it is the SOURCE, and no package
  depends on a file outside itself.
- **The empty conversation's whale too** (alpha.8): "Into the Unknown" draws the
  same fish from `conversation.hero.brand.mark`, another `single` slot wrapped in
  `div[data-slot]`, so it gets the same treatment at 26px - the size that sits on
  the headline's 32px line without moving it.
- **The text wears the chat title's type** (alpha.7): the shipped brand name is
  `18px/600`, while the conversation's own title - the current crumb in the strip
  this band is levelled with - is `14px/20px/500` (`.wSkVaW_crumb` +
  `.wSkVaW_crumbCurrent` in ui-conversation). Two sizes a few pixels apart read as
  a mistake, so the product text takes the title's: `font-size:14px;
  font-weight:500;line-height:20px;letter-spacing:0`. The tracked check pins the
  declaration, and the served `ui-conversation` bundle was compared against the
  served `dsh-themes` bundle to confirm both sides say `14px/20px/500`.
- **It is pinned to the sidebar's hashed class names**, exactly like the band
  above it. That is the accepted cost of this row: the harness offers no seam for
  the branding either, and a harness line that renames those classes needs the
  rule updated (the tracked check pins the rule's text, so the failure is loud).

**The header ring (alpha.9).** The conversation header's icon buttons are meant
to read as one group, and the group's dress is a **round hairline outline**:
28×28, `border-radius:28px`, `.5px solid var(--dsw-alias-border-l3)`, held inside
the box by `box-sizing:border-box`. The terminal control has always worn it and
the pack's Session-log download seat does too; this package's own button did not,
so it sat bare among them — it does now (its own `.dst-button` rule, no
override needed). The ONE button on that bar that cannot draw the ring where it
lives is the right bar's own collapse/expand toggle in the header corner: it
belongs to a **GENERATED** forked bundle that is never hand-edited, so one rule
gives it the ring instead:

```css
html [data-conversation-header-corner] button{
  border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));
  border-radius:28px;box-sizing:border-box}
```

Unlike the band above, this selector is a **stable hook**: the corner element
carries ui-conversation's own `data-conversation-header-corner` marker, so the
rule survives class-name churn. `box-sizing` is part of it because the toggle's
own dress does not set it (without it the outline would grow the button by half a
pixel per side). The corner is a `single` slot, so the rule cannot leak onto
unrelated controls, and the rule set is installed once — there is no palette in
it.

**The Session-log download seat (alpha.9).** The same package also owns the
header's **download seat**, because that seat is the other half of this group and
the two controls share one dress. The shipped
`@deepseek-ai/dsh-session-log-export` browser half put a **three-dot "more
actions" button** there whose menu held exactly one item, "Download session log" —
one click to open a menu, a second to pick the only thing in it.

| Piece | Value |
|---|---|
| slot | `conversation.session.header.utilities` (list, session scope) |
| `id` | **`session-log-download`** — the SHIPPED occupant's own id |
| `priority` | **`-10`** (the shipped occupant sits at the default `0`) |
| `order` | `0` — the shipped occupant's own order, so the button does not move |
| export | the shipped `sessionLogDownload` controller, resolved with `ctx.get(...)` |
| dress | the same `.dst-button` as the Themes control (28×28, 15px glyph, the ring) |

**The seat is taken by the slot system's shadowing rule, not by CSS.** A list
slot renders the **lowest priority** registration for a given `id` and keeps one
occupant per id, so registering the *same* id one priority lower makes this
component the rendered one and leaves the shipped registration in the registry,
unrendered (`entriesOfSlot` is what the renderer walks). Nothing is hidden with a
hashed class — a harness bump that renames classes cannot resurrect the three-dot
button beside this one — and no DOM is touched. `dsh-editor` shadows the rendered
Markdown body the same way (`key` + a lower `priority` in a keyed slot).

**The export is not reimplemented.** The shipped row stays mounted *because* it
is dual-face: its host half owns the authenticated `/api/session.export` stream
and the `/export` slash command, so disabling the row would take the feature away
rather than the button. Its browser half publishes the `sessionLogDownload`
controller — the one-export-per-Session state machine that HEADs the export URL,
hands the browser its own download and publishes `downloading` / `success` /
`error` — and this control calls `download(sessionId)` / `dismiss(sessionId)` on
it. Both surfaces therefore share ONE implementation and ONE busy state: the
button renders disabled while the controller reports `downloading`, and `/export`
behaves as it always did.

**The seat's dialog came with the seat.** The shipped registration was the pair
`[Menu, Dialog]`, so shadowing it takes the preparing/success/error dialog with
it; the dialog is rendered here from the same store, with the same three states
and the same Close button, so `/export` keeps its feedback. What is gone is the
dropdown; what is left is one button and one dialog.

**A missing service degrades instead of crashing.** `sessionLogDownload` is read
with `ctx.get(...)` at use time and is never declared in `inject`; a profile that
never mounts the shipped row gets a disabled button reading "Session export is
unavailable". The inject face hands the renderer a CONSTANT observable source in
that case, so the component's Hook call order is identical either way.

**The Screenshot control (alpha.10).** One more occupant of the same list, at
**`order: -30`**, which captures the whole window and saves the PNG to the
**Desktop of the machine running the app**. It is the first control in the pack
whose behavior is split across both faces of its bundle, so `lib/index.js` is no
longer a no-op row.

| Piece | Value |
|---|---|
| slot | `conversation.session.header.utilities` (list, session scope) |
| `id` | `dsh-themes-screenshot` |
| `order` | `-30` — left of the Themes control (`-20`), right of the Page-zoom control (`-40`) |
| capture | `navigator.mediaDevices.getDisplayMedia({preferCurrentTab:true, selfBrowserSurface:'include', video:{displaySurface:'browser'}, audio:false})`, one frame `drawImage`'d into a canvas and encoded as `image/png` |
| save | `POST /api/dsh-themes/screenshot` (this package's host row) → `%USERPROFILE%\Desktop` / `~/Desktop` / XDG desktop / home, as `vn-harness-<timestamp>.png` |
| fallback | the browser's own download, when the host route answers nothing |
| feedback | the shipped `Toast`, anchored to the button: the saved path, or the reason it failed |

**100% width and 100% height is the tab's box.** The Web GUI is a
**fixed-viewport shell**: the document itself does not scroll — the middle and
right columns do, each keeping its own scroll position — so the page's full width
and full height are exactly what fills the tab. One frame of the tab's own surface
is therefore the whole picture: nothing is stitched, and there is no scrolled-out
remainder to guess at.

**Why the page takes the picture, and not a library or a second browser.** Two
alternatives were rejected for the same reason:

- a **DOM-to-canvas** library would have to stand in for the rendering engine:
  the terminal dock's surface is an xterm **canvas**, dialogs and menus are
  portalled to `document.body`, and the app paints itself from layers of hashed
  stylesheets and `@font-face` rules that a foreignObject render does not
  reproduce faithfully;
- a **headless browser** on the host pointed at the same URL would photograph a
  **fresh load**. The open right-bar tab, the editor's buffer and the terminal
  dock are *this client's* state, not the server's, so the shot would not be what
  the user is looking at (and it would attach a second client to the
  conversation).

`getDisplayMedia` with `preferCurrentTab` is the one API that hands the page its
own pixels, so the browser's share prompt is the price of a truthful shot. The
stream is stopped the instant the frame is grabbed. The picture is **the interface
as it stands, this package's own header controls included**: they are part of the
header being photographed, and alpha.10's rule that took them out of the frame left
a hole in the record, which alpha.11 closes. The one thing the injected
`themes.css` rule keeps out (`html[data-dsh-screenshot] [role=tooltip]`) is the
**open tooltip bubble** — a hover card is not part of the interface, and the
pointer is usually still on the button that started the capture. That button also
passes `disabled` to its own `Tooltip` while the capture runs (the shipped
primitive's close-and-stay-closed switch, keyed on a prop), so its bubble is gone
rather than merely invisible; the CSS rule is the safety net that covers every
other `Tooltip` in the app, and it is keyed on the tooltip's semantic
`role="tooltip"` marker rather than a hashed class.

**The file lands on the host's Desktop, not in the download folder.** The PNG is
POSTed to this package's own authenticated route
(`connection.fetch.register`, `methods: ['POST']`, `requestBody: 'buffered'` —
the same carrier contract dsh-editor and the shipped file-upload plugin use; the
bridge buffers bodies up to 300 MiB). The handler, in order:

1. requires `content-type: image/png` (else `415`),
2. reads the body and refuses an empty one (`400`) or more than 64 MiB (`413`),
3. requires the real **PNG signature** (`415` otherwise — the file is written to
   the user's Desktop, so it has to be worth writing),
4. resolves the Desktop **per request**: `%USERPROFILE%\Desktop`,
   `%USERPROFILE%\OneDrive\Desktop`, `$HOME/Desktop`, the freedesktop
   `XDG_DESKTOP_DIR`, `os.homedir()/Desktop`, OneDrive again, and the home folder
   as the last resort — read fresh every time, because the Desktop can be
   redirected (OneDrive) or configured (XDG) at any moment,
5. writes it **create-exclusively** (`flag: 'wx'`) and answers
   `{ ok, path, directory, bytes }`, taking `-2`, `-3`, … when the timestamped
   name is already there (a second shot inside the same second never clobbers
   the first).

The client never names a path, so the route has no traversal surface and no way
to overwrite a file the user already had; a host with no Desktop and no home
answers a typed failure (`500` + code) rather than throwing. When the host row is
absent — an older profile, or `-Plugin dsh-themes` against a partial install —
`deliverPng` falls back to an `<a download>` of the blob, so the control always
produces a picture; the toast says which of the two paths happened.

**The Page-zoom control (alpha.15).** The fourth occupant of the same list, at
**`order: -40`** — one more step left, so it is the first control in the group —
which drops a `Menu` holding the level in force plus the two steps, **Zoom in** and
**Zoom out**.

It exists because the gesture it mirrors is the *browser's*: `Ctrl+` / `Ctrl-`
(and Ctrl+wheel) page zoom belongs to Chrome, and the **native window**
`run-desktop.bat` opens — a Tauri shell over the very same `dsh web` — has no such
gesture at all. No page can invoke the browser's own zoom, so this control writes
the equivalent itself.

| Piece | Value |
|---|---|
| slot | `conversation.session.header.utilities` (list, session scope) |
| `id` | `dsh-themes-zoom` |
| `order` | `-40` — the group's leftmost occupant, left of the Screenshot control (`-30`) |
| what it writes | ONE inline declaration on `document.documentElement`: `zoom: <percent/100>`, and `removeProperty('zoom')` at the resting level |
| ladder | Chrome's own zoom steps, cut at **50%** and **200%** |
| memory | `localStorage['dsh-themes.page-zoom']`, per origin, re-applied before the control's first render |
| gesture | the mode click opens the menu; a step keeps it open (the shipped `Menu` still closes on a press outside or on Escape) |

**Why `zoom` on the root, and not a transform.** `zoom` is engine-neutral CSS —
Chromium and WebKit have carried it for years, Firefox since 126 — so ONE code path
zooms a Chrome tab and the shell's WebView: no host half, no Tauri API, no
permission, and the bundle stays browser-only. Chromium divides the initial
containing block by the root's zoom, so the shell's own dress
(`html,body,#root{height:100%}`) still fills the window exactly and the **layout
viewport really does become the narrower one** — media queries and fl/grid
reflow — which is what makes this a page zoom rather than a magnifier. A CSS
`transform: scale()` would have moved pixels without reflowing anything, and a
page laid out at full width but drawn at 200% has to be scrolled sideways to be
read.

**The ceiling is measured, not stylistic.** The control lives inside the page it
zooms, and the utilities row it sits in is a crumb plus four 28px buttons (~400px
of min-content). Since a root `zoom` shrinks the layout viewport, a high enough
rung pushes that row — this button included — past the window's right edge, and
the shell does not scroll, so the only way back down would be gone. Measured on
the real shell at a 1378×802 window: 200% and 250% leave the button at x≈870,
300% at 1044, **400% at 1392 (past the edge)** and 500% pushes the whole header
out. The ladder therefore stops at 200%, a rung that still fits with room to
spare, and the bottom stops at 50% (25% renders a shell an agent works in
unreadable). Everything between is Chrome's own rung, so a click lands on the
levels the keyboard gesture would. `check-client-bundles.mjs` pins the array.

**What it deliberately does not do.** It never listens for a key: swallowing
`Ctrl+` / `Ctrl-` in the page would **double** the zoom in a browser, where the
gesture already works. It writes nothing at 100% — the declaration is removed, not
set to `1` — so an unzoomed page keeps exactly the `style` attribute the harness
shipped. And a stored level that is not on the ladder is ignored rather than
applied, because the ladder is the only thing this control ever writes.

**Two honest limits, both measured.** `vh` is resolved against the real viewport
and CSS `zoom` does not change it, while `window.innerWidth` keeps reporting
unscaled pixels — nothing in the frame's own dress is affected (it is laid out in
percentages), but the few `max-height: calc(100vh - X)` rules on the shipped menus
and dialogs are a little more generous than a browser zoom at the same level, and
`position: fixed; inset: 0` surfaces still span the window exactly. Pointer
coordinates are the other half: a real `mousedown` at x=100 in a page zoomed to
200% still reports `clientX === 100` while the rect of the element under it
doubles, so a drag that compares pointer deltas against `getBoundingClientRect()`
(a pane's drag-to-pan, the terminal dock's grip) moves by the zoom factor off the
pointer. Clicking, scrolling, hit-testing and every menu are exact. Both limits are
the price of ONE mechanism that works in a Chrome tab and in the shell's WebView
alike; branching on a webview zoom API would be desktop detection inside a bundle
that has to stay plain.

**The third one was a broken core control, and it is fixed (alpha.16).** That same
scaling splits one piece of frame geometry in half: `ui-layout` solves its three
column widths from the frame's `getBoundingClientRect().width` — **scaled** by a
root `zoom` — but places the right bar's **outer resize seam** with
`left: viewport - rightbar`, which is **layout pixels**. At 100% the two are the
same number and nothing shows; with a level in force the seam slides towards the
middle of the conversation — 288px off at 80% on a 1440px frame — and the bar can
no longer be dragged, which in the native window (the one host this control exists
for) reads as "the right bar stops being resizable after I zoom". The **left** bar
was never affected, and that asymmetry is the tell: its `left` is a layout-pixel
width, with no measurement folded into it.

The fix places the seam from the **layout** instead. While a zoom is in force the
right column is named as a **CSS anchor** and the seam is set to that anchor's left
edge, so both sides are layout pixels:

```css
html[data-dsh-page-zoomed] [data-rightbar-col] { anchor-name: --dsh-themes-rightbar-seam }
html[data-dsh-page-zoomed] [data-rightbar-col] ~ [data-side="rightbar"] {
  left: anchor(--dsh-themes-rightbar-seam left) !important;
}
```

Three properties of that rule are load-bearing, and `check-client-bundles.mjs`
pins each one: it is **gated on `html[data-dsh-page-zoomed]`** (the marker
`applyZoom` writes beside the declaration it belongs to), so at the resting level
no rule of `dsh-themes` matches the seam and the frame's own inline `left` still
governs; it keys on `[data-rightbar-col]`, `ui-layout`'s own **stable marker** (the
one `dsh-terminal` already follows) and on the handle's own `data-side` attribute,
**never a hashed class**; and the `!important` beats the inline `left` the frame
keeps writing. A browser without CSS anchor positioning drops both declarations and
keeps the behaviour of before this change. Nothing is forked and no core row is
disabled — this is dress, the same shape as the header-ring override. Measured in
the desktop window at 80%, 100% and 125% driving the control's own menu and the
drag with real pointer input: the seam sits on the column's left edge to 0.00px and
a drag still resizes the panel, and back at 100% the marker is cleared and the
computed `left` falls back to the frame's inline value.

## 10. The file-manager half of Open In (dsh-open-in-app)

The Session header's **"Open In…"** split button comes from the shipped
`@deepseek-ai/dsh-client-ui-open-in-app` + `@deepseek-ai/dsh-host-open-in-app`
pair. Its file-manager entries (File Explorer / Finder / Files) are opened by the
host through the OS shell's *open verb* - `Invoke-Item` inside a spawned
`powershell.exe` on Windows - which is a fire-and-forget hand-off: the route
reports a successful launch as soon as that helper exits, whatever the desktop
did with it. On a host where the hand-off goes nowhere, the button simply does
nothing.

Fixing that means changing *which command runs*, and the shipped host row exposes
no seam for it (its catalog is compile-time, its config carries only three
timeouts, and a second `webServer` registration for the same path throws). The
pack therefore does what it does for the bar: **fork the client bundle and
disable the shipped row.**

- `dsh-open-in-app/lib/client.js` is the shipped browser bundle with the module
  id rewritten and **two patches** applied by `scripts/sync-vendored.ps1`: a
  constant for the pack route + the file-manager id set, and the single line in
  `launch()` that chooses a route. Everything else - the button, the menu, the
  remembered choice, the icons, the apps/icon routes - is the shipped code, so
  editors, Git GUIs and terminals keep going through the shipped host row
  (which stays mounted and untouched).
- `dsh-open-in-app/lib/index.js` is the pack's own Node half: one authenticated
  route, node builtins only, that spawns the OS file browser **directly** -
  `%SystemRoot%\explorer.exe` (absolute, so PATH cannot shadow it; Explorer's
  delegated exit 1 counts as handed over), `open` on macOS, `xdg-open` on Linux,
  and `explorer.exe` over a `wslpath -w` translation under WSL. A short watch
  window turns an early spawn error or nonzero exit into a real HTTP 502 - which
  the button paints as its error state - instead of another silent success.
- The route repeats the shipped fence: browser authentication and the
  Host/Origin check come from registering through `connection.fetch`, and the
  body is validated at the wire (JSON, a known file-manager id, an absolute path
  that names an existing directory). The launcher only ever spawns an argv array.

Because the fork is patched rather than copied byte-for-byte, the patch list is
data in `sync-vendored.ps1`: a harness bump that moves the patched code fails the
re-sync loudly instead of shipping a fork that silently lost its behavior, and
the generated banner lists the applied patches.

## 11. The terminal dock (dsh-terminal)

The pack's first surface that is not in a column. A real shell in a **bottom
dock**: one horizontal panel that starts at the right edge of the left bar, runs
to the full width of the page, and sits **under** the middle and right columns -
which make room for it instead of being covered. Like §7 it forks nothing,
disables no core row and publishes no service; unlike §7 it does vendor a browser
engine and does own an upgrade route.

**Where it registers.** Two seats, both through `ctx.slots.inject` so neither is
lost to a registration order:

| Seat | Kind | Order | Why there |
|---|---|---|---|
| `conversation.session.header.utilities` | list | 30 | the last utility: right of **Open In...** (-10), the pack's Themes (-20), and immediately left of the right bar's own toggle |
| `shell.overlay` | list (root) | 50 | the layout package renders it inside the frame, in the app's React tree |

The header **corner** is deliberately avoided: `conversation.session.header.corner`
is a `single` slot and the right bar's toggle already owns it, so a registration
there would replace it. The terminal glyph is drawn in the bundle - primitives
ships no terminal icon - and `Tooltip` is the only primitive used.

**Why the dock is `position:fixed` inside the overlay.** A bottom row cannot be a
grid child of the frame (that would mean writing a foreign node into a
React-managed container), and it cannot be positioned relative to the frame
either: the frame declares `overflow:hidden`, which clips an absolutely
positioned child. A fixed box escapes that clip while still living inside the
overlay layer, whose `z-index:20` puts the dock above the columns (10/11) and
below a fullscreen right bar (40) with no further work.

**How the geometry is derived** (there is no layout-service API for a bottom
region - `ctx.layout` only exposes `openRightbar`/`closeRightbar`/`toggleSidebar`/
`selectPanel`):

- **Left edge**: the frame's columns are an inline
  `gridTemplateColumns: <sidebar>px minmax(0,1fr) <rightbar>px`, so the resolved
  computed style's first track IS the left bar's width - no hashed class names,
  and it tracks the bar opening, collapsing and being dragged.
- **Room**: it comes from the **middle and right columns only**, as their own
  `height: calc(100% - <dock>px)`; on close each gets back the inline height it
  had before this plugin ran. Both are found without hashed class names - the
  layout marks the right column itself (`data-rightbar-col`), the middle column is
  its immediately preceding sibling, and the frame's first element child (the left
  bar) is explicitly never one of them.
  - **Not the frame's height.** The frame has a single grid row, so shrinking the
    frame shortens the left column with it. alpha.1 did that, and the left bar's
    contents visibly slid up the instant the dock opened - the dock starts at the
    left bar's right edge, so the left bar has no business losing height.
  - **Not `padding-bottom` either.** The right column's panel is absolutely
    positioned inside it (`top:0; bottom:0`), and an absolute child is placed
    against its ancestor's *padding* box: padding would leave that panel exactly
    where it was and the dock would cover its bottom. A height shortens the column
    itself, so the panel ends at the dock's top edge like everything else.
- **Live moves**: a `MutationObserver` on the frame's `style` attribute (a drag
  rewrites it every frame), **plus a `ResizeObserver` on the two columns the dock
  spans and a `transitionend` on the frame**, plus a `resize` listener. The
  observers are not redundant: the LEFT BAR is animated, so collapsing or
  expanding it rewrites the grid tracks ONCE and then transitions them - the
  mutation fires while the computed track still reads the pre-transition value and
  is never called again, which left the dock standing at the old left edge with a
  stale width. What changes on every frame of that transition is the SIZE of the
  columns, which is what the ResizeObserver reports; `transitionend` is the final
  snap.
- **Intent vs geometry**: `data-open` is user intent, `data-suspended` is derived
  (a fullscreen right bar takes the viewport; the dock yields *and* hands the
  columns their height back for the duration). The observer writes only the
  derived one. This split is not cosmetic: the first spike run had the observer
  set the open state too, so the close that restored the frame's height
  re-triggered the observer and reopened the dock. The spike ran that scenario in
  a real engine before any of the package existed.
- **Resizing**: the grip drags the height (120px ... 70% of the viewport), it is
  remembered in `localStorage`, and every change **re-fits the emulator** - rows
  and cols recomputed from the new box, the new size sent to the PTY, and the view
  put back on the end of the output. Without that re-fit the panel keeps the old
  line count with the newest output out of sight, which is the pair of symptoms
  alpha.2 fixed.

**The bar's chip strip.** One chip per terminal, `+` beside it, and the strip is a
horizontally **scrolling** box. alpha.3 clipped what ran past the right edge
(`overflow:hidden`) and kept `+` *inside* the clipped region, so the control that
opens a terminal could scroll out of reach with the chips. Two rules keep it
honest: the strip measures its own overflow (`scrollWidth > clientWidth`, plus
each end, so a click at an end dims) and grows a `‹`/`›` pair only while there
really is some — the arrows are the affordance the strip wears **instead of** a
native scrollbar, which on a 24px row costs more height than it explains and
would shift the whole bar the first time a chip overflowed. A bare wheel over the
strip moves it (the pack's other scrollable surfaces do the same, and that
listener is NATIVE with `{passive:false}` because React's own wheel listener is
passive and a `preventDefault()` inside it is a no-op), and the chip on screen is
scrolled into view by the smallest amount that reveals it, measured against the
strip's own `getBoundingClientRect`. That last piece is a **pure function**
(`revealDelta`), exported as the bundle's `__internals` so the tracked check can
drive the arithmetic directly — a sign error there scrolls the strip *further
away* from the chip it was asked to show, which no static render can see, and the
check asserts both directions, the 8px of air and the no-op case.

Picking a chip **publishes** the pick. `runtime.show()` writes `dock.active`
straight into the store's map and re-fits the visible emulator, but it bumps no
revision — so a pick routed through it alone left React's `data-active` on the
chip the reader had just left: the terminal being shown changed and the highlight
did not (reported against alpha.3, fixed in alpha.4 by routing every pick through
one `selectSlot()` that writes the store, asks the runtime to show the slot and
bumps).

**Where the PTY comes from.** Not from this pack. The harness already ships
`node-pty` (ConPTY prebuilds for `win32-x64/arm64`, plus `darwin-x64/arm64` and
`linux-x64/arm64`) in its own dependency closure, so nothing is installed and
nothing is built natively. What an out-of-tree plugin must solve is
**resolution**: Node resolves bare specifiers by walking up from the importing
FILE, and this package's file is in this repository, so `import('node-pty')` from
here fails. `lib/pty.js` resolves through `process.argv[1]` (the running entry,
whose parent walk lands in that installation), then `$DSH_HOME/profiles` (which
`@deepseek-ai/dsh-app-boot` fills with the installation closure for exactly this),
then this package's own directory. `ws` is loaded the same way. Because node-pty
is a harness internal rather than a published API, resolution failure is a
first-class outcome: `health` answers `available:false` with the reason, the dock
renders it, and the boot is untouched.

**The routes.** Four authenticated HTTP routes through `connection.fetch` - the
mechanism §6 uses - and ONE **upgrade** route, which that mechanism does not
cover:

| Route | What it is |
|---|---|
| `GET /api/dsh-terminal/health` | PTY availability, the shell's label, the capacity, the platform |
| `GET /api/dsh-terminal/activity` | the agent view's read: this conversation's command-relevant session events, filtered and bounded (read-only) |
| `GET /api/dsh-terminal/vendor/xterm.js` / `xterm.css` | the vendored engine (ETag-cached), like §6's CodeMirror bundle |
| `WS /api/dsh-terminal/pty` | the terminal itself |

`ctx.webServer.registerUpgrade` hands the raw socket over, so this package
performs the gate itself - `connection.requestRejection(req)` (host/origin fence,
then browser authentication) and a raw `401`/`403` written into the socket when
it answers - the same two-step the product's own WebSocket mux performs. No
unauthenticated socket ever reaches a PTY. The protocol is text frames with a
`U+0000` prefix on control frames, because the shell's output is arbitrary text
and `cat` of a JSON file must never be mistaken for a control message
(`{"t":...}` as shell input is a tracked check). Backpressure pauses the PTY past
4 MiB of unflushed socket bytes rather than dropping output, and a heartbeat
drops dead sockets.

**Sessions.** One PTY per (conversation, slot), at most 8 per conversation, cwd
resolved exactly as §6/§7 resolve it. Output is retained in a 256 KiB scrollback
ring, and a session whose last socket goes away is kept for five minutes before
the reaper ends it - so a reload (or closing the dock) reattaches and replays
instead of losing the shell. Every timer is `unref`ed: a terminal can never hold
the harness process open. `pid` is reported `null` in the first `ready` frame on
Windows, where node-pty answers `0` until ConPTY has attached.

**The vendored engine.** xterm.js 5.5.0 plus `@xterm/addon-fit` 0.10.0, built by
`packages/dsh-terminal/vendor/` exactly the way §6 builds CodeMirror (npm install
+ one documented esbuild line), producing `lib/vendor/xterm.js`
(`window.DSHTerminal`) and its stylesheet. The browser half fetches them lazily
the first time a dock opens and injects the script through a blob URL.

**A terminal is an unsandboxed shell.** That is what a terminal is: it does not
pass through the file-policy sandbox the model's tools obey. The gate is the
connection's own authentication, and the dock exists only where `webServer` and
`connection` do.

**The agent's own terminal use (alpha.7; read from the host since alpha.8).**
The dock's second view: a reading of the conversation, not a second shell. The
agent's `bash`/`pwsh` run in the harness's own process through its shell tool and
cannot be attached to the PTY in this panel, so the view is a *transcript* - it
adds no PTY and no host state, and its one route is read-only. An `Agent` switch
in the bar puts an `Agent` chip at the head of the existing strip and shows it;
switching it off hands the panel back to the terminal that was last on screen.
The view is `ACTIVITY_VIEW = -1`, an index no slot has, which is what lets it ride
the SAME `dock.active` cell and the SAME `DockRuntime.show()` the terminals use:
showing `-1` hides every emulator, and the emulators stay mounted behind it
because a shell is a process that hiding must not detach. The toggle is remembered
per origin in `localStorage` - and deliberately NOT in the pack's shared section,
because promoting it would mean adding a field to `dsh-ui-state`'s durable schema,
i.e. changing another package's data contract for a boolean.

**Where those events come from, and why from the HOST.** The harness's client does
expose a session's live event window (`sessions.binding(id).eventSource`), and
alpha.7 read exactly that. It is the wrong source for a panel that must be useful
the moment the app opens: the window opens only once the browser has taken that
conversation onto its **stage**, so the panel sat on "Reading the conversation..."
until something else moved the session along. The host owns the log, so this
package serves it - `GET /api/dsh-terminal/activity?session=<id>` answers a
filtered **tail** from the host's own `sessions` service (`get(id)` ->
`snapshotEvents()`, the contiguous in-memory log) and the BROWSER folds it with the
same pure fold the tracked check drives. That division is deliberate: the host is
the only place that always has the log, and the fold stays one implementation, so
the panel and the check cannot drift about what a command is. The route is
read-only, filtered and bounded: only `tool/call`, `tool/result` and a HUMAN
`user/message` are sent, at most 400 events and roughly 512 KiB from the newest
end, `hasMore` says when older ones were left out, and the newest event is always
included even when it alone is oversized, because one enormous command must not
leave the panel with nothing to draw. A conversation that is not open on this host
answers `NOT_LIVE` with a **200** - a fact about the host, not a bad request. The
panel re-reads that route every 6 seconds, every 2 while a command is running,
stops when nothing is subscribed, pauses in a hidden tab, and publishes nothing at
all when the fold's signature is unchanged.

The read model is **pure** and exported for the check: `parseExecCall` (the
executing tools only - `bash`/`pwsh`, foreground *and* persistent, where a missing
`description` marks the persistent one, plus `run_code` and `terminal_send`),
`parseExitMarker` (the `[exit code: N]` / `[killed by signal: X]` contract
`dsh-shell/render` owns, MIRRORED rather than imported exactly as the shipped
terminal card does, and read only for a foreground shell - a persistent shell can
report resets and partial output without any single exit status, so it claims
none), `stripAnsi`, `formatDuration`, `filterActivity` (the filter is applied at
render time, so changing it never re-reads the conversation) and
`buildActivityFromEvents`. `activitySignature` is what makes the view affordable:
the poll runs every few seconds and the log is append-only, so a signature over the
seq of the events this view consumes changes only when something it DRAWS changed -
otherwise a poll costs one idle request and no re-render.

Every limit is drawn rather than smoothed over: output arrives at **settle**, not
live (the harness has exactly two tool events and no output stream), a result
whose `tool/call` is outside the tail is kept but names no tool and claims no exit
status, older events outside the tail are named instead of paged, and
`Run in Terminal` - which TYPES a command into your own shell without submitting
it - is refused for a multi-line command, whose newlines would submit themselves as
they were typed.

**A row's status is drawn on the row itself (alpha.9).** The status used to be a
rail on the LEFT of the block and only for a failure, so a command that succeeded -
the overwhelmingly common row - drew nothing at all, and the line a reader actually
scans (the clickable head that drops the output down) carried no mark of its own.
Every row now wears the status colour on BOTH rails - green for `exit 0`, amber
while running, red on a failure, a signal or an error - and its head wears a light
`color-mix(..., transparent)` wash of the same colour. The tone is ONE custom
property (`--dst-accent`) set per `data-status`, so the two rails, the wash and the
status pill cannot drift apart, and the wash is mixed with `transparent` rather than
with a surface colour, so it lightens a light theme, darkens a dark theme, and
leaves the label's own themed colour alone.

**What the checks pin.** `check-node-routes.mjs` drives the real protocol against
a real PTY (`init` -> `ready` -> a command answered -> `kill`), proves a JSON line
is shell input rather than a control frame, proves an unauthenticated upgrade is
refused - skipping only the live part, loudly, on a host with no PTY - and drives
the activity route against a stubbed live session: only the three event types the
panel draws are sent, injected context and assistant streams are dropped, the
answer is in log order, a conversation that is not open answers `NOT_LIVE`, an
unreadable log answers `UNREADABLE`, a missing session id is a 400, and a
conversation past the budget answers with its TAIL with `hasMore` set (including
the single oversized newest command). `check-client-bundles.mjs` pins the bundle
id, both seats, the order and the rendered markup, plus (alpha.7) that the switch
is a MODE, that the bundle reads the route rather than the browser's session
window, that the poll stops when nothing is subscribed and pauses in a hidden tab,
(alpha.9) that the stylesheet carries the row's status dress - both rails, the tone
in one property per `data-status`, and the head's wash - and then DRIVES the whole
read model with hand-built session events (the executing-tool parse, the
exit-marker contract, the fold's grouping and statuses, the signature) and RENDERS
the view itself with a hand-built log, because the switch is off by default and a
static render of the dock can never reach a row.

## 12. The installer

The installer is **two halves, one behaviour** - the host picks the half, and
neither half needs the other:

| Host | Script | Runner | Needs |
|---|---|---|---|
| Windows | `scripts/install-all.ps1` / `uninstall-all.ps1`, root `run-web.bat` + `scripts/run-web.ps1` | `scripts/*.bat`, root `install.bat` / `uninstall.bat` | Windows PowerShell 5.1 or 7 |
| macOS / Linux | `scripts/install-all.sh` / `uninstall-all.sh`, root `run-web.sh` | `scripts/*.sh`, root `install.sh` / `uninstall.sh` | POSIX sh (dash/bash) + Node.js with npm/npx - **never PowerShell** |

Both are ASCII-only; the `.sh` half is POSIX (no bashisms, no `sed`/`grep`
pipelines - the JSON/YAML parsing is done by `node -e`, which is a prerequisite
anyway), and both halves accept the same flags (`-Force`, `-Plugin`, `-DshHome`,
`-ProfileName`, `-DshVersion`, `-Target web|cli`, `-NoPause`), print the same
messages and reach the same profile state. The root install and uninstall
launchers are the friendly pair: they add force-the-re-add semantics unless the
caller asked already. `scripts/sync-vendored.ps1`
is **maintainer tooling**, not an installer, and is the one script here that wants
`pwsh` on macOS/Linux.

### The console layer every launcher shares

Five Windows entry points (`install.bat`, `uninstall.bat`, `run-web.bat`,
`run-desktop.bat`, `distribute.bat`) plus the generated `START-HERE.bat` all have
to answer the same questions before doing any work, so they answer them in ONE
place - `scripts/console/adapt.cmd`, which they reach with `call` (batch has no
`include`) and which is deliberately **not** `setlocal`'d, because everything it
decides must still be set when it returns:

| It decides | How |
|---|---|
| Which window | relaunches itself in **Windows Terminal** (`wt.exe -w new`) when wt exists, `WT_SESSION` is unset, and neither `-NoTerminal` nor `VN_HARNESS_NO_WT` opts out; a `wt.exe` that fails falls back to the current console rather than losing the run |
| Which PowerShell | `pwsh` 7 when PATH has it, else Windows PowerShell 5.1 - both first class, because 5.1 is what a stock Windows ships |
| Whether to pause | exports `VN_HARNESS_PAUSE`; `-NoPause` / `VN_HARNESS_NOPAUSE=1` / `VN_HARNESS_QUIET` clear it, so a scripted run is never held open |
| The real arguments | exports `VN_HARNESS_ARGS` - entry points forward THAT and never `%*`, because after the relaunch `%*` is only the `--from-terminal` marker |

The marker variable `VN_HARNESS_CONSOLE` is what makes that last row safe: the
callers guard their argument capture with `if not defined VN_HARNESS_CONSOLE`, so
the relaunched child keeps the inherited real flags. The colour policy and the
shared wording live in `scripts/console/theme.ps1` (dot-sourced by the PowerShell
workers, which keeps `[Console]::OutputEncoding` at UTF-8 so a Node program's
output survives the trip) and in its POSIX twin `scripts/console/theme.sh`
(sourced by the `.sh` entry points, which must never run PowerShell). Colour is
allowed only on a real terminal, never in a redirected log, and `NO_COLOR`
always wins. `scripts/checks/check-dist-layout.mjs` pins the whole contract,
including that `theme.sh` stays POSIX and that `adapt.cmd` keeps its fallback.

**The run launcher.** `run-web.bat` / `run-web.sh` are the launcher's two ENTRY POINTS -
one per host, both at the repo root - and are not an install step: they
start the app the docs would otherwise ask for by hand -
`npx --yes @deepseek-ai/dsh@<pin> web --no-open [--port <n>]` - and open the URL
the app prints once it is listening. On Windows the entry point is `run-web.bat`, a
double-click wrapper that forwards its flags to `scripts/run-web.ps1`, the worker
beside the installer scripts; macOS/Linux have no worker, because POSIX `read`
already streams the app's output line by line, so `run-web.sh` does the whole job
itself. The Windows split is FORCED, not stylistic: cmd's `for /f` reads a child's
output only up to EOF, so a pure batch launcher cannot see the ready line while the
harness is still running. Each half reads `.dsh-version.json` from the repo root -
`$script_dir` for `run-web.sh` (it lives there) and
`Split-Path -Parent $PSScriptRoot` for the worker. On Windows the launcher is
`run-web.bat [flags]`, and a double-click is the point: batch carries no
execution-policy question. Both halves follow the same four steps and
accept the same flags (`-Port`, `-DshHome`, `-DshVersion`, `-NoBrowser`,
`-DefaultBrowser`):

1. **stream** the app's own stdout/stderr to the terminal unchanged, so the
   session looks exactly like a hand-typed `dsh web` (the PowerShell half leaves
   stderr unmerged - `2>&1` into the pipeline turns npm warnings into a
   terminating `NativeCommandError`; the shell half pipes both through a FIFO);
2. **watch** it for the ready line, `dsh web: http://127.0.0.1:<port>/?token=…`
   (printed by `dsh-web-app` when `printUrl` is on, which is the default, and
   kept apart from the optional `(LAN: …)` tail that follows it);
3. **check it is loopback** (`127.0.0.1`, `::1`, `localhost`) and refuse
   anything else - the query carries the process's launch token, the value the
   server exchanges for the browser session cookie, so it must never be handed
   to a browser pointed at another host;
4. **open it**, in Chrome (PATH, the standard install folders, or Windows'
   `App Paths` registry entry; `/Applications/Google Chrome.app` on macOS;
   `google-chrome`/`chromium` on Linux) and in the platform's default browser
   when Chrome is not installed.

The token stays **in memory**: neither half writes it to a file (the shell half
uses an anonymous FIFO rather than a temp log precisely for that), neither echoes
it itself, and it reaches the browser as a single argv element - never through
`cmd /c start`, `sh -c` or any other command string. On Windows that element is
built by `Start-Process -ArgumentList @($Url)` in `scripts/run-web.ps1`; the root
`run-web.bat` above it only forwards flags and never sees the URL at all. `--no-open`
is what keeps the hand-off single: the app must not also start a browser. The
harness runs in the foreground, so Ctrl+C stops it and each half reports the app's
own exit status (the shell half reads the child directly instead of through a
pipeline subshell, which is what makes `wait` meaningful; the PowerShell half gets
the native command's `$LASTEXITCODE` after its streaming pipeline, and `run-web.bat`
passes that through as the batch's own exit code).

- **Detection**: one target - `DSH_HOME` env, else `~/.dsh`; profile `web`
  (`-DshHome` / `-ProfileName` override both). `-Target` still exists but accepts
  only `web` and `cli`, and both mean the web profile, so a stale
  `-Target desktop` invocation fails loudly instead of silently doing nothing.
- **Platform facts**: each half resolves its own host once. The PowerShell half
  derives the path separator, the directory separator, the home directory
  (`HOME`, else `USERPROFILE`, else the profile-folder API) and each tool's name
  (`npx.cmd` / `npm.cmd` / `pnpm.cmd` on Windows, bare names elsewhere) through
  `Get-ToolPath` / `Get-ToolNames`, and builds every path with `Join-Path`. The
  shell half needs none of that: it is already on a POSIX host, so it uses
  `command -v`, `${VAR%pattern}` and a `case`-based argument loop.
- **dsh/pnpm invocation**: every operation runs
  `npx --yes @deepseek-ai/dsh@<pinned>` (pinned in `.dsh-version.json`). pnpm is
  reused when the system one is new enough and otherwise bootstrapped locally
  under `tools/pnpm<major>`: both halves read the profile's
  `node_modules/.modules.yaml`, pick the matching pnpm major, export
  `npm_config_virtual_store_dir_max_length` and the workspace-root-check opt-out
  (`npm_config_ignore_workspace_root_check=true`) because dsh profiles are pnpm
  workspace roots (`packages: [.]`), and prepend the resolved pnpm bin directory
  to `PATH`. The PowerShell half additionally invokes npm through the `npm.cmd`
  spelling (a `npm.ps1` resolution mangles `pkg@version` arguments) and judges
  native calls by exit code alone because stderr becomes a terminating
  `NativeCommandError` under `$ErrorActionPreference = 'Stop'`.
- **Idempotency**: bundles already in `dsh.profile.bundles` are skipped
  unless the flag forces a re-add **or the repo version changed**.
- **Dev sync**: both halves compare the repo `package.json` version against the
  version the profile resolves (`Get-EffectiveInstalledVersion` in PowerShell,
  `effective_version()` in shell). A plain `install.bat` / `./install.sh` after a
  version bump therefore re-adds the bundle, so development changes actually
  reach the profile.
- **Live links**: the web profile installs every bundle (`dsh-vn-master` — the
  blank master, so a profile that lists it still gets no client half — plus
  `dsh-rightbar`, `dsh-rightbar-files`, `dsh-editor`, `dsh-gittree`,
  `dsh-image`, `dsh-audio`, `dsh-diagrams`, `dsh-pdf`, `dsh-terminal`, `dsh-modal`,
  `dsh-ui-state`, `dsh-themes`, `dsh-open-in-app`) as `pnpm link:` symlinks straight into this repo (detected by
  `Test-LiveLink` / `is_live_link()`, comparing realpaths case-insensitively on
  Windows). Code edits then already apply - a restart of
  `npx @deepseek-ai/dsh web` plus a hard browser refresh is all it takes; the
  installer prints that instead of re-adding.
- **Fork re-sync**: `scripts/sync-vendored.ps1` is the installer's sibling for
  the three forked client bundles (§4, §10). It is *not* run by the installers -
  moving a fork forward is a reviewed change, not an install step. Its candidate
  roots cover the profile, the Windows npm cache (`%LOCALAPPDATA%`/`%APPDATA%`),
  `~/.npm/_npx`, and the POSIX global module directories.
- **Retired-name prune**: both scripts remove a profile's stale `dsh-focus`
  and `dsh-files` bundles (kept in `$legacyNames`) before installing, so an
  upgrade from the pack's own-Files era drops the old rows/dock instead of
  double-mounting. Add future removed/renamed packages to that list in both
  scripts.
- **Uninstall** removes the package and therefore its patch layer. Removing
  `dsh-rightbar` also removes the disables, so the shipped rows come back on the
  next boot.

## 13. Versioning and upgrade path

- `.dsh-version.json` pins the dsh line, the `vendoredFrom` line the fork was
  taken from, and per-package versions.
- Packages stay `-alpha.N` until the owner says "make it stable".
- When DSH publishes a newer line: bump the pin, run `sync-vendored.ps1` (then
  review the diff - a fork does not track upstream), re-install with `-Force`,
  and adapt the affected API seams. The seams most likely to change, in order:
  the right-bar tab registry shape (`register`/`openResource`/guide entries) and
  the keyed tab seats with their framework props (`useTabInfo`, `sessionId`,
  `useSessions`) - both of which this pack now owns, so a change there is a
  merge into the fork rather than a break - the patched `launch()` of the
  open-in-app client bundle (§10, the re-sync fails loudly when it moves), and, on
  the Node side, the route registration surface (`connection.fetch.register`,
  where a route must declare `requestBody` or its handler never runs) and the
  session-root lookup.

## 14. Troubleshooting quick table

| Symptom | Cause / action |
|---|---|
| Old panel still showing after edit | client bundle is read at boot; restart the app and HARD-refresh the browser (Ctrl+F5). The web profile is a live link, so no reinstall is needed |
| The right bar is missing entirely | the fork did not load: confirm the boot HTML lists `dsh-rightbar/client.js`, and that `dsh-rightbar`'s layer still disables `ui-sidebar-right` / `ui-sidebar-files` (a profile patch that re-enables them mounts two bars, which throws on the duplicate tab-type ids) |
| The master is in the profile but serves no bundle | expected: `dsh-vn-master` is the blank master. With no `dsh.client` it must NOT appear in the boot HTML; only its no-op `master` row joins the host tree |
| The bar is the shipped one, not the pack's | `dsh-rightbar` is not in `dsh.profile.bundles` (or the row id was renamed); re-run the installer (`install.bat` / `./install.sh`), then restart |
| Two Files panels / a stray dock after upgrading | the retired `dsh-files` (or `dsh-focus`) bundle is still in the profile; re-run the installer (its prune removes both) |
| No "Editor" in the "+" / Start page | the client bundle did not activate: check the browser console for `[dsh-editor]`; a `sidebarRightTabs` service that never appears leaves activation pending |
| Editor says "Editor unavailable (HTTP 400)" on the engine | the Node route is missing `requestBody: 'buffered'`, so Connection's bridge throws before the handler runs and the web server answers a bare 400 |
| Clicking a file opens the read-only preview instead of the editor | the address was vetoed by `canOpen`: a preview-owned extension (html/image/pdf/…), a path outside the session workspace, or an `absolute/…` address. Markdown is NOT one of them - it opens in the editor |
| Save-as says the name is taken / the folder is missing | `409 EXISTS` (pick another name - the dialog stays open with what you typed) or `404 NO_FOLDER` (a subfolder path must already exist; nothing creates directories) |
| The rendered Markdown page has no **Edit** button | the editor's shadow body is not rendering: confirm the boot HTML lists `dsh-editor/client.js` at alpha.7+, and that the shipped body still registers under `sidebar.right.tab.document` keyed `@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown` (the key this pack's lower-priority entry shadows) |
| The Markdown page is double-spaced, or its **Edit** pill looks monospaced | the preview's plain-text scrollport is leaking in (`[data-textpreview-body]` declares `white-space:pre` + a mono stack) - the pack's wrapper reset it from alpha.8 on; confirm the served `dsh-editor` bundle prints alpha.8+ and hard-refresh |
| A Markdown tab still shows a "Markdown / Plain text" viewer menu | `dsh-themes` alpha.3 hides it (`body [data-document-preview="…/markdown"] [data-document-viewer-menu]`); reinstall so that version is in the profile, then restart |
| Save-as shows no dialog, only a browser prompt | `dsh-modal` is not mounted, so the editor fell back to `window.prompt`; re-run the installer with `-Force` and restart to add the bundle |
| The "Open In…" File Explorer entry still does nothing | the forked row is not the one running: confirm the boot HTML lists `dsh-open-in-app/client.js` and not `@deepseek-ai/dsh-client-ui-open-in-app`, and that `dsh-open-in-app`'s layer still disables `ui-open-in-app` |
| Editor tab says "Could not open the file" / `NO_WORKSPACE` | the session root could not be resolved (session not live and not persisted yet) or the path is outside the conversation folder; open the conversation once so its header is available |
| Save answers "Changed on disk" | the file moved under you; use **Reload** (take the disk copy) or **Save anyway** (overwrite it) in the banner |
| Code text is black-on-dark in the light theme | the editor did not follow the scheme: confirm the bundle is alpha.5+ (`dsh-editor` prints its version in the tab's file bar) and that ui-layout still writes `body[data-ds-dark-theme]` |
| No Themes button in the header | `dsh-themes` is not mounted (a new package needs one install run: `install.bat` / `./install.sh`, or `-Force`), or the row did not land: check the console for `[dsh-themes]` |
| No Page-zoom button in the header | the same row as the Themes button — all four controls are one bundle. Inside the native window it is the only way to zoom at all (the shell has no Ctrl+ / Ctrl- page zoom); confirm the served `dsh-themes` bundle prints alpha.15+ |
| The page is stuck at a zoom level in the native window | the level is remembered per origin in `localStorage['dsh-themes.page-zoom']`; the button walks it back (it is the leftmost of the four, and the ladder stops at 200% precisely so it cannot go off-screen), and clearing that key resets it to 100% |
| The right bar cannot be dragged after zooming | the bug alpha.16 fixed: the frame's own pixel arithmetic placed the right seam from the SCALED rect it measures, so a level in force slid the seam off the column's edge (the LEFT bar was fine, its `left` being layout pixels). Confirm the served `dsh-themes` bundle prints alpha.16+ and that the browser supports CSS anchor positioning (Chrome/Edge 125+); the seam override is inert at 100%, so returning to the resting level also restores the old behaviour |
| The Themes button is greyed out | the `theme` service never appeared, so `@deepseek-ai/dsh-client-ui-theme` (row `ui-theme`) is not in the boot graph; the tooltip says "The theme service is unavailable" |
| Fork drift after a harness update | `scripts/sync-vendored.ps1 -Check` exits 1; run it without `-Check` and review the diff |
| No "History" capsule on the "+" / Start page | `dsh-gittree` is not mounted (a new package needs one install run: `install.bat` / `./install.sh`, or `-Force`), or its client bundle did not activate - check the console for `[dsh-gittree]` |
| The History tab says "Not a git repository" | the conversation folder is not inside a repository: the route runs `git rev-parse --show-toplevel` from it and answers a typed `NOT_A_REPO` instead of guessing |
| The History tab says "git is not installed" | `git` is not on the **server's** `PATH` (the routes spawn it directly and report `GIT_MISSING`); install git on the host running `dsh web` |
| The History list is empty although the repository has commits | the folder lives inside a repository whose root is higher up, so commits that never touch this folder are deliberately hidden; check `git log` in that folder |
| No Terminal button in the conversation header | `dsh-terminal` is not mounted (a new package needs one install run: `install.bat` / `./install.sh`, or `-Force`), or the bundle did not activate - check the console for `[dsh-terminal]` |
| The dock says "No terminal on this host" | the harness installation's `node-pty` could not be resolved from this process (`process.argv[1]`, `$DSH_HOME/profiles`, or beside the package); the dock's notice carries the reason, and `GET /api/dsh-terminal/health` reports `available:false` with it. The rest of the pack is unaffected |
| The dock does not open, or opens at the wrong place | the frame it measures is gone: the dock positions itself from `[data-shell-overlay]`'s parent and that frame's resolved `gridTemplateColumns`, so a harness line that stops using grid columns for the layout needs §11 updated |
| The terminal panel covers the conversation instead of pushing it up | the middle/right columns' inline `height: calc(100% - <dock>px)` was removed or overridden by something else writing their `style.height` |
| Opening the dock moves the LEFT bar (its items slide up) | regression of alpha.1, where the room came from the frame's own height: the frame has ONE grid row shared with the left bar, so only the two columns the dock spans may be inset. The check `terminal never resizes the frame` pins this |
| The terminal shows the wrong number of lines, or the newest output is out of view after a resize | the emulator was not re-fitted: a size change must recompute rows/cols from the new box, send `resize` to the PTY, and `scrollToBottom()`. Pinned by the check `terminal refits on resize and follows the end` |
| The dock keeps the old left edge after collapsing/expanding the left bar | only the frame's `style` mutation was being watched. The left bar is ANIMATED (one grid rewrite, then a transition), so that mutation reports the pre-transition value and never fires again - the `ResizeObserver` on the two columns is what follows it. Pinned by the check `terminal tracks the animated left bar` |
| The chip you just left keeps the selected dress after clicking another one | the pick went through `runtime.show()` alone, which writes `dock.active` into the store's map and bumps no revision, so React keeps the `data-active` it rendered last. Every pick must go through `selectSlot()` (store, then show, then `bump()`). Pinned by the check `terminal chip pick publishes to the store` |
| Terminals past the right edge of the bar cannot be reached | `.dst-chips` went back to `overflow:hidden` (alpha.3), which also traps the `+` inside the clipped strip. It must be a horizontally scrolling box with the `+` outside it. Pinned by the checks `terminal chip strip scrolls instead of clipping` and `terminal strip arrows ride on measured overflow` |
| The left bar still shows the fish / "deepseek" wordmark | `dsh-themes` alpha.6 hides whatever occupies `sidebar.brand.mark` / `sidebar.brand.name` and draws the VN mark instead; confirm the served `dsh-themes` bundle prints alpha.6 and hard-refresh. If the sidebar's hashed classes changed in a harness bump, the rule (pinned to them) needs updating |
| A terminal prints nothing after a page reload | the shell is kept only five minutes after its last socket (`DETACH_GRACE_MS`); past that it was reaped and the dock opens a NEW shell in the same folder |
| The terminal's `Ctrl+C` copies instead of interrupting | it must not: `Ctrl+C` is SIGINT and clipboard is `Ctrl+Shift+C` (`Cmd+C` on macOS). A single-key difference here is a bug, not a preference |
| Installer fails with `virtual-store-dir-max-length` | profile created by a different pnpm major; both halves read it from `node_modules/.modules.yaml` and auto-match - re-run the installer |
| `-Target desktop` is rejected | intentional: DSH Desktop is no longer a target of this pack |
| `.ps1` parse error after editing | non-ASCII character crept in (smart quotes/dash); keep scripts ASCII-only |
| `sh -n` fails after editing a `.sh` | a bashism crept into the POSIX half (arrays, `[[ ]]`, `local`); keep it dash-compatible |
| `./install.sh: Permission denied` | the executable bit was lost in a copy: `chmod +x install.sh uninstall.sh scripts/*.sh` |
| `./install.sh` reports a missing command | Node.js (with npm/npx) is not installed - the shell half needs Node, never PowerShell: https://nodejs.org |
| `scripts/sync-vendored.ps1` cannot find `pwsh` | expected on a host without PowerShell 7: that script is maintainer tooling. Install PowerShell 7 (`brew install --cask powershell`, or the package for your distro) or run it on Windows |
| A path with a backslash fails on macOS/Linux | a Windows-only path crept into the PowerShell half (the POSIX half never sees one): build paths with `Join-Path` and take the separator from `[System.IO.Path]` |

See also: `docs/INSTALL.md` (human steps) and `docs/COMPATIBILITY.md`
(version matrix).

## 15. The diagrams plugin (dsh-diagrams)

The pack's first **tool-owned** surface: the model writes a diagram with a tool,
the host validates it, and the result is both a conversation card and a tab of
its own. It is placed last here because it is the newest section, not because it
runs last: it is an ordinary row beside the editor, the History tab and the
terminal.

**What it is.** One row (`diagrams`), six tools (`diagram_write`,
`diagram_patch`, `diagram_read`, `diagram_verify`, `diagram_publish`,
`diagram_delete`), two bundled skills (`mermaid-diagrams`, `tikz-diagrams`, each
with a `reference/complex-diagrams.md`), two tab types (`diagram` - one per
diagram, a resource address; `diagrams` - the conversation index, a page with
the guide entry at `order: 40`) and one `tool.call.toolview` card per tool. The
package README is the reference; this section records the decisions that had to
be made against the harness line, because each of them closed off an obvious
alternative.

**Verdicts are objective, and there is one of each.** Three questions are easy to
collapse into one and must not be: *does the source parse* (`status`), *is the
picture the one you meant* (the advisory `warnings`), and *did a renderer
actually draw THIS revision* (`verification.state`). The third is the one only a
browser can answer, so the browser posts what it did to `/render-report`, the
host stores it against the revision it drew, and **one function**
(`verificationOf` in `lib/store.js`) turns it into `drawn` / `failed` / `stale` /
`pending` for the tool result, the state route and the tab pill alike. The
verdict carries both revision numbers (`revision` = current, `reported` = what
the newest report names), so `stale` is read rather than guessed, and a missing
report is `pending` - never a picture. The same discipline applies to TikZ: a
cache hit re-reads the verdict the compile was cached WITH, because a failing
compile that still produced a PDF is cached deliberately, and assuming `ok` on
the second call was the plugin telling the model its own diagram was fine.

**The tab is a reading surface, not just a renderer.** A diagram is laid out at
80% of the pane - read it whole first - with a zoom ladder (25%-400%) over it,
and **drag to pan** once it overflows. The ladder widens the layout BOX instead
of applying a CSS `transform`: a transform scales into a clipped box with no
scrollable area, and the left edge of a zoomed diagram could never be reached.
Two details are load-bearing and both were bugs first: a zoomed box must
`align-self: stretch` its children (a column flex container sizes children to
their CONTENT on the cross axis, so the picture wrapper stayed at the svg's
natural width and the box zoomed while the diagram did not), and the pan is the
container's own `scrollLeft`/`scrollTop` - nothing is transformed or
repositioned, the wheel keeps working, and the grab cursor is measured from real
overflow rather than assumed from the zoom level. A zoom also remembers the point
the reader was looking at and restores it on the next animation frame (after
React commits and the browser lays out, before the paint), so the picture never
jumps.

**Exports leave the workspace on purpose.** `Export` saves every format to the
**Desktop of the machine running the harness**, through the same route pattern
the screenshot control uses: the client names a format and never a path, the host
resolves the Desktop per request (OneDrive-redirected Windows, `XDG_DESKTOP_DIR`
on Linux, the home folder last) and writes create-exclusively. A diagram is
something a person keeps, the Desktop is where that person is looking, and the
conversation folder is not a place to drop files the user did not ask for. The
browser download stays as the fallback for a profile whose host row is absent.

**The library is a scope, not a second plugin.** A diagram used to belong to the
conversation that drew it and to nothing else, which makes a good one disposable:
the JEPA figure you want to cite next week lives in a chat you have closed. The
fix is not a second store implementation but a second SCOPE: the same
`DiagramStore` class, constructed with a fixed file name
(`$DSH_HOME/dsh-diagrams/library.json`) instead of one name per conversation, so
the library gets the same caps, the same atomic temp+rename write, the same
render reports and the same source budget - and `deps.storeFor(scopeKey)` is the
only seam every tool and route goes through. Two consequences are load-bearing.
**A bare id resolves library-first** (`locate`), because the library is the
citable namespace: `diagram_read { id: "jepa-model" }` has to mean the shared
diagram even when a scratch diagram in this chat shares the id, or a citation
would resolve differently in every conversation. And **the address carries the
scope**: `dsh-resource://diagram/library/<id>` names no conversation at all,
which is what makes it durable and what lets one tab type claim both address
shapes. The artifact cache stays global and content-addressed, so the library
copy of a diagram compiles to the SAME artifact as the conversation copy - which
is also why deleting a diagram no longer drops its hash blindly: an identical
diagram elsewhere is the same file.

**Why the state is a file, not a session event.** The first design appended
`diagram/write` to the session, folded it into a projection, and let the client
read it with `useProjection`. It cannot work on this line:
`@deepseek-ai/dsh-session-persistence` **throws** when it reads a log containing
an event type outside `KNOWN_SESSION_EVENT_TYPES` unless the envelope carries
`ignorable: true`, and `Session.append(type, data, ...opts)` has no way to set
that marker (its third argument is surface metadata only). A plugin-owned event
type would therefore make the conversation unloadable the moment it was
persisted. State is one JSON file per conversation instead
(`$DSH_HOME/dsh-diagrams/sessions/<session>.json`, atomic temp + rename), which
also removes the second problem: a `sessionProjections` unit requires `zod`
schemas, and this pack ships **zero npm dependencies** - the profile installs
bundles as live `link:` deps, so a package dependency is not installed. The
model reads that state back through `diagram_read`, which is what makes a
diagram survive compaction, a reload or the browser closing. Its caps are a
budget, not a formality: 256 KiB per source, **4 MiB of source per
conversation** (enforced on write AND patch, with a typed `BUDGET` error), and a
16 MiB file cap that nothing this plugin writes can reach - because the failure
mode it prevents is silent: a state file past the cap reads as EMPTY, and every
diagram in the conversation disappears at once.

**Why the vendored engine is one big file.** `Connection`'s fetch registry
registers **exact** routes; there is no wildcard, and the method vocabulary is
`GET | HEAD | POST`. Mermaid's chunked ESM build (`dist/chunks/mermaid.esm.min/**`,
104 files) would have needed 104 routes, and its Node flavor keeps ~30 MB of
dependencies as bare imports. Mermaid's own **single-file browser build**
(`dist/mermaid.min.js`, ~3.4 MB) solves both: one self-contained file, one
route, no relative chunk requests - and because it is a classic script whose last
line is `globalThis["mermaid"] = ...`, the browser loads it with a script tag
while the host loads **the same bytes** through `node:vm` behind a DOM stub. That
is also why every write route is a POST and there is no PUT anywhere in this
package.

**Validation is the feature.** Both engines run the real thing before the
diagram is stored:

- **Mermaid** is parsed by a **child process** (`lib/mermaid-check.mjs`) that
  installs a ~60-line DOM stub (enough for the bundled DOMPurify's support probe
  and the parsers) and evaluates the vendored engine, then calls `mermaid.parse`.
  A child is not decoration: putting `document`/`window` on the harness process'
  globals could change other plugins' behaviour, and a crash in a 3.4 MB engine
  must never take the host down. A validator failure is reported as
  `unavailable`, never as a diagram error - telling the model its diagram is
  wrong when the checker is what broke would be a lie.
- **TikZ** is compiled by the machine's own engine (`lib/latex.js`: `pdflatex`
  else `xelatex` else `lualatex`; `tectonic` is deliberately refused because it
  downloads packages), argv-only, with `-no-shell-escape`,
  `MIKTEX_AUTOINSTALL=0`, `openin_any=p` / `openout_any=p`, a private temp cwd, a
  20 s kill and a capped transcript. `-file-line-error` is what makes the
  feedback line-accurate (`diagram.tex:12: Package pgf Error: ...`), and the
  located form is preferred over the coarser `! ...` form when both describe the
  same failure.

The write path itself is normalized before compiling: a bare TikZ body gets the
standard preamble **and** a `tikzpicture`, leading `\usepackage` /
`\usetikzlibrary` / `\tikzset` lines are hoisted into the preamble, and a full
document is used verbatim. A single environment normally gets only the preamble -
**except** the pgfplots ones, which get the `tikzpicture` too, because measured
against this host an `axis` at the top level of a `standalone` document does not
compile at all (`LaTeX Error: Environment axis undefined`, then every `\addplot`
an `Undefined control sequence`), while the very same axis inside a picture
compiles cleanly. `tikzcd` and `circuitikz` are the exceptions: they are
self-contained and are never wrapped. The library
list is generous (including `positioning`, `arrows.meta`, `matrix`, `fit`,
`backgrounds`, `automata`, `graphs`, `trees`, `pgfplots`) because a missing
library fails the whole compile with "I do not know the key", which is a bad
trade against a few hundred milliseconds.

The DOM stub is not decoration either: it has to expose what the engine actually
reaches for. `window.CSS.supports` is the one that bit - the sequence-diagram
`box` parser calls it and falls back to `new Option()` when `window.CSS` is
absent, so **every** `box` diagram died with "Option is not defined" and came
back `unavailable`, stored but never checked. A stub that answers the browser's
own questions keeps the parser in the branch the browser takes.

**Rendering split.** Mermaid is drawn **in the browser** from the source (themed
off the app's light/dark scheme, cached per `(source, theme)`); TikZ is drawn
from the **host's compiled artifact** - `pdftocairo -svg` emits glyph outlines,
so the picture is vector and font-independent - fetched as a blob and shown
through an `<img>`. A compile that failed but still produced a PDF is cached and
shown **flagged as errored**: a hint about what LaTeX understood, never proof
the diagram is right. Artifacts are content-addressed
(`artifacts/<sha256[0:24]>/{doc.tex,doc.pdf,doc.svg,doc.png,meta.json}`, LRU at
200 MiB), so returning to a previous revision is an instant hit and deleting the
cache costs only a recompile.

**Skills travel two ways.** The two `SKILL.md` files live in the package (they
are the source of truth) and the row registers them at runtime from that folder,
so a manually-added bundle still gets them. Both installers additionally copy
each `<package>/skills/<name>/` into `$DSH_HOME/skills`, where the harness' own
filesystem provider reads them and a person can edit them without touching this
repository; every folder the installer creates carries a
`.vn-harness-<package>` marker, so a person's own skill of the same name is never
overwritten and uninstall removes exactly what it wrote. The copy is recursive,
which is what lets each skill carry a `reference/complex-diagrams.md` beside its
`SKILL.md`, and `check-skill-examples.mjs` parses or compiles every fenced
example in those files with the same engines the plugin uses - documentation that
does not run is documentation that misleads.

**TeX is optional.** `GET /api/dsh-diagrams/health` reports `tex.available`; with
no engine the index, the tab and the tool result all say the diagram was stored
but not validated, and it still exports as `.tex`. Nothing else degrades:
Mermaid needs no engine at all.

**Troubleshooting.**

| Symptom | Cause |
|---|---|
| No "Diagrams" entry on the "+" / Start page | `dsh-diagrams` is not mounted (a new package needs one install run: `install.bat` / `./install.sh`, or `-Force`), or the bundle did not activate - check the console for `[dsh-diagrams]` |
| The tool reports `unavailable` for a Mermaid diagram | the child validator could not produce a verdict (engine file missing, spawn blocked, timeout). The diagram IS stored; `node packages/dsh-diagrams/vendor/build.mjs` rebuilds the engine |
| Every TikZ write says "No TeX engine found on this host" | none of `pdflatex`, `xelatex`, `lualatex` is on the **server's** `PATH`; install a TeX distribution on the host running `dsh web`, then `GET /api/dsh-diagrams/health?refresh=1` |
| A TikZ write fails with `File 'x.sty' not found` | the package is not installed and auto-install is deliberately off (a compile must not reach the network). Install it on the host, or use one of the libraries the preamble already loads |
| The tab shows a picture but the status pill says `error` | the compile produced a PDF *and* reported errors - the picture is best-effort; the diagnostics under it are the truth |
| The pill says `not drawn` / `stale` and nothing else | `not drawn` is `pending`: no browser has reported on this revision (normal headless, and normal before the tab is ever opened). `stale` means the newest report names an OLDER revision, so this revision has never been drawn - a report about revision 4 is not evidence about revision 5 |
| A TikZ export says "There is nothing to export as svg yet" | the compile produced no artifact (a document with a hard error). The `.tex` export always works; read the diagnostics |
| An export landed in the conversation folder | that profile's host row is not mounted, so the panel fell back to the browser download; reinstall (`install.bat` / `./install.sh -Force`) so `POST /api/dsh-diagrams/export` exists |
| A `box` sequence diagram reports `unavailable` | fixed in alpha.4 (the DOM stub now exposes `window.CSS`). If it reappears, the profile is serving an older bundle: restart `dsh web` and hard-refresh |
| A bare chart reports `Environment axis undefined` | fixed in alpha.4 (an `axis` body is wrapped in a `tikzpicture`, which is the only form that compiles on a `standalone` document). Same remedy: an older bundle is in the browser |
| "This diagram is not in this conversation (it may have been deleted)" | the tab outlived its diagram: `diagram_delete` removed it, or the tab belongs to another session |
| Diagrams vanished after restarting `dsh web` | state lives in `$DSH_HOME/dsh-diagrams/sessions`; a different `DSH_HOME` (or a different host) has its own store |
| The picture is huge/small in the panel | TikZ is sized by the document (`standalone` + `border=4pt`) and the panel scales it to fit; Mermaid is scaled by its own SVG. Change the source, not the panel |
| `vendor/build.mjs --check` fails | the vendored engine was edited or half-written; re-run the build (never hand-edit `lib/vendor/mermaid.min.js`) |
| The skill catalog still lists an old skill body | the catalog is read at boot: restart the app. The runtime registration comes from the package folder, the copy from `$DSH_HOME/skills` - edit the one in effect (the copy wins for preset agents) |

## 16. The PDF plugin (dsh-pdf)

**What it is.** One row (`pdf`), five tools (`pdf_info`, `pdf_read`, `pdf_find`,
`pdf_render`, `pdf_scan`), two tab types (`pdf` - the reader, band `extension`,
patterns `['*.pdf']`; and `pdfs` - the workspace index, a page type at
`sidebar://pdfs`), one bundled skill (`pdf-analysis`) and ten authenticated
route registrations (state, health, file, list, scan, and five fixed vendor
assets). It makes a PDF readable and scannable by the model and openable in the
right bar, and it is **read-only** - no tool modifies, merges, splits, rotates,
fills or signs a document.

**It replaces the shipped PDF renderer by RANKING, not by disabling.** The
harness's own `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` mounts a
`text` type that claims `dsh-resource://file/**` at the `fallback` band and has a
builtin pdf.js renderer. The bar's registry ranks bands (`extension` 3 >
`builtin` 2 > `fallback` 1) before pattern length, so this package's
`extension`-band type wins the address, and its `canOpen` refuses anything that
is not a `.pdf`. Every other file type keeps the surface it had, the shipped
preview stays mounted as the fallback for a profile without this package, and
**no core row is disabled** - the same shape `dsh-editor` uses to sit in front of
the preview for text. (The editor is unaffected: it already vetoes `pdf` in its
own `PREVIEW_EXTENSIONS`.)

**Two address shapes**, because a PDF can live in two places:

- `dsh-resource://file/session/<sessionId>/<path>` - the ordinary file grammar,
  so a click in the Files tab lands in this reader;
- `dsh-resource://pdf/absolute/<whole-path-encoded>` - this package's own shape
  for a document outside any workspace (a chat attachment, a file in Downloads).
  The ordinary grammar cannot carry a POSIX absolute path: it drops the leading
  slash, so `/home/me/a.pdf` would become a *relative* path. The whole path rides
  as ONE encoded segment instead.

**One engine, both halves, pinned to the harness's own preview.**
`lib/vendor` is generated by `packages/dsh-pdf/vendor/build.mjs` from
`pdfjs-dist@6.3.289` - the exact version and legacy build the shipped preview
inlines - so two renderers in one page can never disagree about a document. The
vendor tree is the engine, its worker, the 169 CJK cMaps, the 16 standard fonts
and pdf.js's Apache-2.0 LICENSE, with every file's bytes and sha256 plus a digest
over each tree recorded in `lib/vendor/VERSION.json`; `build.mjs --check` is part
of the tracked checks, and `.gitattributes` pins the tree's TEXT files to LF
because those bytes are hashed and a Windows checkout would otherwise report
phantom drift (the license files live *inside* the hashed trees). alpha.3 adds
`wasm/` - pdf.js's own **JBIG2**, **OpenJPEG** and **qcms** decoders, 13 files
and 1.5 MB. Skipping them was a real choice in alpha.1 and it was the wrong one
for a reader: without them a fax-style or JPEG2000 scanned page draws blank or
partially, and a page that renders as nothing looks like a document that says
nothing. `quickjs-eval.wasm` rides along unused because `isEvalSupported: false`
is set on both halves.

**The browser never carries the engine.** The harness reads every client bundle
at boot and pdf.js is 1.8 MB, so `lib/client.js` stays small and fetches
`/api/dsh-pdf/vendor/pdf.min.mjs` and `.../pdf.worker.min.mjs` on the first PDF,
turning each into a blob URL - a module `import()` for the engine, a worker URL
for the render worker, exactly the lazy shape `dsh-editor` uses for CodeMirror.

**Why the asset routes are two JSON maps.** The connection's fetch registry
matches **exact paths only** - `fetchRoutes.get(url.pathname)`, and `register`
throws on a duplicate - so there is no prefix route to hang pdf.js's asset trees
on. Serving 169 cMaps and 16 standard fonts one route each would have meant 185
registrations; instead one route per KIND returns a base64 map, and a custom
`BinaryDataFactory` (pdf.js 6's single asset seam, constructed as
`new Factory({cMapUrl, standardFontDataUrl, wasmUrl})` with
`fetch({kind, filename})`) decodes the single entry pdf.js asks for. That is also
why `pdf.min.mjs` is checked for **zero static imports**: the file must survive
being imported from a blob URL.

**Reading a document: identity, child process, cache.**

1. *Identity is content.* The SHA-256 of the bytes (streamed in the parent,
   memoized per `path + size + mtime`) names the cache entry, so an edited file
   can never serve a stale answer and one document read from two conversations
   costs one parse.
2. *One child process per extraction* (`lib/extract.mjs`): argv only, a 25 s
   deadline, `--max-old-space-size=512`, an 8 MiB stdout cap. A PDF is untrusted
   input handed to a large parser; the worst case must be a reported failure. The
   child gates the parser itself: `isEvalSupported: false` (a document's
   JavaScript is never evaluated), `useWorkerFetch: false` with no URL fetching
   anywhere, `enableXfa: false`, `useSystemFonts: false`, `disableFontFace:
   true`, and the cMap/standard-font trees as `file://` URLs.
3. *The cache answers first.* `$DSH_HOME/dsh-pdf/artifacts/<sha256>/` holds
   `index.json` (document facts), `stats.json` (per-page numbers, merged as pages
   are extracted) and `pages/<n>.json` (one page's text in both modes), written
   atomically and LRU-pruned at 512 MiB. `pdf_read` after `pdf_find` is free.

**The panel and the index (alpha.3).** Two toolbar buttons open a side panel
beside the page column, and both halves of it are deliberately NOT the page
component:

- **The thumbnail rail** draws each page into a 104px canvas *when the rail
  scrolls it into view*, with the `IntersectionObserver` **rooted on the rail
  itself** (`element.closest('.dpf-side')`) - a thumbnail two screens down must
  not draw, and an observer rooted on the viewport would treat the whole rail as
  visible. It is capped at 300 pages and the rail says so, because a thousand
  canvases is not a rail, it is a memory leak with a scrollbar. A thumbnail needs
  no text layer, no zoom and no scroll memory, so sharing `PageView` would only
  make both slower.
- **The outline** is resolved in the BROWSER through `getOutline` /
  `getDestination` / `getPageIndex`, bounded to 200 entries and four levels. A
  bookmark whose destination cannot be resolved is rendered *disabled* rather
  than dropped: a bookmark the reader can see but not follow is still
  information, and the host has no better answer to give it (its own extractor
  resolves the same tree the same way, so the two agree).

The **`pdfs` index page** is the pack's familiar page-type shape: `id`
`dsh-pdf-index`, kind `pdfs`, `priority: 'builtin'`, no `patterns` so it never
competes for a file address, a guide entry at `order: 50` (after Files 10, Editor
20, History 30, Diagrams 40), and a body whose rows call the ordinary
`openResource` action - so the registry, not the page, decides what claims a PDF.
Its data comes from `GET /api/dsh-pdf/list`, whose walk is **timid by design**:
depth 6, 200 files, `.pdf` only, a skip-list (`node_modules`, `.git`,
`__pycache__`, `.venv`, ...), symlinks not followed, and page counts only when
asked and only for 12 documents - a count means parsing a document in a child
process, which is worth 12 files on a click and never worth doing for a directory
nobody asked about. The index lists; it never becomes a way to browse the
machine, and every row it hands out is re-validated by `resolveTarget` when it is
opened.

**The scanned-page signal is the point of `pdf_info`.** Per page it reports the
character count and the image count, so a page with **0 characters and images**
is a scan - a picture of text, with nothing to extract - and both `pdf_info` and
`pdf_read` say so in as many words instead of returning an empty string. That is
the difference between a tool that reports and one that invents, and it is what
the scanner consumes.

**The scanner (alpha.2) is one pipeline with two callers.**
`lib/scan.js` is shared by the `pdf_scan` tool and by the reader's own "scan this
page" action through `POST /api/dsh-pdf/scan`, so what the model is told and what
a person sees cannot drift. Four decisions are load-bearing:

- **The default page selection is the whole point.** With no `pages`, it selects
  exactly the pages `pdf_info` found to have no text layer, because those are the
  only pages where recognition beats reading. A page that already carries text is
  never sent to OCR behind the caller's back: recognized text of a page that
  already had real text is strictly worse than the real text, and offering it as
  a default would tempt a model into quoting the inferior copy.
- **Two optional engines, resolved from `PATH`, never installed or bundled:** a
  rasterizer (poppler `pdftoppm`, then `mutool`, then Ghostscript) because Node
  has no canvas, and `tesseract` for the recognition. Both are spawned with argv
  arrays under a pinned environment and killed on a deadline. The engine set is
  DATA - each entry declares its own `args({image, lang, psm})` and its own
  `--list-langs` parser - which is what lets a host without tesseract still drive
  the pipeline in the tracked check through a stub child process.
- **Every input that can change the text is in the cache key.** A result is filed
  at `ocr/<n>.<lang>@<dpi>dpi.p<psm>.txt` and the raster it came from is kept at
  `images/<n>@<dpi>dpi.png`, so a second call is free while re-reading a page at
  300 dpi for a table after reading it at 200 dpi for prose is a NEW recognition.
  Reusing the first for the second would silently answer a question nobody asked.
- **Every absence is a sentence.** No rasterizer, no OCR engine, no data for the
  requested language (checked against the engine's own list BEFORE a page is
  drawn), no page that needs scanning: each comes back as a reason the caller
  words, and the scan route answers 200 with `{ok:false, reason, message}` for a
  capability refusal, because a missing engine is a fact about this host and not
  a bad request.

The answer, the conversation card and the reader's text panel all label the
result a **transcription** rather than extraction, and name the engine, language
and resolution it came from: OCR misreads digits, names, accents and punctuation,
and a verification that is not claimed is worth more than a confident number
that is wrong.

**`layout` mode is its own algorithm.** pdf.js returns positioned text runs with
no line or column structure, so a naive join turns a two-column paper - or an
invoice's label/value pairs - into a run-on. `reconstruct()` in `lib/extract.mjs`
groups runs into lines by baseline (tolerance from the run's own height), orders
lines top-to-bottom, and joins each line left-to-right, turning gaps wider than a
quarter of the type size into spaces and wider than a whole one into column
breaks. Deterministic, and it is what makes an invoice legible (verified against
a real Portuguese *fatura-recibo*).

**The text layer is pdf.js's, and the scale variable is v6's.** The reader builds
`new TextLayer({textContentSource, container, viewport})` per page and sets
`--total-scale-factor` on the page box (`--scale-factor` is pdf.js 3; 6.x reads
the total). The page box also carries `--scale-round-x/y`, because pdf.js's own
layout math is `round(down, var(--total-scale-factor) * Wpx,
var(--scale-round-x))`. Search highlighting walks the rendered spans and wraps
the matched substring in a `<mark>`: every span already has an absolute position
and `white-space: pre`, so wrapping moves nothing.

**Optional host engines, and what happens without them.** `pdf_render` resolves
`pdftoppm`, then `mutool`, then Ghostscript (`gswin64c` / `gswin32c` / `gs`) from
`PATH` and rasterizes into a PRIVATE temporary directory, reading the produced
files back in page order so no engine's naming scheme becomes this plugin's
contract. `pdf_scan` uses the same rasterizer - into the artifact cache this
time, because the picture is worth keeping - and adds `tesseract`, whose language
list is read from the engine itself. With no rasterizer, `pdf_render` says so in
a sentence that names what to install, and `pdf_scan` adds that OCR needs one
too; reading, searching and the reader tab are unaffected, because they need
nothing. `GET /api/dsh-pdf/state` reports both, and `pdf_info` prints both lines
before a model ever asks.

**The path policy, stated rather than implied.** A session-relative path is
resolved inside the conversation workspace and both sides go through `realpath`,
so a symlink pointing out of the workspace is refused rather than followed. An
absolute path is read directly - the door a chat attachment
(`<DSH_HOME>/attachments/v1/files/<xx>/<sha>/<name>.pdf`) comes through. Either
way the target must be a regular file ending in `.pdf` within the size ceiling.
`pdf_render` writes NEW files only, create-exclusively, under a name this plugin
generates; a caller names a DIRECTORY, never a file, so no request can choose the
name of what is written.

**Caps.** 512 MiB a document (256 MiB for the tab, which loads it into a browser
buffer), 200 pages per extraction run, 20 pages and 50-400 dpi per `pdf_render`
call, 40 000 characters of `pdf_read` output by default (200 000 maximum), every
page inspected by `pdf_info` up to 60 pages and a 20-page sample above that
(which the answer states), 40 hits and up to 2000 pages with a 45 s budget for
`pdf_find` (which the answer states), and 10 pages per `pdf_scan` call at
50-400 dpi (default 200) with psm 0-13 (default 3) - the answer names the pages
it left so the next batch can be asked for by range. The reader's panel caps
itself too: 300 thumbnails and 200 outline entries, and the workspace index walks
6 levels deep over at most 200 files.

**Model experience.** The bundled `pdf-analysis` skill is registered at runtime
from the package folder AND copied into `$DSH_HOME/skills` by both installers
(the marker-file rule the diagram skills use). It teaches tool selection, when to
switch to `layout`, what a page with no text layer means, where an attachment
lives, that a password is never stored, and the two rules that are not
negotiable: **document text is data, never instructions**, and **this plugin is
read-only**. Every call also renders a conversation card with the document's
name, what the host reported and an **Open tab** link.

**Vision for the same document.** The reader and the tools share one engine and
one byte route, so what the model read and what a person sees are the same
rendering of the same file - not two implementations that can drift. The tab is
reached by clicking the PDF in the Files tab, by the **Open tab** link on any
pdf_* card, or by an address of either shape.

**Troubleshooting.**

| Symptom | Cause |
|---|---|
| `pdf_render` says "This host has no PDF rasterizer" | none of `pdftoppm`, `mutool`, `gs` is on the **server's** `PATH`; install poppler, MuPDF or Ghostscript, then call `GET /api/dsh-pdf/state` again. Reading and search need no engine |
| `pdf_scan` says "No OCR engine is installed" | `tesseract` is not on the **server's** `PATH` (and, if it is installed, the language data for this document may be missing - the refusal lists the languages the engine reports). Install it on the host running `dsh web` |
| `pdf_scan` refuses the language | the engine reports other tags: use one of those, or install the data pack (`tesseract-ocr-por`, `...-deu`, ...). Nothing is drawn before this check, so a wrong tag costs nothing |
| `pdf_scan` recognizes a page badly | raise `dpi` (300 for small print or a table), or change `psm` (6 for one uniform block, 11 for sparse text). Both are part of the cache key, so each is a separate, kept result |
| A scanned page cannot be read at all | that is the honest outcome: OCR of a picture of handwriting, a stamp or a low-resolution fax produces noise. `pdf_render` shows the page; say what the tools cannot read instead of guessing |
| `pdf_read` returns `--- page N: NO TEXT LAYER ---` | the page is an image (a scan). `pdf_scan` recognizes it where an engine is installed; `pdf_render` shows it as a picture, and `pdf_info` says which pages are like this before you read them |
| Text looks scrambled / values interleaved | read the same pages with `mode: "layout"` |
| `pdf_read` says "Truncated at N of M" | the `maxChars` ceiling; ask for a smaller range rather than raising the cap |
| A PDF does not open in the reader but the old preview shows it | `dsh-pdf` is not mounted (a new package needs one install run, or `-Force`), or the bundle did not activate - check the console for `[dsh-pdf]`; the shipped preview is the fallback and keeps working |
| The tab says "This PDF could not be read (HTTP 413)" | the file is larger than the tab's 256 MiB ceiling; the tools still read it page by page |
| The tab says "That path points outside the conversation workspace" | a relative path with `..` that leaves the workspace: open the file by its absolute path instead, or copy it in |
| `vendor/build.mjs --check` fails | the vendored tree was edited or half-written; re-run `node packages/dsh-pdf/vendor/build.mjs` (never hand-edit `lib/vendor`) |
| A CJK document extracts as boxes | the cMap map route is missing or the tree is incomplete - run the vendor build and restart |
| A scanned page draws blank or half | its image is JBIG2 or JPEG2000 and the `wasm.json` route is missing - run the vendor build and restart. A page that renders as nothing looks like a document that says nothing, which is why these decoders are vendored |
| The Bookmarks panel says the document has none | it genuinely has no outline. Many scans and most word-processor exports have none: the thumbnails, the page field and Find are the way in |
| Thumbnails stop partway | the 300-page rail cap; the page field and Find still reach the rest, and nothing is broken |
| The PDFs page lists nothing | the workspace has no `*.pdf` inside 6 levels - or the walk is looking at the wrong folder, which `GET /api/dsh-pdf/list?session=<id>` answers directly (`root` is in the response) |
| A workspace PDF is missing from the index | it is deeper than 6 levels, past the 200-file cap, inside a skipped directory (`node_modules`, `.git`, ...), or it is a symlink - the walk does not follow those on purpose |
| "Count pages" reports fewer documents than rows | the count pass is capped at 12 documents per request, and a locked or damaged PDF reports `null` rather than failing the list |

-----

## 17. UI state that outlives the process (dsh-ui-state)

**The problem, stated precisely.** Everything the interface remembered before
this package existed was remembered in the wrong place. Three tiers were in play,
and only the first is shared:

| Tier | Where | Survives a restart | Shared by a Chrome tab and the desktop window |
|---|---|---|---|
| Host files | `$DSH_HOME/sessions`, `storages/workspace.json`, `settings.yaml` | yes | **yes** - one file, one picture |
| Browser storage | `localStorage` (page zoom, dock height) | same browser only | **never** - two browser profiles are two stores, even at the same port |
| Nothing | the layout store, the open right-bar tab, the extension theme | no | no |

That is why a new chat opens the last one (tier 1) while the column widths, the
page zoom and a Nord theme did not (tiers 2 and 3). `localStorage` is the trap:
it *looks* like persistence, but it is per **origin** and per browser **profile**,
and the desktop shell prefers port 3080 and falls back to a free one, so even a
single host can lose it by moving a port.

**The answer is a settings namespace, not a new file format.** `dsh-ui-state`'s
Node half registers ONE namespace - `vn-harness` - in the harness's own settings
document, `$DSH_HOME/settings.yaml`, through `ctx.settings.register`. That seam
already provides everything this needs and nothing it does not: one document both
launchers read, atomic writes, schema validation, hot reload on a hand edit, and
a user layer that stays empty until a value actually differs from the contract.
A plugin-owned **session event** was not an option (`dsh-session-persistence`
refuses an unknown event type unless the envelope carries `ignorable: true`, which
`Session.append()` cannot set - the conversation would become unreadable), and
`ctx.storageDomain` needs a projection the browser cannot read.

The namespace's fields and owners:

| Field | Default | Written by |
|---|---|---|
| `pageZoom` | `100` | `dsh-themes` (the header's Page-zoom control) |
| `theme` | `''` | `dsh-themes` (an **extension** theme id only) |
| `dockHeight` | `280` | `dsh-terminal` |
| `sidebarWidth` | `-1` | `dsh-ui-state` itself |
| `rightbarWidth` | `-1` | `dsh-ui-state` itself |

Two conventions carry weight. **A negative width means "never recorded"**, which
is deliberately not `0`: for the sidebar `0` is a real state (collapsed), so a
sentinel is the only way to say "leave the layout's contract default alone"
without lying about a width nobody chose. And **`theme` holds an extension id
only** - `light` / `dark` / `system` are already durable in ui-theme's own
namespace, and a setting with two owners is a setting that can disagree.

**One binder, and why.** `settingsScope` writes are fenced on the LATEST KNOWN
namespace revision, and each bound scope owns its own queue. Three bundles
binding `vn-harness` independently could therefore refuse each other's writes,
and the contract's recovery for a stale revision is a reload of host state -
which would silently drop the write. So the browser half binds the namespace
once and publishes the **`uiState`** client service (`get` / `set` / `unset` /
`subscribe` / `snapshot` / `status`) that the other two packages reach lazily.
`unset` exists because clearing is not the same as overwriting: picking a built-in
theme after Nord must REMOVE the field so it reads as inherited again, not write
the default into the user's document.

**An extension theme is a desired state, not a one-shot choice.** This is the
part that had a real bug in the field, and it is worth recording because the
mechanism is not obvious. ui-theme's `ThemeRuntime.adopt()` assigns its
`preference` from its DURABLE section whenever its settings scope notifies, and
that scope notifies whenever the settings DOCUMENT changes - which any write to
any namespace causes, this pack's own zoom and dock writes included. An extension
theme is never written to that durable section (ui-theme's schema accepts
`light` / `dark` / `system` only), so choosing Nord applied it and the next
settings write snapped the app back to the durable built-in. That predates the
persistence: ANY Settings change reverted an extension theme.
So the control keeps a `desiredTheme` and `reconcileTheme` puts it back on every
`theme/change`, with ui-theme's own namespace **revision** as the tie-break
between the two things that look identical from the outside - a re-adopt
(revision unmoved: nobody chose anything, so re-apply) and a deliberate built-in
chosen in the shipped **Settings > Appearance** row (revision moved: that
decision wins, and the remembered id is cleared). Re-picking the built-in that was
already durable is the one case the revision cannot see, so the extension is
re-applied; the escape is this control's own menu. The tracked check runs the
REAL ui-theme bundle for exactly this reason - a stub theme service accepted the
registration and hid the bug.
**The zoom is applied before the first paint.** A zoom that lands after the client
boots is a visible reflow of the whole shell, so - exactly as ui-theme bootstraps
its own palette - the Node half answers `webserver/index-inject` with one inline
script carrying the remembered level, and writes both the `zoom` declaration and
the `data-dsh-page-zoomed` marker. The marker is a contract, not decoration:
`dsh-themes`' right-bar seam fix (alpha.16) is gated on it, and a boot script that
set the zoom without it would leave the seam 288px off the right column's edge at
80% on a 1440px frame for the whole interval before the client applies the same
level again.

**The column widths are this package's own job.** ui-layout keeps them in a
transient store - its own words - so a reload returns the sidebar to 280px and the
right bar to 45% of the frame, and closing the sidebar forgets its drag width by
design. `ctx.layout` exposes `selectPanel` / `toggleSidebar` / `openRightbar` /
`closeRightbar` and **no width setter**, so the store is reached the way
ui-layout's own `AppFrame` reaches it: the store handle is carried by the `root`
slot registration, and `store.create()` answers the same shared instance the frame
renders from. That is the one core store this pack writes, so it is guarded
twice - the handle must look like a layout store before anything is touched, and a
shape it does not recognise means "remember nothing" rather than "run blind".
Both widths go to the store's own setters **unclamped**, because the store already
clamps to its drag range and to 70% of the frame. A remembered `0` is restored
through `toggleSidebar()`: `setSidebar(0)` clamps to 264, so collapse can only be
the toggle's own transition. Below ui-layout's 1024px auto-collapse width nothing
is restored at all - there the rail is the layout's decision, not a preference.

**Why schema is resolved and not imported.** This pack ships zero npm
dependencies and every other Node half imports only `node:*` builtins: the profile
installs each bundle as a live link into the repo, so a bare
`import '@deepseek-ai/schemastery'` resolves from the repo folder and fails with
`ERR_MODULE_NOT_FOUND` (measured). `settings.register` wants a schemastery schema,
so the module is loaded at runtime instead through the anchors
`packages/dsh-terminal/lib/pty.js` established for the harness's own `node-pty`:
the running entry, then `$DSH_HOME/profiles`, which `dsh-app-boot` keeps as a
mirror of the installation's dependency closure, so Node's ordinary parent walk
finds the very same copy the harness loaded. The CJS build is what makes
`createRequire` work (`schemastery` is `type: module` but publishes
`exports.require`), and duck typing is what makes it safe: `dsh-settings` treats
the schema as a function and reads `schema.toJSON()`, so it never compares class
identity across the two module graphs. With no reachable copy the row WARNS and
degrades - nothing is remembered, and every consumer falls back to the local
behaviour it had before - rather than failing the boot.

**Degradation is designed, not accidental.** `dsh-themes` and `dsh-terminal`
resolve `uiState` with `ctx.get` and never declare it in `inject`, and each keeps
writing its `localStorage` copy alongside the shared field. So a profile with one
of those bundles and not this one behaves exactly as before, and the shared
section always wins when both exist. Nothing is written at all until a value
actually changes, which is why a fresh install grows no `vn-harness` section.

**The desktop window remembers its own geometry, separately.** The window's size
and position must be known BEFORE the window is built, so they cannot come from a
browser round trip: `app/src-tauri/src/windowstate.rs` (the pure half, `cargo
test`-pinned) reads and writes `$DSH_HOME/vn-harness/window.json`, and
`main.rs` does only the Tauri work - read before build, a coalescing writer on
`Resized`/`Moved`, a synchronous write at exit, and a monitor check that falls
back to centring when the remembered point is on no screen. It is desktop-only
state by nature: a Chrome tab has no window geometry to share. A maximized
recording keeps the previously known size and position and flips only the flag,
because a maximized window reports the screen's size and recording it would lose
the window worth un-maximizing to.

**What is deliberately NOT remembered.** The terminal dock's **open** state: the
panel is the window onto a PROCESS, and after a reload the client holds no slots,
so reopening it would either show an empty panel or - once the server's five
minute PTY retention has lapsed - start a shell nobody asked for. A height is a
preference; "a shell was running" is not. The right bar's open tab is per
conversation and belongs to the bar's own store; it is left for a later pass.
