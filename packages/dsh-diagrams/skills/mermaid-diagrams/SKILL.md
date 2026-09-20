---
name: mermaid-diagrams
description: "Author Mermaid diagrams that parse the first time: choose the right diagram type for the question, write syntax the parser accepts, and keep the picture readable in a narrow panel. A bundled reference covers complex, large diagrams."
whenToUse: "Whenever a conversation needs a diagram expressed as Mermaid text - flow, sequence, state, ER, class, timeline, gantt, mindmap, quadrant - or when a Mermaid diagram already written fails to parse. Read the bundled reference first when the picture is large or layered."
---

# Mermaid diagrams

You are writing Mermaid for the **`diagram_write`** tool of this harness. Every
write is parsed on the host before it is stored, and the parse verdict comes
back to you with the offending line. Treat that as the loop:

```
diagram_write { kind: "mermaid", title: "Auth flow", source: "..." }
  -> status "ok"      : it parses; it is already rendering in the conversation
  -> status "error"   : fix the line named in `diagnostics` and write again
  -> status "unavailable" : the validator could not run; the diagram is stored,
                            but you have NOT verified it - say so to the user
```

Rules that matter:

- **Never finish on a non-`ok` status.** A diagram the user cannot see is a failed call.
- **One diagram per question.** Several small diagrams beat one 60-node picture.
- Iterate a long diagram with **`diagram_patch`** (literal replace) instead of
  re-emitting all of it; re-read with **`diagram_read`** if your context may have
  been compacted.
- The returned `address` (`dsh-resource://diagram/session/<session>/<id>`) is the
  tab that shows the picture; the id is a readable slug derived from the title.

## The four verdicts, and what each one actually means

A write comes back with a status, a list of advisory `warnings`, and a line
about what the **browser** did. They answer three different questions, and
mixing them up is how a broken picture ships:

| Signal | Question it answers | What to do with it |
|---|---|---|
| `status: "ok"` | does the engine parse this? | nothing - but keep reading |
| `status: "error"` | no, and here is the line | fix `diagnostics`, write again |
| warnings | it parses, but will it *read* well? | treat as review notes: fix the ones that are right, ignore the ones that are not, and say which you ignored |
| `verification.state` | did a real renderer actually draw it? | see below |

The four verification states are objective and carry the revision they are
about (`revision` = the current one, `reported` = the revision the newest report
names):

| `verification.state` | What the browser reported | What to do |
|---|---|---|
| `drawn` | it DREW this revision | the strongest evidence there is: the picture exists |
| `failed` | it could NOT draw this revision, and said why | the source parses but the renderer refused it: the user is looking at that error, so fix it |
| `stale` | the newest report is about an OLDER revision | this revision has never been drawn; that older report is not evidence about it |
| `pending` | nothing at all | **not** a failure: no client has drawn this revision, which is normal on a headless run |

The `Browser:` line in the tool result says the same thing in words, and repeats
the revision number so it can be checked rather than trusted. A `stale` verdict
is the one that is easiest to misread: a report about revision 3 says nothing
about revision 4.

## Complex diagrams

This file is the syntax summary and the semantics of the verdicts. When a
picture is too big for one glance - layered architectures, sequences with many
participants, composite state machines, theming that survives both app themes,
and the exact wording of every parse error and lint finding - read
`reference/complex-diagrams.md`, which sits beside this file in the same skill
folder. It carries the readability budgets, the layout recipes and full sources
that the host has actually parsed.

## Publishing a diagram you will want again

A diagram belongs to the conversation that drew it unless you say otherwise. When
it is worth citing later - a reference figure, a model diagram, an architecture
picture - put it in the shared **library** instead:

- `diagram_write { ..., scope: "library" }` writes it there directly, or
  `diagram_publish { id }` copies one you already have.
- Its address is `dsh-resource://diagram/library/<id>`: it names no conversation,
  so the id resolves in ANY chat, and `diagram_read { id: "jepa-model" }` finds
  the shared diagram from a conversation that never saw it written.
- A bare id resolves **library-first**, so the same citation means the same
  picture everywhere. Keep scratch work in the conversation (the default) and the
  library stays worth reading.

## Verifying without changing anything

**`diagram_verify { id }`** re-parses the stored source and reports the status,
the diagnostics, the warnings and the browser line - and writes nothing, so it
never bumps the revision. Reach for it when:

- a person edited the diagram in its panel since your last write;
- your context was compacted and you want the current truth before building on it;
- the last verdict is old and you are about to describe the diagram to the user.

