# dsh-diagrams (alpha.4)

**Mermaid and TikZ diagrams as a first-class surface of the harness**: the model
writes them as tools, the host validates every write with a real parser or a
real TeX engine, they render inline in the conversation, and each one lives in
its own right-bar tab with a zoom ladder, a source drawer and an export menu
that saves to the Desktop of the machine running the harness.

- Row `diagrams`, bundle `dsh-diagrams`, tab kinds `diagram` (one tab per
  diagram) and `diagrams` (the conversation index, reachable from the tab
  strip's `+` / **Start** page).
- Tools: `diagram_write`, `diagram_patch`, `diagram_read`, `diagram_verify`,
  `diagram_delete`.
- Skills: `mermaid-diagrams`, `tikz-diagrams` (authored in `skills/`, copied
  into `$DSH_HOME/skills` by the installer), each with a
  `reference/complex-diagrams.md` for pictures too big for the syntax summary.
- No core patch, no forked bundle, no npm dependency, **no network**.

Alpha. `0.1.0-alpha.4`.

---

## 0. What changed in this alpha

### alpha.4

Six things, each found by exercising the surfaces rather than by reading them:

1. **The picture was not the size you wanted to read.** The tab laid a diagram
   out at its own natural size in a pane a few hundred pixels wide. It now lays
   the picture out at **80% of the pane** and adds a **zoom ladder**
   (25%-400%, `-` / `+` / `Fit`, remembered per diagram) with **drag to pan**.
   Three things make that work, and the first two were bugs found by using it:
   the zoom moves the layout BOX rather than applying a CSS `transform` (a
   transform scales into a clipped box with no scrollable area, so a zoomed
   diagram could never be scrolled back to); **every child of a zoomed box is
   stretched to it**, because a column flex container sizes its children to their
   CONTENT on the cross axis and the picture wrapper stayed at the svg's natural
   width however wide the box became - so the box zoomed and the diagram did not;
   and panning is the canvas' own `scrollLeft`/`scrollTop`, so nothing is
   transformed or repositioned and the wheel keeps working. A zoom keeps the point
   the reader was looking at, the grab cursor appears only when there is something
   to pan, and a native image drag cannot steal the gesture.

2. **Exports went somewhere nobody was looking.** Every format now **saves to
   the Desktop of the machine running the harness** - the same deal the
   screenshot control makes - through the host route, which resolves the Desktop
   per request (OneDrive-redirected Windows, `XDG_DESKTOP_DIR` on Linux, the home
   folder last), writes create-exclusively under the diagram's own name and
   answers with the **absolute path** the panel then reports. The conversation
   folder is never written to, the client never names a path, and the browser
   download survives only as the fallback for a profile without that row.

3. **`ok` and `drawn` were doing too much work.** The browser verdict is now ONE
   function (`lib/store.js: verificationOf`) used by the tool result, the state
   route and the tab pill, so the three cannot disagree. The four states are
   objective and carry **both** revision numbers - `revision` (current) and
   `reported` (what the newest report names) - so `stale` is read rather than
   guessed: a report about revision 4 is never evidence about revision 5. A
   missing report is `pending`, never a picture. And the verdict **omits** its
   `error`/`at` keys instead of nulling them, because the tool registry refuses a
   value that does not survive a JSON round trip and `JSON.stringify` drops an
   `undefined` property: with `error: undefined` on a drawn verdict, every
   diagram the browser had RENDERED became unreadable to the model
   (*"value is not lossless JSON"* from `diagram_read` / `diagram_verify`).

4. **A cache hit assumed success.** `checkAndRecord` read a cached TikZ compile
   back as `ok` without looking at what the compile had said. A compile that
   FAILED but still produced a PDF is cached on purpose - the partial picture is
   evidence - so the second call reported a broken diagram as fine. The verdict
   is now read from the cached meta.

5. **A conversation could outgrow its own state file.** Sources were capped per
   diagram (256 KiB) and the file at 1 MiB, so a handful of large diagrams put
   the file past the size at which the store reads it as EMPTY - every diagram in
   the conversation disappearing at once. There is now a **conversation source
   budget** (4 MiB, enforced on write AND patch, replacing a diagram charged
   once) with a typed `BUDGET` error the model can act on, and the file cap sits
   far above it (16 MiB), where only a file that is not ours can reach it.

6. **Two verdicts that meant "we could not check", and one of them was our
   fault.** Mermaid validations now run through a **bounded child pool** (2 at a
   time, bounded queue) instead of an unbounded fan-out of 3.5 MB engine
   children. The DOM stub now exposes `window.CSS`: without it the engine's
   sequence-diagram `box` parser took a `new Option()` fallback that does not
   exist in a stub, so **every `box` diagram** came back `unavailable` - stored
   but never checked. And a bare pgfplots body is now wrapped in a `tikzpicture`:
   on a `standalone` document an `axis` at the top level does not compile at all
   (`Environment axis undefined`, then every `\addplot` undefined), while the same
   axis inside a picture compiles cleanly.

A new tracked check, `scripts/checks/check-skill-examples.mjs`, keeps the skills
honest: every fenced example in every shipped skill document is parsed or
compiled by the same engines the plugin uses (25 examples today, one
deliberately skipped). It found the two skill bugs in item 6's neighbourhood on
its first run - a double-escaped matrix row separator and a fragment that
referenced two nodes it never declared.

### alpha.3

Three findings from a real session, none of which a passing check would have
caught:

1. **The engine's error pictures were being left in the page.**
   `mermaid.render(id, source)` called with no container element builds `#d<id>`
   on `document.body`, draws into it, and removes it again - **but only on the
   success path**. Every failed render left its div behind, and when the engine
   had drawn its own error diagram into it first, what stayed in the interface
   was a full 2412x512 picture reading *"Syntax error in text / mermaid version
   11.17.2"*: one per failure, until the tab was reloaded. Reproduced against
   the vendored engine itself (§7). Fixed by **parsing before rendering**,
   telling the engine never to draw its own errors
   (`suppressErrorRendering: true`), rendering into a **container the plugin
   owns**, and sweeping the engine's fixtures in `finally`.

2. **The state route never carried the source.** `GET /state` answered with
   summaries that omitted `source`, and the browser half holds no other copy of
   it: Mermaid is rendered *from its source in the browser*, the source drawer
   edits it, and TikZ exports from it. Every diagram tab and every conversation
   card was drawing from `undefined`. Summaries now carry `source` **and
   `revision`** - the latter because a render report is only meaningful against
   the revision it drew.

3. **"It parses" and "it draws" were the same signal.** A picture the parser
   accepted and the renderer then refused looked exactly like a healthy one.
   The browser now reports what it did with each revision, and the model reads
   that back through `diagram_read`.

## 1. What the user sees

**In the conversation.** Every diagram tool call renders its picture inline -
Mermaid drawn by the browser from its own source, TikZ drawn from the SVG the
host compiled - under a header naming the diagram (`kind`, title, id, status
pill) with two links: **Open tab** (opens or reveals that diagram's tab) and
**Show/Hide** (the picture). The card is built from the tool call itself, so it
is already correct on replay, before any request returns.

The card reads the shell's own block model: a call still running is a call block
with **no** `kind` (`ui-tool` reads `done = "kind" in block`), and a settled call
is a `tool-result` block carrying `call.argsRaw` plus the `meta` view the host
declared. That second channel is what names the diagram for a `diagram_write` -
the write never carries an id, because the host derives one from the title - so
the settled card can name the diagram, show its status, refresh the conversation
store and offer a live **Open tab** link (alpha.2; alpha.1 read `kind` as
"running", which left every write card an unnamed "still writing" row with no
link at all).

**In the right bar.**

| Surface | What it is |
|---|---|
| `dsh-resource://diagram/session/<session>/<id>` | **one tab per diagram**: the rendered picture laid out at 80% of the pane with a `-` / `+` / `Fit` zoom ladder (25%-400%), drag-to-pan when it overflows, a `Recompile` button for TikZ, `Copy`, and `Export ▾` |
| `sidebar://diagrams` | the **index**: every diagram of the conversation with kind, status and size; `New Mermaid` / `New TikZ`; picking a row opens its tab |

The index type carries the package's one **guide entry** (`order: 40`, after
Files 10, Editor 20 and History 30), which is what the `+` control and the Start
page list.

Both pane bodies re-read the conversation from the host when they mount **and**
whenever the tab becomes visible again, so a tab that stayed mounted while the
model wrote diagrams shows them the moment the user returns to it (alpha.2;
alpha.1 only read once per mount, and the write cards could not refresh at all,
so an open index could sit on a stale list).

**The source drawer.** `Source` opens a monospace drawer beside the picture:
edit, then `Apply` (validated and stored exactly like a model write, and
recompiled when it is TikZ) or `Revert`. It is deliberately a plain textarea:
the package depends on no editor, and the document that this drawer edits is a
diagram, not a program. For a real editor, export the `.mmd`/`.tex` and open it
in `dsh-editor`.

**Export.** `Export ▾` saves every format to the **Desktop of the machine
running the harness** (`POST /api/dsh-diagrams/export`, create-exclusive: the
first free name wins and an existing file is never replaced), and reports the
absolute path it wrote. The client names a format, never a path, so there is no
traversal surface and no way to overwrite a file the user already had. The
second half of the menu downloads through the browser instead - the fallback for
a profile whose host row is not mounted.

| Kind | Formats | Where the bytes come from |
|---|---|---|
| Mermaid | `mmd`, `md`, `svg`, `png` | source for `mmd`/`md`; the **browser's own render** for `svg`, rasterized at 2x for `png` |
| TikZ | `tex`, `pdf`, `svg`, `png` | source for `tex`; the host's compiled artifacts for the rest |

## 2. What the model gets

Five tools with raw JSON-Schema parameters (the registry validates both the
arguments and the returned canonical value):

| Tool | Purpose |
|---|---|
| `diagram_write` | create or replace one diagram (`kind`, `source`, optional `id`, `title`, `note`) and validate it |
| `diagram_patch` | literal `oldString`/`newString` replacement inside one diagram - the cheap iteration path for a long TikZ picture; ambiguous matches are refused (`AMBIGUOUS`), a miss is refused (`NO_MATCH`) |
| `diagram_read` | one diagram's full source plus its last diagnostics, warnings and browser verdict, or the index of the conversation |
| `diagram_verify` | re-validate the stored source without writing: it never bumps the revision and never discards the browser's render report |
| `diagram_delete` | remove one diagram and drop its cached artifacts |

Two rules make this more than a text box:

1. **Every write is validated before it is stored.**
   - *Mermaid*: the source goes to a **child process** that loads the vendored
     engine behind a DOM stub and calls `mermaid.parse()`; the parse error comes
     back with the offending line, the caret and the parser's "Expecting" list.
   - *TikZ*: the source is compiled by the machine's own TeX engine and the
     compiler's lines come back line-accurate
     (`diagram.tex:12: Package pgf Error: No shape named ...`).
2. **The status is the contract.** A tool result carries
   `status: ok | error | unavailable`. `unavailable` means "stored but NOT
   verified" (no TeX engine on this host, or the validator itself failed) and
   says so in the result text, because telling the model its diagram is wrong
   when the checker is what broke would be a lie.
3. **Warnings are advisory, never a refusal.** After a successful validation the
   host lints what a parser cannot refuse but a reader pays for: a picture with
   nodes and no edges, more nodes than a person takes in at once, an
   unclosed-looking label, a Mermaid source whose first line names a different
   diagram type than the engine parsed, a TikZ document that compiled to several
   pages or to a canvas too wide to read. They ride the same result, marked as
   advisory, and never change `status`.
4. **Two degenerate sources are refused in plain words.** An empty (or
   comments-only) source, and a TikZ document with no picture in it at all -
   both of which the engines handle with a success and a blank page.
5. **"It parses" and "it draws" are separate verdicts.** See §4.

The returned `address` is the diagram's tab, so the model can point the user at
it in prose as well.

**`diagram_verify`** re-runs the whole validation against the stored source
without writing: it never bumps the revision, never claims an id, and never
discards the browser's render report. It is the right call when a person edited
the diagram in its panel, when the model's context was compacted, or before
describing a diagram's contents - and it is why re-checking does not have to
cost a rewrite.

**Skills** carry the craft the tools cannot: which Mermaid diagram type fits
which question, the syntax traps that actually break diagrams, layout and
readability budgets; the TikZ preamble the host supplies, node/edge/plot
recipes, sizing, the host's hard limits (no shell escape, no file access, no
package installation) and how to read each compile error. They also document the
verdicts above - what `status`, `warnings` and the `Browser:` line each mean, and
which one to act on. They are registered at runtime from `skills/` **and** copied
into `$DSH_HOME/skills` by the installer, so the catalog finds them however the
bundle was installed.

