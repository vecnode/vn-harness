# Complex TikZ diagrams

Depth for `SKILL.md` in this folder. Everything assumes the host wrapper described
there: `standalone` with `border=4pt`, pgfplots 1.18, one fixed library list. Every
`tex` block below was compiled on this host through the wrapper's own
`normalizeTikzSource` plus `pdflatex -interaction=nonstopmode -no-shell-escape
-file-line-error`: all 10 are **1 page with zero diagnostics**. Sizes are real PDF
boxes in points (1pt = 1/72 in); error strings in section 9 are transcripts.

## 1. Budgets

The host lints (advisory, never a refusal): over 1 page, canvas wider than 2000pt,
more than 250 non-empty lines.

Verified boxes (width x height, pt): layers 102 x 76, styles 254 x 34, edges 156 x
100, small multiples 355 x 138, shapes 206 x 118, example a 159 x 196, b 305 x 182,
c 277 x 161, d 216 x 148, e 159 x 109.

- **200-450pt wide is the sweet spot**: the panel fits the SVG into a few hundred
  pixels, so a 350pt picture readable at 100% is readable there.
- **Split at ~600pt wide, ~900pt tall, ~40 nodes, ~200 non-empty lines.**
- **Past 2000pt the panel scales the canvas down by roughly 5x** and labels are
  gone. A verified `Dimension too large.` case produced a 16322pt artifact: errored,
  and even its first page unreadable.
- Split by **question**, not by size: two facts are two diagrams, even when they share
  three nodes; a legend over 4 edge kinds means the picture carries two stories.
- Prefer **wide over tall**: a row of 3-4 nodes costs 250-350pt of width, the same
  chain stacked vertically costs 900pt of height.

## 2. Sizing and fitting

**`scale=` transforms coordinates only.** Node boxes, `minimum width/height`,
`inner sep` and text stay full size, so a scaled picture gets cramped rather than
smaller: verified, the same two-node picture at `scale=0.5` is **114.8 x 21.9pt
without** `transform shape` and **61.6 x 15.1pt with** it. Add `transform shape`
below ~0.9. It scales `font=\small` physically too, so if a label gets too small,
raise the font a step rather than undoing the scale.

**`x=`/`y=` vs `node distance`.** `x=18mm, y=12mm` sets what `(1,0)` means: use it
when placing by coordinate (grids, timelines). Use `node distance=10mm and 6mm`
(vertical, then horizontal) with `positioning`; below ~8mm boxes with a `minimum
width` touch, so shrink `minimum width`, `minimum height` and `inner sep` together.

**Fonts.** One base font in the picture options (`font=\small`), then only go down
for annotations (`\scriptsize`, `\footnotesize`); never mix `\small` and
`\normalsize` in one picture. `\tiny` survives only at 100% zoom, which the panel does
not guarantee. `border=4pt` already handles whitespace (the PDF is the picture plus
4pt), so a cramped picture needs `inner sep` or more `node distance`.

**`\resizebox` is not the answer.** Verified: `\resizebox{4cm}{!}{...}` around a
`tikzpicture` returns 7 diagnostics including `Package graphics Error: Division by
0.` and `LaTeX Error: \begin{document} ended by \end{tikzpicture}.`, and becomes two
612x792pt letter pages: a box around the picture discards the 4pt crop. Use `scale=`
+ `transform shape`, `x=`/`y=`, `node distance`, `minimum size`.

## 3. Layout at scale

**positioning chains.** `right=of a`, `below left=6mm and 4mm of a`, `above=of a`
need `positioning` (loaded); `node distance` is the default they consume, so a chain
is one `node distance` plus plain `right=of`. Attach edges to named anchors
(`a.north east`, `a.30`) rather than centers. `on grid` snaps node **centers** to the
lattice instead of borders, which is what makes a hand-placed diagram line up
(verified clean with `node distance=15mm, on grid`); do not mix it with explicit
`yshift`/`xshift` nudges.

**`matrix of nodes` is the best tool for a dense grid.** One cell per node,
`row sep`/`column sep` for gaps, cells named `(m-2-3)` so edges are
`(m-2-3) -- (m-3-3)`. Verified: `row 1/.style={nodes={hdr}}` and
`column 3/.style={nodes={alert}}` restyle a whole row or column and `|[fill=red!20]|`
restyles one cell; an empty cell creates **no** node, so write `{}` if it must exist
(`fit=(m-1-1)` on a `{}` cell compiles clean). `minimum width`/`minimum height` in
`nodes={}` set the pitch: a 5x4 grid at 13x7.5mm is already 216pt wide.

