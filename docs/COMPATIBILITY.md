# Compatibility

The pack targets the harness line DeepSeek ships to the raw web install
(`npx @deepseek-ai/dsh web`). DSH Desktop is not supported by this pack.

## Current pin

| | |
|---|---|
| `@deepseek-ai/dsh` | `0.1.5-rc.1` |
| Forked from | the same `0.1.5-rc.1` line (`.dsh-version.json`'s `vendoredFrom`) |
| Install target | the web profile only (`$DSH_HOME/profiles/web`) |
| Host platforms | Windows (PowerShell 5.1 or 7) and macOS / Linux (POSIX shell + Node.js and npm/npx - no PowerShell); the plugins themselves are plain JS and the only OS-specific code is a launcher choosing the host command: the file-browser launcher (`explorer.exe` / `open` / `xdg-open`), the terminal's shell resolver (`pwsh.exe` or `powershell.exe` / `$SHELL` or `/bin/zsh` / `$SHELL` or `/bin/bash`) and the run launchers' browser hand-off (Chrome, else the platform default) |
| Master | **`dsh-vn-master`**, deliberately blank - the bundle layer plus one no-op `master` row; no client half, no service, no inject edge and no core-row disables |
| Right bar | **owned by the pack** - `dsh-rightbar` / `dsh-rightbar-files` are forks of `@deepseek-ai/dsh-client-ui-sidebar-right` / `-sidebar-files`, and the core rows `ui-sidebar-right` / `ui-sidebar-files` are disabled |
| Open In file managers | **owned by the pack** - `dsh-open-in-app` forks `@deepseek-ai/dsh-client-ui-open-in-app` (row `ui-open-in-app` disabled) and launches the OS file browser directly |
| Session log download | **the seat is the pack's** - `dsh-themes` alpha.9 shadows the shipped header seat (same occupant id, `priority: -10`), so a plain download icon replaces the three-dot button; the shipped `session-log-download` row stays **mounted** for `/api/session.export`, the `/export` command and the `sessionLogDownload` controller the button drives (no row disabled, nothing forked, no new package) |
| Header icon rings | the header's icon buttons all wear the same `.5px` round outline: the pack's own controls draw it themselves and `dsh-themes` adds one rule for the right bar's toggle in the header corner (keyed on the stable `data-conversation-header-corner` marker) |
| Window screenshot | **the pack's** - `dsh-themes` alpha.10 adds a Screenshot control (order `-30`, left of Themes): the browser captures the current tab (`getDisplayMedia`, real pixels, so the terminal's xterm canvas and open dialogs are included) and the pack's own host route `POST /api/dsh-themes/screenshot` writes the PNG to the host's Desktop as `vn-harness-<timestamp>.png` (browser download as the fallback); no shipped row is touched |

## Running the app

The pack ships its own launcher next to the installers - one entry point per
platform, `run.bat` (Windows, double-click it) and `run.sh` (macOS/Linux), both
at the repo root - so starting the GUI is one command instead of remembering the
command line. On Windows the entry point is a batch wrapper and the work is in
`scripts/run-web.ps1`, because cmd cannot watch a running child's output (its
`for /f` reads only up to EOF); `run.sh` does the whole job itself. Both run the
same pinned invocation the docs use -
`npx --yes @deepseek-ai/dsh@<pin> web --no-open [--port <n>]` - and then:

- stream the app's own output to the terminal (nothing is filtered), watching for
  the ready line `dsh web: http://127.0.0.1:<port>/?token=<launch token>`;
- open **that** URL, token included, in **Google Chrome** - found on `PATH`, in
  the standard install folders or through Windows' `App Paths` registry entry,
  `/Applications/Google Chrome.app` on macOS, `google-chrome`/`chromium` on Linux
  - and fall back to the platform's **default browser** when Chrome is absent;
- refuse to open anything that is not a loopback address (`127.0.0.1`, `::1`,
  `localhost`), because the query carries the process's launch token;
- keep the harness in the foreground: Ctrl+C stops it, and the terminal reports
  the app's own exit status.