## 3. How it is put together

```
lib/index.js          host row: 5 tools, 2 skills, the /api/dsh-diagrams/* routes
lib/store.js          per-conversation state (one JSON file, atomic writes)
lib/cache.js          content-addressed artifact cache (svg/png/pdf/tex + meta)
lib/latex.js          engine probe, source normalization, compile, convert
lib/mermaid-check.mjs CHILD process: DOM stub + vm-loaded engine + parse + lint
lib/client.js         browser half: 2 tab types, their bodies/titles, tool cards
lib/vendor/mermaid.min.js   GENERATED single-file mermaid build (~3.4 MB)
skills/<name>/SKILL.md      the two skills (copied to $DSH_HOME/skills on install)
vendor/build.mjs      generates lib/vendor/mermaid.min.js + VERSION.json
```

### Routes (`connection.fetch`, exact paths, GET/HEAD/POST only)

The harness's Connection registry registers **exact** routes and its method
vocabulary is `GET | HEAD | POST`. Two consequences are visible in the design:
the vendored engine is **one self-contained file** served from one route (the
chunked ESM build would have needed 104 routes), and every write - including
delete - is a **POST**.

| Route | Behavior |
|---|---|
| `GET /health` | the vendored Mermaid version, the TeX capability (`engine`, `svg`, `png`), cache entry count. `?refresh=1` re-probes the engines |
| `GET /state?session=` | the conversation's diagram index (source + revision + warnings + last render report) + the capability block |
| `GET /diagram?session=&id=` | one diagram, source included |
| `POST /diagram` | create/replace (`{session, id?, kind?, title?, source, create?, recompile?}`), or delete (`{session, id, delete: true}`). Used by the panel; the model goes through the tools |
| `GET /artifact?session=&id=&format=` | `svg`/`png`/`pdf`/`tex` from the cache (Mermaid: `mmd`/`source` only - its picture exists in the browser) |
| `POST /export` | save one format to the **Desktop** of the machine running the harness, create-exclusively, and answer with the absolute path, the folder and the name it wrote |
| `POST /render-report` | what the BROWSER did with one revision (`{session, id, revision, ok, phase?, error?, theme?, ms?}`). Deliberately forgiving: a report about a deleted diagram or an older revision answers 200, because a verification channel must not fail loudly |
| `GET /vendor/mermaid.js` | the vendored engine (ETag, immutable) |