**`fit` + `backgrounds` for layer bands.** `\node[fit=(a)(b)(c), inner sep=8pt] {}`
(needs `fit`) frames the nodes you list. Put it inside
`\begin{scope}[on background layer] ... \end{scope}` or its `fill` paints **over**
the boxes and hides their labels; put the label on the band
(`label={[opts]above:Layer 2}`), not on the picture.

**`pgfdeclarelayer`/`pgfonlayer`** when `on background layer` is not enough (three or
more layers, or a highlight that must sit between two groups). Those two commands are
**not** in the hoist list, so they stay in the document body, which is fine and
verified above a `tikzpicture`. **`local bounding box`** for composition:
`\begin{scope}[local bounding box=grp] ... \end{scope}` names the enclosed content, so
`fit=(grp)` frames a sub-assembly without listing every node and `(grp.east)` anchors
an edge to the group.

```tex
\usetikzlibrary{fit,backgrounds,positioning,arrows.meta}
\pgfdeclarelayer{bands}
\pgfsetlayers{bands,main}
\begin{tikzpicture}[font=\footnotesize, box/.style={draw, rounded corners=2pt, fill=white, inner sep=3pt}]
  \begin{scope}[local bounding box=grp]
    \node[box] (a) at (0,0) {A};
    \node[box] (b) at (2.4,0) {B};
    \node[box] (c) at (1.2,-1.5) {C};
  \end{scope}
  \begin{pgfonlayer}{bands}
    \node[fit=(grp), draw=gray!50, dashed, fill=gray!8, rounded corners=4pt, inner sep=7pt] {};
  \end{pgfonlayer}
  \draw[-{Latex[length=1.8mm]}] (a) -- (b);
  \draw[-{Latex[length=1.8mm]}] (b) -- (c);
\end{tikzpicture}
```

## 4. Edges at scale

- **Tips**: `-{Latex[length=2mm,width=1.4mm]}`; set once with `>={Latex[length=2mm]}`
  and write `->` after. A bare `->` is fatter; mixed tip sizes look wrong.
- **`shorten >=1.5pt, shorten <=1.5pt`** in the arrow style stops a fan of edges
  colliding with rounded corners and node borders. Set it once, not per edge.
- **Curves**: `bend left=25` for a symmetric pair, `to[out=-35, in=215]` when the
  geometry is asymmetric, `looseness=1.7` to push a return edge clear. Two edges
  between the same pair need opposite bends (`bend left=25` / `bend left=-25`).
- **Orthogonal**: `|-` and `-|` between explicit anchors, e.g.
  `(cli.south) |- (auth.east)`; between centers they double back through the boxes.
- **Labels**: `node[midway, above, sloped]` on a diagonal edge, `pos=0.3` to move it
  off the middle, `near start`/`near end` for the ends. On a vertical edge use
  `right`, never `above`.
- **Mid-edge arrows**: `decorations.markings` with `postaction={decorate}` and
  `mark=at position #1 with {\arrow{Latex[length=1.8mm]}}` in a style taking an
  argument, used as `midarrow=0.5`; use it when both endpoints already carry tips.

```tex
\usetikzlibrary{arrows.meta,positioning,decorations.markings,calc}
\tikzset{flow/.style={-{Latex[length=2mm,width=1.4mm]}, thick, shorten >=1.5pt, shorten <=1.5pt}, midarrow/.style={decoration={markings, mark=at position #1 with {\arrow{Latex[length=1.8mm]}}}, postaction={decorate}}}
\begin{tikzpicture}[font=\footnotesize, node distance=16mm, box/.style={draw, rounded corners=2pt, fill=blue!8, minimum height=8mm, minimum width=18mm, align=center}]
  \node[box] (a) {A};
  \node[box, right=of a] (b) {B};
  \node[box, below=of a] (c) {C};
  \draw[flow] (a) -- node[midway, above, sloped, font=\scriptsize] {direct} (b);
  \draw[flow] (a) -- (c);
  \draw[flow, bend left=25] (c) to node[midway, above, sloped, font=\scriptsize] {bend} (b);
  \draw[flow, dashed] (a.south) |- (b.south);
  \draw[midarrow=0.5, thick] (a) to[out=-35, in=215] (b);
\end{tikzpicture}
```

