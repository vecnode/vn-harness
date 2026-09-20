# dsh-diagrams

**Mermaid and TikZ diagrams as a first-class surface of the harness**: the model
writes them as tools, the host validates every write with a real parser or a
real TeX engine, they render inline in the conversation, and each one lives in
its own right-bar tab with a source drawer and an export menu.

- Row `diagrams`, bundle `dsh-diagrams`, tab kinds `diagram` (one tab per
  diagram) and `diagrams` (the conversation index, reachable from the tab
  strip's `+` / **Start** page).
- Tools: `diagram_write`, `diagram_patch`, `diagram_read`, `diagram_delete`.
- Skills: `mermaid-diagrams`, `tikz-diagrams` (authored in `skills/`, copied
  into `$DSH_HOME/skills` by the installer).
- No core patch, no forked bundle, no npm dependency, **no network**.

Alpha. `0.1.0-alpha.2`.

---

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
| `dsh-resource://diagram/session/<session>/<id>` | **one tab per diagram**: the rendered picture (fit to the panel, zoom by scrolling), a `Recompile` button for TikZ, `Copy`, and `Export ▾` |
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

**Export.** `Export ▾` writes into the conversation folder
(`POST /api/dsh-diagrams/export`, create-exclusive: the first free name wins and
an existing file is never replaced) or downloads through the browser.

| Kind | Formats | Where the bytes come from |
|---|---|---|
| Mermaid | `mmd`, `md`, `svg`, `png` | source for `mmd`/`md`; the **browser's own render** for `svg`, rasterized at 2x for `png` |
| TikZ | `tex`, `pdf`, `svg`, `png` | source for `tex`; the host's compiled artifacts for the rest |

## 2. What the model gets

Four tools with raw JSON-Schema parameters (the registry validates both the
arguments and the returned canonical value):

| Tool | Purpose |
|---|---|
| `diagram_write` | create or replace one diagram (`kind`, `source`, optional `id`, `title`, `note`) and validate it |
| `diagram_patch` | literal `oldString`/`newString` replacement inside one diagram - the cheap iteration path for a long TikZ picture; ambiguous matches are refused (`AMBIGUOUS`), a miss is refused (`NO_MATCH`) |
| `diagram_read` | one diagram's full source plus its last diagnostics, or the index of the conversation |
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

The returned `address` is the diagram's tab, so the model can point the user at
it in prose as well.

**Skills** carry the craft the tools cannot: which Mermaid diagram type fits
which question, the syntax traps that actually break diagrams, layout and
readability budgets; the TikZ preamble the host supplies, node/edge/plot
recipes, sizing, the host's hard limits (no shell escape, no file access, no
package installation) and how to read each compile error. They are registered at
runtime from `skills/` **and** copied into `$DSH_HOME/skills` by the installer,
so the catalog finds them however the bundle was installed.

## 3. How it is put together

```
lib/index.js          host row: 4 tools, 2 skills, the /api/dsh-diagrams/* routes
lib/store.js          per-conversation state (one JSON file, atomic writes)
lib/cache.js          content-addressed artifact cache (svg/png/pdf/tex + meta)
lib/latex.js          engine probe, source normalization, compile, convert
lib/mermaid-check.mjs CHILD process: DOM stub + vm-loaded engine + parse
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
| `GET /state?session=` | the conversation's diagram index + the capability block |
| `GET /diagram?session=&id=` | one diagram, source included |
| `POST /diagram` | create/replace (`{session, id?, kind?, title?, source, create?, recompile?}`), or delete (`{session, id, delete: true}`). Used by the panel; the model goes through the tools |
| `GET /artifact?session=&id=&format=` | `svg`/`png`/`pdf`/`tex` from the cache (Mermaid: `mmd`/`source` only - its picture exists in the browser) |
| `POST /export` | write one format into the conversation folder, create-exclusively |
| `GET /vendor/mermaid.js` | the vendored engine (ETag, immutable) |

### State: one file per conversation

`$DSH_HOME/dsh-diagrams/sessions/<session>.json` - `{order, diagrams{id →
{kind, title, source, status, diagnostics, artifact, revision, history}}}`, one
atomic write per change, capped (64 diagrams, 256 KiB per source, 1 MiB per
file). The browser reads it through the routes; the model reads it through
`diagram_read`, which is what makes a diagram survive compaction, a reload or
the browser closing.

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

**TikZ, on the host.** `pdflatex` (else `xelatex`, else `lualatex`) compiles a
normalized document in a private temp folder, then `pdftocairo`/`pdftoppm`
produce the SVG/PNG. The tab and the card show the **engine's own vector
output** (`pdftocairo -svg` emits glyph outlines, so it is font-independent),
fetched as a blob and shown through an `<img>`. A failing compile that still
produced a PDF is cached too and shown **flagged as errored** - a hint, never
proof.

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
  log, 256 KiB source, 8 MiB artifact, one compile at a time (queued).
- **Mermaid validation runs in a child process** so the DOM stub never touches
  the harness process, and a crashing engine can never take the host down.
- **Writes** go to `$DSH_HOME/dsh-diagrams/**` (state + cache) and to the
  conversation folder only when the user asks for an export - where the name is
  host-generated, realpath-contained and create-exclusive.

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
node scripts/checks/check-client-bundles.mjs   # tab types, seats, cards, styles
node scripts/checks/check-node-routes.mjs      # routes, tools, store, compile, export, vendor drift
```

The client check renders the real seats through a real React runtime (the panel
bodies, both chips, all four tool cards) and the node check drives the routes and
the tool bodies against a temp `DSH_HOME` - including a real Mermaid parse, a
real TikZ compile when the host has an engine, an ambiguous-patch refusal, the
create-exclusive export and the vendored-engine hash.

## 8. Limits and roadmap

- One diagram per tab: `dsh-resource://diagram/session/<session>/<id>`; the
  index is the only page.
- The source drawer is a textarea by design (alpha.1); reusing `dsh-editor`'s
  vendored CodeMirror when that bundle is installed is the next step.
- TikZ with multiple files (`\input`) is not supported - the document is one
  self-contained source.
- A source may not read files or run commands: the engine is sandboxed to its
  temp folder with shell escape off.