### State: one file per conversation

`$DSH_HOME/dsh-diagrams/sessions/<session>.json` - `{order, diagrams{id →
{kind, title, source, status, diagnostics, warnings, render, artifact, revision,
history}}}`, one atomic write per change, capped (64 diagrams, 256 KiB per
source, 4 MiB of source per conversation, 16 MiB per file). The browser reads it
through the routes; the model reads it through `diagram_read`, which is what
makes a diagram survive compaction, a reload or the browser closing.

`render` is the browser's own report about the revision it drew
(`{revision, ok, phase, error, theme, at}`), stored by `recordRender` and read
back as one of four states by `verificationOf`: `drawn` (a renderer reported
success for THIS revision), `failed` (it reported failure, with its own error),
`stale` (the newest report names a DIFFERENT revision, so this one has never been
drawn) or `pending` (no report at all). The verdict carries both revision
numbers, so `stale` is read rather than guessed. A write sets `render` back to
`null`, because the old picture was of different text.

**Why not a session event.** This was the first design and it is a dead end on
this harness line: `@deepseek-ai/dsh-session-persistence` refuses to load a log
containing an event type outside `KNOWN_SESSION_EVENT_TYPES` unless the envelope
carries `ignorable: true`, and `Session.append()` has no way to set that marker.
A plugin-owned event type would therefore make the conversation unreadable.

