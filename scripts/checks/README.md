# scripts/checks

Standalone verification for the pack's JavaScript halves. None of the four
scripts needs a running harness and none is part of the installers; run them
after touching a client bundle, a Node route or a shipped skill (they caught a
real "the tab body never got the hook it needs" bug during the alpha.4 editor
work). Node only - identical on Windows, macOS and Linux.

```sh
node scripts/checks/check-client-bundles.mjs   # module table + real React render
node scripts/checks/check-node-routes.mjs      # every Node route + the diagram tools
node scripts/checks/check-pdf-node.mjs         # the five pdf tools + the routes, against PDFs it builds
node scripts/checks/check-skill-examples.mjs   # every fenced example in every shipped skill
DSH_CHECK_LAUNCH=1 node scripts/checks/check-node-routes.mjs   # also opens a real file browser
```

(Windows PowerShell: `$env:DSH_CHECK_LAUNCH='1'; node scripts/checks/check-node-routes.mjs`.)

A check that cannot run on this host says so and skips loudly instead of
passing: the live terminal socket needs a resolvable `node-pty` **and** `ws`,
the git routes need `git` on `PATH`, and the TikZ cases need a TeX engine.

- `check-client-bundles.mjs` loads each browser half exactly the way the shell
  does (through `window.__ModuleLoader__.load`), activates it against a stub
  cordis context, and drives it with a **real React runtime** found in the
  profile or an npx cache (`react-dom/server`, so browser-only hooks such as
  `useEffect` are skipped, like any server render). Bundles covered:
  - `dsh-modal` - the `modals` service and its queue;
  - `dsh-ui-state` - the pack's durable UI state: the contract defaults the host
    schema mirrors, the `uiState` service (`get`/`set`/`unset`/`subscribe`), and
    the two COLUMN WIDTHS it restores through the `root` slot registration's own
    store handle - driven against a store double in every order that matters (the
    section first, the layout first, neither, a narrow frame, a remembered `0`
    collapsed through the toggle, and a store shape it must REFUSE rather than
    run blind). It also pins the same wiring from the other side: that
    `dsh-themes` and `dsh-terminal` resolve the service lazily, never declare it
    in `inject`, and keep their `localStorage` copies underneath;
  - `dsh-editor` - the tab type, `canOpen` (Markdown claimed, previews vetoed),
    the guide contract, the **Preview** hand-off naming the registry's kind (and
    the fallback when the preview type is absent), the blank-document save path,
    the theme-compartment source invariants, and the shell languages (alpha.10:
    the extension map in the client source, and the built `cm6.min.js` actually
    carrying `StreamLanguage` + `shell` + `powerShell` + `batch` - a bundle that
    was not rebuilt after entry.js changed fails there);
  - `dsh-open-in-app` - the route split (file managers to the pack route,
    everything else to the shipped one);
  - `dsh-themes` - the header seats and their orders, the theme registry
    snapshot, the Nord/Monokai extensions (their token maps and glyphs), the
    Session-log download seat, the screenshot control, the **Markdown paper**
    (the light declarations it copies out of fake theme stylesheets, and the
    dark ones it must skip), the left-top-bar branding and the header ring; plus -
    the one section that loads a HARNESS bundle rather than a pack one - the
    **extension-theme regression** against the **real ui-theme runtime**: choosing
    Nord applies it through the real service, `adopt()`'s re-adopt of the durable
    built-in (triggered by ANY settings-document change) no longer discards it, a
    built-in chosen on a surface that writes durably still wins, and this
    control's own menu always goes back to a built-in. It skips loudly when the
    host has no copy of ui-theme, because a stub theme service is exactly what
    let that bug ship;
  - `dsh-gittree` - registration, guide order, the history-only body, the chip
    title;
  - `dsh-terminal` - the bundle id, both seats, order 30, and the geometry
    invariants the dock must keep at the source level (never the frame's height,
    inset the two columns, re-fit on resize, follow the left bar through the
    mutation observer *and* the column `ResizeObserver`), plus the bar itself:
    every chip pick publishes to the store (store + show + `bump()`, or the
    highlight stays on the terminal you just left), the strip is a horizontally
    scrolling box with `+` outside it, the arrows are gated on measured overflow
    and the wheel listener is native and non-passive - and the strip's
    scroll-into-view arithmetic is DRIVEN, through the bundle's pure
    `__internals.revealDelta`. alpha.7 adds the agent view on the same terms: the
    switch is a MODE (off by default, no `Agent` chip until it is on), the bundle
    reads this package's own `/activity` route rather than the browser's session
    window and polls only while something is subscribed and the tab is visible,
    killing a chip must not move a reader who is looking at the log, and **Run in
    Terminal** must refuse a multi-line command - and then the whole read model is
    DRIVEN with hand-built session events: `parseExecCall` (a missing
    `description` marks the persistent shell, `read` is not a command),
    `parseExitMarker` (consumed, a signal is not an exit code, marker-like text
    mid-output left alone), `stripAnsi`, `formatDuration`, `filterActivity` and
    `buildActivityFromEvents` (grouping by prompt, injected context does not open
    a group, a failure read off its marker, a call with no result still running, a
    persistent shell claiming no exit status, a result outside the tail kept but
    unnamed), the view itself RENDERED from a hand-built log (since the switch is
    off by default no static render of the dock can reach a row), plus
    `activitySignature`, which is what keeps an unchanged poll from re-folding the
    log;
  - `dsh-rightbar` - the forked bar's own source invariants (module-table id,
    the module-table surface other bundles inject);
  - `dsh-diagrams` - both tab types and their seats, all six tool cards, and the
    four load-bearing properties of the render path (parse-before-render,
    `suppressErrorRendering`, the plugin's own container, the `finally` sweep),
    plus the zoom ladder moving the layout box rather than a transform, the
    Desktop-export wording and the four verdict labels;
  - `dsh-pdf` - the reader type and the `pdfs` index page, every tool card, the
    scanner's own route call, and the parts of the reader that are contracts
    (the text layer's scale variables, the lazily drawn thumbnail rail, the
    outline resolved through pdf.js, the engine fetched from the package's own
    routes rather than inlined);
  - `dsh-image` - the image type and its seat, the extension band and the
    `canOpen` refusals, the chip title and the deliberate absence of a guide
    entry, the tab body and the title seat rendered as markup, and the viewer's
    load-bearing rules by name: the layout-sized zoom (never a transform), the
    measured overflow behind the grab cursor, the non-passive wheel listener
    anchored at the pointer, the 1x1 pixel sampler, the checkerboard, the
    pixelated threshold, the base64 decode, and the fact that the bundle has no
    `fetch` and no route of its own because bytes come from the shipped
    `workspaceFiles` remote.
  - `dsh-audio` - the audio type and its seat, the extension band and the
    `canOpen` refusals, the chip title and the deliberate absence of a guide
    entry, the opening markup, and the viewer's load-bearing rules by name (the
    layout-sized zoom, the viewport-anchored canvas, the non-passive wheel
    listener, the audio-clock playhead, the streaming window read and the host
    cap a refusal teaches it). It is also the one section that **builds its own
    audio** - a RIFF/WAVE, an IFF FORM and a FLAC, byte by byte - and drives the
    bundle's pure half (`exports.__internals`) to assert the decoded numbers:
    sample rates, channel counts, bit depths, durations, a half-scale sine's
    envelope, a DC half followed by real silence, the 24-bit two's-complement
    edges, unclamped IEEE float, `WAVE_FORMAT_EXTENSIBLE`, the G.711 laws, a
    truncated file reported as unknown rather than silent, an unsupported codec
    refused by name, and the peak pyramid's bucket arithmetic - including that a
    WINDOWED decode builds the same pyramid as a whole-file one.
