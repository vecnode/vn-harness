# dsh-audio (alpha.1)

**Audio opens as a waveform, not as a file whose bytes happen to be sound.**

The shipped preview gives an audio file a browser `<audio>` element and nothing
else: no waveform, no time ruler, no zoom - and for AIFF, in Chrome, not even
playback, because Chrome cannot decode it. This package is the right bar's
`audio` tab type for **WAV/RIFF, AIFF/AIFC and FLAC**, and it draws the thing a
recording is actually looked at through: **one track per channel, in rows, a time
ruler, a min/max envelope with the RMS band inside it, zoom down to individual
samples, drag-to-select, and playback with a playhead that follows the audio
clock.**

It is a **client-only** package: bytes come from the harness's own
`workspaceFiles` remote, so there is no route, no host-side state, and no path
policy of its own to get wrong.

## What it adds

| | |
|---|---|
| **A real waveform** | **One TRACK per channel, in a row of its own** - a file with eight channels shows eight rows, never eight overlays - with the **min/max envelope filled** and the **RMS drawn inside it as a brighter band**: the envelope is what you see, the RMS is what you hear, and a professional view shows both. The 48 px gutter beside each row is a cell of **exactly that row's height**, holding the track's name and its amplitude reading together. A stereo pair is `L`/`R`, more tracks are numbered, and a **mono file has no letter at all** (a lone "M" is a letter the reader has to decode, and one track has nothing to tell apart from). The toolbar's `N tracks` / `1 track` button collapses the view to a single row and back. |
| **Resizable tracks** | **Drag any track's bottom edge** (the hairline in the gutter; the cursor turns into a resize arrow) and the height changes - **for every track at once**, from 24 px to 420 px, because a waveform is read across tracks and separately sized tracks would no longer line up. The envelope, the ruler and the gutter cells all follow. |
| **Adaptive time ruler** | "Nice" 1-2-5 steps from 0.1 ms to 1 h, chosen from the zoom, with a major/minor tick hierarchy and labels whose width is **measured**, so they never collide. |
| **Zoom by layout** | 1 px/s (an hour in a pane) to 500000 px/s. `+`/`-` walk the ladder, `Fit` fits the file, `Ctrl`/`Cmd` + wheel zooms **at the pointer**, and a bare wheel scrolls sideways - time is the axis here. Past ~3 px per sample the samples themselves are drawn as stems. |
| **dBFS or linear** | A toggle, because a linear scale hides everything a compressor did. The dBFS scale draws a 72 dB range, and the gutter says which reading the track is showing. |
| **Amplitude gain** | `Shift` + wheel scales the drawing 0.25x to 16x, because "-6 dBFS" and "a line at the top" are two readings of the same take - a gesture, with no button taking up toolbar space. |
| **Playback** | Play/pause, click to seek, `Space` to toggle, `Home`/`End`, one screen-pixel per arrow press, and a **playhead driven by the AudioContext clock** rather than a CSS animation, so the line cannot drift from the sound. Drag a range and it plays that range **looped**. |
| **Selection** | Drag on the waveform to select; the status line reports the selection's duration, peak and RMS - and **names where the numbers came from** ("from the samples" or "from 4096-sample buckets"). |
| **Details panel** | Container, codec, sample rate, channels, bit depth, frame count, duration, size, which decoder drew it, the peak pyramid's levels, and any metadata the file carries: RIFF `LIST/INFO`, BWF `bext` (description, originator, date), AIFF `NAME`/`AUTH`/`ANNO`, FLAC's Vorbis comment. |
| **Honest failure** | A codec this viewer cannot decode is **named** (`IMA ADPCM`, `mu-law` is decoded, `MACE 3:1` is not); a truncated file draws what exists and says the rest is **unknown** rather than as silence; a FLAC too big to hand the browser says how big it is and why. |

## How it plugs in