## 5. Reusable styles

A picture that repeats raw option lists drifts: node 7 gets `minimum width=20mm` and node
8 does not, and the rows stop aligning. Define names once in one hoisted `\tikzset` line.

- **Arguments**: `tinted/.style={box, fill=#1}` used as `tinted=blue!12`;
  `/.style 2 args={...}` for two; `/.default=` for the common case.
- **Inheritance**: parent first (`tinted` starts from `box`), so a change to `box`
  propagates.
- **Globals**: `every node/.style={...}` replaces the global dress,
  `every node/.append style={outer sep=2pt}` extends it; the picture's `[options]`
  list is where `font=`, `align=` and `>={...}` belong.
- **`execute at begin node=\strut`** in the box style gives every node the same
  internal height, so one-line and two-line labels stop jogging the row.
- **The hoisting contract** (verified, the sharpest trap here): each hoisted command
  on **one line**, all **contiguous** at the top - the wrapper hoists only leading
  lines matching its prefix list and stops at the first line that does not.
  - A multi-line `\tikzset{` hoists line 1 and dumps the rest into the body: verified
    9 diagnostics of `Missing \endcsname inserted.` and `Paragraph ended before
    \__file_name_expand_cleanup:Nw was complete.`, ending in `Fatal error occurred,
    no output PDF file produced!`. No PDF at all.
  - A blank line between preamble lines stops hoisting; a `\usepackage` below it gives
    `LaTeX Error: Can be used only in preamble.` (verified, 2 letter pages), and a
    `\usetikzlibrary` below it still worked under pdflatex but must not be relied on.
  - So keep `\tikzset`, `\definecolor`, `\newcommand`, `\usetikzlibrary` and
    `\pgfplotsset` to one line each at the top with no blanks between; multi-line style
    groups go in the `tikzpicture` options, where breaks are safe.

```tex
\usetikzlibrary{positioning,arrows.meta}
\tikzset{box/.style={draw, rounded corners=2pt, minimum height=9mm, minimum width=20mm, align=center, font=\footnotesize, execute at begin node=\strut}, tinted/.style={box, fill=#1}, flow/.style={-{Latex[length=2mm]}, thick, draw=black!70}}
\begin{tikzpicture}[node distance=12mm, every node/.append style={outer sep=2pt}]
  \node[tinted=blue!12] (a) {Fetch};
  \node[tinted=green!14, right=of a] (b) {Parse};
  \node[tinted=orange!16, right=of b] (c) {Store};
  \draw[flow] (a) -- (b);
  \draw[flow] (b) -- (c);
\end{tikzpicture}
```

## 6. Colors and themes

The compiled SVG is drawn on the app's panel background, light or dark, and you
cannot see which. Design so the answer does not matter.

- **Palette discipline**: 2-4 `\definecolor` entries, one hue per role or layer, then
  tints for fills and shades for strokes and text: `fill=accent!12`,
  `draw=accent!55!black`, `text=ink`. More than ~5 hues is noise.
- **Give every text-bearing node its own contrast.** An unfilled node with default
  black text disappears on a dark panel; `fill=white` with white text disappears on
  both. The safe dress is an explicit light fill plus an explicit dark text color
  (`fill=blue!8, text=ink`): the node carries its own background.
- **Never leave `text=` at the default** on a node with no fill; never `draw=white`.
- **Translucent tints over the panel** (`fill=blue!8` with nothing underneath) shift
  with the theme. Fine for bands, but keep the text on them a dark opaque color,
  because in dark mode the band is the panel color plus a little blue.
- **Strokes**: `draw=ink!65` or `black!70` reads as a line, pure black as a seam; a
  legend must repeat the exact styles it explains.

The dress in one line: `\definecolor{ink}{HTML}{1F2933}`, `\definecolor{accent}{HTML}{2F6FED}`, then `tile/.style={draw=ink!40, text=ink, fill=#1}` applied as `tile=accent!12` and a stronger `tile=accent!22` for the node that matters.

## 7. pgfplots recipes

