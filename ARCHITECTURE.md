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
packages/dsh-themes/              # sub-plugin: the header's Themes control
  package.json        # dsh.bundle + dsh.client
  cordis.patch.yml    # inserts the 'themes' row (nothing else patched)
  lib/index.js        # Node half: no-op row (the control is browser-only)
  lib/client.js       # browser half: the Light/Dark/System button over `ctx.get('theme')`
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
only host-side routes in the pack.

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

`dsh-themes` is the pack's **conversation-header package**: it owns the three
controls described below — the Themes button, the Session-log download seat and
the Screenshot control — plus the appearance overrides that dress the bar and the
frame.

The conversation header's right-hand group is a slot list
(`conversation.session.header.utilities`): the shipped **Open In…** split button
registers there at `order: -10`, the Session-log download seat at the default `0`
(that seat used to draw a three-dot button — see the download seat below) and the
**Screenshot** control at **`-30`**, one step left of the Themes occupant, which
registers at **`order: -20`** and therefore renders first of the pack's three —
immediately left of Open In. Nothing shipped is patched or reordered.

**The Themes control.** One icon button with a `Menu`:

| Piece | Value |
|---|---|
| `id` | `dsh-themes` (the occupant's slot id) |
| slot | `conversation.session.header.utilities` (list, session scope) |
| `order` | `-20` — first in the group, left of Open In (-10) |
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
  `THEME_EXTENSIONS` (this package's **Nord**) is the only place a palette is
  declared — and a theme another plugin registers shows up too, named by its id
  with the generic mark. Registration is idempotent and retried on the post-boot
  microtask and on every `theme/change`, because ui-theme may provide its service
  a tick after this row. An extension theme is IN-PROCESS by the shipped design:
  the durable preference schema accepts `light` / `dark` / `system` only, so a
  reload returns to the stored built-in.
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
where the mark was, and the product text **VN Harness**.

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
  `.hHd-Xa_railMark`, and `content:"VN Harness"` on `.hHd-Xa_brandName`. Being in
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
**`order: -30`** — the leftmost of the pack's three header controls — which
captures the whole window and saves the PNG to the **Desktop of the machine
running the app**. It is the first control in the pack whose behavior is split
across both faces of its bundle, so `lib/index.js` is no longer a no-op row.

| Piece | Value |
|---|---|
| slot | `conversation.session.header.utilities` (list, session scope) |
| `id` | `dsh-themes-screenshot` |
| `order` | `-30` — the list's first occupant, left of the Themes control (`-20`) |
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
stream is stopped the instant the frame is grabbed, and the pack's three controls
— plus whatever tooltip hangs off them — are hidden for that one frame by
`html[data-dsh-screenshot]` (the injected `themes.css` rule), so the picture is
the app rather than the buttons that took it.

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

**The routes.** Three authenticated HTTP routes through `connection.fetch` - the
mechanism §6 uses - and ONE **upgrade** route, which that mechanism does not
cover:

| Route | What it is |
|---|---|
| `GET /api/dsh-terminal/health` | PTY availability, the shell's label, the capacity, the platform |
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

**What the checks pin.** `check-node-routes.mjs` drives the real protocol against
a real PTY (`init` -> `ready` -> a command answered -> `kill`), proves a JSON line
is shell input rather than a control frame, and proves an unauthenticated upgrade
is refused - skipping only the live part, loudly, on a host with no PTY.
`check-client-bundles.mjs` pins the bundle id, both seats, the order and the
rendered markup.

## 12. The installer

The installer is **two halves, one behaviour** - the host picks the half, and
neither half needs the other:

| Host | Script | Runner | Needs |
|---|---|---|---|
| Windows | `scripts/install-all.ps1` / `uninstall-all.ps1` | `scripts/*.bat`, root `install.bat` / `uninstall.bat` | Windows PowerShell 5.1 or 7 |
| macOS / Linux | `scripts/install-all.sh` / `uninstall-all.sh` | `scripts/*.sh`, root `install.sh` / `uninstall.sh` | POSIX sh (dash/bash) + Node.js with npm/npx - **never PowerShell** |

Both are ASCII-only; the `.sh` half is POSIX (no bashisms, no `sed`/`grep`
pipelines - the JSON/YAML parsing is done by `node -e`, which is a prerequisite
anyway), and both halves accept the same flags (`-Force`, `-Plugin`, `-DshHome`,
`-ProfileName`, `-DshVersion`, `-Target web|cli`), print the same messages and
reach the same profile state. The root launchers are the friendly pair: they add
force-the-re-add semantics unless the caller asked already. `scripts/sync-vendored.ps1`
is **maintainer tooling**, not an installer, and is the one script here that wants
`pwsh` on macOS/Linux.

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
  `dsh-terminal`, `dsh-modal`,
  `dsh-themes`, `dsh-open-in-app`) as `pnpm link:` symlinks straight into this repo (detected by
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

**What it is.** One row (`diagrams`), five tools (`diagram_write`,
`diagram_patch`, `diagram_read`, `diagram_verify`, `diagram_delete`), two bundled
skills (`mermaid-diagrams`, `tikz-diagrams`, each with a
`reference/complex-diagrams.md`), two tab types (`diagram` - one per
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
