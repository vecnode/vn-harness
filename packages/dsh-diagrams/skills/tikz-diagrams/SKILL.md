---
name: tikz-diagrams
description: "Author TikZ/LaTeX diagrams that compile: use the host's prepared preamble, the right libraries, layout and plot recipes, and read the compiler's line-accurate errors to converge in a couple of writes. A bundled reference covers complex, large pictures."
whenToUse: "Whenever a conversation needs a precise, publication-quality diagram as LaTeX - node-and-edge architecture, layered systems, precise flow charts, state machines, trees, plots, annotated geometry - or when a TikZ diagram already written fails to compile. Read the bundled reference first for anything over ~20 lines."
---

# TikZ diagrams

You are writing LaTeX/TikZ for the **`diagram_write`** tool of this harness. The
host compiles every write with the machine's own TeX engine and returns the
compiler's diagnostics, so the loop is:

```
diagram_write { kind: "tikz", title: "Layered architecture", source: "..." }
  -> status "ok"          : compiled; the PDF/SVG is cached and rendering
  -> status "error"       : fix `diagram.tex:LINE: ...` and write again
  -> status "unavailable" : no TeX engine on this host (or the diagram was
                            stored but not compiled) - say so, and offer the .tex
```

Rules that matter:

- **Never finish on a non-`ok` status.** If TeX is unavailable, tell the user
  plainly and hand over the source, which still exports as `.tex`.
- TikZ pays off for **precision** (alignment, arrows, annotations, plots) and
  loses to Mermaid for rough, quickly-changing pictures. Choose accordingly.
- A diagram that fits one page at a readable size is the target. Prefer
  **≤ 40 nodes** and **≤ 200 lines**; split anything larger.
- Iterate with **`diagram_patch`** (literal replace) - never re-emit a long
  picture to move one arrow. `diagram_read` gives you the current source back.
- Compiles are cached by content: an unchanged diagram costs nothing, and a
  change costs ~1-2 s. `{ recompile: true }` on the panel side forces a rebuild.

## Complex pictures

This file is the quick-start. For a picture that needs real layout work -
layered bands, matrices, dense edge routing, pgfplots charts, braces and
annotations, and the meaning of every compiler error this preamble can produce -
read `reference/complex-diagrams.md`, which sits beside this file in the same
skill folder. Every example in it was compiled by the host's own engine, and it
is the file to open before writing anything over ~20 lines.

## The verdicts, and the two the compiler cannot give you

| Signal | Question it answers | What to do |
|---|---|---|
| `status: "ok"` | did the engine compile this? | nothing - but keep reading |
| `status: "error"` | no, and here is the line | fix `diagnostics`, write again |
| `status: "unavailable"` | there is no TeX engine here | say so; the source still exports |
| warnings | it compiled, but is it the picture you meant? | review each one |
| `verification.state` | did the compiled artifact actually load in a browser? | see below |

For TikZ the browser's job is smaller - the host compiled the picture, the client
fetches the artifact - but the four states are the same, and they carry the
revision they are about (`revision` = the current one, `reported` = the revision
the newest report names):

| `verification.state` | What the browser reported | What to do |
|---|---|---|
| `drawn` | it loaded this revision's artifact | the picture exists; you may describe it |
| `failed` | the artifact could not be loaded, with the reason | the compile produced something the client cannot show; check the diagnostics |
| `stale` | the newest report is about an OLDER revision | this revision has never been shown; that older report is not evidence about it |
| `pending` | nothing at all | not a failure: no client has shown it yet, which is normal headless |

A compile that FAILED but still produced a PDF is cached on purpose and shown
flagged as errored, because the partial picture is evidence of what LaTeX did
understand - so `status: "error"` and a visible artifact are not a contradiction.

Two failures the compiler will never report, and the host now catches:

- **A source with no picture in it.** A document with no `tikzpicture`/`axis`
  and no `\node`/`\draw`/`\path` compiles to a blank page and reports success.
  The host refuses it as `status: "error"` with *"There is no picture in this
  source"*, because an empty panel is a failure a person sees and pdflatex
  does not.
- **A picture on more than one page.** A stray page break or an overflowing
  figure yields a 2-page PDF; the panel shows the first page, so the second is
  invisible to the user. The host warns with the page count.

Other warnings to expect: a canvas over 2000pt (the panel scales it down until
labels are unreadable - shrink with `scale=`, `node distance=` or a smaller
font), an engine font substitution, and a document past 250 non-empty lines.

## Verifying without changing anything

**`diagram_verify { id }`** recompiles the stored document (through the
artifact cache, so an unchanged document costs nothing and reports
`served from the artifact cache`), returns the diagnostics, the warnings and
the browser line, and writes nothing - the revision does not move. Use it when
a person edited the diagram in its panel, when your context was compacted, or
before you describe a diagram's contents to the user. Do **not** re-write a
diagram just to re-check it: a write bumps the revision and discards the
browser's render report.

## What the host already does for you

Your source may be any of these three shapes:

1. a **bare body** of TikZ commands (`\node ...; \draw ...;`) - it is wrapped in
   `\begin{tikzpicture} ... \end{tikzpicture}`;
