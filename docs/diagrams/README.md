# Exported diagrams

Two figures on the JEPA model, committed here so the versions live in git rather
than only inside this machine's diagram library. Both are **verbatim exports**:
the text of each file is exactly the source the tool stores, byte for byte.

| File | Kind | Library id | Revision |
|---|---|---|---|
| `jepa-model.mmd` | Mermaid flowchart | `jepa-model` | 4 |
| `jepa-model-tikz.tex` | TikZ | `jepa-model-tikz` | 2 |

Both validate clean: `status: ok`, no lint findings, and the TikZ source compiles
with `pdflatex` to a single page.

## Where the live copies are

The `dsh-diagrams` plugin keeps one library for the whole harness at:

```
$DSH_HOME/dsh-diagrams/library.json        # default: ~/.dsh/dsh-diagrams/library.json
```

That file - not this folder - is what the tab renders and what the tools edit. A
figure edited in its panel changes the library and leaves these exports stale,
which is what the drift check below is for.

## Re-publishing an export back into the library

The library address names no conversation, so an id resolves from any chat:

```
diagram_write { kind: "mermaid", id: "jepa-model", scope: "library",
                source: <contents of jepa-model.mmd> }
diagram_write { kind: "tikz", id: "jepa-model-tikz", scope: "library",
                source: <contents of jepa-model-tikz.tex> }
```

Passing the existing `id` replaces that diagram in place; omitting it would file a
second copy under a new name. Every write is re-validated before it is stored, so
a source that no longer compiles comes straight back with the offending line.

## Re-exporting after an edit

`library.json` is the source of truth: edit in the panel, then copy the new
`source` field over the matching file here. `scripts/checks/check-diagram-exports.mjs`
compares the two and reports `DRIFT` (exit 1) when a file no longer matches the
stored source; it skips silently on a machine with no library.

```sh
node scripts/checks/check-diagram-exports.mjs
```

## Compiling the TikZ figure on its own

`jepa-model-tikz.tex` is a bare TikZ body, which is the shape the tool accepts -
it supplies the preamble. To build it with `pdflatex` outside the tool, wrap it in
the same document the plugin uses:

```tex
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
\begin{document}
\input{jepa-model-tikz.tex}
\end{document}
```

```sh
pdflatex -interaction=nonstopmode -no-shell-escape -file-line-error doc.tex
```

Write that wrapper in a scratch directory - `\input` needs the `.tex` file beside
it - and expect a one-page PDF whose box is exactly the picture plus the 4pt
border. Keep the leading `\usetikzlibrary`/`\definecolor`/`\tikzset` lines at the
top of the body and contiguous: the plugin hoists them into the preamble and stops
at the first line it does not recognise. A multi-line hoisted block, or a blank
line in the middle of one, breaks the document rather than the picture.