Flags: `-Port <n>`, `-DshHome <dir>`, `-DshVersion <ver>`, `-NoBrowser`
(start the server only) and `-DefaultBrowser` (skip Chrome). On Windows the
launcher is `run.bat [flags]` (double-click friendly, no execution-policy
question, because the entry point is batch). The launch token is
never written to a file: the POSIX half pipes the app's output through an
anonymous FIFO and both halves keep the token in memory. It reaches the browser as
a single argv element - `Start-Process -ArgumentList` on Windows, an argument of
`open`/`xdg-open` on macOS/Linux - never through a command string; SECURITY.md has
the details.

## What this means for the plugin

- **dsh-vn-master** is the pack's master and is **deliberately blank**: one no-op
  `master` row plus the bundle layer, no `dsh.client`, no service, no `inject`
  edge and no core-row disables. It is installed last (its name sorts last and
  `dsh plugin add` appends), so it is the profile's final layer - the slot for
  pack-wide patches. Because it publishes and consumes nothing, it cannot enter
  or disturb the right bar's tab-type chain.
- **dsh-rightbar** provides the right bar (chrome, docking panel, expand button,
  Start page) and the `sidebarRightTabs` / `sidebarRight` services its tab types
  use; **dsh-rightbar-files** provides the Files tab on top of it.
- **dsh-editor** registers a **tab type** into that bar:
  - `ctx.sidebarRightTabs.register({ id, kind, patterns, priority, canOpen, title, guide })`
    (stage one: what the type is),
  - the keyed body/title seats `sidebar.right.pane.tab` and
    `sidebar.right.pane.tab.title`, registered with `key` = the definition's id
    (stage two: what a tab draws),
  - the `extension` priority band, so text files open editable rather than in
    the shipped read-only viewer; `canOpen` vetoes every extension the shipped
    previews own (html/images/pdf/office/archive/media/binary) and every path
    outside the session workspace - **Markdown is not one of them** (it is text
    and the editor claims it, with the rendered view one click away),
  - a `guide` entry, which is what the tab strip's "+" control lists.
- The workspace tree it opens files from is the pack's Files tab over
  `remote.workspaceFiles` (a shipped host service, not a UI dependency). That
  Remote is read-only, so saving (and creating a new file from a blank editor
  tab) goes through the plugin's own authenticated route; the session's
  workspace root is resolved host-side from the live session header or session
  persistence.
- **dsh-gittree** adds the **History** page tab (its label; the package, row and address keep the `gittree` name): the workspace’s **commit history**
  (short id, subject, author, date), with the branch and the current commit kept in
  its file bar, read through the package’s own **read-only**
  `/api/dsh-gittree/*` routes (the tab uses their `brief=1` form, so it never builds
  a file list). Picking a commit shows its message and the files it touched, and a
  file row opens the file through the ordinary `dsh-resource://file/...` address,
  which the editor or a shipped preview then claims. It replaces nothing and
  publishes no service, so it cannot disturb the bar’s tab-type chain.
  **git must be on `PATH`** for its routes to answer.
- **dsh-terminal** adds a **real shell in a bottom dock**: a header control at
  `order: 30` in the same `conversation.session.header.utilities` list (the last
  utility, right of Open In at `-10`) toggles a horizontal panel that starts at
  the left bar's right edge, spans the page and sits **under** the middle and
  right columns. Those two make room for it - and only those two: the left bar
  keeps its full height and its contents do not move. Inside is vendored
  **xterm.js** attached
  over an authenticated WebSocket to a real **PTY** - ConPTY PowerShell on
  Windows, the login shell on macOS/Linux - so prompts, colors, `Ctrl+C` and
  resizes all behave, and every resize re-fits the emulator so the visible line
  count matches the panel and the newest output stays in view. It replaces
  nothing and publishes no service (it does not
  use the header corner, which the right bar's toggle owns), forks nothing and
  disables no core row.
  - The PTY is the **harness installation's own `node-pty`**, resolved (never
    installed) from `process.argv[1]`, `$DSH_HOME/profiles` or the package's own
    directory; a host where it cannot be resolved reports
    `available:false` on `/api/dsh-terminal/health` and the dock says so - the
    rest of the pack is unaffected.
  - **A terminal is an unsandboxed shell.** It does not pass through the
    file-policy sandbox the model's tools obey; the gate is the connection's own
    authentication, checked before the socket reaches the PTY.
  - Clipboard is `Ctrl+Shift+C` / `Ctrl+Shift+V` (`Cmd` on macOS), because a bare
    `Ctrl+C` has to stay SIGINT.
  - Detaching (a page reload, or closing the dock) keeps the shell for five
    minutes so a reattach replays the retained scrollback; after that it is
    reaped. Sessions do not survive a harness restart.
  - **New package**, so the first install after this change needs a plain
    `install.bat` / `./install.sh` run or `-Force`.
