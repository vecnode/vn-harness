# dsh-editor (alpha.9)

**Editor** is a **tab type for the pack's right bar** (`dsh-rightbar` — the
right-hand column of the DeepSeek Harness web GUI, beside the **Start** page and
the **Files** tab that `dsh-rightbar-files` provides). It opens **text files
only** (strict UTF-8, binary is refused) — **Markdown included** — edits them with
a vendored **CodeMirror 6**, starts **blank documents** from the tab strip's "+",
names and creates new files through the shared **`dsh-modal`** dialog, and saves
them back to disk. It is a **sub-plugin**: it holds no bar code, and its
host-side half owns the pack's own HTTP routes. Alpha.

## What it does (through alpha.9)

- **The toolbar is the tab's own top bar, on the same line as the other two
  columns** (alpha.9). Every column opens with a band that ends in one hairline at
  **y=76**: the conversation header is `min-height:76px`, the left column's
  branding row is given the same 70px band by `dsh-themes`, and the right column's
  first line is the open tab's own header — the docking strip above a pane is
  **38px** (28px + 10px top padding), so the shipped Files tab's **38px**
  `box-sizing:border-box` header lands exactly on that line, and so does the
  document preview's. This toolbar was `8px + 26px + 8px = 42.5px`, so its rule
  sat **~4.5px below** the middle column's. It is now the same **38px** box
  (`box-sizing:border-box`, so the `.5px` rule sits inside it) with the controls a
  size down (**24px**, 12px type): the find input, **Preview** and **Save**. The
  panel is taller by a few pixels, and the three hairlines are one line.

- **The rendered page behaves like a document, not like plain text** (alpha.8).
  The shadow body below lives inside the preview's scrollport, which is built for
  the **plain-text** renderer: `[data-textpreview-body]` declares
  `white-space:pre` and a monospace font stack, and the shipped Markdown body
  undid both in the wrapper this package replaces. The pack's own wrapper now
  does the same — `white-space:normal`, so a source newline is a soft break
  again and blank lines collapse into paragraph spacing instead of rendering as
  full empty lines (the "huge spaces" a Markdown document used to show on the
  white page), and the app's UI font on the **Edit** pill (which otherwise
  inherited the mono face, unlike every button around it).
- **Preview is a toggle** (alpha.7). The editor's Markdown preview now carries the way back:
  this package registers the rendered Markdown **document body** itself
  (`sidebar.right.tab.document`, keyed by the shipped preview's own Markdown
  implementation id, at a **lower priority** — the slot system's shadowing rule,
  *lowest renders*), so only the page is ours and the shipped preview keeps its
  metadata, paging, wrap and reload chrome. That body draws a sticky **Edit**
  button which hands the same file straight back to the editor, replacing the
  preview tab — Editor → **Preview** → **Edit** → Editor, one tab, same file.
  Uninstalling this package brings the shipped body back with no residue.
- **Markdown opens editable.** `.md` / `.markdown` are text, so the editor claims
  them (they used to be vetoed to the shipped preview). Clicking one in the Files
  tree opens it as a highlighted document — edit it, save it, and the file on disk
  is what changes.
- **`Preview` hands the file to the rendered view.** The toolbar button (shown
  while a Markdown file is open) names the shipped document-preview type
  (`@deepseek-ai/dsh-client-ui-sidebar-documentpreview`, whose *kind* is read from
  the tab registry, never hardcoded) and asks the right bar's controller to open
  the same address there, **replacing the editor tab** — so Edit ⇄ Preview is one
  tab that cannot drift from the file it names. Refused while the document has
  unsaved edits: the preview reads the file from disk, and showing the older text
  silently would be a lie. In the pack's own profile that rendered page is the
  always-light **Markdown paper** (`dsh-themes`), and since `dsh-themes` alpha.3 it
  carries **no viewer menu**: the preview header builds that menu from *every*
  candidate renderer ("Markdown" plus the plain-text fallback), and a Markdown page
  has exactly one — **Edit** is the way back to the text.
- **The editor follows the app's appearance** (alpha.5) — light **or** dark. CodeMirror
  needs a palette of its own, so the surface configures **oneDark only while the
  app is dark** and a transparent light theme while it is light — the light layer
  leaves the panel's `--dsw-*` tokens visible instead of painting a white canvas
  of its own. The document text colour is the `--dsw-alias-label-primary` token
  in both modes, which is what keeps a file with **no syntax language**
  (`.ps1`, `.gitignore`, `.txt`, …) readable: in the light theme that token is
  near-black, so on oneDark's opaque dark canvas it used to paint black text on a
  dark background.
