# dsh-terminal (alpha.6)

**Terminal** is a **bottom dock** for the DeepSeek Harness web GUI: a real shell,
in the app, under the conversation. A header button — the same 28px round control
the right bar's own toggle wears, sitting immediately right of **Open In...** —
opens a horizontal panel that starts at the **right edge of the left bar**, runs
to the **full width of the page**, and sits **under** the middle and right
columns. Those two columns make room for it and **only those two**: the left bar
keeps its full height, and nothing in it moves.

Inside the panel is **xterm.js** talking to a **real PTY** over an authenticated
WebSocket: ConPTY PowerShell on Windows, the login shell on macOS/Linux. Prompts,
colors, TUI programs, `Ctrl+C`, resizes and scrollback all behave like a terminal
because it is one.

## How it plugs in

Nothing shipped is patched, no core row is disabled, and nothing is forked:
this package adds surface. It contributes two things and owns one row.

| Piece | Value |
|---|---|
| row | `terminal` (`cordis.patch.yml`, an `insert`) |
| header control | `conversation.session.header.utilities`, `order: 30` |
| dock | `shell.overlay` (the layout package's root-scoped **list**), `order: 50` |
| client `inject` | `slots` (code), `@deepseek-ai/dsh-client-ui-conversation` (package) |
| primitives used | `Tooltip` only — the terminal glyph is drawn here |
| Node routes | `/api/dsh-terminal/health`, `/api/dsh-terminal/vendor/xterm.js`, `/api/dsh-terminal/vendor/xterm.css` |
| Node upgrade | `/api/dsh-terminal/pty` (WebSocket, authenticated) |

**Why the header list and not the corner.** `conversation.session.header.corner`
is a **single**-occupant slot that the right bar's toggle already owns, so
registering there would replace it. `...header.utilities` is a **list**: Open In
sits at `-10`, the pack's Themes at `-20`, and this control at `30` — the last
utility, directly left of the corner. Change that one number to move the button.

**Why `shell.overlay` and not a second React root.** The dock has to escape the
frame's `overflow:hidden` to sit at the very bottom of the window, and it has to
live in the app's tree to inherit its React context. Both hold at once: the
overlay layer is rendered *inside* the frame, and the dock is `position:fixed`,
which no ancestor's overflow can clip. The layer's own `z-index:20` also puts the
dock above the columns (10/11) and below a fullscreen right bar (40) for free.

## Geometry

The dock is not a grid child of the app frame (that would mean writing foreign
nodes into a React-managed container), so it positions itself:

- **Left edge** — the frame's columns are an inline
  `gridTemplateColumns: <sidebar>px minmax(0,1fr) <rightbar>px`, so the RESOLVED
  computed style carries the left bar's width in px. No hashed class names, and
  it follows the left bar opening, collapsing (`0`) and being dragged.
- **Room** — taken from the **middle and right columns only**, as their own
  `height: calc(100% - <dock>px)`; on close each gets back the inline height it
  had before this plugin ever ran. Both are found without hashed class names: the
  layout marks the right column itself (`data-rightbar-col`), the middle column is
  its immediately preceding sibling in the frame, and the frame's **first element
  child** — the left bar — is explicitly never one of them.
  - *Not the frame's height.* The frame has a single grid row, so shrinking the
    frame shortens the left column with it: alpha.1 did exactly that, and the left
    bar's contents visibly slid up the moment the dock opened.
  - *Not `padding-bottom` either.* The right column's panel is absolutely
    positioned inside it, and an absolute child is placed against its ancestor's
    **padding** box, so padding would leave that panel where it was and the dock
    would cover its bottom. A height shortens the column itself.
- **Live tracking** — a `MutationObserver` on the frame's `style` attribute (a
  drag rewrites it every frame), a `ResizeObserver` on the two columns the dock
  spans, a `transitionend` on the frame, and a `resize` listener. The
  `ResizeObserver` is what follows the **left bar being collapsed or expanded**:
  that is animated, so the grid tracks are rewritten *once* and then transitioned
  — the mutation reports the pre-transition value and never fires again (alpha.2
  left the dock standing at the old edge), while the columns' **size** changes on
  every frame of the transition. `transitionend` is the final snap.
  - *Installed once, not per height.* Placement and tracking are two effects
    (alpha.6). They used to be one, keyed on the height, so **every frame of a
    dock drag disconnected both observers and built them again** — with their
    pending notifications then landing on the fresh ones. Placing the dock is now
    a two-write effect; the observers are installed while the dock is open and
    read `dock.height` at call time (module state, so there is no stale closure).
