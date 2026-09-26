# dsh-terminal (alpha.8)

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

Right beside it — behind one **Agent** switch — is a **live transcript of the
agent's own terminal use**: every `bash`/`pwsh`/`run_code`/`terminal_send` call
this conversation recorded, grouped under the prompt that asked for it, with its
exit status, duration and output. It is a *second view of the conversation you
are already in*, not a second shell: see below.

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
| Node routes | `/api/dsh-terminal/health`, `/api/dsh-terminal/activity` (read-only), `/api/dsh-terminal/vendor/xterm.js`, `/api/dsh-terminal/vendor/xterm.css` |
| Node upgrade | `/api/dsh-terminal/pty` (WebSocket, authenticated) |
| agent view (alpha.7) | read-only: the `/activity` route answers a filtered **tail** of the conversation's session events, folded in the browser by the same pure fold the check drives |

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
- **The agent's own terminal use, beside your shell** (alpha.7): the bar's
  **Agent** switch puts an `Agent` chip at the head of the strip whose view is a
  read-only transcript of every command this conversation ran — grouped under the
  prompt that asked for it, with the tool, the working folder, the duration, the
  exit status and the output. See *The agent's own terminal use* below.
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
  untouched. The agent view degrades the same way: a host whose routes are not
  reachable, or a conversation that is not open on this host, says so in the
  panel instead of throwing in a render.

## The agent's own terminal use

Your shell and the agent's commands are **two different worlds**. The agent runs
`bash`/`pwsh` through the harness's own shell tool, in the harness's own process;
it never touches the PTY in this panel, and this panel cannot attach to it. So
the second view is not a second terminal: it is a **transcript of what the
conversation recorded**, drawn in the dock because that is where you are already
looking. You keep your shell, and you can see — without reading a single message
— what the agent ran.

**The switch is a mode.** `Agent` in the dock's bar adds an `Agent` chip at the
head of the strip and shows it; switching it off takes the chip away and hands
the panel back to the terminal you were on (not to slot 1). The toggle is
remembered per origin in `localStorage` — a *view* preference, which is exactly
why it may be remembered while the dock's **open** state deliberately is not: the
panel is a window onto a process, and a boolean that resets merely re-hides the
log. It is `localStorage` and not the pack's durable section on purpose: promoting
it would mean adding a field to `dsh-ui-state`'s schema, i.e. changing another
package's data contract for a boolean.

**What it shows.** One row per executing tool call — `bash`, `pwsh` (foreground
*and* persistent), `run_code`, `terminal_send` — grouped under the human prompt
that preceded it, so the log reads *what you asked, then what it ran*. Each row
carries the tool, the command (or the sent text), the working folder when the
call named one, the duration, and a status pill: `running`, `exit N`,
`killed · SIG`, `error`, or `done`. Output is clamped to 12 lines with
**Show all N lines**; long output is never hidden outright. A row expands on
click (or on `Enter`/`Space` — the head is a `role="button"`), and carries three
actions: **Copy command**, **Copy output**, and **Run in Terminal**.

**Run in Terminal TYPES the command into your active shell; it does not submit
it.** You get the agent's command line in your prompt, to read, edit or run —
which is the whole point of having both halves in one panel. It is offered only
for a **single-line** command: a multi-line command would have its newlines
submitted as they were typed, so the row says `multi-line` instead of offering a
foot-gun.

**Filters.** `Commands` (the default) / `All tools` switches every other tool call
into the log as a one-line row with its own status and a summary taken from its
arguments (`file_path`, `pattern`, `query`, …); `Failures` narrows to what went
wrong. The filter is applied at RENDER time: changing it never re-reads the
conversation.

**Following is a scroll position, not a mode.** The view follows the tail while
you are at the bottom, stops the moment you scroll up (a **Follow ↓** pill appears
in its bar to come back), and shows the newest command otherwise.

**Where the data comes from** — the conversation's own durable session events,
served by this package's read-only Node route `GET /api/dsh-terminal/activity`
and folded **in the browser** by the same pure fold the tracked check drives:

| Event | What it contributes |
|---|---|
| `tool/call` | `{ turn, step, callId, name, arguments }` — `arguments` is the RAW JSON string, so the command appears the moment the call is dispatched |
| `tool/result` | `{ turn, step, message, error?, meta? }` — `message.content[0]` is the `ToolResultBlock`: its `content` is the output, its `isError` the failure flag |
| `user/message` | a prompt when `source.kind === 'user'` (every other kind is injected context, and does not open a group) |

**Why the route and not the browser's own session window.** The harness's client
does expose a session's event window (`sessions.binding(id).eventSource`), and
alpha.7's first cut read exactly that. It does not work for this panel: the
window opens only once that conversation is *staged* by the browser, and a panel
that is supposed to have something to show the moment the app opens instead sat
on "Reading the conversation…" until something else moved the session along
(sending a message did). The **host** always has the log — it is the log's owner —
so the route answers from there, and the panel fills in on the first poll
whatever the browser has or has not staged.

The route is read-only, filtered and bounded: only those three event types are
sent (an assistant message with its embedded stream is neither sent nor needed),
injected context and non-human `user/message` events are dropped on the host, and
the answer is the **tail** — at most 400 events and roughly 512 KiB, newest first
— with `hasMore` stating that older ones were left out rather than truncating
silently. The newest event is always included even if it alone is oversized: a
single enormous command must not leave the panel with nothing to draw.

The panel re-reads that route every 6 seconds, and every 2 while a command is
running. The poll stops when nothing is subscribed (the header control of the
conversation on screen is the usual subscriber), pauses in a hidden tab and
resumes on the next visit, and publishes **nothing** when the fold's signature is
unchanged — a steady conversation costs an idle request and no re-render.

The exit status is recovered from the `\n[exit code: N]` / `\n[killed by
signal: X]` markers that `@deepseek-ai/dsh-shell/render` appends — the same
mirror-not-import the shipped terminal card does. It is read **only for a
foreground shell tool**: a persistent shell can report resets and partial output
without any single process exit status, so it claims none and settles as `done`.
A result whose `tool/call` is outside the tail still becomes a row (its
output is worth seeing) but names no tool and claims no exit status. Output
passes through the same kind of filter the host's own `TerminalSanitizer` is:
OSC, two-character escapes and CSI are removed before anything is drawn.

**Why the event log and not the Chat assembly.** `uiConversation`'s assembled
snapshot would hand over paired nodes for free, but it is a *view* registry —
a node can be hidden by a presentation choice that has nothing to do with what
happened, and reaching it means depending on another package's render layer.
The event log is the durable truth underneath it, and folding it in the browser
means this panel and the transcript can only disagree about *presentation* —
and the fold lives in one place, so the panel and the tracked check cannot
disagree about what a command is.

**What it deliberately does not do.** It does not stream. The harness has exactly
two tool events and no live output channel, so a command shows as `running` from
the moment it is dispatched and its output lands in one shot at settle — a real
"live stdout" feed would need a host-side tap on the shell executor (and a new
socket), which is a much larger change than a view. Long-running commands are
usually backgrounded anyway, and then the agent's own `job_output` calls appear
here as rows, which is where their output is read.

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
lib/client.js         browser half (module-table bundle, no build step): the dock,
                      the terminals, and the agent-activity view + its feed
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
node scripts/checks/check-client-bundles.mjs   # bundle id, both seats, order 30, markup, geometry invariants, the activity arithmetic
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

The agent view (alpha.7) is pinned on both sides. The **Node** check drives the
route itself: that only the three event types the panel draws are sent, injected
context and assistant streams are dropped, the answer is in log order, a
conversation that is not open answers `NOT_LIVE` (with a 200, because that is a
fact about the host and not a bad request), an unreadable log answers
`UNREADABLE`, a missing session id is a 400, a conversation past the budget
answers with its **tail** (newest kept, `hasMore` set) and one oversized newest
command is still sent. The **client** check pins that the bundle reads that route
and no longer reaches for the browser's own session window, that the poll stops
when nothing is subscribed and pauses in a hidden tab, that the switch is a
**mode** (off by default, `aria-pressed`, and no `Agent` chip in the strip until
it is on), that the stylesheet carries the view's rules, that killing a chip does
not move a reader looking at the log, and that **Run in Terminal** refuses a
multi-line command. Then the bundle's pure half is **driven** with hand-built
events — `parseExecCall` (including that a missing `description` marks the
persistent shell and that `read` is not a command), `parseExitMarker` (the marker
consumed, a signal not an exit code, marker-like text mid-output left alone),
`stripAnsi` (CSI, OSC, a bare CR), `formatDuration`, `filterActivity`
(commands-only is the default, `All tools` adds the rest, empty groups drop) and
`buildActivityFromEvents` (grouping by prompt, injected context NOT opening a
group, a failure read off its marker, a call with no result still running, a
persistent shell claiming no exit status, a result outside the tail kept but
unnamed) — plus `activitySignature`, which is what keeps a poll that returns the
same log from re-folding it.