**Why not a projection.** A `sessionProjections` unit requires `zod` schemas,
and this pack ships no npm dependencies (the profile installs bundles as live
links, so a package dependency would not be installed). It would also fold the
same events the paragraph above rules out.

### Rendering

**Mermaid, in the browser.** The engine is fetched once from the plugin's own
route and evaluated as a classic script (its last line is
`globalThis["mermaid"] = ...`), exactly how the editor loads CodeMirror. Renders
are cached per `(source, theme)` (LRU, 24 entries) and re-drawn when the app's
light/dark scheme flips.

Every render goes through **`renderMermaidSafe`**, and the order inside it is
load-bearing:

1. **`mermaid.parse(source)` first.** It is the engine's own syntax check and
   it throws with the offending line, so `render()` is only ever reached by a
   source the parser accepted. A broken source therefore cannot produce a
   picture *at all* - clean or broken.
2. **`suppressErrorRendering: true`.** If `render()` fails anyway (a renderer
   bug on a source the parser accepted), the engine throws instead of drawing
   its 2412x512 "Syntax error in text" diagram.
3. **A container the plugin owns.** `render(id, source)` with no container
   builds `#d<id>` on `document.body` and removes it **only on success**; every
   failure left one behind, and one of those divs holds the error picture.
   Passing `mermaidHost()` - attached, laid out at zero size, offscreen -
   keeps every fixture out of the interface. A `finally` sweeps `d<id>`/`i<id>`
   anyway, so an engine that ever ignores the container still cannot paint.
