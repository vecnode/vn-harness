# scripts/checks

Standalone verification for the pack's JavaScript halves. None of the three
scripts needs a running harness and none is part of the installers; run them
after touching a client bundle, a Node route or a shipped skill (they caught a
real "the tab body never got the hook it needs" bug during the alpha.4 editor
work). Node only - identical on Windows, macOS and Linux.

```sh
node scripts/checks/check-client-bundles.mjs   # module table + real React render
node scripts/checks/check-node-routes.mjs      # every Node route + the diagram tools
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
    dark ones it must skip), the left-top-bar branding and the header ring;
  - `dsh-gittree` - registration, guide order, the history-only body, the chip
    title;
  - `dsh-terminal` - the bundle id, both seats, order 30, and the geometry
    invariants the dock must keep at the source level (never the frame's height,
    inset the two columns, re-fit on resize, follow the left bar through the
    mutation observer *and* the column `ResizeObserver`);
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
    refused);
  - **themes** - the screenshot route's type/signature/size refusals and the
    create-exclusive write onto a redirected Desktop;
  - **diagrams** - the route table, the vendored-engine hash, a real Mermaid
    parse, a real TikZ compile when the host has an engine, the lint warnings,
    the empty-source refusals, `diagram_verify` leaving the revision alone, the
    render-report round trip (drawn / failed / stale / pending), an
    ambiguous-patch refusal, the create-exclusive export onto a redirected
    Desktop (never the workspace), the source budget, a cache hit keeping the
    verdict it was cached with, a `box` sequence diagram validating, a bare
    `axis` chart compiling, and every tool result validated against the schema
    the tool declares.
- `check-skill-examples.mjs` extracts every fenced example from `skills/**/*.md`
  and parses or compiles it with the plugin's own engines, so a copy-pasteable
  source that no longer works fails the run instead of misleading the next
  agent.