- **The switch is live.** The surface re-configures the moment the appearance
  changes, in either direction, without reopening the file: the `theme` service
  (shipped `@deepseek-ai/dsh-client-ui-theme`) emits `theme/change`, and the
  `body[data-ds-dark-theme]` marker ui-layout writes is watched as the fallback
  for a profile that never mounts ui-theme. Both are resolved lazily — the editor
  never hard-depends on the theme package.
- **Registered into the right bar** through the bar's tab-type registry
  (`ctx.sidebarRightTabs.register`, provided by `dsh-rightbar`): id
  `dsh-editor`, kind `editor`, with the body and the chip title registered in
  the keyed `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` seats.
  There is no private dock, no header capsule and no window bridge.
- **Text files open editable.** The type declares `dsh-resource://file/**` in
  the `extension` priority band, which outranks every viewer the product ships,
  and vetoes in `canOpen`:
  - what a text editor has nothing to add to (`.html`, images, PDF,
    office/archive/media and binary extensions) — those keep their own preview
    tab;
  - paths outside the session workspace (including the authorizing-less
    `absolute/…` addresses).
  So clicking a `.ts`, `.json`, `.py`, `.txt`, `.md` … in the Files tree opens it
  in the editor; clicking a `.png` or a `.pdf` opens the shipped preview as
  before.
- **"+" → Editor opens a BLANK document.** Picking the guide entry creates an
  editor tab on an empty, unnamed document: nothing is read from disk and the
  tab holds no workspace browser. The file bar reads *Untitled* and **Save** is
  always offered.
- **Saving a blank document names it.** Save (or Ctrl+S) opens the pack's shared
  dialog (`dsh-modal`'s `modals` service) asking for the **file name with its
  extension** — a relative path such as `notes.md` or `src/app.ts`, created in
  **this conversation's workspace folder** (the same place the tab was opened
  from); the folder must already exist. The dialog validates the name (an
  extension is required, dotfiles excepted; no absolute or `..` paths), shows
  the server's answer **inside the dialog** when the name is taken
  (`409 EXISTS`) and keeps what was typed. On success:
  - an ordinary text/code file (`.txt`, `.ts`, `.json`, `.py`, `.md`, …) becomes
    its own tab (`replaceTab`), so the chip shows the file name and every later
    save is an ordinary in-place save — exactly as if the file had been clicked in
    the Files tree;
  - an extension a shipped preview owns (`.html`, an image, a PDF, …) **stays in
    the editor**: the chip takes the file's name through the tab title store, and
    later saves go in place. The tab is deliberately not handed to the preview,
    because the preview cannot edit the file and this tab is the only place that
    can.
  Without `dsh-modal` mounted the dialog falls back to the browser's own prompt.
- **Edit**: CodeMirror 6 with line numbers, history/undo, bracket matching,
  autocomplete, find-in-file, and syntax highlighting for js/ts/jsx/tsx, json,
  markdown, python, html, css, yaml. Line-wrapping for prose-ish files. The
  palette follows the **app's own light/dark theme** (oneDark while the app is
  dark, a token-driven transparent theme while it is light; see alpha.5 above).
  The engine is **lazy**: the vendored classic bundle is
  fetched once from `/api/dsh-editor/vendor` the first time a file opens.
- **Toolbar**: a find-in-file search input, a **Preview** button (Markdown files
  only, see alpha.7) and a **Save** button. Save is offered for an unnamed
  document at all times and for an open file while it is modified;
  **Ctrl/Cmd+S** works inside the editor. The chip of a tab with unsaved work
  carries a dot.
- **Saving** is optimistic and atomic: the panel PUTs the whole document with the
  mtime/size it opened with; the server re-checks containment and writes a temp
  file renamed over the target. If the file changed on disk meanwhile the panel
  offers **Reload** / **Save anyway** instead of silently clobbering.
- Unsaved edits are NOT persisted across tab closes or app restarts (alpha
  caveat — save before closing a tab).

## How the write path works (no core patches)

The browser cannot write files on this dsh line: `remote.workspaceFiles` reads
files and lists folders but exposes **no mutation operation**. Mirroring the
shipped `dsh-session-log-export` plugin, the Node half registers
**authenticated routes** through the `connection` service:

| Route | What it does |
|---|---|
| `GET /api/dsh-editor/file?session=<id>&path=<rel>` | read one text file (the host resolves the session's workspace root, containment-checks the path against it; strict UTF-8, no NUL; ≤ 2 MiB) |
| `PUT /api/dsh-editor/file` | save one text file `{session, path, text, expected?: {mtimeMs, size}}` (atomic temp+rename; 409 when the file moved on disk) |
| `PUT /api/dsh-editor/file` with `{create: true}` | **create** a new file at `path` (the PARENT folder must exist inside the workspace and is realpath-checked; the target must not exist — `409 EXISTS`; published create-exclusive, so a create never overwrites a file the user did not open) |
| `GET /api/dsh-editor/vendor` | serve the vendored CodeMirror 6 classic bundle (lazy, cached) |

The session id is what the tab's address already carries
(`dsh-resource://file/session/<sessionId>/<path>`); the workspace root is
resolved **host-side** — live session header first, session persistence second,
exactly like `@deepseek-ai/dsh-api-workspace-files` resolves its own reads. The
client never names a root, and a session whose root cannot be resolved gets a
typed `NO_WORKSPACE` failure instead of a guess.

The web profile exposes the same `connection` surface the route registration
uses on every boot.

## Layout

```
cordis.patch.yml      bundle layer: inserts the 'editor' row (nothing else patched)
lib/index.js          Node half: the /api/dsh-editor routes above (read, save, create, vendor)
lib/client.js         Browser half: tab type + guide entry, body (blank document or an
                      open file), the save-as dialog over the `modals` service, the
                      Preview hand-off to the rendered Markdown view, and the title
                      with the dirty dot (module-table bundle)
lib/vendor/cm6.min.js GENERATED - the vendored CodeMirror 6 classic bundle
                      (IIFE on window.DSHEditorCM); commit it, do not edit by hand
vendor/package.json   +  vendor/entry.js  — reproducible CM6 build inputs
```

The save-as dialog lives in [`packages/dsh-modal`](../dsh-modal): the editor
resolves the `modals` service **lazily** (`ctx.get('modals')` at save time) and
falls back to `window.prompt` when it is absent, so the editor never depends on
that package being installed. `dsh-modal` is not listed in this package's
`dsh.client.inject` on purpose — the dependency is a service lookup, not a module
load order.

The theme service is resolved the same way (`ctx.get('theme')`, from the shipped
`@deepseek-ai/dsh-client-ui-theme`): with it the editor reads the resolved
`active.colorScheme`, and without it it falls back to the `body[data-ds-dark-theme]`
marker ui-layout writes and then to `prefers-color-scheme` — so the editor keeps
following the app on every profile. The header control that switches that
preference is [`packages/dsh-themes`](../dsh-themes).

**Preview** resolves two more services lazily, and neither is a hard dependency:
the right bar's controller (`ctx.get('sidebarRight')`) does the actual open, and
the tab registry (`ctx.get('sidebarRightTabs')`) is consulted for the **kind** the
shipped document preview registered under — so a harness line that renames that
kind keeps working, and a deployment without the preview type gets a clear
"Preview unavailable" instead of a dead button. `openResource(address, { kind })`
is the controller's own option; the tab record's `openResource` action drops
`kind`, so the editor calls the controller directly (the tab is on screen, so its
session is the mounted one).

### Regenerating the vendored CodeMirror bundle

Only needed when the CM6 version set changes (not for plugin code edits). The
build runs anywhere Node does; only the last line's output path differs per OS:

```sh
cd packages/dsh-editor/vendor
npm install
npx --yes esbuild entry.js --bundle --minify --format=iife --global-name=DSHEditorCM \
  --target=es2020 --outfile=../lib/vendor/cm6.min.js
```

(On Windows use `..\lib\vendor\cm6.min.js` in the last argument.)

`lib/client.js` itself stays hand-written — no build step for normal edits.

## Install / uninstall

The repo launcher (`install.bat` on Windows, `./install.sh` on macOS/Linux)
auto-discovers this package — it is a standard `dsh.bundle` — and so does the
uninstaller; nothing else changes. After a version bump, a plain launcher run
re-adds it; the web profile gets it as a live link, so code edits just need a
restart of `npx @deepseek-ai/dsh web` plus a hard refresh.