- **dsh-diagrams** adds **Mermaid and TikZ diagrams** as a surface of their own:
  six tools (`diagram_write` / `diagram_patch` / `diagram_read` / `diagram_verify`
  / `diagram_publish` / `diagram_delete`) whose every write is validated before it
  is stored, two bundled skills, one tab per diagram plus an index page, and a
  conversation card per tool call. A diagram belongs to the conversation that drew
  it, or to a shared **library** (`$DSH_HOME/dsh-diagrams/library.json`) that every
  conversation reads and cites by id.
  - **Mermaid is validated headlessly** by a child process that loads the same
    vendored engine the browser renders with behind a DOM stub; **TikZ is
    compiled** by the machine's own TeX engine (argv only, `-no-shell-escape`,
    `MIKTEX_AUTOINSTALL=0`, `openin_any`/`openout_any` paranoid, a private temp
    cwd, a 20 s kill), so a broken diagram returns the parser's or compiler's own
    line-accurate error and the model fixes it in the same turn.
  - **TeX is optional**: with no `pdflatex`/`xelatex`/`lualatex` on the server's
    PATH, TikZ diagrams are still stored, listed and exported as `.tex`, and
    every surface says the diagram was not validated. Mermaid needs no engine.
  - **State is one file per conversation** under `$DSH_HOME/dsh-diagrams`
    (never a session event: `dsh-session-persistence` refuses a log containing a
    type outside `KNOWN_SESSION_EVENT_TYPES` without the `ignorable` marker,
    which `Session.append()` cannot set) plus a content-addressed artifact cache.
  - The **vendored Mermaid engine** (`lib/vendor/mermaid.min.js`, ~3.4 MB) is a
    GENERATED file rebuilt by `vendor/build.mjs`, hashed into
    `lib/vendor/VERSION.json` and re-checked by the tracked route check. The
    harness' Connection fetch registry takes **exact** routes with
    `GET | HEAD | POST` only, which is why the engine is one self-contained file
    on one route and every write is a POST.
  - No npm dependency, no network, no core patch, no forked bundle. The two
    skills are copied into `$DSH_HOME/skills` by both installers (each copied
    folder carries a marker, so a person's own skill is never overwritten and
    uninstall removes only what it wrote).
  - **New package**, so the first install after this change needs a plain
    `install.bat` / `./install.sh` run or `-Force`.
