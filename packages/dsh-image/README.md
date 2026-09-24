# dsh-image (alpha.1)

**Images open as pictures, not as a file whose bytes happen to be an image.**

The shipped preview draws a PNG at its intrinsic size and stops there: a 4000 px
screenshot in a 400 px pane is a scrollbar with a corner of a picture in it, and
there is no way to zoom out, zoom in, or drag it. This package is the right bar's
`image` tab type - PNG, JPEG, GIF, WebP, AVIF, BMP, ICO, SVG and TIFF - and it
behaves the way an image viewer is expected to: **fit on open, a zoom ladder from
5% to 800%, fit-to-pane and 100% actual pixels one click away, wheel zoom at the
pointer, and drag to pan.**

It is a **client-only** package: bytes come from the harness's own
`workspaceFiles` remote, so there is no route, no host-side state, and no path
policy of its own to get wrong.

## What it adds

| | |
|---|---|
| **Fit on open** | The whole picture is visible whatever the pane's size. Fit shrinks but never enlarges - blowing a 16 px icon up to fill the pane is not what "fit" means. The pane is followed live: resizing the column re-fits while Fit is on. |
| **Zoom ladder** | 5%, 10%, 17%, 25%, 33%, 50%, 67%, 75%, 100%, 125%, 150%, 200%, 300%, 400%, 600%, 800%. `+` / `-` walk it; the ends clamp. |
| **100% actual pixels** | One image pixel per CSS pixel, the honest reference for "how big is this really". |
| **Ctrl/Cmd + wheel** | Zooms **at the pointer**, so the detail under the cursor stays under the cursor. A trackpad pinch is the same gesture, and it multiplies the zoom rather than stepping it, so the pinch feels continuous. A bare wheel is left alone: it scrolls, as it should. |
| **Drag to pan** | With a real grab cursor - offered only when the pane was **measured** to have something to pan. |
| **Double-click** | Toggles Fit and 100%. |
| **Keyboard** | `+` / `-` zoom, `0` fit, `1` actual size, arrows scroll. |
| **Transparency** | A checkerboard behind the picture, so a transparent PNG reads as transparent instead of as whatever the pane's background happens to be. |
| **Pixel peeping** | Past 300% the image is drawn with nearest-neighbour sampling, so a zoomed pixel is a square and not a smear. |
| **Status line** | The picture's true dimensions, its size on disk, its format, and the **source pixel under the pointer with its colour** (`x,y · #rrggbb · 42%` for a partially transparent one). |
| **Honest failure** | A codec this browser does not have (TIFF in Chrome, say) says exactly that, names the format, and offers to read the file again - rather than drawing nothing. |

## How it plugs in

| Piece | Value |
|---|---|
| `id` / slot key | `dsh-image` |
| `kind` | `image` |
| `patterns` / `priority` | `['*.png','*.apng','*.jpg','*.jpeg','*.jpe','*.jfif','*.gif','*.webp','*.avif','*.bmp','*.ico','*.svg','*.tif','*.tiff']` / `extension` |
| seats | keyed `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` |
| services | `slots`, the bar's `sidebarRightTabs`, and `remote.workspaceFiles` |
| guide entry | **none** - a blank image is not a document the "+" control should offer |
| core rows disabled | **none** |
| npm dependencies | **none** |
| host routes | **none** |

It replaces nothing by patching. The bar's tab registry ranks by band
(`extension` 3, `builtin` 2, `fallback` 1) and then by the length of the pattern
that matched; the shipped preview claims `dsh-resource://file/**` at `fallback`,
and this type registers the image suffixes at `extension`, so an image opens here
while **every other file type keeps exactly the surface it had**. `canOpen`
refuses anything that is not an image address, so the ranking can never leak. The
shipped preview stays mounted as the fallback for a profile without this package
- the same arrangement `dsh-pdf` makes for `*.pdf` and `dsh-editor` makes for
text. The editor is unaffected: it already vetoes image extensions.

## Addresses

One shape: `dsh-resource://file/session/<sessionId>/<path>` - the ordinary file
grammar, so a click in the Files tab lands here.

There is deliberately no second, package-owned shape (the way `dsh-pdf` has one
for a document outside any workspace). A `session` address is what authorizes a
host read of the file; the ordinary grammar's `absolute` form carries no session
and cannot authorize one, so claiming it would only produce a tab that cannot
read. An image outside a conversation workspace is still opened by whatever
surface had it - the conversation's own attachment renderer, for instance.

## Why it is built this way

