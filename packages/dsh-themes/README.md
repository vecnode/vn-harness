# dsh-themes (alpha.13)

**The pack's conversation-header package.** It owns three controls on that header
and the appearance overrides that dress it.

**1. Themes** — one small control in the web GUI's conversation header: a button,
the size and dress of the header's other icon buttons, sitting immediately **left
of the shipped "Open In…" control**. Pressing it opens a menu with the three
appearances the product already offers — **Light**, **Dark** and **System** — plus
every theme **registered into the shipped theme registry** (alpha.12), which is
where this package's own **Nord** and **Monokai** (alpha.13) come from. The button
wears one static appearance mark rather than the active preference's sun/moon. See
[Registered themes](#registered-themes-nord-alpha12-and-monokai-alpha13).

**2. The Session-log download seat** (alpha.9) — the shipped
`@deepseek-ai/dsh-session-log-export` browser half put a **three-dot "more
actions" button** in that same header group whose menu held exactly **one** item,
"Download session log": one click to open a menu, a second to pick the only thing
in it. This package takes that seat and draws **one plain download icon button**
on it — one click and the export starts. The export itself is not reimplemented:
the shipped row stays mounted and its `sessionLogDownload` controller does the
work, so the button and the `/export` command stay one implementation. See [The
Session-log download seat](#the-session-log-download-seat-alpha9).

**3. The Screenshot control** (alpha.10) — one more button on the same row, left of
the Themes control. It captures the **whole window** (the app is a fixed-viewport
shell, so the page's 100% width and 100% height are exactly the tab's box) and
saves the PNG to the **Desktop of the machine running the app**, through this
package's own host route. Since alpha.11 the picture is **the interface as it
stands**, the header's own buttons included; only an open tooltip bubble is kept
out of the frame. See [The screenshot control](#the-screenshot-control-alpha10).

It also carries the pack's **appearance overrides** — rules that hold one surface
on a fixed palette or a fixed shape whatever the app theme is. The first is the
**Markdown paper** (alpha.2): the rendered Markdown view stays white in the dark
theme. The second is the **Markdown chrome** (alpha.3): that same page has exactly
one viewer, so the preview header's viewer menu is hidden on Markdown tabs. The
third is the left column's **top bar** (alpha.4): the sidebar's branding row
becomes the same 76px band, ending in the same hairline, that the middle and right
columns open with — and, since alpha.6, that row wears the pack's own **VN
branding** (a 24px black disc and the text *VN Harness*) instead of the shipped
fish and wordmark. The fourth (alpha.9) is the **header ring**: the right bar's
own collapse/expand toggle in the header corner is the one icon button on that bar
that could not be given the group's round outline where it lives (it belongs to a
GENERATED forked bundle), so one rule keyed on the header's stable corner marker
gives it the same ring this package's three header buttons draw themselves. See
below. All of them are plain engine-neutral CSS, so they hold in whichever browser
the Web GUI is opened in.

It is a thin control, not a second theme system:

- the **preference** stays owned by the shipped
  `@deepseek-ai/dsh-client-ui-theme` — its `theme` client service persists the
  choice in the `ui-theme` settings namespace, resolves `system` through
  `prefers-color-scheme`, and ui-layout applies every snapshot to the document
  (`body[data-ds-dark-theme]` + the `--dsw-*` tokens);
- this bundle only **reads** the published snapshot and calls `setTheme(id)`,
  exactly like the Settings → General → **Appearance** row. Switching here
  updates Settings, and switching in Settings updates this control: there is one
  preference, one persistence path, and one palette.

It can also **register** themes through that same service (`ctx.theme.register`,
ui-theme's documented third-party surface) — see
[Registered themes](#registered-themes-nord-alpha12-and-monokai-alpha13).

## Registered themes: Nord (alpha.12) and Monokai (alpha.13)

The **registry is the extension point**, and this package uses it.
`@deepseek-ai/dsh-client-ui-theme` exposes `register({ id, colorScheme, tokens })`;
ui-layout's presenter writes a registered theme's alias tokens as **inline CSS
variables on `body`**, over whichever base palette `colorScheme` selects, and
`getTheme()` publishes every registered theme in `snapshot.themes`. This bundle:

- **registers** each theme in `THEME_EXTENSIONS` inside a `ctx.effect`, so the
  theme leaves the registry with the row. A profile without ui-theme simply has
  nothing to register into, and the control reports that the way it always did;
- builds the control's **menu from the registry** (`snapshot.themes`, with the
  `system` preference appended last), so a theme becomes selectable by being
  registered — there is no second list to keep in step;
- draws the header button with **one static appearance mark** (a half-filled
  disc) instead of the active preference's sun/moon. A registered palette has no
  shipped glyph to wear, and the menu — plus the tooltip, which names the active
  theme — is where the choice is.

### Nord

**Nord** ([nordtheme.com](https://www.nordtheme.com/)) is registered on the
**dark** base palette and recolors the alias layer with the palette's own colours:

| Nord | Values | What they paint here |
|---|---|---|
| Polar Night | `#2e3440` `#3b4252` `#434c5e` `#4c566a` | the page, the surface ladder, menus, code blocks, scrollbars |
| Snow Storm | `#d8dee9` `#e5e9f0` `#eceff4` | primary and secondary text, inverted foreground |
| Frost | `#8fbcbb` `#88c0d0` `#81a1c1` `#5e81ac` | brand, links, primary button, switches, focus rings, muted text |
| Aurora | `#bf616a` `#d08770` `#ebcb8b` `#a3be8c` `#b48ead` | the error / warn / success states and the syntax tokens |

`nord0` is the page for the conversation **and** the sidebar (the way
vscode-nord draws editor and sidebar alike — the columns are separated by the
frame's own hairline, not by a lighter rail), a code fence sits one step above it,
and the syntax colours follow the rules nord-vim follows: keywords and comments in
Frost `#81a1c1`, functions and links in `#88c0d0`, strings in Aurora green,
numbers in `#b48ead`.

### Monokai (alpha.13)

**Monokai** ([monokai.nl](https://monokai.nl/)) is the classic TextMate palette
Wimer Hazenberg wrote for Coda, registered on the **dark** base palette with the
same 93 token overrides Nord carries — 73 alias, 11 `--dsw-specific-*` and the
nine shiki syntax tokens:

| Monokai | Values | What they paint here |
|---|---|---|
| Surfaces | `#272822` `#2f3029` `#3e3d32` `#49483e` | the page, the raised step, and the theme's own line-highlight and selection steps — menus, code blocks, scrollbars |
| Text | `#f8f8f2` `#dadad5` `#b6b4a8` `#75715e` | the off-white body, its 12% darker step, the comment grey lifted halfway back to the body, and the comment grey itself as the quietest tier |
| Warm accents | `#f92672` `#fd971f` `#e6db74` | the pink brand — switches, focus rings, the primary button, errors — plus orange parameters and the warn step, and yellow strings and warning |
| Cool accents | `#66d9ef` `#ae81ff` `#a6e22e` | cyan links, the info state and the ghost-active border, purple constants, green functions and success |

`#272822` is the page for the conversation **and** the sidebar, the theme's line
highlight (`#3e3d32`) is one step above it and its selection (`#49483e`) the step
above that, so a code fence, a menu and a selected row are all steps of the same
near-black. The syntax tokens carry the classic Monokai roles unchanged — keywords
and tags pink, constants purple, strings yellow, comments the olive grey,
parameters orange, functions green, punctuation the off-white body.

Steps the classic palette does not define are **derived from its own colours**
rather than invented: the primary button's hover is Monokai Pro's pink `#ff6188`,
its dimmed fill is the pink darkened 28% (`#b31b52`), the cyan's hover is the cyan
lifted a fifth toward white (`#85e1f2`), and the two text tiers between the body
and the comment grey are the body darkened 12% (`#dadad5`) and the comment grey
lifted halfway back to the body (`#b6b4a8`).

**Why the alias layer and not the `--dsw-static-*` ramp.** A static is shared by
roles that are not the same role — in the dark palette `neutral-bluish-50` is both
the primary label *and* the brand fill — so recoloring the ramp drags unrelated
surfaces along with it. The alias layer is the semantic one, and the layer
ui-theme documents as the third-party surface. Aliases a theme does not name
keep their shipped dark value: the scrims (`bg-mask-*`), the elevation strokes and
the shadow scale are scheme-neutral black/white alphas and read correctly on
either registered dark theme unchanged.

**The choice is in-process, by the shipped design.** ui-theme's durable preference
schema accepts `light` / `dark` / `system` only, so `setTheme('nord')` applies at
once and a **reload** (or a settings re-adopt, e.g. after a reconnect) returns to
the durable built-in. That is the shipped boundary, not something this
registration can lift — which is also why nothing here remembers the choice behind
the service's back.

**Adding another theme** is one entry in `THEME_EXTENSIONS` (id, label key,
`colorScheme`, token map, menu glyph) plus its `theme.<id>` copy in both
dictionaries. The menu picks it up from the registry; nothing else changes.

## The Markdown paper (alpha.2)

The shipped document preview draws rendered Markdown into a container marked
`data-document-markdown` and paints it from the `--dsw-*` tokens. Those tokens
are declared on `body` (light) and **overridden** on `body[data-ds-dark-theme]`
(dark), so a subtree cannot un-dark itself by referencing them — it just inherits
the dark values, which is why the rendered document used to go dark with the app.

This package injects **one rule** that re-declares ui-theme's own **light**
declarations on that container (the static palette, the ~80 alias tokens, and the
shiki token colours), then paints `background:#fff` on it:

```css
body [data-document-markdown]{ /* the theme's light layer, verbatim */ background:#fff; … }
```

- **Read, not hardcoded.** The light layer is copied out of ui-theme's own
  stylesheets at boot (every top-level `:root` / `body` rule that is *not* the
  dark one), so a palette change on a harness bump carries over by itself instead
  of freezing today's hex values here. The read uses the CSSOM and falls back to
  the rule's text where an engine does not enumerate custom properties.
- **All or nothing.** If the stylesheets cannot be read, nothing is injected:
  forcing white without the light tokens would paint light text on a white page,
  which is worse than leaving the view on the app theme.
- **Scoped.** Only the rendered Markdown document is pinned — chat Markdown, code
  previews and every other surface keep following the app theme. A second
  selector paints the preview's scrollport (`[data-textpreview-body]`, matched
  with `:has([data-document-markdown])`) white as well, so a short document does
  not sit on the app's dark canvas underneath; where `:has()` is unsupported that
  one rule is dropped and the document itself is still white. Because
  `--dsl-code-block-*` and `--shiki-*` resolve *inside* the document, the copied
  tokens also give the code blocks, inline code, links and lists their light
  styling for free.
- **Re-installed on every `theme/change`** (a palette swap re-registers the
  sheets), and once more on the tick after boot, in case ui-theme's stylesheets
  land after this row.

The editor's **Preview** button is what reaches this view for a Markdown file; the
white page is this package's doing.

## The Markdown chrome (alpha.3)

A rendered Markdown page in this pack has exactly **one** viewer, but the shipped
preview header builds its viewer menu out of *every* candidate implementation it
resolved for the file: the Markdown body plus the shipped **plain-text** fallback.
A Markdown tab therefore offered "Markdown" / "Plain text", and the second entry is
never what the pack wants — plain text is what the editor's own text surface is for,
and the deliberate way there is the **Edit** button the editor's document body draws
on the page.

So the menu is hidden on Markdown tabs:

```css
body [data-document-preview="@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown"]
  [data-document-viewer-menu]{display:none}
```

- **Scoped by renderer, not by guesswork.** The preview stamps the selected
  implementation's id into `data-document-preview` on the document root, so the rule
  matches the shipped Markdown id alone and a code or plain-text preview keeps its
  menu (there the choice is real, and the pack has no opinion about it).
- **Static CSS, installed once.** Unlike the paper there is no palette to read, so a
  single install at activation is enough. It gets its own style tag
  (`dsh-themes/markdown-chrome.css`) so it does not depend on the paper's read
  succeeding.
- **Only the header control goes.** The path, the reload tool and the document
  itself are untouched, as is the page's **Edit** button.

## The left column's top bar (alpha.4, gap alpha.5, branding alpha.6)

The frame opens with one band per column, and every column's band ends in the same
hairline at **y=76**:

| column | its band | its line |
|---|---|---|
| left | `.hHd-Xa_logoRow` — was a vertically centred 60px row under the root's 6px padding, so it ended at 66 | **none at all** |
| middle | the conversation header (`min-height:76px`, `padding:10px 28px 0 20px`) | `.5px solid var(--dsw-alias-border-l3)` at 76 |
| right | the docking kit's 38px tab strip, then the open tab's own 38px header (the shipped Files tab) | the same hairline at 38+38 = **76** |

The left column was the odd one out twice over: no rule under its branding row, and
a collapsed rail that changed **both** the root's top padding (6px → 18px) and the
row's height (60px → 36px) — so anything drawn under that row moved with the
toggle. The override gives the branding row the other two columns' band, in both
rail states:

```css
html .hHd-Xa_root.hHd-Xa_collapsed{padding-top:6px}
html .hHd-Xa_root .hHd-Xa_logoRow{
  height:70px;                       /* 6px root padding + 70 = the 76px line */
  margin:0 -12px 8px;                /* rule to both edges; 8px under it       */
  padding:4px 12px 35.5px 16px;      /* leaves a 30px content strip at the top */
  align-items:center;
  border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));
}
html .hHd-Xa_root.hHd-Xa_collapsed .hHd-Xa_logoRow{margin:0 -10px 12px;padding:1px 10px 32.5px}
```

- **The band, not the row.** The `4px` top / `35.5px` bottom split leaves a **30px**
  content strip at the band's top — the strip the conversation's own `titleRow`
  occupies — so the fish mark, the brand name and the collapse control sit **on**
  the top bar with a common centre at the frame's **y=25**, level with the
  conversation title, instead of being centred in a 60px row.
- **Nothing moves when the rail collapses.** The rail keeps the frame's own 6px
  top padding and its row is the same 70px band (its strip is 36px, the rail
  toggle's own size, centred on the same y=25), so the hairline stays at y=76 and
  the icon does not jump.
- **Edge to edge.** The row bleeds past the root's inline padding by exactly that
  padding (12px open, 10px in the rail), so the left line meets the middle line and
  the column's own vertical border as one continuous rule.
- **Breathing room under the line** (alpha.5). The row's bottom edge *is* the
  hairline, so its bottom margin is the gap before **New session** — the core's own
  8px when the sidebar is open and 12px in the rail. Zeroing that margin (as the
  alpha.4 rule did) left the button flush against the rule.
- **Pinned, and harmless if it drifts.** The selectors are the sidebar module's
  hashed class names, which belong to the harness line in `.dsh-version.json`
  (0.1.5-rc.1). On a bump that renames them this matches nothing — a no-op, never a
  broken layout — and the fix is to re-read the new names, not to add `!important`.
- **Static, installed once.** No palette to read beyond the border token, which
  carries a literal fallback for a profile that never mounts ui-theme, so it gets
  its own tag (`dsh-themes/left-topbar.css`) and needs no `theme/change` refresh.

### The VN branding (alpha.6, icon alpha.8)

The same rule set also replaces what that row *shows*: the product's mark becomes
the **app icon** and its name the text **VN Harness**.

```css
/* hide whatever occupies the brand slots, then draw the replacements */
html .hHd-Xa_root .hHd-Xa_brandMark>*,
html .hHd-Xa_root .hHd-Xa_brandName>*,
html .hHd-Xa_root .hHd-Xa_railMark>*{display:none!important}
html .hHd-Xa_root .hHd-Xa_brandMark::before,
html .hHd-Xa_root .hHd-Xa_railMark::before{
  content:"";width:24px;height:24px;flex:none;display:block;
  background:url("<the icon, inlined>") center/contain no-repeat
}
html .hHd-Xa_root .hHd-Xa_brandName::before{content:"VN Harness"}
/* and the same icon where the empty conversation's whale sits */
html .pXSMma_fishHitbox>*{display:none!important}
html .pXSMma_fishHitbox::before{
  content:"";width:26px;height:26px;background:url("<the icon>") center/contain no-repeat
}
```

- **An override, not a slot registration.** The mark and the name are slots —
  `sidebar.brand.mark` and `sidebar.brand.name`, both **`single`** — and the
  shipped `@deepseek-ai/dsh-client-ui-brand-official` row already occupies both.
  Registering our own would be a fight over a one-occupant seat, and the row is
  `aria-hidden` decoration inside the band this package already owns.
- **The empty conversation's whale too** (alpha.8): "Into the Unknown" draws the
  same fish from its own single slot, `conversation.hero.brand.mark`, wrapped in
  `div[data-slot]` exactly like the sidebar's. Same treatment, and the icon is
  26px so it sits on the headline's 32px line without moving it.
- **It hides children, not an `<svg>`.** The shipped brand plugin wraps each
  occupant in `<div data-slot="sidebar.brand.mark" style="display: contents">`
  (verified in the running app), so the rule targets the children — which also
  covers the layout's own `FishLogo` fallback, used when no brand plugin is
  mounted at all. `!important` is what beats that inline `display: contents`.
- **Both rail states.** The collapsed rail draws the mark alone, in its own
  element (`.hHd-Xa_railMark`), and gets the same icon.
- **The icon is `assets/vn-harness.svg`** at the pack root: a black circle centred
  on (12,12) in a 24px box — with a **1px transparent margin**, which is the fix
  for alpha.7's "cut" disc. That disc was drawn edge-to-edge inside boxes the app
  paints with `overflow:hidden` (the sidebar's brand button is exactly 24px tall),
  where the circle lost a fraction of a pixel on each side. The artwork carries
  the inset instead, so no container can shave it.
- **Inlined as a data URI rather than served.** The mark is a few hundred bytes,
  so inlining costs nothing and the branding needs no route, no request and no
  Node half (this package's row is a deliberate no-op). `assets/vn-harness.svg`
  stays the source of truth, and the tracked check compares the inlined copy's
  viewBox and circle geometry against that file, so the two cannot drift. The
  asset sits at the repository root because it is the *source*; like the vendored
  engine in `dsh-terminal`, a package never depends on a file outside itself.
- **The name wears the chat title's type** (alpha.7): the shipped brand name is
  `18px/600`, while the conversation's own title — the current crumb in the strip
  this band is levelled with — is `14px/20px/500`, so the product text takes the
  title's:

  ```css
  html .hHd-Xa_root .hHd-Xa_brandName{font-size:14px;font-weight:500;line-height:20px;letter-spacing:0}
  ```
- **Verified, not assumed.** In the running app the shipped art computes to
  `display:none`, the sidebar and rail marks draw the icon at `24px × 24px`, the
  hero draws it at `26px × 26px`, the name reads `"VN Harness"` at
  `14px/20px/500` — the same numbers the **served** `ui-conversation` bundle
  declares for its title crumb. The icon's own pixels were checked by drawing the
  asset to canvases and reading them back: at 24px and 26px the opaque box is
  exactly square (22×22 and 24×24), the margin is exactly 1px on all four sides,
  every row and column mirrors, the corners are transparent, and **nothing
  touches the canvas edge** in any size tested.

## The Session-log download seat (alpha.9)

The shipped `@deepseek-ai/dsh-session-log-export` browser half put a **three-dot
"more actions" button** into the same header group, and its menu held exactly one
item: "Download session log". So downloading a session's log was one click to
open a menu and a second to pick the only thing in it. This package takes that
seat and draws the download glyph on it directly.

**How the seat is taken — the slot system's own shadowing rule.**

```js
ctx.slots.register({
  name: 'conversation.session.header.utilities',
  id: 'session-log-download',   // the SHIPPED occupant's own id
  priority: -10,                // the shipped one sits at the default 0
  order: 0,                     // the shipped position: the button does not move
  ...
}, SessionLogDownloadAction)
```

`conversation.session.header.utilities` is a **list** slot, and a list slot
renders the **lowest priority** registration for a given occupant `id` and keeps
one occupant per id — so registering the shipped id one priority lower makes this
component the rendered one and leaves the shipped registration in the registry,
unrendered. That is the same rule `dsh-editor` uses to shadow the shipped
rendered-Markdown body (`key` + a lower `priority`). It matters that this is the
registry's rule and not CSS:

- no `display:none` on a hashed class, so a harness bump that renames classes
  cannot resurrect the three-dot button beside this one;
- no DOM is touched, and nothing shipped is disabled;
- the seat does not move: it keeps the shipped occupant's `order: 0`.

**What is NOT reimplemented: the export.** The shipped row
`session-log-download` stays mounted **because** it is dual-face. Its host half
owns the feature — the authenticated `/api/session.export` stream and the
`/export` slash command — so disabling that row would take the export away, not
the button. Its browser half publishes the `sessionLogDownload` controller: one
export per Session, a HEAD of the export URL, the browser's own download, and
`downloading` / `success` / `error` state. This control resolves that controller
lazily (`ctx.get('sessionLogDownload')`) and calls it, so:

- the header button and `/export` are **one implementation with one busy state**
  (the button also renders disabled while the controller reports `downloading`,
  so a second click cannot start another export);
- if the service is absent (a profile that never mounts that row), the button
  renders **disabled** and says `Session export is unavailable` instead of
  pretending to work.

**The seat's dialog came with the seat.** The shipped registration was the pair
`[Menu, Dialog]`, so shadowing the seat takes the export's
**preparing / success / error** dialog along with the menu. This bundle renders
that dialog from the same store, with the same three states and the same Close
button, so `/export` keeps the feedback it always had. What is gone is the
dropdown; what is left is one button and one dialog.

**The button's dress** is the Themes button's own `.dst-button`: 28×28, `6px`
padding, a 15px glyph, `border-radius: 28px` and the group's hairline ring. The
glyph is the shipped `IconDownloadOutline16` — the icon the removed menu item
carried.

## The screenshot control (alpha.10)

One more button on the same header row, **left of the Themes control** (order
`-30` against its `-20`), which captures **the whole window** and saves the PNG to
the **Desktop of the machine running the app**.

**"100% width and 100% height" is the tab's box.** The Web GUI is a
fixed-viewport shell — the document itself does not scroll, the columns do (each
keeping its own position) — so the page's full width and full height are exactly
what fills the tab. One frame of the tab's own surface is therefore the whole page:
nothing is stitched together, and there is no scrolled-out remainder to guess at.

**Why the browser takes the picture.** Only the page can photograph itself in real
pixels:

```js
const stream = await navigator.mediaDevices.getDisplayMedia({
  video: { displaySurface: 'browser' },
  preferCurrentTab: true,       // Chrome / Edge: offer THIS tab first
  selfBrowserSurface: 'include',
  surfaceSwitching: 'exclude',
  audio: false,
})
```

That first frame is drawn into a canvas and encoded as `image/png`, so anything the
app draws with **canvas** (the terminal dock's xterm surface), with compositor
effects, or inside an open dialog is in the picture. Two alternatives were rejected
for exactly that reason: a DOM-to-canvas library would have to stand in for the
engine (portalled dialogs and menus, layered hashed stylesheets, the xterm canvas),
and a headless browser pointed at the same URL would photograph a **fresh load** —
the open tab, the editor buffer and the dock are *this client's* state, not the
server's.

The stream is stopped the instant the frame is grabbed. The picture is **the
interface as it stands — this package's three header controls included**: they are
part of the header being photographed, and alpha.10's rule that took them out of
the frame (so the shot would be "the app rather than the buttons that took it")
left a hole in the record, which alpha.11 closes.

The one thing kept out of the frame is the **open tooltip bubble**, through
`html[data-dsh-screenshot] [role=tooltip]`: a hover card is not part of the
interface, and the pointer is usually still on the button that started the
capture. That button also passes `disabled` to its own `Tooltip` while the capture
runs — the shipped primitive's own close-and-stay-closed switch — so its bubble is
gone rather than merely invisible, and the rule is the safety net that covers every
other `Tooltip` in the app. The rule is keyed on the tooltip's **semantic**
`role="tooltip"` marker, never on a hashed class, so it cannot drift with a harness
line.

**Where the file goes: the host's Desktop, not the download folder.** The PNG is
POSTed to this package's own authenticated route, which is the one thing here that
needs the host half (`lib/index.js`):

| Route | Body | Answer |
|---|---|---|
| `POST /api/dsh-themes/screenshot` | the PNG (`content-type: image/png`) | `{ ok: true, path, directory, bytes }` |

The route resolves the Desktop **per request** — Windows plain or OneDrive-redirected
(`%USERPROFILE%\Desktop`, `%USERPROFILE%\OneDrive\Desktop`), macOS/Linux `~/Desktop`
including the freedesktop `XDG_DESKTOP_DIR`, with the home folder as the last resort
— then validates what it is about to write: the body must carry `image/png`, really
start with the PNG signature, and stay under 64 MiB. It is written
**create-exclusively** as `vn-harness-<timestamp>.png` (`-2`, `-3`, … when that name
is already taken), so a second shot inside the same second never clobbers the first.
Failures come back typed (`415` / `400` / `413` / `500` + a code) instead of as a
stack trace, and the client never names a path: there is no traversal surface and no
way to ask this host to write anywhere but the Desktop it reports.

If a profile runs this bundle **without** its host row, the browser's own download
is the fallback and the toast says which of the two happened — the control always
produces a picture.

**Feedback** is the shipped `Toast`, anchored to the button: the saved path on
success, and otherwise the reason — a dismissed picker, a browser without
`getDisplayMedia` (the page is not on HTTPS or localhost), or a write failure.

## The header ring (alpha.9)

The conversation header's icon buttons are meant to read as one group, and the
group's dress is a **round hairline outline**: `28px` square, `border-radius:28px`
and `.5px solid var(--dsw-alias-border-l3)`, held *inside* the box by
`box-sizing:border-box`. The terminal control has always worn it; the Session-log
download seat now does too; this package's own button did not, so it sat bare
among them. It does now.

The one button on that bar that cannot draw the ring where it lives is the **right
bar's own collapse/expand toggle** in the header corner — it is the pack's forked
right bar's button, in a GENERATED bundle that is never hand-edited — so this
package gives it the ring with one rule:

```css
html [data-conversation-header-corner] button{
  border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));
  border-radius:28px;box-sizing:border-box}
```

- **A stable hook, not a hashed class.** The corner element carries
  `data-conversation-header-corner`, the conversation header's own marker in
  ui-conversation, so this rule survives the class-name churn a harness bump
  brings (unlike the left-bar band above, which is pinned to hashed names on
  purpose and documented as such).
- **`box-sizing` is part of the rule.** The toggle's own dress does not set it, so
  without it the `.5px` outline would grow the button by half a pixel per side.
- **The corner is a `single` slot**, so the rule cannot leak onto unrelated
  controls; it is also installed once — there is no palette in it.

## Where it sits

The Session header is composed from slots
(`conversation.session.header.{actions,utilities,corner}`). This control is one
occupant of the **utilities** list:

| Occupant | Order | Position |
|---|---|---|
| **Screenshot** (this package) | `-30` | first — left of the Themes control |
| **Themes** (this package) | `-20` | next — left of Open In |
| Open In… (`open-in-app` / the pack's `dsh-open-in-app`) | `-10` | next |
| **Session log download** (this package, shadowing the shipped seat) | `0` | after that — was the three-dot button |
| Terminal (`dsh-terminal`) | `30` | last |

`-30` and `-20` are the whole placement: the utilities list renders in ascending
order, so a lower order simply renders further left. Nothing shipped is patched and
no existing row's order is changed. The download seat is the one place this package
takes OVER an occupant instead of adding one, and it does that by the registry's
priority rule (same `id`, lower `priority`) rather than by hiding anything.

## Layout

```
cordis.patch.yml   bundle layer: inserts the 'themes' row (nothing else patched)
lib/index.js       Node half: one authenticated route, POST /api/dsh-themes/screenshot,
                   which writes the client's PNG to this machine's Desktop (the
                   browser bundle needs no host otherwise)
lib/client.js      Browser half: the Screenshot button (capture + save), the Themes
                   button + menu, the registered themes (THEME_EXTENSIONS: Nord's
                   and Monokai's token maps and menu glyphs, registered through
                   ctx.theme), the Session-log download seat (same slot, shipped id
                   at a lower priority) with its export dialog, the theme snapshot
                   reader, and the appearance overrides (the Markdown paper, the
                   Markdown chrome, the left column's top bar, the header ring)
```

## Behaviour worth keeping

- **The service is optional, lazily resolved.** `theme` is read through
  `ctx.get('theme')` at use time and never declared as a hard dependency, so a
  profile that never mounts ui-theme keeps its header: the button renders
  disabled with "The theme service is unavailable" instead of blocking another
  plugin's activation.
- **Live, not sticky.** The control subscribes to ui-theme's `theme/change`
  event, so a switch made in Settings — or an OS flip while the preference is
  `system` — repaints the label. It needs no DOM observation of its own: the
  resolved palette is not this control's business, only the preference is.
- **The button wears one static mark** (alpha.12), not the active preference's
  sun/moon: the menu and the tooltip carry the choice, and a registered theme has
  no shipped glyph to wear. The tooltip still names the active theme, so the
  control is never ambiguous about what is on.
- **A theme is added by registering it.** The menu iterates `snapshot.themes` (the
  registry's own list) and appends `system` last, so `THEME_EXTENSIONS` is the only
  place a palette is declared. A theme another plugin registers shows up too — by
  its id, with the generic appearance mark, since this package has no words or
  glyph for it.
- **Extension themes do not touch the durable preference.** `setTheme` only writes
  `light` / `dark` / `system` through the settings scope, so selecting Nord or
  Monokai leaves the stored preference alone — which is exactly why it is
  session-scoped, and why this package does not fake a persistence layer of its
  own.
- **Same switch, both surfaces.** Because the write goes through
  `theme.setTheme(id)`, no second copy of the preference (and no second
  persistence path) exists to drift.
- **The download seat is taken by priority, not by force.** Registering the
  SHIPPED occupant's `id` one priority lower is what makes this package's
  component the rendered one; a different `id` would simply have added a second
  button beside the three-dot one.
- **The shipped controller is optional and resolved at use time.** Nothing
  shipped is disabled, and a profile without `sessionLogDownload` degrades to a
  disabled button reading "Session export is unavailable" — the same rule this
  package follows for `theme`.
- **The screenshot is taken by the page and saved by the host.** The browser half
  never writes a path and the host half never trusts the client's bytes: the
  route names the file, resolves the Desktop itself, and validates the PNG before
  writing it create-exclusively. A missing host row costs the Desktop shortcut,
  not the feature — the browser download still saves the picture.

## Install / uninstall

The repo launcher (`install.bat` on Windows, `./install.sh` on macOS/Linux)
auto-discovers this package — it is a standard `dsh.bundle`. Adding a package
changes the profile's bundle set, and a bundle the profile does not list yet is
added by one plain launcher run (no `-Force` needed); after that a plain run is
enough. The web profile links
it into this repo, so code edits only need a restart of
`npx @deepseek-ai/dsh web` plus a hard browser refresh. Starting it is
`run.bat` / `./run.sh` — the launcher that starts `dsh web` and opens the URL it
prints in Chrome.