## Alpha notes

- **alpha.8** — the agent view showed nothing: `Reading the conversation…`, and
  it only filled in after a new message was sent. The read was the bug, not the
  drawing. alpha.7 read the **browser's** session window
  (`sessions.binding(id).eventSource`), and that window opens only once the
  conversation has been taken onto the client's **stage** — so a panel that is
  supposed to have something to show the moment the app opens had nothing to read
  yet, and it stayed that way until something else (a new message) moved the
  session along. The events now come from the **host**, which owns the log:
  `GET /api/dsh-terminal/activity` answers a filtered tail of it and the browser
  folds that, so the panel fills in on the first poll of a freshly opened app.
  Two consequences worth naming: the view now sees the **whole** conversation
  rather than the loaded page (bounded to a tail of 400 events / ~512 KiB, with
  `hasMore` stating what was left out), and the harness must be **restarted** for
  the new route to exist — a host row is loaded at boot, so a page refresh alone
  would answer `The terminal routes are not reachable` until it is.
- **alpha.7** — the agent's own terminal use, in the dock (see the section
  above). Five decisions worth naming:
  1. **a transcript, not a second shell.** The agent's `bash`/`pwsh` run in the
     harness's process and cannot be attached to this panel's PTY, so the view
     reads the conversation's own durable events instead. It adds **no PTY and no
     host state**, and its one route is read-only — an "observation" feature must
     never become a second execution path.
  2. **the log from the HOST, not the browser's session window.** The client does
     expose one (`sessions.binding(id).eventSource`), and the first cut read it —
     then sat on "Reading the conversation…" until something staged the session,
     because that window only opens for a conversation the browser has taken onto
     its stage. The host owns the log, so the panel asks the host, and it fills in
     on the first poll of a freshly opened app.
  3. **the fold in the browser, exported for the check.** Keeping it client-side
     means one implementation of "what a command is" — the panel and the tracked
     check cannot drift — while the host stays a filtered, bounded reader.
  4. **the view is the toggle.** An `Agent` chip at the head of the strip reads
     as one more thing to switch to, reuses the strip's own scrolling, arrows and
     scroll-into-view, and needs no geometry change: `ACTIVITY_VIEW = -1` is an
     index no slot has, so the runtime hides every emulator with the code it
     already had and the emulators stay mounted (a shell is a process — hiding it
     must not detach it).
  5. **honest about what a terminal cannot know.** Output arrives at settle, not
     live (the harness has no tool-output stream); a persistent shell claims no
     exit status; a call outside the tail names no tool; `Run in Terminal` refuses
     a multi-line command because its newlines would submit themselves. Each is
     drawn as what it is rather than smoothed over.
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
- The agent view shows the **tail** of the conversation's log: at most 400
  relevant events and roughly 512 KiB, newest kept. A conversation past that says
  so (`older ones are outside this view`) rather than offering to page them.
- The agent view reads the conversation only while it is **live on this host** (a
  stored conversation that no process has open answers `NOT_LIVE`), it is
  refreshed by polling rather than pushed — 6 s, or 2 s while a command is
  running — and it names commands by tool: a call whose `tool/call` event is
  outside the tail is shown as an unnamed result with its raw output, and
  sub-agent commands belong to the sub-agent's own session (the root `subagent`
  call is what appears here).
- The activity switch is remembered per origin (`localStorage`), not in the
  pack's durable section: making it survive across the Chrome tab and the desktop
  window needs a `terminalActivity` field in `dsh-ui-state`'s schema, which is a
  change to another package's data contract rather than a change to this one.