- `check-node-routes.mjs` imports each Node half, captures the handlers it
  registers on the `connection` service, and drives them with real `Request`s
  against temp workspaces and a temp `DSH_HOME`:
  - **editor** - containment, text-only reads, create-only semantics,
    optimistic concurrency, atomic save;
  - **open-in-app** - the launcher's wire validation and the status a real launch
    answers (the actual window is behind `DSH_CHECK_LAUNCH=1`);
  - **gittree** - the three read-only routes against a real scratch repository
    (init -> commit -> modify -> untracked -> a workspace that is a subfolder),
    asserting scope, the brief form, the root commit's file list and the
    option-injection guard;
  - **terminal** - the route family, the ETag, and a LIVE shell over a real
    socket (init -> ready -> a command answered -> kill, a JSON line proven to
    be shell input rather than a control frame, and an unauthenticated upgrade
    refused). alpha.7 adds the agent view's read: the `/activity` route is driven
    against a stubbed live session and must send only the three event types the
    panel draws (injected context and assistant streams dropped), in log order,
    answer `NOT_LIVE` for a conversation that is not open on this host (a 200 -
    a fact about the host, not a bad request), `UNREADABLE` for a log that will
    not read, 400 without a session id, and answer a conversation past the budget
    with its **tail** (`hasMore` set, the newest kept, and one oversized newest
    command still sent);
  - **themes** - the screenshot route's type/signature/size refusals and the
    create-exclusive write onto a redirected Desktop;
  - **ui-state** - the pack's settings namespace with no route to capture: the
    row is driven against a stub so the check can assert what `apply` registered
    (the `vn-harness` namespace, asked for through the OPTIONAL settings service)
    and that the schema really resolves the defaults the browser half mirrors -
    drift between those two is what would make a fresh install read a field
    nobody set - plus the ladder and height refusals and the pre-paint zoom row
    (silent at the resting level, carrying level and seam marker otherwise, and
    silent when no settings service is composed);
  - **diagrams** - the route table, the vendored-engine hash, a real Mermaid
    parse, a real TikZ compile when the host has an engine, the lint warnings,
    the empty-source refusals, `diagram_verify` leaving the revision alone, the
    render-report round trip (drawn / failed / stale / pending), an
    ambiguous-patch refusal, the create-exclusive export onto a redirected
    Desktop (never the workspace), the source budget, a cache hit keeping the
    verdict it was cached with, a `box` sequence diagram validating, a bare
    `axis` chart compiling, and every tool result validated against the schema
    the tool declares.
- `check-pdf-node.mjs` builds its own PDFs (a two-page report with a labelled
  value, a one-page scan that is one image and no text, a twelve-page document
  for the per-call caps, one nested in a subfolder and one inside `node_modules`
  to pin the index walk, a truncated copy), so it needs no TeX, no poppler and no
  network, and drives all five `pdf_*` tools, the routes, the path policy and the
  vendor `--check`. The scanner is verified in two halves on purpose: the tool as
  the agent calls it (which on a host without tesseract means pinning its
  refusal) and the pipeline directly through a stub OCR engine, which is what
  proves on any host that the raster handed to the engine is the one drawn for
  that page, that a second call is a cache hit, that another dpi/psm/language is
  a new recognition, and that the per-call cap names the pages it left.
- `check-skill-examples.mjs` extracts every fenced example from `skills/**/*.md`
  and parses or compiles it with the plugin's own engines, so a copy-pasteable
  source that no longer works fails the run instead of misleading the next
  agent.