| Piece | Value |
|---|---|
| `id` / slot key | `dsh-audio` |
| `kind` | `audio` |
| `patterns` / `priority` | `['*.wav','*.wave','*.aif','*.aiff','*.aifc','*.flac']` / `extension` |
| seats | keyed `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` |
| services | `slots`, the bar's `sidebarRightTabs`, and `remote.workspaceFiles` |
| guide entry | **none** - a blank audio file is not a document the "+" control should offer |
| core rows disabled | **none** |
| npm dependencies | **none** |
| host routes | **none** |
| vendored engines | **none** |

It replaces nothing by patching. The bar's tab registry ranks by band
(`extension` 3, `builtin` 2, `fallback` 1) and then by the length of the pattern
that matched; the shipped preview claims `dsh-resource://file/**` at `fallback`,
and this type registers the audio suffixes at `extension`, so an audio file opens
here while **every other file type keeps exactly the surface it had** - MP3 and
M4A included, which the shipped preview still plays and this package deliberately
does not claim. `canOpen` refuses anything that is not an audio address, so the
ranking can never leak, and the shipped preview stays mounted as the fallback for
a profile without this package.

## Addresses

One shape: `dsh-resource://file/session/<sessionId>/<path>` - the ordinary file
grammar, so a click in the Files tab lands here.

There is deliberately no second, package-owned shape (the way `dsh-pdf` has one
for a document outside any workspace). A `session` address is what authorizes a
host read of the file; the ordinary grammar's `absolute` form carries no session
and cannot authorize one. A chat attachment or a file in Downloads is still
opened by whatever surface had it.

## How the bytes are read, and why

**The file is read in WINDOWS.** `workspaceFiles.readBytes` hands over one
2 MiB window per call (the host's own cap; a deployment may configure it lower,
and a refusal carries the limit, so the window is halved and asked for again).
The decoder consumes one window at a time, folds the samples into the peak
pyramid and **drops them**, which is what lets a 2 GiB WAV draw a waveform at a
bounded memory cost - a cap that a single `readAll` (32 MiB by default) would
have imposed on every file.

**WAV and AIFF are decoded here.** They are the two the browser cannot both do -
Chrome decodes WAV but not AIFF - and both are simple containers. What is
decoded: WAV/RIFF and RF64 (`u8`, `s16`, `s24`, `s32`, `f32`, `f64`,
`WAVE_FORMAT_EXTENSIBLE`, A-law, mu-law) and AIFF/AIFC (`s8`, `s16`, `s24`,
`s32`, `sowt`, `fl32`/`FL64`, `alaw`, `ulaw`).

**FLAC is decoded by the browser** (`decodeAudioData`), which is why its path
reads the whole file and is bounded by the harness's single-read cap. Its
STREAMINFO is parsed here first, so a FLAC that is too big to decode still shows
its exact sample rate, channels, bit depth and length - and says what the limit
is. The decoder is asked for a context at the **file's own** sample rate, so a
44.1 kHz FLAC is not silently resampled; if the browser refuses that rate the
panel says "resampled".

**The peak pyramid is the drawing's data structure.** Level 0 is one bucket per
256 samples holding `(min, max, rms)` per channel, and every level above groups
exactly four buckets of the level below, so a decimated RMS is the root of the
mean of its children's squares - the pyramid's numbers are the samples' numbers
and not an approximation of them. The client picks the level from the current
pixels-per-second, which is why zooming out changes **which level is read** and
never how many samples are walked.

**The zoom moves the layout, never a transform.** The scrollable spacer is the
file's duration times the pixels-per-second, so panning is the pane's own
`scrollLeft` and a zoomed waveform stays scrollable to its edge. The canvas that
paints it is **viewport-anchored** (`position: sticky; left: 0`), because a
canvas cannot be 300000 px wide: the layout is the file, the canvas is the window
onto it, and it repaints on scroll. A zoom remembers the time under the pointer
and restores it on the next animation frame.

**The wheel listener is native and non-passive.** React's own wheel listener is
passive, so a `preventDefault()` inside it does nothing - the browser's own
Ctrl+wheel *page* zoom would fire on top of ours, and the whole app would scale.

**The playhead is the audio clock.** `currentTime - startedAt + from` is what
the AudioContext is actually playing, so the line cannot drift from the sound the
way a CSS animation can.