2. one or more **picture environments** (`\begin{tikzpicture}`, `\begin{axis}`,
   ...) - wrapped in the document, left as-is;
3. a **complete document** (`\documentclass` present) - used verbatim.

Leading `\usepackage`, `\usetikzlibrary`, `\usepgfplotslibrary`, `\pgfplotsset`,
`\tikzset`, `\definecolor`, `\pgfkeys`, `\newcommand` and `\DeclareMathOperator`
lines are **hoisted into the preamble**, so write them the way you normally
would: at the top, before the picture.

The supplied preamble is, in full (shown for reference - it is not a diagram, so
the example checker skips it):

```latex no-check
\documentclass[tikz,border=4pt]{standalone}
\usepackage[T1]{fontenc}
\usepackage{lmodern}
\usepackage{amsmath,amssymb}
\usepackage{tikz}
\usetikzlibrary{arrows.meta,positioning,shapes.geometric,shapes.misc,shapes.callouts,
  calc,fit,backgrounds,matrix,chains,automata,graphs,trees,
  decorations.pathreplacing,decorations.markings,patterns,shadows.blur,quotes,angles,intersections}
\usepackage{pgfplots}
\pgfplotsset{compat=1.18}
\usepgfplotslibrary{fillbetween}
```

`standalone` plus `border=4pt` means **the PDF is exactly the picture**, so there
is no page-layout step: size the picture itself, and expect the app to scale it
to the panel.

## Core syntax you will use constantly

```latex
\begin{tikzpicture}[
  font=\small,
  node distance=14mm,
  box/.style={draw, rounded corners=2pt, minimum height=9mm, minimum width=24mm, align=center, fill=blue!6},
  arrow/.style={-{Latex[length=2mm]}, thick},
]
  \node[box] (a) {Client};
  \node[box, right=of a] (b) {API};
  \node[box, right=of b, fill=green!8] (c) {Store};
  \draw[arrow] (a) -- node[above, font=\scriptsize]{HTTPS} (b);
  \draw[arrow] (b) -- (c);
  \draw[arrow, dashed] (b.south) to[out=-90, in=-90, looseness=1.2] node[below, font=\scriptsize]{async} (c.south);
\end{tikzpicture}
```

- **Positioning**: `right=of a`, `below left=6mm and 4mm of a`, `above=of a`.
  Requires `positioning` (included). Anchors: `a.north east`, `a.30`, `a.south west`.
- **Edges**: `--` straight, `|-`/`-|` orthogonal, `to[out=…, in=…]` curved,
  `edge[bend left=20]`, `.. controls ..`, `circle`/`ellipse` through `to` paths.
- **Arrow tips** come from `arrows.meta`: `-{Latex}`, `-{Stealth[length=2mm]}`,
  `<->`, `-{Latex[length=2mm,width=1.6mm]}`. A bare `->` also works but is fatter.
- **Styles** are the maintainable unit: put `box`, `arrow`, `lbl` in the options
  list and reference them by name. Change one line, change every node.
- **Coordinates**: `(0,0)`, `(2,1.5)`, `($ (a)!0.5!(b) $)` (calc),
  `($(a)+(0,-1)$)`, `(a |- b)` (intersection of the two axes), polar `(30:2)`.
- **Loops**: `\foreach \x in {1,2,3} { \node at (\x,0) {\x}; }` — fine in dozens,
  wasteful in thousands.

## Layout recipes

**Layered architecture** — one row per layer, `fit`/`backgrounds` for the bands:

```latex
\begin{tikzpicture}[font=\small, layer/.style={draw, dashed, rounded corners, inner sep=6pt},
                    box/.style={draw, rounded corners=2pt, fill=blue!6, minimum height=8mm, minimum width=20mm, align=center}]
  \matrix (m) [matrix of nodes, row sep=12mm, column sep=8mm,
               nodes={box}] {
    Client & CLI & IDE \\
    |[fill=orange!10]| Gateway & |[fill=orange!10]| Auth \\
    |[fill=green!10]| Sessions & |[fill=green!10]| Diagrams \\
  };
  \begin{scope}[on background layer]
    \node[layer, fit=(m-1-1)(m-1-3), label={[font=\scriptsize]left:UI}] {};
    \node[layer, fit=(m-3-1)(m-3-2), label={[font=\scriptsize]left:Core}] {};
  \end{scope}
  \draw[-{Latex[length=2mm]}] (m-1-1) -- (m-2-1);
  \draw[-{Latex[length=2mm]}] (m-2-1) -- (m-3-1);
\end{tikzpicture}
```

**Flow with decisions** — `shapes.geometric` diamonds, explicit branches:

```latex
\node[draw, diamond, aspect=2, align=center] (c) {cache\\hit?};
\node[draw, rounded corners=2pt] (miss) [left=18mm of c] {origin};
\node[draw, rounded corners=2pt] (hit) [right=18mm of c] {cache};
\draw[-{Latex}] (c.west) -- node[above,font=\scriptsize]{no} (miss);
\draw[-{Latex}] (c.east) -- node[above,font=\scriptsize]{yes} (hit);
```