- **Intent is separate from geometry.** `data-open` is user intent;
  `data-suspended` is derived (a fullscreen right bar takes the viewport, and the
  dock yields *and* hands the columns their height back for the duration). The
  observer only ever writes the derived one — the first spike run failed exactly
  here, reopening the dock on the very close that restored the frame's height.
- **Resizing** — the grip drags the height (120px … 70% of the viewport), and it is
  remembered in both `localStorage` and the pack's shared section. Every change
  **re-fits the emulator**: rows and columns are recomputed from the new box and
  the view is put back on the **end of the output**, so a drag never leaves a
  stale screen with the wrong number of lines and never hides the newest ones.
  Three things keep the drag itself honest (all alpha.6, all reported from use):
  - the height comes from the **pointer's** Y and the values captured at
    `pointerdown`, never from the dock's rect — the grip moves as the dock moves,
    so a handler that measured it would chase itself. Moves are coalesced to one
    per animation frame, the pointer is captured for the duration, and the drag
    closes on `pointerup` **and** `pointercancel`;
  - the **PTY** is told the new size at most every `SIZE_WIRE_MS` (120ms) while
    the drag runs, and always once when it settles. The emulator is re-fitted on
    every frame — that is what makes the line count follow the pointer — but every
    size message makes the shell redraw its prompt, and one per frame is ~60
    prompt redraws a second;
  - the shared section is written **once, 400ms after the drag settles** (plus a
    flush at release), never per pointer move. See the alpha.6 note below: a write
    per move is what made the dock fight its own echo.

## What it does

- **Several terminals per conversation** (up to 8): the bar's chips switch
  between them, `+` opens another, a chip's `×` kills that one shell. The dock
  is bound to the conversation that opened it; **switching conversation closes
  it**.
- **The chip strip scrolls sideways** once the terminals outgrow it. While there
  is real overflow the strip grows a `‹` and a `›` — one page per click, and they
  dim at the ends — a bare wheel over the strip moves it, and the chip on screen
  is always scrolled into view, so a terminal added with `+` (or picked from the
  strip) never lands out of sight. The `+` sits **outside** the strip and is
  therefore always reachable. The strip wears those arrows *instead of* a
  scrollbar: a classic scrollbar on a 24px row costs more height than it explains
  and would shift the whole bar the moment one more chip appeared.
- **Clipboard** is `Ctrl+Shift+C` / `Ctrl+Shift+V` (`Cmd` on macOS). A bare
  `Ctrl+C` stays **SIGINT**, which is the whole reason for the shift.
- **Follows the app's appearance**: the palette is re-applied from
  `body[data-ds-dark-theme]` and re-paints the live terminals; the dock element
  carries `data-appearance` so the appearance in force is visible.
- **Survives a reload.** Detaching (page reload, closing the dock) closes the
  socket but not the shell: the PTY is kept for five minutes, and a reattach
  replays the retained scrollback (256 KiB ring). Nothing is left running for
  ever — an unattached session is reaped.
- **Graceful degradation.** If the host has no PTY, the dock says so with the
  reason instead of failing; the row still mounts and the rest of the pack is
  untouched.

## The PTY comes from the harness, not from this pack

A browser terminal needs a **real** pty, and the harness already installs
`node-pty` (prebuilds for `win32-x64/arm64` ConPTY, `darwin-x64/arm64`,
`linux-x64/arm64`) as part of its own dependency closure. So this package
installs nothing and builds nothing native. What it does have to do is **find**
it: an out-of-tree plugin's own path is this repository, and Node resolves bare
specifiers by walking up from the importing FILE, so `import('node-pty')` from
here fails. `lib/pty.js` therefore resolves through, in order:

1. `process.argv[1]` — the running entry, whose parent walk lands in that
   installation's `node_modules`;
2. `$DSH_HOME/profiles` — `@deepseek-ai/dsh-app-boot` mirrors the installation
   closure into `$DSH_HOME/profiles/node_modules` for exactly this;
3. this package's own directory — so a future line where `node-pty` is a
   declared dependency here works unchanged.

`ws` is loaded the same way. Because `node-pty` is a harness internal rather than
a published API, resolution failure is a first-class outcome: `GET
/api/dsh-terminal/health` answers `available:false` with the reason, and the dock
renders it.

