# PLAN — `dsh-audio`: WAV / AIFF / FLAC as a surface the pack can show and the agent can read

Status: **plan, not built**. Nothing in this document exists yet. It is the
design for a new bundle under `packages/dsh-audio/` (row `audio`, tab kind
`audio`) built the way every other package in this pack is built: one bundle, no
npm dependencies, no fork, no disabled core row, its own tracked checks.

The two questions it answers are the two the other surfaces answer:

1. **a person** wants to open a `.wav` / `.aif` / `.flac` in the right bar and
   *see* it — a real waveform with a time ruler, zoom and pan, and playback;
2. **the agent** wants to *read* it — duration, channels, sample rate, level,
   silence, clipping — instead of `cat`-ing binary noise.

---

## 1. Why this is not "just an `<audio>` tag"

The shipped preview gives an audio file a browser element and nothing else: no
waveform, no zoom, no time ruler, and for the formats that matter here not even
playback. Three facts shape everything below.

**A waveform is a picture of the samples, and the samples are not in the file.**
WAV is usually raw PCM, but AIFF is big-endian, FLAC is compressed, and none of
them is "drawable" until it is decoded. So the package needs a **decoder** — and
per this pack's rules, a decoder is either hand-written here, vendored with a
hash, or an optional host engine that degrades in a sentence.

**A browser is not a decoder we can rely on for the formats the owner named.**
Chrome decodes WAV, MP3, M4A/AAC, Ogg and FLAC through WebAudio; it does **not**
decode AIFF (`Safari` does). So a design that leans on `decodeAudioData` cannot
draw an AIFF at all, and one that leans on the host alone cannot play anything
without its own playback clock. The plan therefore has **tiers**, exactly like
`dsh-pdf`'s rasterizer/OCR pair:

| Tier | What it decodes | Who does it | When it is missing |
|---|---|---|---|
| **T1 — built in** | WAV/RIFF (u8, s16, s24, s32, f32, f64, WAVE_FORMAT_EXTENSIBLE, A-law/µ-law) and AIFF/AIFC (s8/s16/s24/s32, `sowt`, `fl32`/`FL32`, `alaw`, `ulaw`) | this package, pure JavaScript, in a **child process** | never — it ships |
| **T2 — the browser** | FLAC, MP3, M4A/AAC, Ogg Vorbis/Opus | `decodeAudioData` **in the tab**, bounded by duration | a file too long to decode in memory says so and names T3 |
| **T3 — a host engine** | anything `ffmpeg` (or `sox`) reads, decoded without loading the file into the page | the host, streamed, argv only, deadline + heap cap | the tab still draws T1/T2 formats; the tools say what to install |

T1 is the point of the package: **WAV and AIFF are the two the browser cannot
both do**, and both are simple containers (~300 lines each, no dependencies).
T2 makes FLAC work out of the box for ordinary durations. T3 is for the long
file and the exotic codec, and it is optional in the same sense `pdftoppm` is.

## 2. Peaks: decode once, draw for ever

Drawing a waveform from raw samples is a per-frame rescan of the file; drawing it
from peaks is a memory read. So the host computes a **peak pyramid** once, caches
it by content, and the browser draws from it.

```
$DSH_HOME/dsh-audio/artifacts/<sha256>/
  info.json          container, codec, sampleRate, channels, bits, frames,
                     duration, bucket sizes, loudness facts, decoder used
  peaks/0.bin        level 0: one bucket per 256 samples
  peaks/1.bin        level 1: one bucket per 1024 ... (a x4 decimation each level,
  ...                up to a level whose buckets-per-pixel is ~1 at a whole-file view)
```

- Each file is a **documented little-endian header + Float32 `(min, max, rms)`
  triples per channel**, so the client wraps the response body in a
  `Float32Array` and draws with no parsing at all.
- Identity is the **SHA-256 of the file's bytes** (streamed, memoized per
  `path + size + mtime`), exactly like `dsh-pdf`: an edited file can never serve
  a stale waveform, and the same track read from two conversations costs one
  decode.
- The LRU cap is small on purpose (peaks are ~1-2 % of the PCM): **256 MiB**.
- The client picks the level from the current `pixelsPerSecond`: `bucketSamples`
  is chosen so one bucket is between 1 and 4 device pixels wide. Zooming out
  changes *which file it fetches*, never how many samples it walks.

## 3. The tab

`dsh-resource://file/session/<sessionId>/<path>`, kind `audio`, band
`extension`, patterns `*.wav *.wave *.aif *.aiff *.aifc *.flac` (plus `*.mp3
*.m4a *.aac *.ogg *.oga *.opus` through T2), `canOpen` refusing anything else.
It replaces the shipped `<audio>` element for those addresses **by ranking**,
never by disabling a row — the same arrangement `dsh-image` already makes for
images.