Do **not** use `diagram_write` to re-check a diagram: it rewrites it under a new
revision, throws away the browser's render report, and costs a full re-render.

## Choosing the type

| The question is about | Use | First line |
|---|---|---|
| Steps, decisions, a pipeline, a decision tree | flowchart | `flowchart TD` |
| Messages between actors over time | sequence | `sequenceDiagram` |
| A lifecycle, a protocol, a mode machine | state | `stateDiagram-v2` |
| Tables and their relations | ER | `erDiagram` |
| Types, interfaces, inheritance | class | `classDiagram` |
| Work over calendar time | gantt | `gantt` |
| Events on a line, releases, history | timeline | `timeline` |
| A breakdown of one topic | mindmap | `mindmap` |
| Two-axis prioritisation (impact/effort) | quadrant | `quadrantChart` |
| A user journey with satisfaction | journey | `journey` |
| A proportion of a whole | pie | `pie` |

Prefer **flowchart** unless another type is clearly better: it is the most
capable and the least surprising.

## Working syntax (copy these shapes)

Flowchart — direction, shapes, labelled edges, subgraphs:

```
flowchart TD
    A[Client] -->|POST /login| B[/API/]
    B --> C{Credentials OK?}
    C -->|yes| D[(Session store)]
    C -->|no| E[401]
    D --> F[Redirect /home]
    subgraph Backend
        B
        D
    end
```

Node shapes: `[box]`, `(rounded)`, `([stadium])`, `[[subroutine]]`, `[(database)]`,
`((circle))`, `>asymmetric]`, `{diamond}`, `{{hexagon}}`, `[/parallelogram/]`,
`[\trapezoid\]`. Edges: `-->`, `---`, `-.->`, `==>`, `--text-->`, `-->|text|`,
`-- text -->`, `o--o`, `x--x`, `<-->`.

Sequence:

```
sequenceDiagram
    autonumber
    participant U as User
    participant S as Server
    U->>S: login(user, pass)
    activate S
    S-->>U: 200 + token
    deactivate S
    Note over U,S: token cached for 15 min
```

Arrows: `->>` (solid, arrowhead), `-->>` (dashed), `-x` (lost), `-)` (async).
Use `loop`, `alt`/`else`/`end`, `opt`, `par`, `critical`, `rect rgb(...)`, `box`.

State:

```
stateDiagram-v2
    [*] --> Idle
    Idle --> Running: start
    Running --> Idle: stop
    Running --> Failed: error
    Failed --> [*]
    state Running {
        [*] --> Fetching
        Fetching --> Parsing
    }
```

ER:

```
erDiagram
    USER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : contains
    USER {
        string id PK
        string email
    }
```

Cardinality: `||--||`, `||--o{`, `}o--o{`, `||--|{`. Attribute keys: `PK`, `FK`, `UK`.

Class:

```
classDiagram
    class Store {
        +get(key) Value
        +put(key, value)
        -cache Map
    }
    Store <|-- MemoryStore
    Store *-- Entry
```

Relations: `<|--` inheritance, `*--` composition, `o--` aggregation, `-->` association, `..>` dependency, `..|>` realization.

Gantt (dates are `YYYY-MM-DD`; tasks need an id when they have a status):

```
gantt
    title Release plan
    dateFormat YYYY-MM-DD
    axisFormat %b %d
    section Design
        Spec        :done,    spec, 2024-03-01, 5d
        Review      :active,  rev,  after spec, 3d
    section Build
        Implement   :         impl, after rev, 10d
        Milestone   :milestone, m1, after impl, 0d
```

Timeline / mindmap / quadrant / pie:

```
timeline
    title vn-harness
    2024 Q1 : first plugin
            : editor tab
    2024 Q3 : diagrams

mindmap
    root((Diagrams))
        Mermaid
            flowchart
            sequence
        TikZ
            nodes
            plots

quadrantChart
    title Impact vs effort
    x-axis Low effort --> High effort
    y-axis Low impact --> High impact
    quadrant-1 Do now
    quadrant-2 Plan
    quadrant-3 Drop
    quadrant-4 Delegate
    Caching: [0.2, 0.8]
    Rewrite: [0.9, 0.7]

pie showData
    title Where the time goes
    "Rendering" : 45
    "Compiling" : 35
    "Caching" : 20
```

## Syntax traps that actually break diagrams

1. **Labels with punctuation must be quoted.** Parentheses, brackets, braces,
   commas, colons, semicolons, `#`, `"` and `<` inside an unquoted label break
   the parser:
   `A["Retry (3x)"]` not `A[Retry (3x)]`.