A plot is a picture like any other: one page, one story, readable at panel size. The
wrapper loads pgfplots 1.18 with `fillbetween` only; any other pgfplots library needs its
own single-line `\usepgfplotslibrary{...}` at the top.

**`axis` always ends up inside a `tikzpicture`.** A bare `\begin{axis}...\end{axis}` body is
wrapped in one by the host, and that is deliberate: on a `standalone` document an `axis` at
the top level does NOT compile - pdflatex answers `LaTeX Error: Environment axis undefined`
and every `\addplot` after it is an `Undefined control sequence`, while the very same axis
inside a `tikzpicture` compiles cleanly (both measured). So write the axis; do not add your
own surrounding `tikzpicture` unless you need to place the axis at a coordinate or put
several of them in one picture, in which case the wrapper sees the `tikzpicture` and leaves
it alone.

**Axis sizing and ticks.** `width=`/`height=` are the axis box, not the figure:
labels, ticks and title add about a centimeter each way. 9-10cm x 5-6cm is the sweet
spot (verified 277 x 161pt). Keep ticks sparse: `xtick distance=2`,
`minor tick num=1`, `tick label style={font=\scriptsize}`; `grid=both` for a dense
read, `grid=major` when the curve is the subject, `enlargelimits=0.05` to keep a curve
off the frame.

**Series and legends.** `\addplot[mark=*, thick] coordinates {...}` for measured points,
`\addplot[thick, domain=0:10, samples=60] {f(x)}` for a function. Give **every**
`\addplot` its own `domain`/`samples` or it silently inherits the previous plot's shape.
`mark size=1.3pt` stops a marker series dominating a line series; `\addlegendentry`
follows the plot it names; a filled legend
(`legend style={font=\scriptsize, fill=white, draw=black!25}`) keeps grid lines off it.

**fillbetween** (loaded): two `draw=none` outlines with a `name path`, then
`\addplot[blue!18] fill between[of=hi and lo];`. Add `forget plot` to the outlines or
they consume legend slots and cycle colors.

**Small multiples and log axes.** `\usepgfplotslibrary{groupplots}` (hoisted, ships
with pgfplots), then `tikzpicture` > `groupplot` > `\nextgroupplot` per panel with one
shared `width`/`height`; `width x panels` is the width budget (verified 355pt for two
6.4cm panels). For log axes set `ymode=log`, or use the `semilogyaxis` environment in the
same way; a log axis cannot place a zero or negative sample, so keep the expression
strictly positive.

```tex
\usepgfplotslibrary{groupplots}
\begin{tikzpicture}
  \begin{groupplot}[group style={group size=2 by 1, horizontal sep=1.6cm},
      width=6.4cm, height=4.6cm, grid=both,
      tick label style={font=\scriptsize}, label style={font=\small}, title style={font=\small\bfseries}]
    \nextgroupplot[title={power law}, xlabel={$t$}, ylabel={value}]
    \addplot[thick, blue, domain=0:5, samples=40] {x^1.6};
    \nextgroupplot[title={log axis}, xlabel={$t$}, ymode=log]
    \addplot[thick, red, domain=0:5, samples=40] {exp(x)};
  \end{groupplot}
\end{tikzpicture}
```

## 8. Shapes and annotations

- **`shapes.geometric`**: `cylinder` (`aspect=0.35`) for stores, `diamond`
  (`aspect=1.8`) for a decision wide enough for text, `trapezium` with
  `trapezium left angle=70, trapezium right angle=110` for an aggregation step. All
  need `minimum height`/`minimum width` or they collapse onto their text.
- **`shapes.callouts`**: `rectangle callout` with
  `callout relative pointer={(0.3,-0.6)}` for a bubble pointing at a node; the pointer
  does not dodge other nodes, so aim it at empty space.
- **Braces** (`decorations.pathreplacing`): `\draw[decorate, decoration={brace,
  mirror, amplitude=4pt}] (a.south west) -- (b.south east)` with
  `node[midway, below=4pt, font=\scriptsize]` for the label; `mirror` flips the side.
  Keep `amplitude` near 4pt or the brace collides with its label.
- **`patterns`**: `pattern=north east lines, pattern color=green!55!black` over a
  `fill=` marks a degraded state without a new hue; keep the pattern color dark
  against the fill or the hatch vanishes.