4. **A verdict, not a throw**, at the call site: `MermaidError.phase` says
   whether the parser or the renderer refused, and the pictures draw that as
   text with the diagnostics, a **Retry** button and a route to the source.

The exports (`svg`/`png`) go through the same path, so a diagram that does not
render fails with the parser's words instead of writing an engine error picture
to the Desktop.

**TikZ, on the host.** `pdflatex` (else `xelatex`, else `lualatex`) compiles a
normalized document in a private temp folder, then `pdftocairo`/`pdftoppm`
produce the SVG/PNG. The tab and the card show the **engine's own vector
output** (`pdftocairo -svg` emits glyph outlines, so it is font-independent),
fetched as a blob and shown through an `<img>`. A failing compile that still
produced a PDF is cached too and shown **flagged as errored** - a hint, never
proof. A document that compiles to no picture at all is refused before the
engine sees it, with words rather than a blank panel.

Content-addressed cache: `$DSH_HOME/dsh-diagrams/artifacts/<sha256[0:24]>/{doc.tex,doc.pdf,doc.svg,doc.png,meta.json}`,
keyed by engine + renderer version + normalized source. Editing back to a
previous revision is an instant hit, and the cache can be deleted at any time
(it costs a recompile, nothing else). LRU-pruned at 200 MiB.

## 4. Safety

- **argv, never a shell**: every engine and converter is spawned with an
  argument array; nothing a model writes reaches a shell.
- **No shell escape, no installer, no network**: `-no-shell-escape`,
  `MIKTEX_AUTOINSTALL=0` (a missing package fails in ~300 ms instead of reaching
  the internet), `openin_any=p`/`openout_any=p`, `TEXMFOUTPUT` inside the temp
  folder, cwd inside it too, and the folder is removed afterwards. `tectonic` is
  deliberately **not** accepted as an engine: it downloads packages.
- **Bounded**: 20 s engine kill, 15 s validator kill, 512 KiB captured compiler
  log, 256 KiB source, 4 MiB of source per conversation, 8 MiB artifact, one
  compile at a time (queued) and at most two Mermaid validator children (with a
  bounded queue behind them).
- **Mermaid validation runs in a child process** so the DOM stub never touches
  the harness process, and a crashing engine can never take the host down.
- **Writes** go to `$DSH_HOME/dsh-diagrams/**` (state + cache) and to the
  **Desktop** when the user asks for an export - where the name is
  host-generated, the folder is resolved per request, and the write is
  create-exclusive, so nothing the user already had can be replaced. The client
  never names a path.

## 5. Building the vendored engine

```sh
node packages/dsh-diagrams/vendor/build.mjs          # rebuild from the pinned version
node packages/dsh-diagrams/vendor/build.mjs --check  # drift check (non-zero on drift)
```

`vendor/package.json` pins the version; the script installs it under
`vendor/node_modules` (gitignored), copies **mermaid's own single-file browser
build** to `lib/vendor/mermaid.min.js` and writes `lib/vendor/VERSION.json`
(bytes + sha256 + the global it exposes). The tracked route check re-computes
that hash against the served bytes, so a hand-edited or half-copied engine fails
the checks instead of shipping.