**State machine** — `automata` (included): `state`, `initial`, `accepting`,
`edge[bend left]`, `double`.

**Trees** — `trees` (included):

```latex
\node {root}
  child { node {left} }
  child { node {right} child { node {leaf} } };
```

**Sequence-like diagram** — `matrix` for lanes plus `decorations.markings` or
plain `\draw` for the arrows; do not try to reproduce Mermaid's sequence
renderer.

**Plots** — `pgfplots` with `compat=1.18`:

```latex
\begin{axis}[width=9cm, height=5.5cm, xlabel={$t$}, ylabel={value},
             grid=both, legend pos=north east, legend cell align=left]
  \addplot[domain=0:10, samples=80, thick, blue] {exp(-x/3)};
  \addlegendentry{decay}
  \addplot+[mark=*, only marks, red] coordinates {(1,0.7) (4,0.3) (7,0.1)};
  \addlegendentry{measured}
\end{axis}
```

`\usepgfplotslibrary{fillbetween}` is loaded, so `\addplot fill between[...]` is
available. Every `\addplot` inside one `axis` must have the same `domain`/`samples`
shape or a `\closedcycle`-style mismatch appears.

## Text, math and labels

- Math works: `\node {$O(n\log n)$};` — but a bare `_` or `^` outside `$...$` is
  a hard error, and `%` must be escaped as `\%`.
- Multi-line labels need `align=center` (or `text width=…`) and `\\`.
- Sizes: `font=\scriptsize`/`\small`/`\footnotesize` on a node, or globally in
  the `tikzpicture` options.
- Special characters in `\node {…}`: `\&`, `\%`, `\$`, `\#`, `\_`, `\{`, `\}`.

## Sizing and export

- The PDF **is** the picture (`standalone`), so control the size in the picture:
  `scale=0.9` (also `transform shape` when you want nodes to scale),
  `node distance`, `minimum width/height`, `x=…,y=…` unit vectors.
- Prefer a **landscape-ish aspect** for the panel; a very tall picture is
  scrollable but awkward.
- Export formats: `tex` (the source), `pdf` (vector, print-ready), `svg`
  (vector, what the panel draws), `png` (200 dpi raster). All are written into
  the conversation folder on request.

## Hard limits of this host — do not fight them

| Not available | Why | Do this instead |
|---|---|---|
| `\write18`, `\directlua` shell calls | the engine runs with `-no-shell-escape` | compute the number in your head or in prose |
| `external` / `svg` / `externalization` libraries | they shell out to convert | compile normally; the host converts |
| `minted`, `\lstinputlisting` | they shell out | `listings` in a pinch, or plain `\texttt` |
| `\includegraphics{...}` of a local file | no file access from the document | draw the shape, or embed a `tikzpicture` |
| `pstricks`, `asymptote`, `metapost` | not TikZ and not on the engine path | TikZ/pgfplots only |
| Packages that are not installed | the engine runs with auto-install DISABLED, so it fails in ~300 ms instead of reaching the network | use the libraries listed above, or ask the user to install the package |

The engine used is the first of `pdflatex`, `xelatex`, `lualatex` present on the
host (normally `pdflatex`). PDF-specific advice above assumes `pdflatex`.

## Reading a compile error

`diagnostics` returns the compiler's own lines, with the line number in **your
normalized document** (`diagram.tex:LINE: ...`), so subtract the preamble offset
when the source was wrapped - or, more usefully, read the quoted text, which
names the construct:

```
diagram.tex:12: Package pgf Error: No shape named `missingnode' is known.
diagram.tex:18: Undefined control sequence.
diagram.tex:9: Package pgfkeys Error: I do not know the key '/tikz/on grid'
diagram.tex:6: LaTeX Error: File `notapackage.sty' not found.
```

| Error | Cause | Fix |
|---|---|---|
| `No shape named X is known` | an edge to a node that was never declared, or a typo | declare the node (or fix the name) before the `\draw` |
| `I do not know the key '/tikz/...'` | the option needs a library (e.g. `on grid`, `node distance` without `positioning`) or it is misspelled | add the library or drop the option |
| `Undefined control sequence` | a macro from a library/package that is not loaded, or a typo in a command | load that library in a leading `\usetikzlibrary` line, or fix the spelling |
| `Missing $ inserted` | `_`, `^` or a math command outside math mode | wrap in `$...$` |
| `File 'X.sty' not found` | the package is not installed and auto-install is off | use a library from the list above, or tell the user which package to install |
| `Runaway argument` / `Paragraph ended before ...` | an unbalanced brace or a missing `;` after a `\node`/`\draw` | balance the braces, terminate the path |
| `Dimension too large` | coordinates or `minimum size` far outside the page | reduce the numbers; the picture is scaled to fit anyway |
| `! Package pgfplots Error` on an axis | a plot with mixed `domain`/`samples`, or `compat` mismatch | give every `\addplot` its own explicit `domain`/`samples` |

A failing compile still often produces a PDF, which the host caches and the
panel shows **flagged as errored**: use it as a hint about what LaTeX did
understand, never as proof the diagram is right.