**The dock is an unsandboxed shell.** That is what a terminal is: it does not
pass through the file-policy sandbox that the model's tools obey. The gate is the
connection's own authentication, checked *before* the socket reaches `ws`
(`connection.requestRejection`, then a raw 401/403 written into the socket — the
same two-step the product's own WebSocket mux performs).

## Wire protocol

Text frames; a control frame is prefixed with `U+0000` so that `cat` of a JSON
file can never be mistaken for one.

| Direction | Frame |
|---|---|
| → | `\0{"t":"init","session":"<conversation>","slot":0,"cols":80,"rows":24}` (always first) |
| → | `\0{"t":"resize","cols":N,"rows":N}` · `\0{"t":"kill"}` · `\0{"t":"ping"}` |
| → | anything else: written to the shell verbatim |
| ← | `\0{"t":"ready","key","index","shell","cwd","pid","cols","rows","attached","replay"}` |
| ← | `\0{"t":"exit","code","signal"}` · `\0{"t":"closed","reason"}` · `\0{"t":"pong"}` · `\0{"t":"error","code","message"}` |
| ← | anything else: raw terminal output |

Backpressure is honest, not invisible: past 4 MiB of unflushed socket bytes the
PTY is paused (`IPty.pause`) and resumed once the queue drains. Nothing is
dropped. A heartbeat (`ping`/`pong`) drops dead sockets. `pid` is `null` in the
first `ready` frame on Windows, where node-pty reports `0` until ConPTY attaches.

## Files

```
package.json          one dsh bundle: the row, plus the client half
cordis.patch.yml      bundle layer: inserts the 'terminal' row (nothing else)
lib/index.js          Node half: the routes above + the authenticated upgrade
lib/shell.js          the ONE per-OS file: which shell this host runs
lib/pty.js            node-pty resolution, the session registry, the reaper
lib/client.js         browser half (module-table bundle, no build step)
lib/vendor/xterm.js   GENERATED - vendored xterm.js classic bundle (window.DSHTerminal)
lib/vendor/xterm.css  GENERATED - its stylesheet, served beside it
vendor/package.json + vendor/entry.js - reproducible build inputs
```

### Regenerating the vendored xterm bundle

```sh
cd packages/dsh-terminal/vendor
npm install
npx --yes esbuild entry.js --bundle --minify --format=iife --global-name=DSHTerminal \
  --target=es2020 --outfile=../lib/vendor/xterm.js
cp node_modules/@xterm/xterm/css/xterm.css ../lib/vendor/xterm.css
```

(On Windows use `..\lib\vendor\xterm.js` in the last argument and `Copy-Item` for
the stylesheet.) The bundle is **generated**: never edit `lib/vendor/*` by hand.

## Checks

```sh
node scripts/checks/check-client-bundles.mjs   # bundle id, both seats, order 30, markup, geometry invariants
node scripts/checks/check-node-routes.mjs     # routes, etag, and a LIVE shell over a real socket
```

The node check drives the real protocol against a real PTY when this host has
one (and says so when it does not): `init` → `ready` → a command answered →
`kill`, a JSON line proven to be shell input rather than a control frame, and an
unauthenticated upgrade refused with 401.

The client check cannot run effects, so the geometry promises are pinned at the
source level: this bundle must never write the frame's height, it must inset the
two columns it spans, it must re-fit (and follow the end) on a resize, and it
must track the left bar through *both* the mutation observer and the column
`ResizeObserver` (plus the `transitionend` snap). The bar's own two behaviours are
pinned the same way (alpha.4): picking a chip must write the store **and** bump
its revision — `runtime.show()` alone left the highlight on the terminal the
reader had just left — and the strip must be a scrolling box with the `+` outside
it, the arrows gated on real overflow and the wheel listener registered natively
as `{passive:false}`. The strip's scroll arithmetic is pinned by **driving** it
rather than reading it: the bundle exposes its pure half as
`__internals.revealDelta(box, chip, margin)` and the check asserts the sign in
both directions, the 8px of air and the no-op case — a sign error there scrolls
the strip *further away* from the chip it was asked to show, and no static render
would ever see it.
The behaviour itself was verified in a real browser engine while it was built —
including that the left bar's height and contents are byte-for-byte where they
were before the dock opened, that the middle and right columns end exactly at the
dock's top edge, that growing then shrinking the dock takes the visible rows from
13 → 16 → 6 with the newest output on screen throughout, and that the dock follows
an **animated** sidebar collapse and expand (the case that failed in alpha.2: with
the tracking removed, that check reports the dock stuck at its old edge).

## Alpha notes

- **alpha.6** — dragging the dock's top edge "did not work well": the panel
  jumped, kept moving after the release, and the only way out was to hide it.
  Three causes, all in the resize path:
  1. **the dock fought its own echo.** alpha.5 put the height in the pack's shared
     section, and the section is a *queued, non-optimistic* wire write: `set` is
     one request per call, and the scope re-announces on every accepted view —
     so the accept handler re-read the section and adopted whatever the LAST
     accepted view carried. During a drag that is a height the pointer left
     behind a moment ago, and with one write per `pointermove` the answers were
     seconds behind: the dock was dragged up, snapped back to a stale echo,
     dragged up again, and the queue kept replaying old heights after the release.
     An accepted view is now adopted only when it is **news** — `adoptDecision`
     refuses while the pointer is down, refuses this client's own last written
     value, and refuses the height already in force — an adopted height is written
     with `persist: false`, the shared write is debounced to 400ms past the
     settle (the same figure dsh-ui-state uses for its own column-width drags),
     and the release flushes the final value at once.
  2. **the observers were rebuilt per frame** (see *Geometry*).
  3. **the PTY heard a resize per frame**, and a shell redraws its prompt on each
     one (see *Resizing*).
  The grip is also easier to grab and to keep hold of: a small handle bar that
  brightens on hover, `setPointerCapture` for the drag, `pointercancel` handling,
  and `body.dst-dragging` (row-resize cursor, no text selection) while the
  pointer is down. `adoptDecision` is exported in `__internals` and pinned
  behaviourally by the tracked check — the arithmetic is four numbers and two
  flags, and the source shapes that let this ship were all present and correct.
- **alpha.4** — two things about the bar itself, both reported from use:
  1. picking a chip showed the terminal but left the **highlight** on the chip you
     had just left. The pick was routed through `runtime.show()`, which writes
     `dock.active` straight into the store's map and re-fits the visible emulator
     but never bumps the revision — so React did not re-render and `data-active`
     stayed where it was. The pick now goes through one `selectSlot()` that writes
     the store, asks the runtime to show the slot and bumps; showing and
     highlighting cannot disagree again.
  2. chips that ran past the right edge were **clipped** (`.dst-chips` was
     `overflow:hidden`), with `+` inside that same clipped strip. The strip is now
     a horizontally scrolling box with the `+` beside it, arrows that appear only
     while it really overflows (one page per click, dimmed at each end), a bare
     wheel that moves it, and a scroll-into-view for the active chip.
- **alpha.3** — collapsing or expanding the left bar left the dock at its old left
  edge. The left bar is animated: one grid rewrite, then a CSS transition, so the
  `MutationObserver` on that rewrite reports the *pre-transition* track and is
  never called again. A `ResizeObserver` on the two columns the dock spans (whose
  **size** changes on every frame of the transition) now follows it, with a
  `transitionend` snap as the backstop. Measured in the engine: the callback sees
  `260px` while the track animates `260 → 171 → 62 → 60`.
- **alpha.2** — two reports from the first run, both fixed here:
  1. resizing the dock left the emulator at its old size, so the line count was
     wrong and the newest output could sit out of view. Every size change now
     re-fits (rows/cols from the new box), tells the PTY, and scrolls to the end;
  2. opening the dock shortened the **left bar** (the frame's single grid row was
     being shrunk with it), so its contents slid up. The room now comes from the
     middle and right columns as their own height — the left bar is never touched,
     and it is handed back exactly on close.
  2 also changed the mechanism, not just the numbers: `padding-bottom` was tried
  first and is wrong for the right column, whose panel is absolutely positioned
  inside it against its ancestor's *padding* box.

## Known limits

- One PTY per (conversation, slot); slots are capped at 8 per conversation.
- Sessions do not survive a harness restart (they are process-local), and the
  scrollback ring is 256 KiB — older output is dropped, not paged.
- The dock is positioned from the frame's resolved grid tracks, and the two
  columns it insets are found from the layout's own `data-rightbar-col` marker
  plus sibling order: a harness line that stops using `grid-template-columns` for
  the columns, or that puts something else between the middle and right columns,
  needs `columnsFor` updated (there is no layout service API for a bottom region).
- A fullscreen right bar suspends the dock while it is up.
- Windows reports `pid: null` in the first `ready` frame (see above).