- **`shadows.blur`**: `blur shadow={shadow blur steps=5, shadow xshift=1pt, shadow
  yshift=-1pt}` in a shared style; it costs compile time per node, so drop it above
  ~30 nodes.
- **`angles` + `quotes`**: `\pic[draw, ->, "$\theta$", angle radius=9mm, angle
  eccentricity=1.3] {angle = B--A--C};` draws the arc and places the label; the
  **middle** name is the vertex. A third annotation system belongs in its own figure.

```tex
\usetikzlibrary{shapes.geometric,shapes.callouts,shadows.blur,patterns,arrows.meta,positioning}
\tikzset{sh/.style={draw, blur shadow={shadow blur steps=5, shadow xshift=1pt, shadow yshift=-1pt}, font=\footnotesize, align=center}}
\begin{tikzpicture}[node distance=16mm and 14mm]
  \node[sh, cylinder, shape border rotate=90, aspect=0.35, minimum height=14mm, minimum width=13mm, fill=orange!14] (db) {DB};
  \node[sh, diamond, aspect=1.8, fill=yellow!22, right=of db] (chk) {ok?};
  \node[sh, trapezium, trapezium left angle=70, trapezium right angle=110, fill=blue!12, right=of chk] (svc) {Service};
  \node[sh, rectangle callout, callout relative pointer={(0.3,-0.6)}, fill=green!14, pattern=north east lines, pattern color=green!55!black, below=of chk] (note) {retry 3x};
  \draw[-{Latex[length=2mm]}] (db) -- (chk);
  \draw[-{Latex[length=2mm]}] (chk) -- (svc);
\end{tikzpicture}
```

## 9. Debugging the compiler

`status: "error"` carries `diagnostics`: the engine's own located lines,
`diagram.tex:LINE: ...`, counting from the wrapper's preamble (a bare body's first
command is 12, and 11 with `\begin{tikzpicture}` written). Do not subtract offsets; read
the quoted construct and find it by name.