## Caps and what is not claimed

| | |
|---|---|
| claimed formats | wav, wave, aif, aiff, aifc, flac |
| zoom | 1 to 500000 px/s, capped so the layout stays inside a browser's own ~33.5 M px limit |
| playback | files the page can hold: under 32 MiB and under 24 M samples. A larger file still draws its waveform, from a streaming pass, and the transport says why it is disabled. |
| FLAC | decodes up to the harness's single-read cap (32 MiB by default); past it the facts are shown and the waveform is refused in a sentence |
| not claimed | MP3, M4A/AAC, Ogg/Opus (`<audio>` in the shipped preview already plays them), and any codec tag the decoder does not implement - ADPCM, MACE, GSM, `ima4` - which is refused **by name** |
| no editing | this tab reads. There is no trim, normalize, convert, re-encode or save. |

## Verifying a change

```
node --check packages/dsh-audio/lib/client.js
node scripts/checks/check-client-bundles.mjs
```

The tracked check **builds its own audio** - a RIFF/WAVE, an IFF FORM, a FLAC,
byte by byte, in the check itself - and drives the bundle's pure half through
`exports.__internals`, so no ffmpeg, no sox, no browser and no fixture on disk is
needed. It asserts the decoded **numbers**: the sample rate, channel count, bit
depth and duration of each container; a half-scale sine's envelope; a DC half
followed by real silence; the 24-bit two's-complement edges; unclamped IEEE
float; `WAVE_FORMAT_EXTENSIBLE`'s sub-format; the G.711 laws' own zero and
full-scale codes; a truncated file as *unknown* rather than silent; an
unsupported codec refused by name; and the pyramid's bucket arithmetic - level 0,
the four-to-one decimation, and the load-bearing claim that **a windowed decode
builds the same pyramid as a whole-file one**. It also pins the tab type (band,
patterns, `canOpen`'s refusals, the chip title, the absence of a guide entry),
the seats, the opening markup, the layout-sized zoom, the sticky canvas, the
non-passive wheel listener, the pinch-compounding zoom ref, the audio-clock
playhead, and the fact that there is no `fetch` and no `/api/` path anywhere in
the bundle - and it **renders the viewer and the details panel as markup**, on
facts and a pyramid it builds itself, so the toolbar, the spacer, the canvas, the
status line and the metadata rows are all exercised rather than assumed.

`__internals` exists only for that check: nothing in the app reads it, and it is
there so the decoder's arithmetic cannot quietly drift.

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

- **alpha.1** (this release): the viewer - the hand-written WAV/AIFF/AIFC
  decoder streaming the file in windows, the browser's FLAC path, the peak
  pyramid, the canvas waveform with one row per track, a draggable shared track
  height, the ruler, the RMS band and the dBFS scale, zoom that moves the
  layout, drag-to-select with measured numbers, and playback with an
  audio-clock playhead.
- **alpha.2, the model surface** (planned): `audio_info` and `audio_measure` as
  real tools, so the agent reads a recording instead of `cat`-ing it - duration,
  channels, level, silence, clipping, DC offset, and a windowed measurement with
  its method named - through the same decoder and the same peak pyramid this tab
  uses, plus a bundled `audio-analysis` skill. Then a **spectrogram** as a second
  mode of the same surface, and the optional host `ffmpeg`/`sox` tier for the
  codecs this package refuses by name.
- **alpha.3** (planned): a remembered per-file view (zoom, scroll, selection), a
  level meter, markers from BWF/ID3/Vorbis comments drawn as a marker lane, an
  **audios** index page beside the PDFs one - and, if the host-engine tier is
  never wanted, a vendored FLAC decoder built the way Mermaid and pdf.js already
  are.

The design this implements is written out in
[`docs/PLAN-dsh-audio.md`](../../docs/PLAN-dsh-audio.md); its section 3 is this
release, section 4 is the next one.

This package also reuses the shape `dsh-image` established: the same
zoom-moves-the-layout rule, the same pointer anchoring, the same honest-failure
sentences, and the same client-only stand on bytes.