**The zoom moves the layout, never a CSS transform.** The picture sits in a box
sized `naturalPixels * zoom` inside a scrollable pane, so panning is the pane's
own `scrollLeft` / `scrollTop` and everything the browser already does - wheel
scrolling, scrollbars, keyboard scrolling, overscroll - keeps working untouched.
A `transform: scale()` would scale into a clipped box with no scrollable area,
which is the bug the pack's diagram viewer shipped first; a zoomed picture must
stay scrollable to its edge.

**A zoom keeps the point the reader was looking at.** The point under the
pointer (or the pane's centre for a button) is remembered as a *fraction* of the
scrollable area before the layout changes, and restored on the next animation
frame - by then React has committed the new box and the browser has laid it out,
but the frame has not been painted, so the picture never visibly jumps.

**The wheel listener is native and non-passive.** React's own wheel listener is
passive, so a `preventDefault()` inside it does nothing - the browser's own
Ctrl+wheel *page* zoom would fire on top of ours, and the whole app would scale.
The listener is therefore attached with `addEventListener('wheel', …, { passive:
false })`, reading the latest handler from a ref.

**The pixel readout costs one pixel.** The sample is drawn into a 1×1 canvas
(`drawImage` of a 1×1 source rectangle) and read back with `getImageData`, so
inspecting an 8000 px photograph does not copy the picture into a second buffer.

**Base64 is decoded with one indexed loop.** `Uint8Array.from(atob(x), fn)` calls
a mapper once per byte; at the remote's 32 MiB ceiling that is the difference
between an instant open and a visible stall.

**Bytes come from the harness, not from a new route.** `readAll` on the
`workspaceFiles` remote - the same call the shipped preview makes for a
"bytes-complete" document - already resolves the path against the conversation
workspace, refuses a symlink out of it, requires a regular file, and enforces the
single-file byte cap (32 MiB by default) on the **host** side. A plugin route
would have had to re-implement all of that. So this package ships no route and no
host state; its Node half is one no-op row whose only job is to put the browser
bundle in the boot graph.

**The blob URL is revoked.** A reader flipping through a folder of photographs
does not keep every one of them pinned in memory, and a reload is a new
generation: the aborted read's settlement is dropped rather than racing the new
one.

## Caps and what is not claimed

| | |
|---|---|
| claimed formats | png, apng, jpg, jpeg, jpe, jfif, gif, webp, avif, bmp, ico, svg, tif, tiff |
| zoom | 5% - 800% |
| file size | the harness's own read cap (32 MiB by default), reported in a sentence when exceeded |
| not claimed | HEIC/HEIF, RAW, PSD, and every other format no browser decodes - those keep the shipped preview |
| no editing | this tab reads. There is no crop, rotate, resize, convert or save. |

TIFF is claimed deliberately: Chrome cannot decode it, and a viewer that says
"this browser could not decode a TIFF file - the bytes are here and intact, it is
the codec that is missing" is more useful than a generic binary-file message.

## Verifying a change

```
node --check packages/dsh-image/lib/client.js
node scripts/checks/check-client-bundles.mjs
```

The tracked check drives this bundle through the real React runtime: it activates
it against a stubbed context, asserts the type definition (bands, patterns,
`canOpen`'s refusals, the chip title, the absence of a guide entry), renders the
tab body and the title seat as markup, and pins the load-bearing rules by name -
the layout-sized zoom, the measured overflow, the non-passive wheel listener, the
pointer anchor, the 1×1 sampler, the checkerboard, the pixelated threshold, and
the fact that there is no `fetch` and no `/api/` path anywhere in the bundle.

## Install

The package is discovered from `packages/`; both installers pick it up:

```
install.bat -Force        # Windows
./install.sh -Force       # macOS / Linux
```

This one is a **new bundle**, so the app's profile has to learn about it: run the
installer once, then restart `npx @deepseek-ai/dsh web` and hard-refresh the
browser (Ctrl+F5). After that it is a live link, and editing `lib/client.js`
needs only a restart.

## Alpha roadmap

- **alpha.1** (this release): the viewer - fit, the zoom ladder, pointer-anchored
  wheel zoom, drag-to-pan, the checkerboard, pixelated rendering past 300%, the
  pointer/pixel readout, and honest failure for an undecodable format.
- **Next, if the pictures you look at ask for it**: a per-image remembered zoom
  and scroll position, an EXIF/metadata drawer (dimensions, camera, date, GPS) for
  JPEG and PNG, an image index page beside the PDFs one, and rotation - which is
  the one edit a viewer can hold in memory without touching the file.

This package is also the shape the planned **`dsh-audio`** viewer reuses: the same
zoom-moves-the-layout rule, the same pointer anchoring, the same
measured-overflow pan.