**Triage order.** The first diagnostic is the cause and the rest is fallout. A missing
`}` or `;` produces a page of secondary errors: verified, one forgotten `;` gives
exactly one diagnostic, `Giving up on this path. Did you forget a semicolon?`, pointed
at the **next** path's line, while an unclosed `{` gives `File ended while scanning use
of \tikz@fig@scan@options.` plus `Emergency stop.`. Fix the smallest thing that removes
the first error and recompile (~1-2s, content-cached). `extractDiagnostics` keeps only
the located **first line** of a multi-line message, so
`I do not know the key '/tikz/spy scope',` is all you get even though the log continues
`to which you passed 'length=1cm', and I am going to ignore it.` Fix by name, never by
quoting the message back.

| Failure | Meaning | Action |
|---|---|---|
| `I do not know the key '/tikz/X'` | the option or shape name does not exist: usually an unloaded library (`spy scope` needs `\usetikzlibrary{spy}`) or a typo | add the library line at the top, one line, contiguous |
| `Unknown shape 'X'. Using 'rectangle' instead.` | `shape=X` is misspelled or from an unloaded `shapes.*` library | fix the name; geometric, misc and callouts are covered |
| `No shape named X is known.` | an edge references a node never declared or never named | declare and name it before the `\draw` |
| `Undefined control sequence.` | a macro not defined there: a `\newcommand` below a blank line so it never reached the preamble, an unloaded library command, or a typo | hoist a one-line definition |
| `Missing $ inserted.` | `_`, `^` or a math-only command outside math mode | wrap the label in `$...$` |
| `Giving up on this path. Did you forget a semicolon?` | a path with no `;` (the error points at the next path) | terminate the path |
| `File ended while scanning use of \tikz@fig@scan@options.` + `Emergency stop.` | unclosed `{` or `[` | balance the braces |
| `Paragraph ended before ... was complete.` / `Missing \endcsname inserted.` | the preamble itself broke, typically a multi-line hoisted `\tikzset` | one line per hoisted command |
| `File 'X.sty' not found.` + `Emergency stop.` | `\usepackage` of something not installed; auto-install is off so it fails in ~300ms | use the wrapper's libraries, or name the package for the user |
| `Dimension too large.` | a coordinate or `minimum size` far outside the page | bring the numbers back to millimeters |
| `Package graphics Error: Division by 0.` / `\begin{document} ended by \end{tikzpicture}` | a box (`\resizebox`) replaced the standalone preview target | drop the box; use `scale=` |
| `No room for a new \dimen` | the engine ran out of internal registers: thousands of boxes, typically a huge `\foreach` | split the picture; never generate hundreds of nodes |

**A failed compile can still have produced a PDF.** Verified: a `Dimension too large.`
picture still emitted a PDF (16322pt wide, past the lint) with non-empty `diagnostics`,
so `status` is `"error"` and the artifact exists - the panel shows a partial PDF flagged
as errored. Read it as evidence of what LaTeX understood, never as proof.

- **A picture inside a float or paragraph cannot be drawn by `standalone`.** Verified:
  `\begin{figure}...\end{figure}` around the picture compiles with **zero diagnostics**
  into **3 pages of 612x792pt**, so `status` is `"ok"` while page 1 - the only page the
  panel shows - has no picture; text around a bare-body picture does the same.
- **Never carry your own `\documentclass`**: such a document is passed through verbatim
  and none of the wrapper's preamble or hoisting applies. Verified:
  `\documentclass{article}` + `\begin{document}` + a tikzpicture compiles clean into a
  **612x792pt** page with the picture in a corner. If you must write a full document,
  keep `\documentclass[tikz,border=4pt]{standalone}` and supply the preamble yourself.
- **Shell escape is off**: `\write18{echo hello}` compiles clean and does nothing
  (verified), so any value routed through it is silently absent. Two `tikzpicture`
  environments = **2 pages** (verified), so one picture per write.

## 10. Iteration protocol

1. **Skeleton first**: named nodes, 2-4 edges, no styling; one `diagram_write` proves
   the topology and the names.
2. **Read `status`, then `diagnostics[0]`**, and fix that one thing.
3. **Iterate with `diagram_patch { id, oldString, newString }`**, never by re-emitting a
   long picture; choose an `oldString` unique to the region (node name, label text) or
   pass `replaceAll: true` knowingly.
4. **Dress in one pass per concern**: styles, then colors, then labels and legend; then
   **size last** (`scale=`, `transform shape`, `node distance`, `minimum size`), because
   every content change moves the box.
5. **`diagram_verify { id }`** recompiles the stored document through the artifact cache
   without writing: use it after a person edited the diagram in its panel, after your
   context was compacted, or before describing the picture. Do **not** re-write to
   re-check - a write bumps the revision and discards the browser's render report.
6. **`diagram_read { id }`** when you need the source back; `diagram_patch` needs an
   exact `oldString`, so read before patching a picture you did not just write.
7. **Finish only on a full verdict.** With no TeX engine the tool reports
   `status: "unavailable"`, nothing is drawn and there is no point iterating on the
   look: say so plainly and hand over the source, which still exports as `.tex`.

**Compiled is not drawn.** `status: "ok"` says the engine produced a PDF; the screen is
the browser's verdict, `verification.state`: `drawn` (a browser rendered this exact
revision), `pending` (no client has reported yet - normal with no tab open), `stale`
(the source changed after the browser drew it), `failed` (the browser could not draw it
- a conversion problem, not a TeX one). For TikZ the panel draws the host's compiled
SVG, so `status: "ok"` **plus** `verification.state: "drawn"` is the only full
confirmation; `pending` is not a failure, and `diagram_verify` re-checks it without
writing.

## 11. Worked examples

Each block is a complete `diagram_write { kind: "tikz", source: ... }` payload, compiled clean here (1 page, 0 diagnostics).

### (a) Layered architecture: fit bands, background layer, orthogonal edges, legend

159 x 196pt. `fit` bands on the background layer, orthogonal routes, a dashed return, and a legend of nested `\tikz` strokes repeating the real arrow styles.

```tex
\usetikzlibrary{arrows.meta,positioning,fit,backgrounds,calc}
\definecolor{ink}{HTML}{1F2933}
\tikzset{box/.style={draw=ink!40, text=ink, fill=white, rounded corners=2pt, minimum height=8mm, minimum width=21mm, align=center, font=\footnotesize}, band/.style={draw=#1!55!ink, dashed, rounded corners=3pt, inner sep=7pt, fill=#1!10}, flow/.style={-{Latex[length=2mm]}, thick, draw=ink!70}}
\begin{tikzpicture}[node distance=10mm and 6mm]
  \node[box] (ui) {Client};
  \node[box, right=of ui] (cli) {CLI};
  \node[box, below=of ui] (gw) {Gateway};
  \node[box, right=of gw] (auth) {Auth};
  \node[box, below=of gw] (sess) {Sessions};
  \node[box, right=of sess] (diag) {Diagrams};
  \begin{scope}[on background layer]
    \node[band=blue, fit=(ui)(cli), label={[font=\scriptsize\bfseries,text=ink]above:Layer 1: Edge}] {};
    \node[band=orange, fit=(gw)(auth), label={[font=\scriptsize\bfseries,text=ink,yshift=1pt]above:Layer 2: Service}] {};
    \node[band=green, fit=(sess)(diag), label={[font=\scriptsize\bfseries,text=ink,yshift=1pt]above:Layer 3: Core}] {};
  \end{scope}
  \draw[flow] (ui) -- node[right, font=\scriptsize, text=ink]{call} (gw);
  \draw[flow] (cli.south) |- (auth.east);
  \draw[flow] (gw) -- (sess);
  \draw[flow] (auth.south) |- (diag.east);
  \draw[flow, dashed] (sess.east) to[out=0, in=0, looseness=1.7] (gw.east);
  \node[draw=ink!40, rounded corners=2pt, inner sep=5pt, align=left, font=\scriptsize, text=ink, fill=white, anchor=north east] at ([yshift=-6mm]sess.south east)
    {\tikz[baseline=-0.5ex]{\draw[flow] (0,0)--(5mm,0);}~call\\[1pt]
     \tikz[baseline=-0.5ex]{\draw[flow,dashed] (0,0)--(5mm,0);}~event};
\end{tikzpicture}
```

### (b) State machine with `automata`

305 x 182pt. `automata` supplies `state`, `initial` and `accepting`; the return edges use `bend left` and `out`/`in`.

```tex
\usetikzlibrary{automata,positioning,arrows.meta}
\tikzset{st/.style={state, fill=blue!8, draw=blue!55!black, font=\footnotesize, minimum size=9mm}, trans/.style={-{Latex[length=2mm]}, thick, draw=black!70}}
\begin{tikzpicture}[node distance=20mm and 24mm]
  \node[st, initial, initial text={}] (idle) {idle};
  \node[st, right=of idle] (run) {run};
  \node[st, right=of run, accepting] (done) {done};
  \node[st, below=of run] (fail) {fail};
  \draw[trans] (idle) -- node[above, font=\scriptsize]{start} (run);
  \draw[trans] (run) -- node[above, font=\scriptsize]{ok} (done);
  \draw[trans] (run) -- node[right, font=\scriptsize]{error} (fail);
  \draw[trans] (fail) to[bend left=30] node[below left, font=\scriptsize]{retry} (idle);
  \draw[trans] (done) to[out=200, in=140, looseness=1.5] node[below, font=\scriptsize]{again} (idle);
\end{tikzpicture}
```

### (c) Three-series chart with legend and grid

277 x 161pt. One `axis`, three series with different dress, a filled legend in the south east corner.

```tex
\usetikzlibrary{arrows.meta}
\begin{tikzpicture}
\begin{axis}[width=10cm, height=6cm, xlabel={time (s)}, ylabel={throughput (k req/s)},
    grid=both, minor tick num=1, legend pos=south east, legend cell align=left,
    legend style={font=\scriptsize, fill=white, draw=black!25},
    tick label style={font=\scriptsize}, label style={font=\small},
    every axis plot/.append style={thick}]
  \addplot[blue, domain=0:10, samples=60] {10*(1-exp(-x/3))};
  \addlegendentry{warm}
  \addplot[red, mark=*, mark size=1.3pt, domain=0:10, samples=11] {8*(1-exp(-x/4))};
  \addlegendentry{cached}
  \addplot[green!45!black, mark=square*, mark size=1.3pt, domain=0:10, samples=11] {6+0.4*x};
  \addlegendentry{linear}
\end{axis}
\end{tikzpicture}
```

### (d) Dense grid as a timeline (`matrix`)

216 x 148pt for 20 cells. One cell per bucket, a per-column `alert` style for the incident window, a `fit` frame on the background layer, a `brace` under the grid.

```tex
\usetikzlibrary{matrix,positioning,arrows.meta,fit,backgrounds,decorations.pathreplacing}
\definecolor{ink}{HTML}{1F2933}
\tikzset{cell/.style={draw=ink!30, minimum width=13mm, minimum height=7.5mm, font=\scriptsize, align=center, text=ink, fill=white}, hdr/.style={font=\scriptsize\bfseries, text=ink, minimum width=13mm, minimum height=7.5mm, align=center}, up/.style={fill=green!18}, down/.style={fill=red!12}, alert/.style={fill=red!22}}
\begin{tikzpicture}
  \matrix (g) [matrix of nodes, nodes={cell}, row sep=1.2pt, column sep=1.2pt,
               row 1/.style={nodes={hdr}}, column 1/.style={nodes={hdr}},
               column 3/.style={nodes={alert}}] {
    {} & 09:00 & 10:00 & 11:00 & 12:00 \\
    api & |[up]| up & |[up]| up & |[down]| down & |[up]| up \\
    db & |[up]| up & |[down]| down & |[down]| down & |[up]| up \\
    cache & |[down]| down & |[up]| up & |[up]| up & |[up]| up \\
  };
  \begin{scope}[on background layer]
    \node[fit=(g), draw=ink!25, rounded corners=3pt, inner sep=5pt, fill=ink!3] {};
  \end{scope}
  \node[font=\scriptsize\bfseries, text=ink, anchor=south west] at ([yshift=3mm]g.north west) {service availability};
  \draw[decorate, decoration={brace, mirror, amplitude=4pt}] ([yshift=2pt]g.south west) -- ([yshift=2pt]g.south east)
        node[midway, below=4pt, font=\scriptsize, text=ink] {5-minute buckets};
\end{tikzpicture}
```

### (e) Annotated brace and angle figure

159 x 109pt. `angles`+`quotes` for the arc, `decorations.pathreplacing` for the braces, `sloped` for the tilted label.

```tex
\usetikzlibrary{angles,quotes,decorations.pathreplacing,arrows.meta,calc}
\begin{tikzpicture}[font=\small, >={Latex[length=2mm]}]
  \coordinate (A) at (0,0);
  \coordinate (B) at (4.4,0);
  \coordinate (C) at (2.4,2.6);
  \draw[thick, draw=black!75] (A) -- (B) -- (C) -- cycle;
  \pic[draw, ->, "$\theta$", angle radius=9mm, angle eccentricity=1.3, font=\small] {angle = B--A--C};
  \draw[decorate, decoration={brace, mirror, amplitude=4pt}] (A) -- (B)
        node[midway, below=4pt, font=\scriptsize] {base $=4.4$};
  \draw[decorate, decoration={brace, amplitude=4pt}] (B) -- (C)
        node[midway, sloped, above=3pt, font=\scriptsize] {edge};
  \fill (A) circle (0.6pt) (B) circle (0.6pt) (C) circle (0.6pt);
  \node[below left, font=\scriptsize] at (A) {$A$};
  \node[below right, font=\scriptsize] at (B) {$B$};
  \node[above, font=\scriptsize] at (C) {$C$};
\end{tikzpicture}
```

## 12. Checklist before finishing a complex picture

- [ ] `status: "ok"`, `diagnostics` empty, `verification.state: "drawn"`.
- [ ] 1 page (the lint reports the count; a 2-page artifact hides half the picture).
- [ ] Width under ~600pt for a panel and well under the 2000pt lint; height under ~900pt.
- [ ] No float, no surrounding prose, no own `\documentclass`, no `\resizebox`.
- [ ] Every text-bearing node has an explicit `fill=` **and** `text=`.
- [ ] Hoisted lines contiguous, single-line, at the very top; no multi-line `\tikzset{`.
- [ ] Styles named and referenced; no repeated raw option lists; one arrow style and one label font.
- [ ] A legend if color or dash style carries meaning, using the picture's own styles.
- [ ] Every `\addplot` has its own `domain`/`samples`; every legend entry follows its plot.
- [ ] Nothing routed through `\write18`; nothing `\includegraphics`-ed from a file.
- [ ] Read the picture once as the user will: names, not code; nodes, not lines.