- **dsh-modal** provides the shared `modals` client service the editor's save-as
  dialog uses. It owns no slot and no ordering edge, and the editor resolves it
  lazily (falling back to the browser's own prompt), so neither plugin requires
  the other to be installed.
- **dsh-themes** adds the conversation header's Themes button. It contributes
  one occupant to the shipped `conversation.session.header.utilities` list at
  `order: -20` (left of Open In at `-10`) and drives the shipped
  `@deepseek-ai/dsh-client-ui-theme` service (`getTheme` / `setTheme` / the
  `theme/change` event, resolved lazily) - so the button and
  Settings → General → Appearance are the same preference. The editor reads the
  same service for its own light/dark CodeMirror palette. It also injects the
  pack's appearance overrides: the **Markdown paper**, one rule that re-declares
  ui-theme's own light declarations on the shipped preview's
  `[data-document-markdown]` root, so the rendered Markdown view stays white in
  the dark theme, the **Markdown chrome**, one static rule that hides the
  preview header's viewer menu on Markdown tabs (the page has exactly one
  renderer; the editor's **Edit** button is the way back), and - since alpha.9 -
  the **header ring**, one rule that gives the right bar's own collapse/expand
  toggle in the header corner the same `.5px` round outline every other icon
  button on that bar wears (that button belongs to a GENERATED forked bundle, so
  it cannot draw the ring where it lives; the rule keys on the header's stable
  `data-conversation-header-corner` marker, never a hashed class). Since alpha.9
  the same package also owns the header's **Session-log download seat**: the
  shipped `@deepseek-ai/dsh-session-log-export` browser half put a three-dot "more
  actions" button there whose menu held exactly one item ("Download session log"),
  and the pack registers the **same occupant id** (`session-log-download`) at
  `priority: -10` in that list slot - a list slot renders the **lowest priority**
  registration for an id, the slot system's own shadowing rule - so the ellipsis
  stops rendering and a plain download icon button takes the seat, with no CSS
  hiding and no DOM poking. The seat keeps its `order: 0` (it does not move), and
  its preparing/success/error dialog is drawn from the same store, so `/export`
  keeps its feedback. The **export is not reimplemented**: the shipped row stays
  mounted because its host half owns `/api/session.export` and the `/export`
  command, and this control drives the controller its browser half publishes
  (`sessionLogDownload`, resolved lazily with `ctx.get`). Nothing is forked, no
  core row is disabled and no new package was added; a profile without that
  service shows a disabled button instead of a broken one. On the pack's
  own **left top bar** it also replaces the branding: the shipped mark and wordmark
  (they are `single`-slot occupants filled by the harness's `brand-official` row,
  with the layout's own fish as fallback) are hidden and redrawn as a plain
  **24px black disc** and the text **VN Harness**, in the wide row and in the
  collapsed rail.
- The shipped `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` row stays
  enabled: it only consumes `sidebarRightTabs` and the keyed seat, so the
  code/image/PDF/HTML previews keep working inside the pack's bar, and the editor
  names its kind (`text`, read from the registry) for **Preview**. The pack's
  **first-generation Files panel is retired**: `dsh-files` (row `files`)
  and its pre-alpha.10 name `dsh-focus` are pruned from the profile.

## Upgrading the pack when DSH moves

1. Bump `dsh` in `.dsh-version.json` (and each package's tested note).
2. Re-run `scripts/sync-vendored.ps1` (then review the diff: a patched fork's
   patch list fails loudly when the core code it patches moved).
3. Re-run the installer with `-Force` to re-add bundles under the new CLI pin.
4. If a core API moved (registry shape, seat names, framework props, route
   registration), adapt the affected package and bump its alpha version.
5. Re-run the uninstaller on machines that should drop the old version first.

## Renames, retirements and forks within the pack

- **alpha.9 → alpha.10**: `dsh-focus` (row `focus`) was renamed to `dsh-files`
  (row `files`).
- **editor alpha.1 → alpha.2**: `dsh-files` was retired outright - the harness
  now ships a right Sidebar with a Files tab, and the editor became a tab type
  registering into that bar instead of a panel inside the pack's own dock.
- **installer alpha.2**: the DSH Desktop target was removed; the pack installs
  into the web profile only.
- **rightbar alpha.1**: the pack now **owns the bar**. `dsh-rightbar` and
  `dsh-rightbar-files` are byte-for-byte forks of the shipped
  `@deepseek-ai/dsh-client-ui-sidebar-right` / `-sidebar-files` bundles, and the
  bar's bundle layer hard-disables the two core rows so only the pack's
  copies run. Re-sync the fork with `scripts/sync-vendored.ps1` after a
  harness-line bump (see `ARCHITECTURE.md` §4).
- **editor alpha.4 / modal alpha.1 / open-in-app alpha.1**: the editor starts
  blank documents and names new files through the new shared `modals` dialog;
  the Open In file-manager entries moved to the pack's own cross-platform
  launcher, so `ui-open-in-app` is disabled and `native-open-in-app` runs
  instead.
- **os-neutral alpha**: no version bumps - the launchers gained macOS/Linux
  twins (`install.sh` / `uninstall.sh`, `scripts/*.sh`) and the PowerShell
  scripts stopped assuming Windows; installed profiles are unaffected.
- **editor alpha.5 / themes alpha.1**: the editor's CodeMirror palette follows
  the app's light/dark appearance (oneDark only while the app is dark) and
  re-themes live, and the new **dsh-themes** bundle adds the header button that
  switches Light / Dark / System. New package, so the first install after this
  change needs a plain `install.bat` / `./install.sh` run or `-Force`.
- **editor alpha.6 / themes alpha.2**: **Markdown opens editable** in the editor
  (it is text) with a toolbar **Preview** button that hands the file to the
  rendered view by naming the shipped preview's registry kind; and
  **dsh-themes** carries the **Markdown paper**, which keeps that rendered view
  white in the dark theme by re-declaring ui-theme's own light declarations on
  it. No new packages, no core rows touched.
- **editor alpha.7 / shell-installer alpha**: the rendered Markdown page now
  carries an **Edit** button (the editor's own document body, shadowing the
  shipped one at a lower slot priority), so **Preview is a toggle**: Editor →
  Preview → Edit → Editor on the same tab and file. Separately, `install.sh` /
  `uninstall.sh` and `scripts/install-all.sh` / `uninstall-all.sh` are **real
  POSIX shell implementations** now - Node.js + npm/npx only - instead of
  wrappers around PowerShell, so macOS/Linux hosts no longer need PowerShell at
  all; the `.ps1` half stays the Windows path (`install.bat`), and
  `scripts/sync-vendored.ps1` remains PowerShell-only maintainer tooling.

- **master alpha.1 (new package)**: the pack gained a master bundle of its own,
  **`dsh-vn-master`**, and it is deliberately **blank** - the bundle layer plus
  one no-op `master` host row, with no `dsh.client`, no published service, no
  `inject` edge and no core-row disables. The right bar therefore stops being the
  pack's base and keeps only bar responsibilities; pack-wide patches now belong
  to the master, whose layer is installed last (its name sorts last and
  `dsh plugin add` appends) and is consequently the profile's final word per row.
  Nothing about the bar's tab-type chain changes: `sidebarRightTabs` /
  `sidebarRight` stay in the generated fork, and the `ui-sidebar-right` /
  `ui-sidebar-files` disables stay in `dsh-rightbar`, next to the rows they
  replace. New package, so the first install after this change needs a plain
  `install.bat` / `./install.sh` run or `-Force`.
- **editor alpha.8 / themes alpha.3**: two fixes on the rendered Markdown page.
  The editor's shadow body (alpha.7) replaced the shipped wrapper that undid the
  preview scrollport's plain-text styling, so the page inherited `white-space:pre`
  (a source newline became a hard break and every blank line a full empty line -
  the double-spaced look) and the **Edit** pill inherited the monospace stack;
  the pack's own wrapper now resets both. And because a Markdown page has exactly
  one viewer, `dsh-themes` hides the preview header's viewer menu on Markdown
  tabs, so "Plain text" is no longer offered beside "Markdown" - the editor's
  **Edit** button is the way back to the text. No new packages.

- **gittree alpha.1 (new package)**: the pack gained **`dsh-gittree`**, a
  **read-only** git tab: a page tab type on the right bar with one guide entry
  (`order: 30`, after Files and Editor), showing the workspace's git tree with
  status badges plus a History view whose commits open to their changed files.
  Its Node half owns three read-only routes (`state` / `history` / `commit`) that
  spawn `git` with argv arrays, a pinned environment, a 10 s timeout and an 8 MiB
  cap; the only subcommands reachable are `rev-parse`, `status`, `ls-files`,
  `log`, `show` and `diff-tree`, so it cannot change a repository. Nothing is
  forked and no core row is disabled. A file row opens the file through the
  ordinary file address, so the editor or a shipped preview claims it - the tab
  needs neither. **git must be on `PATH`.** New package, so the first install
  after this change needs a plain `install.bat` / `./install.sh` run or `-Force`.

- **gittree alpha.2**: the tab is **history-only** - the working-tree listing, its path
  filter, its changed-only switch and the viewer switch are gone; what remains is the
  commit list plus the branch and the current commit in the file bar, and a commit’s
  message and changed files when one is picked. The state route gained a `brief=1`
  form for exactly those bar facts, so the tab never builds a file list. It also fixes
  a real hang: alpha.1 returned an effect cleanup that ran on the very next render -
  the one its own `setState` caused - and cancelled the request the effect had just
  started, so the panel sat on "Reading the history…" forever. Every request
  now carries a `useRef` token and applies its answer only while it is the newest one.

- **gittree alpha.3**: the tab is **renamed to History** in the capsule and the chip,
  because it shows commits rather than a file tree. The label is all that changed: the
  package, the row, the kind and the address keep the `dsh-gittree` / `gittree` name, so
  an installed profile needs no re-add - only a restart and a hard refresh.

- **terminal alpha.1 (new package)**: the pack gained **`dsh-terminal`**, a real
  shell in a **bottom dock**. A header button (order 30 in the header utilities
  list, right of Open In...) opens a panel that starts at the left bar's right
  edge, spans the page and sits under the middle and right columns, which make
  room for it: the frame's inline height becomes `calc(100% - <dock>px)` while it
  is open and is restored exactly on close, and the left edge comes from the
  frame's resolved grid tracks, so it follows the left bar opening, collapsing
  and being dragged. **xterm.js 5.5.0** (+ `@xterm/addon-fit` 0.10.0) is vendored
  into `lib/vendor/` from `vendor/` the same way the editor vendors CodeMirror,
  and the Node half owns `/api/dsh-terminal/health`, `/api/dsh-terminal/vendor/*`
  and one authenticated WebSocket upgrade, `/api/dsh-terminal/pty`. The PTY is
  the **harness's own `node-pty`** - resolved, never installed - with
  ConPTY PowerShell on Windows and the login shell on macOS/Linux; one shell per
  (conversation, slot), up to eight, kept five minutes after its last socket so a
  reload reattaches with a scrollback replay. Nothing is forked and no core row
  is disabled. A terminal is, by nature, an **unsandboxed shell**: the gate is the
  connection's own authentication, checked before the socket reaches a PTY. New
  package, so the first install after this change needs a plain
  `install.bat` / `./install.sh` run or `-Force`.

- **terminal alpha.2**: two things the first run got wrong.
  1. Resizing the dock left the emulator at its old size, so the visible line
     count was wrong and the newest output could sit out of view. Every size
     change (grip drag or viewport) now re-fits - rows and columns recomputed from
     the new box - sends the new size to the PTY, and scrolls back to the end of
     the output.
  2. Opening the dock shortened the **left bar**, so its items visibly slid up: the
     room came from the app frame's inline height, and the frame has a single grid
     row that the left bar shares. It now comes from the **middle and right columns
     only**, as their own `height: calc(100% - <dock>px)`, handed back exactly on
     close - the left bar is never touched. (Not `padding-bottom` either: the right
     column's panel is absolutely positioned against its ancestor's *padding* box,
     so padding would leave that panel where it was and the dock would cover its
     bottom.)

  Both are pinned by the tracked client check (`terminal never resizes the frame`,
  `terminal refits on resize and follows the end`) and were verified in a real
  browser engine: the left bar's height and contents are exactly where they were
  before the dock opened, the middle and right columns end at the dock's top edge,
  and growing then shrinking the dock takes the visible rows 13 -> 16 -> 6 with the
  newest output on screen throughout.

- **terminal alpha.3**: collapsing or expanding the **left bar** left the dock
  standing at its old left edge. The left bar is animated - one grid rewrite,
  then a CSS transition - so the `MutationObserver` on that rewrite reports the
  **pre-transition** track (`260px` while the track animates `260 → 171 → 62 →
  60`, measured in the engine) and is never called again. A `ResizeObserver` on
  the two columns the dock spans - whose *size* changes on every frame of the
  transition - now follows it, with a `transitionend` snap as the backstop. No
  new packages, no changed placement: a restart plus a hard refresh is enough.

- **themes alpha.6**: the left bar's **branding is now the pack's**. The mark and
  the product name are `sidebar.brand.mark` / `sidebar.brand.name`, both
  **`single`** slots that the shipped `@deepseek-ai/dsh-client-ui-brand-official`
  row already occupies (and which fall back to the layout's own fish), so this is
  an **override** on the band alpha.4 already owns rather than a fight for a
  one-occupant seat: the slots' children are hidden (`display:none!important`,
  which beats the `display:contents` wrapper the app puts around each occupant)
  and a **24px black disc** plus the text **VN Harness** are drawn in their place
  - in the wide row and in the collapsed rail. Verified in the running app: the
  shipped art computes to `display:none` and the disc to `24px × 24px`,
  `border-radius:50%`, `rgb(0,0,0)`. Pinned to the sidebar's hashed class names
  like the band itself, so a harness bump that renames them needs that one rule
  updated (and the tracked check fails loudly).

- **themes alpha.7**: the branding text wears the **chat title's type**. The
  shipped brand name is `18px/600` while the conversation's own title (the current
  crumb in the header strip the band is levelled with) is `14px/20px/500`, so the
  two read as different sizes a few pixels apart; **VN Harness** now takes the
  title's size, weight and line height. The check pins the declaration, and the
  served `ui-conversation` bundle was compared with the served `dsh-themes` bundle
  to confirm both declare `14px/20px/500`.

- **themes alpha.8**: the branding mark is now the **app icon** —
  `assets/vn-harness.svg` at the pack root, a black circle centred on (12,12) with
  a **1px transparent margin** inside its box. That margin is the fix for alpha.7's
  "cut" disc: it was drawn edge-to-edge inside boxes the app paints with
  `overflow:hidden` (the sidebar's brand button is exactly 24px tall), where the
  circle lost a fraction of a pixel on each side. The same icon replaces the whale
  in the empty conversation's hero ("Into the Unknown", the
  `conversation.hero.brand.mark` slot) at 26px, so the new-session screen wears the
  same mark as the sidebar. The icon is **inlined as a data URI** — no route, no
  request, no Node half — with the asset as the source of truth and a tracked check
  comparing the inlined geometry against it. Verified in the running app (sidebar,
  rail and hero) and at the pixel level: at 24px and 26px the opaque box is exactly
  square with a 1px margin on all four sides, every row and column mirrors, the
  corners are transparent and nothing touches the edge.

  Installers prune both retired bundle names; upgrade by re-running
  `install.bat` / `./install.sh`, then restart the app and hard-refresh the
  browser.

- **themes alpha.9**: the middle panel's top bar loses the shipped three-dot
  "more actions" button (whose only menu item was "Download session log") and
  gains a **download icon button** in the same seat that starts the export on the
  first click. `dsh-themes` registers the SHIPPED seat id (`session-log-download`)
  at `priority: -10`, so the list slot's own shadowing rule (lowest renders) makes
  its component the one that draws - no CSS hiding, no DOM poking, no disabled
  core row and no new package: the shipped `session-log-download` row stays
  mounted because it owns `/api/session.export`, the `/export` command and the
  `sessionLogDownload` controller this button drives (the seat's dialog included,
  so `/export` keeps its feedback). The same alpha gives every icon button on that
  bar the SAME round `.5px` hairline ring: the Themes button and the new download
  button draw it themselves (the terminal control already had it), and one
  override rule gives it to the right bar's own toggle in the header corner,
  keyed on the header's stable `data-conversation-header-corner` marker (that
  button lives in a GENERATED forked bundle and could not draw it where it lives).
  No new packages: an install run with `-Force` (or a plain one, since the version
  changed) plus a restart and a hard refresh is enough.

- **themes alpha.10**: the header gains a **Screenshot control**, one order step
  left of the Themes button (`order: -30`), which captures the whole window and
  saves the PNG to the **Desktop of the machine running the app**. The capture is
  the browser's own - `getDisplayMedia({ preferCurrentTab: true,
  selfBrowserSurface: 'include' })`, one frame drawn into a canvas and encoded as
  `image/png` - because the Web GUI is a fixed-viewport shell (its 100% width and
  100% height are exactly the tab's box) and only the page can photograph its own
  pixels: a DOM-to-canvas library would have to stand in for the engine, and a
  headless browser at the same URL would photograph a fresh load without this
  client's open tab, editor buffer or terminal dock. The file does not go through
  the browser's downloads: `lib/index.js` stops being a no-op row and registers
  `POST /api/dsh-themes/screenshot`, which resolves the host's Desktop per request
  (Windows plain or OneDrive-redirected, `~/Desktop`, XDG `XDG_DESKTOP_DIR`, home
  last), validates the body (`image/png`, the PNG signature, a 64 MiB cap) and
  writes it create-exclusively (`vn-harness-<timestamp>.png`, `-2` on a
  collision), answering the path the toast then shows. A profile without that row
  falls back to an ordinary browser download. Restart `npx @deepseek-ai/dsh web`
  and hard-refresh; the version changed, so a plain install run (or `-Force`)
  re-adds the bundle.

- **diagrams alpha.4 / alpha.6**: `dsh-diagrams` gains a second **scope**. A
  diagram used to belong to the conversation that drew it and to nothing else;
  there is now a shared **library** - one file for the whole harness
  (`$DSH_HOME/dsh-diagrams/library.json`, written by the same store class) - that
  `diagram_write { scope: 'library' }` writes into and `diagram_publish { id }`
  copies a conversation diagram into, addressed as
  `dsh-resource://diagram/library/<id>`. A bare id resolves library-first, the
  index shows both halves, and a panel edit writes back where the diagram already
  is. Alpha.4 is the usability pass around it: the diagram tab lays a picture out
  at 80% of the pane with a **zoom ladder** (25%-400%, remembered per diagram) and
  drag-to-pan that moves the layout box (never a CSS transform), and **every
  export saves to the Desktop** of the machine running the harness
  (`POST /api/dsh-diagrams/export`, create-exclusively, absolute path reported)
  instead of the conversation folder, with the browser download left as the
  fallback. Restart and hard-refresh; the version changed, so a plain install run
  (or `-Force`) re-adds the bundle.