### The surface

```
+------------------------------------------------------------------+
| [zoom -] 250 px/s [zoom +] [Fit] [Sel] | 0:00.000 / 3:41.512 | ...|
+------------------------------------------------------------------+
|  time ruler    0s      5s      10s     15s     20s     25s       |
| -----------------------------------------------------------------|
| L +--------------------------------------------------------------+|
|   |        ▁▂▄█▆▂▁   ▁▃█▇▅▂      ▁▁▂▄▆█▅▃▂▁                        ||
|   |                                                              ||
| R +--------------------------------------------------------------+|
|   |        ▁▂▄█▆▂▁   ▁▃█▇▅▂      ▁▁▂▄▆█▅▃▂▁                        ||
| -----------------------------------------------------------------|
| 00:00:12.480   L -6.2 dBFS  peak -1.1 dBFS  RMS -18.4 dBFS       |
+------------------------------------------------------------------+
```

- **One lane per channel**, each labelled in a 40 px gutter, sharing one time
  axis; a channel can be collapsed when a file has 8 of them.
- **Min/max envelope** filled, with the **RMS** drawn inside it as a lighter
  band — the envelope is what you see, the RMS is what you hear, and a
  professional view shows both.
- **Adaptive time ruler**: "nice" 1-2-5 steps in µs/ms/s/min, chosen from
  `pixelsPerSecond`, with a major/minor tick hierarchy and labels that never
  collide (the label text is measured, not guessed).
- **Amplitude scale**: linear or **dBFS** (a toggle), because a linear scale
  hides everything a compressor did.
- **Zoom is a LAYOUT width** (`pixelsPerSecond`), never a transform: panning is
  the pane's own `scrollLeft`, exactly the rule `dsh-image` and the diagram tab
  already follow, so a zoomed waveform stays scrollable to its edge and the
  wheel keeps working. The ladder runs 1 px/s (a whole hour in a pane) up to
  500 000 px/s (individual samples as stems), `Fit` fits the whole file, and
  Ctrl/Cmd+wheel zooms **at the pointer** while a bare wheel scrolls.
- **Vertical zoom** (Shift+wheel) scales the amplitude, because "-6 dBFS" and
  "a line at the top" are two different readings of the same take.
- **Playback** through WebAudio from a Blob URL of the original bytes (T2), or
  from `GET /api/dsh-audio/pcm` (T3/T1 for AIFF), with: play/pause, click to
  seek, a **selection** dragged on the waveform (with its own duration, peak and
  RMS in the status line), loop-selection, and a playhead driven by the
  AudioContext clock rather than a CSS animation. `Space` toggles, `Home`/`End`
  jump, arrow keys step by one screen-pixel worth of time.
- **A spectrum view** (alpha.2) as a second mode of the same surface: an FFT per
  column computed on the host from the decoded window and cached, drawn as a
  colour-mapped bitmap — the same zoom, the same pan, the same playhead.
- Honest failure, always a sentence: an unsupported codec names the codec and
  what to install; a truncated file draws what exists and marks the rest
  **unknown** rather than as silence (a missing tail is not silence); a FLAC
  longer than the browser can decode says how much memory that would take and
  points at ffmpeg.

## 4. The model surface (alpha.2)

Same shape as `dsh-pdf` and `dsh-diagrams`: real tools, a card in the
conversation, and a bundled skill.

| Tool | The question it answers |
|---|---|
| `audio_info` | What IS this file: container, codec, sample rate, channels, bit depth, frames, duration, bitrate, peak/RMS per channel (dBFS and linear), DC offset, clipping sample count, silence regions, and any BWF/ID3/Vorbis metadata |
| `audio_measure` | What is in THIS WINDOW: RMS and peak, crest factor, zero-crossing rate, silence ratio, and coarse band energies (so "is there a 50 Hz hum?" has an answer) — with the window, the method and the resolution named |

Both read through the same decoder and the same cache as the tab, so what the
model is told and what the person sees cannot drift (the `pdf_scan` /
`/api/dsh-pdf/scan` precedent). `skills/audio-analysis/SKILL.md` teaches when to
reach for which tool and the one rule that matters: **a measurement is not a
transcript** — the answer names the window it measured and the method it used,
and says "silent" only when the samples are actually zero.

## 5. Routes

Exact `connection.fetch` paths, GET/HEAD/POST only, authenticated, all of them
read-only:

| Route | What it answers |
|---|---|
| `GET /api/dsh-audio/state\|health` | capabilities (which tiers this host has: T1 always, T2 reported by the tab, T3 by probing `ffmpeg`/`sox`), cache facts, caps |
| `GET /api/dsh-audio/info` | the facts of one file (JSON; decoded once, cached by content hash) |
| `GET /api/dsh-audio/peaks` | one pyramid level as `application/octet-stream` (the Float32 header + triples) |
| `GET /api/dsh-audio/file` | the original bytes, for the browser's own decoder and for playback |
| `GET /api/dsh-audio/pcm` | a decoded window (`?from=&to=&format=f32`), for AIFF playback and for the spectrogram |
| `POST /api/dsh-audio/scan` | an on-demand analysis the tool and the tab share |

## 6. Path policy and caps

Stated, not implied — and identical to `dsh-pdf`'s, because the same questions
come up:

- a **session-relative** path is resolved inside the conversation workspace and
  `realpath`-checked on both sides, so a symlink out is refused rather than
  followed;
- an **absolute** path is read directly, which is how a chat attachment
  (`<DSH_HOME>/attachments/v1/files/...`) arrives;
- either way the target must be a **regular file** with a claimed extension,
  inside the size ceiling (**2 GiB** for the tools, **512 MiB** for the tab);
- the decoder runs in a **child process** (`lib/decode.mjs`, argv only) with a
  deadline, a heap cap and a bounded stdout, because an audio file is untrusted
  input handed to a parser;
- **nothing is written outside** `$DSH_HOME/dsh-audio/`, and nothing in this
  package writes to, converts, trims, normalizes or re-encodes the file itself.

## 7. Milestones

| Release | Content |
|---|---|
| **alpha.1 — the viewer** | the `audio` tab; T1 (WAV + AIFF/AIFC, host-side, pure JS); T2 (browser decode) for FLAC/MP3/M4A/Ogg with a duration cap; the peak pyramid + content-addressed cache; the canvas waveform with ruler, lanes, RMS band and dBFS toggle; the image viewer's zoom/pan model; playback with playhead and selection; honest failures; README + tracked checks |
| **alpha.2 — the model surface** | `audio_info` and `audio_measure`; the conversation cards; the `audio-analysis` skill; `GET /pcm` and `POST /scan`; the T3 `ffmpeg`/`sox` tier; the **spectrogram** view |
| **alpha.3 — the finish** | a remembered per-file view (zoom, scroll, selection), channel solo/mute and a level meter, BWF/ID3 markers drawn as a marker lane, an `audios` index page beside PDFs, and — only if the owner wants no host engine ever — a **vendored FLAC decoder** built by `vendor/build.mjs` with a hashed `VERSION.json`, the way Mermaid and pdf.js already are |

## 8. Verification

- `scripts/checks/check-client-bundles.mjs` gains a `dsh-audio` section: the tab
  type and both seats, the `canOpen` refusals, the zoom-moves-the-layout rule,
  the ruler's tick function, the honest-failure strings, and that no decoder is
  inlined in the bundle.
- A new `scripts/checks/check-audio-node.mjs` **builds its own audio** so it
  needs no ffmpeg, no sox and no network: a mono sine WAV, a stereo WAV with a
  known silent second and a known peak, a 24-bit WAV, a big-endian AIFF, an
  `sowt` AIFC, a truncated WAV, and a file with an unsupported codec tag. It then
  drives the routes and the tools and asserts the decoded **numbers** (sample
  rate, channels, duration, peak per channel, the silent region, the clipping
  count), the cache behaviour (a second call is free; an edited file is a new
  hash), and the refusals. The T3 tier is driven through a **stub engine** (this
  same Node binary), which is what lets a host with no ffmpeg prove the spawn,
  the argv shape, the deadline and the streaming arithmetic — the exact trick
  `check-pdf-node.mjs` uses for tesseract.

## 9. Open questions for the owner

1. **Is listening wanted in the tab**, or is the waveform (plus seeking) enough
   for alpha.1? Playback is what makes the AIFF path need a decoded-PCM route.
2. **Do the agent tools belong in the same package from the start**, or should
   alpha.1 be a viewer only and the tools a later release?
3. **Spectrogram** — wanted (it is the professional differentiator, and it is
   the one view that answers "what is wrong with this recording"), and if so in
   alpha.2 or later?
4. **FLAC without any host engine** — is "the browser decodes it, up to a
   duration cap; install ffmpeg for longer files" acceptable, or do you want a
   vendored FLAC decoder so nothing is ever required beyond the pack itself?
5. **Formats beyond the three named** — should MP3/M4A/Ogg be claimed as well
   (they work through the browser's own decoder), or should the tab only claim
   the lossless/studio set?
6. **Where audio comes from** — the Files tab (workspace files) only, or also
   chat attachments and files outside the workspace by absolute path, the way
   the PDF reader accepts them?