Why that file: it is self-contained (no dynamic imports, no chunk requests), it
exposes `globalThis.mermaid` for the browser, and **the same bytes** run
headlessly in Node via `vm.runInThisContext` behind the DOM stub - one vendored
artifact, both halves.

## 6. TeX is optional

Everything works without a TeX engine except compiling TikZ. `GET /health`
reports `tex.available`; when it is false the index says so, the tab explains
that the diagram is stored but not validated, the tool result says the same, and
TikZ diagrams still store and export as `.tex`. Mermaid needs no engine at all.

## 7. Checks

```sh
node scripts/checks/check-client-bundles.mjs   # tab types, seats, cards, the render trap, zoom, Desktop export, verdict labels
node scripts/checks/check-node-routes.mjs      # routes, tools, store, compile, export, vendor drift, budgets, cache verdicts
node scripts/checks/check-skill-examples.mjs   # every fenced example in every shipped skill, parsed or compiled
```

The client check renders the real seats through a real React runtime (the panel
bodies, both chips, all five tool cards) and asserts the four load-bearing
properties of the render path - parse-before-render, `suppressErrorRendering`,
the plugin's own container, and the `finally` sweep - each of which is the
difference between a text error and a stray error picture in the page; it also
pins the zoom ladder to the layout box rather than a transform, the Desktop
export wording, and the four verdict labels. The node check drives the routes and
the tool bodies against a temp `DSH_HOME` - including a real Mermaid parse, a real
TikZ compile when the host has an engine, the lint warnings, the empty-source
refusals, `diagram_verify` leaving the revision alone, the render-report round
trip (drawn / failed / stale / pending), an ambiguous-patch refusal, the
create-exclusive export onto a redirected Desktop (never the workspace), the
source budget, a cache hit keeping the verdict it was cached with, a `box`
sequence diagram validating, a bare `axis` chart compiling, and the
vendored-engine hash. The skill check is the one that keeps the DOCUMENTATION
honest: it extracts every fenced example from `skills/**/*.md` and runs it
through the same parser and engine, so a copy-pasteable source that no longer
works fails the run instead of misleading the next agent.

The reproduction that found the error pictures is not part of the tracked
checks, because it needs a real DOM and this pack ships no npm dependency. It
was run three ways, each recorded here so a future change can be compared
against it:

1. **The vendored engine under `jsdom`** (throwaway install). Three failed
   renders left **three** `div#d<id>` elements in `document.body`, each holding
   the engine's error SVG; the parse-first path left **zero** of either.
2. **The vendored engine in real headless Chrome**, through two pages that
   differ only in call shape. Measured from the screenshots with a PNG decoder
   (ink coverage per row, no image library):

   | Page | Ink below the report line | Blocks |
   |---|---|---|
   | old call shape (`render(id, source)`, three failures) | 37 039 px over rows 16..409 | **3** stacked engine blocks, ~123 px each |
   | parse-first path (same three failures) | 0 px below row 52 | **none** |

   That is the user's report, reproduced and then removed: the interface grew a
   block of engine output per failed render.
3. **The tracked checks**, which assert the four load-bearing properties so a
   regression cannot reach the page again.


## 8. Limits and roadmap

- One diagram per tab: `dsh-resource://diagram/session/<session>/<id>`; the
  index is the only page.
- The source drawer is a textarea by design (alpha.1); reusing `dsh-editor`'s
  vendored CodeMirror when that bundle is installed is the next step.
- TikZ with multiple files (`\input`) is not supported - the document is one
  self-contained source.
- A source may not read files or run commands: the engine is sandboxed to its
  temp folder with shell escape off.
- **Host-side Mermaid rasterization was considered and rejected.** Verifying a
  Mermaid *picture* on the host would need real SVG geometry (`getBBox`), which
  the child validator's DOM stub deliberately does not provide - and adding
  `jsdom`/`svgdom` would break the pack's zero-dependency rule. The browser
  render report is the substitute: it uses the real renderer, in the real theme,
  on the user's own screen, which is a stronger signal than a headless proxy.
  Its only cost is that it needs a client to have drawn the revision.
- Follow-ups worth doing: report the render verdict per diagram in the
  conversation card (today the card is honest but does not say "drawn"), and
  fold the render report into the tool result the model sees when a client
  happens to be open at call time.