- **themes alpha.12 / alpha.13**: the Themes menu is the **shipped registry's own
  list** now. `dsh-themes` registers its own palettes through
  `ctx.theme.register` - ui-theme's documented third-party surface - starting with
  **Nord** (alpha.12) and adding **Monokai** (alpha.13) in the same 93-token alias
  shape on the dark base. The header button wears one static appearance mark
  instead of the active preference's sun/moon, and the choice is in-process: the
  durable preference schema accepts `light` / `dark` / `system` only, so a reload
  returns to the durable built-in. Adding another theme is one entry in
  `THEME_EXTENSIONS` plus its copy in both dictionaries. Restart and hard-refresh.

- **layout parity (rightbar alpha.2, editor alpha.9, gittree alpha.4)**: three
  changes that are about the same 38px box. The pack's bar lifts the shipped
  bundle's **two-pane dock cap** to the docking kit's own four (with the top/bottom
  drop bands re-opened, so a 2x2 is built by dragging a tab into a pane's upper or
  lower quarter), and the editor's and History's toolbar became the tab's own
  **top bar**: `38px`, `box-sizing:border-box`, the same box the shipped Files tab
  and the document preview use, so every column's first hairline lands on the
  **y=76** line the 38px docking strip, the 76px conversation header and the left
  column's branding band all end on (the toolbar had been `8 + 26 + 8 = 42.5px`,
  i.e. ~4.5px low).

- **run launcher (new)**: `run.bat` / `run.sh` - one file per platform at the repo
  root - start the pinned `dsh web` and open the URL it prints in Chrome, falling
  back to the default browser; see **Running the app** above. Each half holds all
  the work, so there is no wrapper/worker split: the Windows half is one
  self-contained batch file (no PowerShell at all, which is what makes it
  double-clickable) and the POSIX half is POSIX sh. Nothing in the profile changes
  and no bundle was added: the launcher is repo tooling, and an installed profile
  needs nothing to use it.

## Alpha policy

Every package under `packages/` ships with an `-alpha.<n>` suffix. "Stable"
promotion happens only when the owner says so (edit the package `version`,
`.dsh-version.json`, and this table), then re-run the installer with `-Force`.
