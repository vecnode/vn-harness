# AGENTS.md - guidance for coding agents in vn-harness

This file is the quick-start brief. Read `ARCHITECTURE.md` for the deep dive.

## What this repo is

Personal plugin pack for DeepSeek Harness. It installs into ONE place only:

- the web profile: `npx @deepseek-ai/dsh web` (profile `web` under `DSH_HOME`,
  default `~/.dsh`)

DSH Desktop support was removed on purpose - the desktop app runs its own frozen
generation snapshot and this pack targets the raw web install alone. Do not add
desktop detection, a `-Target desktop` switch, or desktop install steps back.

Everything is a standard dsh **bundle**: an npm package with
`dsh.bundle` (+ `cordis.patch.yml`) and, for UI plugins, `dsh.client` and an
`exports["./client"]` browser bundle. Nothing patches DeepSeek core files.

**Platforms.** The plugins are plain JavaScript and must stay OS-neutral; the
only per-OS code allowed is a launcher choosing the right command for the host
(see `packages/dsh-open-in-app`). The tooling is split by host, not shared:
**Windows** runs PowerShell (`scripts/*.ps1`, on Windows PowerShell 5.1 *and* 7 -
use `Join-Path`, `[System.IO.Path]::PathSeparator` / `DirectorySeparatorChar`,
`$PSVersionTable` (never `$IsWindows` unguarded - 5.1 has no such variable) and
the `Get-ToolPath` / `Get-ToolNames` helpers instead of hardcoding `npx.cmd`,
`npm.cmd`, `powershell.exe`, `%USERPROFILE%` or `\` separators); **macOS/Linux**
run POSIX shell (`scripts/*.sh`) and must NEVER require PowerShell - they need
Node.js with npm/npx and nothing else. Both halves do the same work with the same
flags, and entry points come in pairs: `install.bat` / `install.sh`,
`uninstall.bat` / `uninstall.sh`, plus the console twins `scripts/*.bat` /
`scripts/*.sh`. The run launcher is the one pair that is NOT split that way: it is
exactly two files, `run.ps1` + `run.sh`, both at the repo root (there is no
`run.bat` and no `scripts/run-all.*` - for run there is no wrapper-only behaviour
to add, which is the whole reason the install pair has a wrapper).
`scripts/sync-vendored.ps1` is the one exception:
maintainer tooling for moving the forks forward, and it wants `pwsh` on
macOS/Linux.

**The run launcher.** `run.ps1` / `run.sh` start the pinned
`npx @deepseek-ai/dsh@<pin> web --no-open`, stream the app's own output to the
terminal, read the ready line it prints once the server is listening
(`dsh web: http://127.0.0.1:<port>/?token=<launch token>`) and open THAT url in
Chrome, falling back to the default browser. Two rules are load-bearing and must
survive any edit: the launch token is a live credential, so it is read IN MEMORY
and never written to a file, echoed by us, or handed to a shell (it reaches the
browser as one argv element), and a URL that does not name a loopback address is
refused instead of opened. The two halves mirror each other flag for flag
(`-Port`, `-DshHome`, `-DshVersion`, `-NoBrowser`, `-DefaultBrowser`), and each
reads `.dsh-version.json` from its OWN directory - so they must stay at the repo
root, and a move into `scripts/` means `repoRoot = $PSScriptRoot` and
`repo_root=$script_dir` have to change with it.

## Layout

- `packages/<bundle>/` - one standalone bundle per plugin. Today:
  - `packages/dsh-vn-master/` - **the master, and deliberately blank**: the bundle layer plus one no-op `master` host row. **No `dsh.client`**, no published service, no `inject` edge and no core-row disables - so it cannot disturb the right bar's tab-type chain. Its name is the only one here that sorts last and `dsh plugin add` appends, so it is the profile's **final layer**: the slot that can restate any pack or core row. Pack-wide patches belong here, not in the bar
  - `packages/dsh-rightbar/` - the pack's own right bar (tab strip + "+", docking panel, expand button, Start/guide page, the `sidebarRightTabs` registry + `sidebarRight` controller, the keyed tab seats). `lib/client.js` is a GENERATED fork of `@deepseek-ai/dsh-client-ui-sidebar-right`; its `cordis.patch.yml` hard-disables the `ui-sidebar-right` / `ui-sidebar-files` rows and inserts `rightbar`. The disables stay with the row they replace (the bar), never the master, so `-Plugin dsh-rightbar` still mounts exactly one bar.
  - `packages/dsh-rightbar-files/lib/client.js` - GENERATED fork of `@deepseek-ai/dsh-client-ui-sidebar-files`: the Files tab type on top of the bar
  - `packages/dsh-editor/lib/client.js` - browser half (hand-written, NO build step); the editor tab type (`dsh-resource://file/**` in the `extension` band) plus the guide entry the "+" control lists. "+" -> Editor opens a BLANK document; Save names it (extension included) through the shared `modals` dialog and creates it in the session workspace folder. **Markdown is claimed too** (it is text): a `md`/`markdown` tab shows a toolbar **Preview** button that reads the shipped document preview's kind from the tab registry and hands the address to it as `ctx.get('sidebarRight').openResource(address, { kind, replaceTab })`. Its CodeMirror palette follows the app's light/dark theme (oneDark only while the app is dark, a CodeMirror `Compartment` reconfigured live off `ctx.get('theme')` / `theme/change`, `body[data-ds-dark-theme]` as the fallback). The rendered page also **undoes what the preview's plain-text scrollport imposes** on its contents (`white-space:pre` and the mono font stack), so a Markdown document draws as a document and its **Edit** pill wears the app font (alpha.8)
  - `packages/dsh-editor/lib/index.js` - Node half (authenticated `/api/dsh-editor/*` routes: read/save/CREATE text files by session, serve vendored CM6)
  - `packages/dsh-editor/lib/vendor/cm6.min.js` - GENERATED vendored CodeMirror 6 (rebuilt from `vendor/`, never hand-edited)
  - `packages/dsh-gittree/` - **read-only** git HISTORY tab, labelled **History** in the capsule and the chip while the package, row and address keep the `gittree` name: a PAGE tab type (no `patterns`, `priority: 'builtin'`) with one guide entry at `order: 30`, beside Files (10) and Editor (20), showing the workspace’s COMMIT HISTORY (short id, subject, author, date) with the branch and the current commit kept in its file bar; picking a commit shows its message and the files it touched, and a changed-file row opens that file through the ordinary `openResource` action with no options - the registry decides (editor for text, a shipped preview for an image), so it needs neither and publishes no service. `lib/index.js` owns three READ-ONLY routes (`/api/dsh-gittree/state|history|commit`) that spawn `git` with argv arrays only (`rev-parse`, `status`, `ls-files`, `log`, `show`, `diff-tree`; nothing that writes) under a pinned env (`GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`), a 10 s kill and an 8 MiB cap. The tab reads `state` with `brief=1` (branch, current commit, changed count - no file list), the workspace scope is computed from `realpath` on both sides, and every request is guarded by a `useRef` token: alpha.1 returned an effect cleanup instead, whose next-render run cancelled the request it had just started and left the panel on "Reading the history…" forever. No fork, no disabled core row, nothing for `sync-vendored.ps1` to track
  - `packages/dsh-diagrams/` - **diagrams as a surface**: Mermaid and TikZ in ONE bundle (row `diagrams`). SIX tools - `diagram_write`, `diagram_patch`, `diagram_read`, `diagram_verify`, `diagram_publish`, `diagram_delete` - each taking an optional `scope` (`conversation` | `library`), whose every write is VALIDATED before it is stored: Mermaid by parsing the source headlessly with the SAME vendored engine the browser renders with (a CHILD process, `lib/mermaid-check.mjs`, installs a ~60-line DOM stub and loads `lib/vendor/mermaid.min.js` through `node:vm`, so the stub never touches the host process), TikZ by compiling it with the machine's own engine (`lib/latex.js`: `pdflatex` else `xelatex` else `lualatex`, argv only, `-no-shell-escape`, `MIKTEX_AUTOINSTALL=0`, `openin_any=p`/`openout_any=p`, a private temp cwd, a 20 s kill) - so a broken diagram returns the parser's/compiler's own line-accurate error (`diagram.tex:12: Package pgf Error: ...`) and the model fixes it in the same turn. Validation is followed by ADVISORY linting (alpha.3) that never changes the status: a picture with nodes and no edges, more nodes than a reader takes in at once, an unclosed-looking label, a Mermaid first line naming a different type than the engine parsed, a TikZ document that compiled to several pages or to no picture at all; two degenerate sources are refused in plain words rather than by the engine (empty/comments-only Mermaid, and a TikZ document with no drawing command, which pdflatex compiles to a blank page and reports as success). `diagram_verify { id }` re-runs the whole validation WITHOUT writing: it never bumps the revision and never discards the browser's render report. TWO skills (`skills/mermaid-diagrams/SKILL.md`, `skills/tikz-diagrams/SKILL.md`) registered at runtime from the package folder AND copied by both installers into `$DSH_HOME/skills`, where each copied folder carries a `.vn-harness-<package>` marker so a person's own skill is never overwritten and uninstall removes only what it wrote. STATE is ONE FILE per conversation (`$DSH_HOME/dsh-diagrams/sessions/<session>.json`, atomic temp+rename, 64 diagrams, 256 KiB per source, a 4 MiB SOURCE BUDGET per conversation - a typed `BUDGET` refusal checked on write AND patch, replacing a diagram charged once - and a 16 MiB file cap that nothing this plugin writes can reach, because a file past the cap reads as EMPTY and every diagram in the conversation would disappear at once) **plus a LIBRARY** (alpha.6): the SAME store class with a fixed file name instead of one per conversation, so `$DSH_HOME/dsh-diagrams/library.json` is ONE file for the whole harness and `diagram_write { scope: 'library' }` / `diagram_publish { id }` put a diagram in it. A bare id resolves LIBRARY-FIRST and then in the conversation, which is what lets `diagram_read { id: 'jepa-model' }` find a shared diagram from a chat that never saw it written; the address `dsh-resource://diagram/library/<id>` names NO conversation, so a citation survives the chat and the `diagram` tab type claims that address shape as well as the session one; the state route carries the library with every conversation's diagrams; and a panel edit writes back where the diagram ALREADY is, or editing a library diagram would quietly fork a conversation-only copy plus a content-addressed artifact cache (`artifacts/<sha256[0:24]>/{doc.tex,doc.pdf,doc.svg,doc.png,meta.json}`, LRU at 200 MiB). **Never a session event**: `dsh-session-persistence` refuses a log containing a type outside `KNOWN_SESSION_EVENT_TYPES` unless the envelope carries `ignorable: true`, and `Session.append()` cannot set that marker - a plugin-owned event type would make the conversation unreadable. **Never a projection**: a unit needs `zod` schemas and this pack ships ZERO npm dependencies (the profile installs live links, so a package dependency is not installed). The ROUTES are exact `connection.fetch` paths with **GET/HEAD/POST only** (the registry's own vocabulary), which is why the vendored engine is mermaid's own SINGLE-FILE browser build on ONE route (`/api/dsh-diagrams/vendor/mermaid.js`, ETag, ~3.4 MB, rebuilt by `vendor/build.mjs`, hash recorded in `lib/vendor/VERSION.json` and re-checked by the tracked route check) and why every write - including delete - is a POST. The BROWSER half registers two tab types: `diagram` (a resource kind, `dsh-resource://diagram/session/<session>/<id>` - one tab PER diagram, with the rendered picture, a source drawer whose Apply re-validates exactly like a model write, and an Export menu that SAVES EVERY FORMAT TO THE HOST'S DESKTOP (alpha.4: mmd/md/tex/pdf/svg/png, create-exclusively, the client naming a format and never a path, the Desktop resolved per request - never the conversation folder, with the browser download kept as the fallback) and a zoom ladder (25%-400%, remembered per diagram) with DRAG TO PAN over a picture laid out at 80% of the pane as its 100% rung - the ladder moves the layout BOX (never a CSS transform, which would scale into a clipped box with no scrollable area), a zoomed box STRETCHES its children (a column flex container sizes children to their CONTENT, so without that rule the box zoomed and the diagram did not - the bug that shipped first), panning is the canvas' own scrollLeft/scrollTop with the grab cursor MEASURED from real overflow, and a zoom keeps the point the reader was looking at) and `diagrams` (the index page `sidebar://diagrams`, whose guide entry at `order: 40` is what `+` / Start lists - after Files 10, Editor 20, History 30); plus a `tool.call.toolview` card per tool name that draws the diagram inline in the conversation with an "Open tab" link. Mermaid renders in the BROWSER from its own source (engine fetched once, evaluated as a classic script, cached per `(source, theme)`, themed off the app's scheme); TikZ renders from the HOST's compiled SVG (blob + `<img>`), and a failing compile that still produced a PDF is shown flagged as errored. **The Mermaid render path is the one place this package had a real interface bug** (alpha.3): `mermaid.render(id, source)` called with NO container element builds `#d<id>` on `document.body` and removes it again **only on the success path**, so every failed render left a div behind - and when the engine had drawn its own error diagram into it first, what stayed in the page was a full 2412x512 SVG reading "Syntax error in text / mermaid version 11.17.2", one per failure, until the tab was reloaded. The fix has four load-bearing parts and the tracked client check asserts each one: the source is **`parse()`d before `render()` is ever called**, the engine is initialized with **`suppressErrorRendering: true`** so it throws instead of drawing its error diagram, every render goes into **a container the plugin owns** (`mermaidHost()`, attached but laid out at zero size offscreen, because the engine measures what it draws), and a **`finally` sweeps** any `d<id>`/`i<id>` fixture anyway. A refusal comes back as a `MermaidError` carrying `phase: parse | render` and is drawn as TEXT - the parser's own lines, a Retry button and a route to the source drawer. **The state route carries each diagram's `source` AND `revision`** (alpha.3; it carried neither, so every tab and card drew from `undefined` and no render report could be matched to the revision it drew). **The browser reports what it drew** to `POST /api/dsh-diagrams/render-report`, stored per revision and read back by `diagram_read`/`diagram_verify` as `drawn` / `failed` / `stale` / `pending` - the one verdict the host cannot produce alone, since parsing proves the source is valid and only a renderer proves the picture exists. TeX is OPTIONAL: without an engine TikZ is stored and exported as `.tex`, and the index, the tab and the tool result all say so. No fork, no disabled core row, nothing for `sync-vendored.ps1` to track
  - `packages/dsh-modal/` - the pack's shared dialog surface: `lib/client.js` mounts one body-level overlay on `document.body` (`react-dom/client` `createRoot`) and provides the client service **`modals`** (`open`/`alert`/`confirm`/`prompt`, async `submit` work with inline errors). No slot, no ordering edge; consumers use `ctx.get('modals')`
  - `packages/dsh-themes/` - the pack's conversation-header package. It owns (a) the **Themes** control: one 28px icon button registered into the slot LIST `conversation.session.header.utilities` at `order: -20`, i.e. immediately left of the shipped **Open In...** (which sits at `-10`), opening a `Menu` of Light / Dark / System plus every theme registered into the shipped registry (alpha.12: this package registers its own **Nord** through `ctx.theme.register` - ui-theme's documented third-party surface, alias-token overrides on the dark base; alpha.13 adds **Monokai** the same way, after Nord in `THEME_EXTENSIONS` and in the same 93-token shape - the menu iterates `snapshot.themes` with the `system` preference last, the button wears ONE static appearance mark instead of a per-preference sun/moon, and the choice is in-process because the durable preference schema accepts the built-in three only); and (b) the **Session-log download seat** (alpha.9): the shipped `@deepseek-ai/dsh-session-log-export` browser half put a three-dot "more actions" button in that same list whose only menu item was `Download session log`, so this bundle registers the SAME occupant `id` (`session-log-download`) at `priority: -10` where the shipped occupant sits at its default `0` - a list slot renders the LOWEST priority registration for an id, which is the slot system's own shadowing rule (the one `dsh-editor` uses for the rendered Markdown body) - and the seat draws one plain download icon button that starts the export on the first click. The seat keeps `order: 0`, so it does not move, and the seat's preparing/success/error dialog is rendered here from the same store so `/export` keeps its feedback; no CSS hiding, no DOM poking and no disabled core row is involved. The EXPORT is not reimplemented: the shipped row stays mounted because its host half owns `/api/session.export` and the `/export` command, and its browser half publishes the `sessionLogDownload` controller, which this control resolves lazily with `ctx.get(...)` (`download` / `dismiss` / `store`) - a profile without that service renders the button disabled with "Session export is unavailable". Both of these buttons wear the header group's round `.5px` hairline ring (`border-radius:28px`, `--dsw-alias-border-l3`, border-box) - the dress the terminal control already had - and one more one-shot override gives the SAME ring to the right bar's own collapse/expand toggle in the header corner, the one button on that bar that cannot draw it where it lives (it belongs to a GENERATED forked bundle): the rule is keyed on the header's stable `data-conversation-header-corner` marker, never a hashed class, and carries `box-sizing:border-box` because that toggle's own dress does not set it. The Themes control is a **thin control**: the preference stays owned by the shipped `@deepseek-ai/dsh-client-ui-theme`, resolved lazily as `ctx.get('theme')` (`getTheme()` + `setTheme(id)` + the `theme/change` event), never declared in `inject`. The editor resolves the same service (and falls back to `body[data-ds-dark-theme]`) for its own palette. It also carries the pack's **appearance overrides**, starting with the **Markdown paper**: one injected rule re-declares ui-theme's own light declarations (read from its stylesheets, never hardcoded) on the preview's `[data-document-markdown]` root, so the rendered Markdown view stays white in the dark theme; the same package hides the preview header's **viewer menu on Markdown tabs** (alpha.3), because that page has exactly one renderer and the editor's **Edit** button is the way back to the text; and it carries the pack's **VN BRANDING** on that same left row (alpha.6): the shipped mark and wordmark are replaced by the **APP ICON** (`assets/vn-harness.svg`, a black circle centred on (12,12) with a 1px transparent margin so no `overflow:hidden` box can shave it; inlined as a data URI, alpha.8) and the text `VN Harness`. That is an OVERRIDE, not a slot registration - `sidebar.brand.mark` / `sidebar.brand.name` are `single` slots the shipped `@deepseek-ai/dsh-client-ui-brand-official` row already occupies, and the row is `aria-hidden` decoration inside the band this package already owns. The rule hides the slots' CHILDREN (`display:none!important`, which beats the `display:contents` wrapper the app puts around each occupant), so it also covers the layout's own `FishLogo` fallback; the icon and the text are drawn as `::before` on `.hHd-Xa_brandMark` / `.hHd-Xa_railMark` / `.hHd-Xa_brandName`, in the wide row and in the collapsed rail, the SAME icon replaces the whale in the empty conversation's hero (`conversation.hero.brand.mark`, 26px, alpha.8), and the TEXT wears the CHAT TITLE's type (alpha.7: `14px/20px/500`, the values ui-conversation declares for `.wSkVaW_crumb`/`.wSkVaW_crumbCurrent`) rather than the shipped brand name's `18px/600` - two sizes a few pixels apart read as a mistake; and (c) the **Screenshot control** (alpha.10): one more occupant of that same list at `order: -30`, i.e. one step LEFT of the Themes control, which captures the whole window and saves the PNG to the Desktop of the machine running the app. The capture is the browser's own: `getDisplayMedia({preferCurrentTab:true, selfBrowserSurface:'include'})` hands the page the current tab's surface, one frame is drawn into a canvas and encoded as PNG - real pixels, so the terminal dock's xterm CANVAS and any open dialog are in the picture, and the interface is otherwise photographed as it stands: this package's own three header controls STAY in the frame (alpha.11 - alpha.10 hid them for that one frame, which left a hole in the record) and only the open tooltip bubble is kept out, via `html[data-dsh-screenshot] [role=tooltip]` plus `disabled` handed to the clicked button's own Tooltip while the capture runs. A DOM-to-canvas library and a second headless browser pointed at the same URL were both rejected: the first would have to stand in for the engine (portalled dialogs, layered hashed stylesheets, the xterm canvas), the second photographs a FRESH load (the open tab, the editor buffer and the dock are THIS client's state, not the server's). The Web GUI is a fixed-viewport shell - the document does not scroll, the columns do - so 100% width and 100% height IS the tab's box and nothing is stitched. The file does not go through the browser's downloads: the PNG is POSTed to this package's own authenticated Node route `POST /api/dsh-themes/screenshot` (`lib/index.js` is no longer a no-op row: `connection.fetch.register`, `requestBody: 'buffered'`), which resolves the host's Desktop PER REQUEST (`%USERPROFILE%\Desktop`, OneDrive-redirected, XDG `XDG_DESKTOP_DIR`, the home folder last), validates what it writes (content-type `image/png`, the PNG signature, a 64 MiB cap) and writes it create-exclusively as `vn-harness-<timestamp>.png` (`-2`, `-3`, ... on a collision), answering `{ok,path,directory,bytes}` - the client never names a path, so there is no traversal surface and no way to overwrite a file the user already had. A profile without that row still gets the picture through the browser's own download, and either way a shipped `Toast` anchored to the button reports the saved path or the failure (a dismissed picker, no `getDisplayMedia` outside HTTPS/localhost, a write failure)
  - `packages/dsh-open-in-app/` - PATCHED fork of `@deepseek-ai/dsh-client-ui-open-in-app` (the Session header's "Open In..." button) whose file-manager ids post to a Node half that opens the OS file browser directly (`explorer.exe` / `open` / `xdg-open`, WSL-aware) instead of the shipped shell-open verb. The patch list is data in `scripts/sync-vendored.ps1`; its `cordis.patch.yml` disables `ui-open-in-app` and inserts `native-open-in-app`. The shipped HOST row (`open-in-app`) stays mounted for editors/terminals
  - `packages/dsh-terminal/` - a REAL SHELL in a **bottom dock**, the pack's first surface that is not in a column: a header control at `order: 30` in the slot LIST `conversation.session.header.utilities` (the last utility, right of Open In at -10) toggles a horizontal panel that starts at the left bar's right edge, spans the page and sits UNDER the middle and right columns, which make room for it - and ONLY those two. `lib/client.js` renders the dock into the root-scoped `shell.overlay` LIST as a `position:fixed` box (the frame's `overflow:hidden` cannot clip a fixed child), gives the room by setting `height: calc(100% - Hpx)` on the MIDDLE and RIGHT columns (found from the layout's own `data-rightbar-col` marker plus sibling order; the frame's first element child - the left bar - is never one of them) and handing back what they had on close - NEVER the frame's own height, whose single grid row the left bar shares (alpha.1 did that and visibly pulled the left bar's items up; padding is wrong too, because the right column's panel is absolutely positioned against its ancestor's PADDING box). Every resize (grip drag or viewport) re-fits the emulator, sends the new size to the PTY and scrolls to the end, or the panel keeps a stale line count with the newest output out of sight. The left edge is the frame's resolved `gridTemplateColumns` first track, tracked by a MutationObserver on the frame's `style` PLUS a `ResizeObserver` on the two columns and a `transitionend` on the frame: the LEFT BAR IS ANIMATED (one grid rewrite, then a transition), so the mutation alone reports the pre-transition value and never fires again, leaving the dock at the old edge - the columns' SIZE is what changes every frame, and it keeps `data-open` (INTENT) apart from `data-suspended` (derived): the first spike run had the geometry observer reopen the dock on the very close that restored the frame's height. It does NOT use the header corner - that is a single-occupant slot the right bar's toggle owns. xterm.js 5.5.0 + `@xterm/addon-fit` are VENDORED (`vendor/` -> `lib/vendor/xterm.js` + `xterm.css`, GENERATED, served by `/api/dsh-terminal/vendor/*` with an ETag and fetched lazily into a blob script exactly like the editor's CodeMirror). `lib/index.js` owns `/api/dsh-terminal/health` plus ONE authenticated WebSocket upgrade `/api/dsh-terminal/pty` (`ctx.webServer.registerUpgrade` + `connection.requestRejection`, since upgrade routes are not covered by `connection.fetch`; control frames are prefixed `U+0000` so `cat` of a JSON file is never mistaken for one, and past 4 MiB of unflushed socket bytes the PTY is PAUSED rather than dropping output). The PTY is the HARNESS'S OWN `node-pty` - resolved, never installed: `lib/pty.js` anchors on `process.argv[1]`, `$DSH_HOME/profiles` and this package (with NO existence check: `createRequire` uses the anchor's DIRECTORY, which is the whole point of the profiles anchor) and degrades to `available:false` plus a dock notice instead of a broken boot. One PTY per (conversation, slot), 8 max, cwd resolved like the editor/gittree do, a 256 KiB scrollback ring, detached sessions kept 5 minutes so a reload reattaches with a replay, every timer `unref`ed. `lib/shell.js` is the ONLY per-OS file (pwsh.exe else powershell.exe / `$SHELL` else /bin/zsh / `$SHELL` else /bin/bash) and a terminal is an UNSANDBOXED shell by nature - the gate is the connection's own authentication. Clipboard is Ctrl+Shift+C/V so a bare Ctrl+C stays SIGINT. No fork, no disabled core row, nothing for `sync-vendored.ps1` to track
  - `assets/` - the pack's **source artwork**: `vn-harness.svg`, the app mark (a black circle centred on (12,12) with a 1px transparent margin inside its 24px box). It is INLINED into `dsh-themes/lib/client.js` as a data URI - the branding needs no route, no request and no Node half - and the tracked check compares the inlined copy's geometry against this file, so the two cannot drift. It lives at the repo root because it is the source; like the vendored engines, no package depends on a file outside itself. The 1px margin is what keeps the mark from being shaved by the app's `overflow:hidden` boxes (the sidebar brand button is exactly 24px tall)
  - each package's `cordis.patch.yml` - its bundle layer (rows, plus the bar's and the open-in-app client's disables)
- `scripts/install-all.ps1` / `uninstall-all.ps1` - the **Windows** half
  (PowerShell 5.1+), driven by `scripts/*.bat` and the root `install.bat` /
  `uninstall.bat`
- `scripts/install-all.sh` / `uninstall-all.sh` - the **macOS/Linux** half:
  plain POSIX sh (dash/bash), Node.js + npm/npx only, **no PowerShell**, driven
  by `scripts/*.sh` and the root `install.sh` / `uninstall.sh`. Same flags, same
  messages and same behaviour as the PowerShell half
- `run.ps1` / `run.sh` - the run launcher, one file per host, both at the repo
  root (see **The run launcher** above). It pipes the app's output through a FIFO
  on the POSIX side (never a file, so the launch token stays off the disk) and
  reads it from the main shell, which is what lets `wait` report the harness's own
  exit status
- `scripts/sync-vendored.ps1` - moves the forks forward after a harness-line bump
  (copies the core bundles, rewrites the module ids, applies each fork's patch
  list, stamps the banner; `-Check` reports drift without writing). Maintainer
  tooling: the only script here that wants `pwsh` on macOS/Linux
- `scripts/checks/` - standalone verification for the JS halves
  (`check-client-bundles.mjs` drives the browser bundles through a real React
  runtime, `check-node-routes.mjs` drives the Node route handlers,
  `check-skill-examples.mjs` parses/compiles every fenced example in every
  shipped skill document with the plugin's own engines)
- `.dsh-version.json` - the pinned dsh version, the `vendoredFrom` line, and
  per-package versions
- `docs/` - INSTALL + COMPATIBILITY notes (superseded in depth by ARCHITECTURE.md)

> Retired in alpha.2 of this pack: the first-generation **Files** plugin
> (`dsh-files`, before that `dsh-focus`) with its private dock, header capsules
> and `window.__dshFilesHost` bridge. Both install scripts still carry
> `$legacyNames = @('dsh-focus','dsh-files')` so an upgraded profile drops the
> old bundles instead of double-mounting.

## Golden rules

1. Target the pinned dsh line only (`0.1.5-rc.1`, see `.dsh-version.json`).
   Test against what the owner runs. When DSH publishes a new line, bump the
   pin, run `scripts/sync-vendored.ps1` (the right bar, the Files tab and the
   open-in-app client are **forks** of that line's bundles), then adapt - do not
   silently chase master APIs.
2. Plugins stay **alpha** (`-alpha.N`) until the owner says "make it stable".
3. Never touch DeepSeek core packages, the harness profile internals beyond
   what `dsh plugin` does, or API keys. The pack owns its right bar by
   **forking** the core bundles into `packages/` and hard-disabling the core
   rows - never by editing an installed core file.
4. The browser bundle is read at harness boot. The web profile installs every
   bundle as a live link into this repo, so after editing a `client.js`
   the app only needs a RESTART of `npx @deepseek-ai/dsh web` plus a hard
   browser refresh (Ctrl+F5) - no reinstall. Reinstall (a plain
   `install.bat` / `./install.sh`, which re-adds on version change, or `-Force`)
   is only needed when the package set or version changes. There is no HMR
   unless a `pnpm run dev:web` watcher from the harness repo is running.
5. Client bundles are module-table files:
   `window.__ModuleLoader__.load({ id, factory })`. Browser-only: no Node
   imports; you may `require("react")`; the shell statically seeds `react`,
   `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`,
   `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
   `@deepseek-ai/dsh-client-ui-primitives` and
   `@deepseek-ai/dsh-client-ui-dockkit`; anything else must be reached through
   `ctx.get(...)` after declaring it in the exported `inject` array
   (e.g. `["slots","sidebarRightTabs"]`). A client service is published with
   `ctx.reflect.provide(name, value)` (`sidebarRightTabs`, `sidebarRight`,
   `modals`); a service a consumer can live without - like `modals` - is
   resolved lazily at use time instead of being declared in `inject`. A tab type
   is TWO registrations: the static definition through
   `ctx.sidebarRightTabs.register(...)` and the keyed body/title through
   `ctx.slots.inject("sidebar.right.pane.tab"...)` with `key` = the
   definition's `id`; the "+" control lists every type that declares a `guide`
   entry on its definition.
6. Installer scripts are ASCII-only (smart quotes/dashes have broken parsing
   before). The `.ps1` half runs on **Windows PowerShell 5.1 and 7**; the `.sh`
   half is **POSIX sh** (dash/bash on macOS/Linux) and must never call
   PowerShell. Keep the two halves in step: same flags (`-Force`, `-Plugin`,
   `-DshHome`, `-ProfileName`, `-DshVersion`, `-Target web|cli`), same messages,
   same behaviour. After editing a `.ps1`, parse-check it; after editing a `.sh`,
   run `sh -n` (see below).
7. When the pack branding is mentioned, the repo name is `vn-harness`.
   Commits are authored as `vecnode <vecnode@users.noreply.github.com>`
   (git config is set in the repo).

## Commands

```bat
:: Windows
install.bat                   :: installs into the web profile (the only target)
install.bat -Force            :: re-add bundles even when versions match
powershell -NoProfile -ExecutionPolicy Bypass -File run.ps1
                              :: start the app + open it in Chrome (foreground; Ctrl+C stops it)
uninstall.bat
```

```sh
# macOS / Linux - Node.js with npm/npx; no PowerShell needed
./install.sh                  # the web profile (the only target)
./install.sh -Force           # re-add bundles even when versions match
./run.sh                      # start the app + open it in Chrome (foreground; Ctrl+C stops it)
./uninstall.sh
```

`install.bat` drives the PowerShell half and `install.sh` the POSIX half; the
run launcher is the root `run.ps1` / `./run.sh` pair. Each can also be run
directly:
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-all.ps1 -Force`
(Windows) and `sh scripts/install-all.sh -Force` (macOS/Linux).

`-Target cli` is accepted as an alias for the web profile; there is no desktop
target any more. Everything runs through `npx --yes @deepseek-ai/dsh@<pinned>`;
pnpm is bootstrapped locally under `tools/pnpm<major>` (the profile's pnpm major
is read from `node_modules/.modules.yaml`).

> Package retirements: the panel was `dsh-focus` (row `focus`) until alpha.10,
> when it became `dsh-files` (row `files`), and in alpha.2 of the editor the
> whole first-generation Files package was dropped when the harness grew its own
> right Sidebar with a Files tab. From then on the pack **forks** the bar
> (`dsh-rightbar`, `dsh-rightbar-files`) and disables the core rows instead of
> depending on them. Both install scripts keep the
> `$legacyNames = @('dsh-focus','dsh-files')` prune so an upgraded profile drops
> the old bundles. Add future removed/renamed packages to that list in both
> scripts.

## Iterating on a change (quick loop)

```powershell
# 1. syntax-check a JS/PS/SH file
node --check packages/dsh-editor/lib/client.js
node --check packages/dsh-rightbar/lib/index.js    # forked client.js is generated
sh -n scripts/install-all.sh scripts/uninstall-all.sh install.sh uninstall.sh run.sh
$t=$null;$e=$null; [System.Management.Automation.Language.Parser]::ParseFile(
  'scripts/install-all.ps1',[ref]$t,[ref]$e); $e.Count   # expect 0
$t=$null;$e=$null; [System.Management.Automation.Language.Parser]::ParseFile(
  'run.ps1',[ref]$t,[ref]$e); $e.Count                   # expect 0

# 2. after a harness-line bump, move the forks forward (then review the diff).
#    sync-vendored.ps1 is maintainer tooling and is the one script that wants
#    pwsh on macOS/Linux (`powershell -NoProfile -ExecutionPolicy Bypass -File`
#    on Windows).
pwsh -NoProfile -File scripts/sync-vendored.ps1
pwsh -NoProfile -File scripts/sync-vendored.ps1 -Check

# 3. push the bundles into the web profile
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-all.ps1 -Force   # Windows
sh scripts/install-all.sh -Force                                                     # macOS / Linux

# 4. verify the served bundle really contains the change (optional smoke):
$env:DSH_HOME = "$HOME/.dsh"          # Windows: "$env:USERPROFILE\.dsh"
npx --yes @deepseek-ai/dsh@0.1.5-rc.1 web --no-open --port 3099   # background
# then GET http://127.0.0.1:3099/?token=<token-from-log>, and confirm the boot
# HTML lists dsh-rightbar / dsh-rightbar-files / dsh-editor / dsh-gittree /
# dsh-terminal / dsh-modal /
# dsh-themes / dsh-open-in-app / dsh-diagrams client.js and does NOT LOAD the disabled core rows
# (@deepseek-ai/dsh-client-ui-sidebar-right|files, @deepseek-ai/dsh-client-ui-open-in-app) -
# note that those names still appear in OTHER bundles' `inject` arrays, so match
# the /plugins/??<name>/client.js URLs, not the bare strings.
# It must also NOT list dsh-vn-master: the master is blank, with no client half.
# POST /api/dsh-open-in-app/open {"app":"explorer","path":"<abs dir>"} must open
# a real file-browser window; PUT /api/dsh-editor/file {"create":true,...} must
# create the file (and answer 409 EXISTS on a second try).

# 5. commit as vecnode and push
git add -A; git commit -m "describe the change"; git push
```

## Checklist before finishing a UI change

- [ ] `node --check` passes for every touched `.js`
- [ ] generated files untouched by hand (`dsh-rightbar*/lib/client.js`,
      `dsh-open-in-app/lib/client.js`, `dsh-editor/lib/vendor/cm6.min.js`,
      `dsh-terminal/lib/vendor/xterm.js` + `xterm.css`) -
      re-sync/rebuild instead (`sync-vendored.ps1 -Check` must exit 0)
- [ ] `.ps1` files still parse and `.sh` files pass `sh -n`; all ASCII-only
- [ ] version bumped (`packages/.../package.json` + `.dsh-version.json`) and
      installed with `-Force` to the web profile when behavior changed
- [ ] client bundles still activate and render: run the tracked checks
      (`node scripts/checks/check-client-bundles.mjs`,
      `node scripts/checks/check-node-routes.mjs`,
      `node scripts/checks/check-skill-examples.mjs`) - they drive the real React
      runtime through the module table, the Node route handlers directly, and
      every example the shipped skills tell an agent to write
- [ ] README/`packages/*/README.md` bullets updated
- [ ] no core-file or profile-file edits beyond the installer's own writes
- [ ] pushed to `origin` (`main`) as vecnode