2. **`#` is special** (entity codes). Write `#35;` for a literal `#`. The same
   applies to a lone `%`.
3. **Comments are `%%`** on their own line. A single `%` is not a comment.
4. **Node ids are not labels.** `A[Label]` — the id is `A`. An id containing
   spaces or dashes needs the `id["Label"]` form and consistent reuse.
5. **`end` and other keywords are reserved** as ids in several diagrams. Rename
   the node (`endNode`) instead of fighting it. Lowercase `end` still closes a
   subgraph.
6. **`subgraph` needs its own `end`**, and every opened block (`loop`, `alt`,
   `par`, `state X {`) needs one too. Unbalanced blocks are the most common
   error in long diagrams.
7. **A line break inside a label is `<br/>`**, not a newline:
   `A["line one<br/>line two"]`.
8. **Edge labels go between the dashes** (`A -->|yes| B` or `A -- yes --> B`),
   never inside the target's brackets.
9. **Semicolons separate statements** and are optional; a stray one inside an
   unquoted label ends the statement.
10. **Quotes inside quoted labels** must be entity-escaped or avoided.
11. **Don't mix type syntax.** A `sequenceDiagram` has no `-->`; a `flowchart`
    has no `participant`.
12. **Unicode and emoji are fine**; exotic symbols can trip older renderers -
    prefer words over glyphs in critical labels.

## Readability in a narrow panel

- Keep a flowchart at **≤ 20 nodes**, a sequence at **≤ 8 participants**, a
  class diagram at **≤ 8 classes**. Split the topic instead of shrinking the font.
- Pick the direction that matches the reading shape: `TD` for processes, `LR`
  for pipelines and comparisons, `BT` only when it reads naturally.
- Labels are **1–4 words**. Put detail in the message that accompanies the
  diagram, not inside the boxes.
- Group with `subgraph` when a picture has more than ~8 nodes; name groups by
  layer or ownership, not by colour.
- Styling is optional and easy to overdo. If you use `classDef`, prefer a
  **neutral palette** that survives both light and dark themes (the app renders
  in both): set `fill`, `stroke` and `color` explicitly, or leave the theme
  alone. `classDef` + `class A,B name` is far more maintainable than repeated
  `style A fill:#...` lines.
- Avoid `linkStyle` indices in a diagram you expect to edit: the index breaks
  the moment an edge is inserted.

## Fixing a parse error

`diagnostics` carries the parser's own words, e.g.

```
Parse error on line 2:
...t TD  A[Start --> B{{{
----------------------^
Expecting 'SQE', 'DOUBLECIRCLEEND', ... got 'DIAMOND_START'
```

Read it as: **the caret marks where the parser gave up**, and the "Expecting"
list names what it would have accepted there. In practice:

| Message says | Almost always means |
|---|---|
| `got 'DIAMOND_START'` / `Expecting ... 'PE'` | an unclosed `[`, `(` or `{` before that point |
| `got 'NEWLINE'` | a statement split across lines where the syntax needs one line, or a missing `end` |
| `No diagram type detected` | the first non-comment word is not a diagram keyword (or it is misspelled, e.g. `flowChart`) |
| `Expecting 'TEXT'` | an unquoted label containing punctuation |
| `got 'EOF'` | a block was opened and never closed |

Fix the smallest thing that explains the caret, write again, and keep iterating
until the status is `ok`.

## What the host warns about

Alongside the parse verdict the host lints the source for things a parser
cannot refuse but a reader pays for. These arrive as `warnings` on a write that
**succeeded** - ignore them at your peril, but never treat them as a refusal:

| Warning | Usually means |
|---|---|
| *"does not start with a diagram keyword"* | a typo in the first line, or you pasted prose above it |
| *"parsed as X but the source reads like a Y"* | two diagram types mixed in one source |
| *"a square bracket ... is never closed"* | an unclosed `[` (the host says which line) |
| *"participant belongs to a sequenceDiagram"* | flowchart body with sequence syntax, or the reverse |
| *"A sequenceDiagram draws messages with ->> ..."* | flowchart arrows inside a `sequenceDiagram` |
| *"N nodes and no edges"* | nodes were declared but never connected - a list dressed as a diagram |
| *"past the point a reader takes in at once"* | split the topic; see the budgets above |
| *"A node label runs to N characters"* | move the detail into the message that accompanies the diagram |

The host also refuses two things outright, in plain words rather than the
engine's cryptic ones: an **empty source**, and a source that is **only
comments**. Both are `status: "error"` and neither costs a parse.
