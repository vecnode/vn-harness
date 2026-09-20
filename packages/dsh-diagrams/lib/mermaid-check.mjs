/**
 * dsh-diagrams — headless Mermaid validation, run as a CHILD PROCESS.
 *
 * Why a child: the vendored engine (`lib/vendor/mermaid.min.js`, mermaid's
 * single-file browser build) is the only Mermaid this pack has, and it expects
 * a browser. Making it parse in Node means loading it with a DOM stub on the
 * globals - which must never happen inside the harness process, where a
 * `document`/`window` that exists can change other plugins' behaviour. A child
 * also contains a crash or an out-of-memory engine: the worst case is a failed
 * spawn, reported as "not validated", never a broken host.
 *
 * The stub below is deliberately small and only has to satisfy DOMPurify's
 * support probe (`document.implementation.createHTMLDocument`, element
 * `entries`/`getParentNode`) plus whatever the parsers touch. It is NOT a DOM:
 * nothing renders here. `mermaid.parse()` only validates syntax and reports the
 * diagram type, which is exactly what the model needs to fix a bad diagram.
 *
 * The engine is loaded with `vm.runInThisContext` because it is a CLASSIC
 * script (its last line is `globalThis["mermaid"] = ...`), not an ES module -
 * which is the same reason the browser can load it from one route with a plain
 * script tag.
 *
 * Usage:  node mermaid-check.mjs            (source on stdin)
 *         node mermaid-check.mjs <file>     (source from a file)
 * Output: ONE line of JSON on stdout:
 *   { ok: true,  diagramType: 'flowchart-v2', warnings: [...], ms: 87 }
 *   { ok: false, reason: 'parse' | 'internal', error: '...', warnings: [...], ms: 84 }
 * Exit code is always 0 when a verdict was produced; a non-zero exit means the
 * caller should treat the check as unavailable.
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const noop = () => {}

/** One fake element. Enough for the sanitizer's probe and the parsers' reads. */
function makeNode(tag = 'div') {
  const name = String(tag).toUpperCase()
  return {
    nodeName: name,
    tagName: name,
    nodeType: 1,
    textContent: '',
    innerHTML: '',
    style: {},
    dataset: {},
    attributes: {},
    childNodes: [],
    children: [],
    classList: { add: noop, remove: noop, contains: () => false, toggle: noop },
    setAttribute: noop,
    getAttribute: () => null,
    removeAttribute: noop,
    hasAttribute: () => false,
    appendChild(child) {
      this.childNodes.push(child)
      this.children.push(child)
      return child
    },
    removeChild: (child) => child,
    insertBefore: (child) => child,
    replaceChild: (child) => child,
    cloneNode: () => makeNode(tag),
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: () => true,
    getElementsByTagName: () => [],
    getElementsByClassName: () => [],
    querySelector: () => null,
    querySelectorAll: () => [],
    entries: () => [][Symbol.iterator](),
    keys: () => [][Symbol.iterator](),
    values: () => [][Symbol.iterator](),
    forEach: noop,
    firstChild: null,
    lastChild: null,
    parentNode: null,
    ownerDocument: null,
    getRootNode: () => documentStub,
    contains: () => false,
  }
}

const documentStub = makeNode('#document')
documentStub.nodeType = 9
documentStub.implementation = {
  createHTMLDocument: () => documentStub,
  createDocument: () => documentStub,
  createDocumentType: () => makeNode('doctype'),
}
documentStub.createElement = (tag) => makeNode(tag)
documentStub.createElementNS = (_ns, tag) => makeNode(tag)
documentStub.createTextNode = (text) => ({ nodeType: 3, textContent: text })
documentStub.createComment = (text) => ({ nodeType: 8, textContent: text })
documentStub.createDocumentFragment = () => makeNode('#fragment')
documentStub.importNode = (node) => node
documentStub.body = makeNode('body')
documentStub.head = makeNode('head')
documentStub.documentElement = makeNode('html')
documentStub.getElementById = () => null
documentStub.getElementsByTagName = () => []
documentStub.querySelector = () => null
documentStub.querySelectorAll = () => []
documentStub.addEventListener = noop
documentStub.removeEventListener = noop

class DOMParserStub {
  parseFromString() {
    return documentStub
  }
}

const windowStub = {
  document: documentStub,
  location: { href: 'http://localhost/', protocol: 'http:', host: 'localhost' },
  addEventListener: noop,
  removeEventListener: noop,
  dispatchEvent: () => true,
  matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }),
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
  cancelAnimationFrame: noop,
  setTimeout,
  clearTimeout,
  innerWidth: 1200,
  innerHeight: 800,
  devicePixelRatio: 1,
  /**
   * `window.CSS.supports` exists in every browser this engine was written for,
   * and the sequence-diagram box parser reaches for it:
   *
   *     if (window?.CSS) window.CSS.supports('color', value) || (value = 'transparent')
   *     else { const probe = new Option().style; ... }
   *
   * With no `window.CSS` the engine took the `new Option()` branch, and `Option`
   * does not exist here - so EVERY `box` diagram died with "Option is not
   * defined", which the plugin can only report as `unavailable` ("stored but not
   * validated"). That was a hole in the stub, not in the diagram.
   *
   * Answering `true` is the honest emulation of a modern browser, and it cannot
   * hide a real problem: the only question ever asked is whether a colour string
   * is valid, and BOTH answers leave the source parsing - the fallback is
   * `transparent`, which is not a parse error.
   */
  CSS: { supports: () => true },
  DOMParser: DOMParserStub,
  XMLSerializer: class {
    serializeToString() {
      return ''
    }
  },
  Node: class {},
  Element: class {},
  HTMLElement: class {},
  SVGElement: class {},
}
windowStub.window = windowStub

globalThis.window = windowStub
globalThis.document = documentStub
globalThis.self = windowStub

/** Read the source: stdin by default, or a file path when one is given. */
function readSource() {
  const file = process.argv[2]
  if (typeof file === 'string' && file.length > 0 && file !== '-') return readFileSync(file, 'utf8')
  return readFileSync(0, 'utf8')
}

// ---------------------------------------------------------------------------
// Structural linting
// ---------------------------------------------------------------------------
/**
 * What the PARSER cannot refuse but a READER pays for.
 *
 * These are advisories, never a refusal: mermaid accepts a great many things
 * that draw badly, and a check that cries wolf is worse than no check. Each
 * rule below is deliberately conservative - it fires only on a shape that is
 * far more often a mistake than an intention - and the caller reports every one
 * as a warning on a write that SUCCEEDED.
 *
 * @param source - the diagram source.
 * @param diagramType - what the engine called it (null when it did not parse).
 * @returns an array of `{ kind, text }`.
 */
export function lintMermaid(source, diagramType) {
  const warnings = []
  const add = (kind, text) => warnings.push({ kind, text })
  const text = stripFence(source)
  if (text.trim().length === 0) return warnings
  const stripped = sourceLines(text)

  const heading = firstMeaningfulLine(stripped)
  if (!heading) return warnings
  const kind = diagramKind(heading)
  if (kind === null) {
    add(
      'type',
      'The first line (' +
        JSON.stringify(heading.trim()) +
        ') does not start with a diagram keyword - mermaid needs one of flowchart, graph, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, pie, mindmap, timeline, quadrantChart, journey, gitGraph, sankey-beta, xychart-beta, block-beta, packet-beta, architecture-beta, kanban, radar, treemap, requirementDiagram, C4Context or zenuml.',
    )
    return warnings
  }

  const expected = {
    sequence: 'sequence',
    class: 'class',
    state: 'state',
    er: 'er',
    gantt: 'gantt',
    pie: 'pie',
    mindmap: 'mindmap',
    timeline: 'timeline',
    quadrant: 'quadrant',
    journey: 'journey',
    flow: 'flow',
  }[kind]
  const actual = typeFamily(diagramType)
  if (expected && actual && expected !== actual) {
    add(
      'type',
      'The engine parsed this as "' +
        diagramType +
        '" but the source reads like a ' +
        expected +
        ' diagram. Check the first line - mixing two diagram types is the usual cause.',
    )
  }

  if (kind === 'sequence') {
    if (/(^|\s)(-->|==>|-\.->|~~~)(\s|$)/.test(stripped.join('\n'))) {
      add('syntax', 'A sequenceDiagram draws messages with ->> / -->> / -x / -), not with flowchart arrows (-->, ==>, -.->).')
    }
    if (/\b(subgraph|flowchart|graph TD|graph LR)\b/.test(stripped.join('\n'))) {
      add('syntax', 'flowchart-only syntax (subgraph, graph TD/LR) appears inside a sequenceDiagram.')
    }
  }
  if (kind === 'flow' && /^\s*participant\s+/m.test(text)) {
    add('syntax', '"participant" belongs to a sequenceDiagram; a flowchart declares its nodes inline (A[Label]) or with subgraph.')
  }

  const bracket = unbalancedBrackets(stripped.join('\n'), kind)
  if (bracket) add('structure', bracket)

  if (kind === 'flow') {
    const nodes = new Set()
    let edges = 0
    const nodePattern = /(^|[\s(\[{|>])([A-Za-z_][A-Za-z0-9_-]*)\s*(\[\[|\[\(|\[|\(\(|\(|\[\[|\{\{|\{|>|\[\\|\[\/)/g
    let match
    while ((match = nodePattern.exec(text)) !== null) nodes.add(match[2])
    for (const line of stripped) edges += (line.match(/-->|---|-\.->|==>|--o|--x|<-->|o--o|x--x/g) ?? []).length
    if (nodes.size > 40) {
      add('size', 'About ' + nodes.size + ' nodes in one picture. A flowchart stays readable to roughly 20; split it or group it with subgraph.')
    } else if (nodes.size > 20) {
      add('size', 'About ' + nodes.size + ' nodes is past the point a reader takes in at once. Consider one diagram per question.')
    }
    if (nodes.size >= 8 && edges === 0) {
      add('shape', nodes.size + ' nodes and no edges: nodes only become a diagram once they are connected. A list may say this better.')
    }
    if (edges > 60) add('size', edges + ' edges is a lot of lines to follow; a table or two smaller diagrams usually reads better.')
    const subgraphs = (text.match(/^\s*subgraph\s/gm) ?? []).length
    if (subgraphs > 6) add('size', subgraphs + ' subgraphs nest past what a narrow panel can show.')
  }

  const longLabel = text.match(/\[["']?([^\]"'\n]{80,})/)
  if (longLabel) {
    add('label', 'A node label runs to ' + longLabel[1].length + ' characters. Labels read best at 1-4 words with the detail in the message that accompanies the diagram.')
  }
  if (/[`]/.test(text) && /^```/m.test(text)) {
    add('source', 'The source contains a markdown code fence. Pass the diagram text alone - a fence is stripped automatically, but text after it is not part of the diagram.')
  }
  return warnings
}

/** The first line that carries content once comments and blank lines are gone. */
function firstMeaningfulLine(lines) {
  for (const line of lines) {
    const trimmed = line.trim().replace(/^---$/, '').trim()
    if (trimmed.startsWith('%%')) continue
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

/** The diagram family the source's own first line declares, or null. */
function diagramKind(heading) {
  const line = String(heading).trim()
  if (/^(flowchart|graph)\b/i.test(line)) return 'flow'
  if (/^sequenceDiagram\b/i.test(line)) return 'sequence'
  if (/^classDiagram\b/i.test(line)) return 'class'
  if (/^stateDiagram(-v2)?\b/i.test(line)) return 'state'
  if (/^erDiagram\b/i.test(line)) return 'er'
  if (/^gantt\b/i.test(line)) return 'gantt'
  if (/^pie\b/i.test(line)) return 'pie'
  if (/^mindmap\b/i.test(line)) return 'mindmap'
  if (/^timeline\b/i.test(line)) return 'timeline'
  if (/^quadrantChart\b/i.test(line)) return 'quadrant'
  if (/^journey\b/i.test(line)) return 'journey'
  return null
}

/** The same families, read from the engine's own diagram type name. */
function typeFamily(diagramType) {
  const name = String(diagramType ?? '').toLowerCase()
  if (name.startsWith('flowchart') || name === 'graph' || name === 'flowchart-elk') return 'flow'
  if (name.startsWith('sequence')) return 'sequence'
  if (name.startsWith('class')) return 'class'
  if (name.startsWith('state')) return 'state'
  if (name.startsWith('er')) return 'er'
  if (name.startsWith('gantt')) return 'gantt'
  if (name.startsWith('pie')) return 'pie'
  if (name.startsWith('mindmap')) return 'mindmap'
  if (name.startsWith('timeline')) return 'timeline'
  if (name.startsWith('quadrant')) return 'quadrant'
  if (name.startsWith('journey')) return 'journey'
  return null
}

/**
 * Brackets opened and never closed.
 *
 * Only the shapes a LABEL uses are counted, and only the kinds the diagram type
 * actually uses for labels: an `erDiagram` legitimately writes its attribute
 * blocks as `ENTITY { ... }` with the block opening on the entity line, so its
 * curlies are not counted at all. Deliberately not a real tokenizer - a missing
 * closing bracket is the single most common broken diagram, and anything subtler
 * is left to the parser, which is authoritative anyway.
 *
 * @param text - the comment-stripped source.
 * @param kind - the diagram family, from {@link diagramKind}.
 * @returns a message, or null when nothing looks unbalanced.
 */
function unbalancedBrackets(text, kind) {
  const shapes = kind === 'er' ? [['[', ']', 'square']] : kind === 'mindmap' ? [['[', ']', 'square']] : [['[', ']', 'square'], ['{', '}', 'curly']]
  for (const [open, close, what] of shapes) {
    let depth = 0
    let firstOpenLine = 0
    const lines = text.split('\n')
    for (let index = 0; index < lines.length; index += 1) {
      for (const character of lines[index]) {
        if (character === open) {
          if (depth === 0) firstOpenLine = index + 1
          depth += 1
        } else if (character === close) {
          depth = Math.max(0, depth - 1)
        }
      }
    }
    if (depth > 0) {
      return 'A ' + what + ' bracket opened on line ' + firstOpenLine + ' is never closed - ' + depth + ' still open at the end of the source.'
    }
  }
  return null
}

/**
 * The source with one surrounding markdown fence removed.
 *
 * `diagram_write` strips a fence before it stores anything, so the checker has
 * to look at the same text the engine will: a model that pasted a fenced block
 * must get a verdict about its DIAGRAM, not about its backticks.
 *
 * @param text - the raw source.
 * @returns the unfenced source.
 */
export function stripFence(text) {
  const trimmed = String(text ?? '').trim()
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed)
  return fence ? fence[1] : String(text ?? '')
}

/**
 * A source that carries no diagram at all - the one "error" the parser reports
 * so unhelpfully ("No diagram type detected ...") that it deserves its own
 * verdict and its own words.
 *
 * @param source - the diagram source.
 * @returns a message, or null when there is something to work with.
 */
export function emptySourceReason(source) {
  const text = stripFence(source)
  if (text.trim().length === 0) return 'The source is empty, so there is nothing to draw. Pass the diagram text in `source`.'
  if (firstMeaningfulLine(sourceLines(text)) === '') {
    return 'The source holds nothing but comments (`%%`), so there is nothing to draw.'
  }
  return null
}

/** The comment-stripped lines of one source. */
function sourceLines(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      const cut = line.indexOf('%%')
      return cut === -1 ? line : line.slice(0, cut)
    })
}

/** Install the stub, load the vendored engine, parse one source. */
async function main() {
  let source
  try {
    source = readSource()
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'internal', error: 'could not read the source: ' + message(err) }) + '\n')
    return
  }
  const started = Date.now()

  // A source with no diagram in it is refused in our own words: the engine only
  // ever says "No diagram type detected", which tells the model nothing about
  // the fact that it sent an empty string.
  const emptyReason = emptySourceReason(source)
  if (emptyReason) {
    process.stdout.write(
      JSON.stringify({ ok: false, reason: 'parse', error: emptyReason, lint: true, warnings: [], ms: Date.now() - started }) + '\n',
    )
    return
  }
  // The engine validates the same text the plugin will store: a pasted code
  // fence is removed rather than reported as a bad first line.
  source = stripFence(source)

  try {
    const script = readFileSync(new URL('./vendor/mermaid.min.js', import.meta.url), 'utf8')
    vm.runInThisContext(script, { filename: 'mermaid.min.js' })
  } catch (err) {
    process.stdout.write(
      JSON.stringify({ ok: false, reason: 'internal', error: 'engine unavailable: ' + message(err), ms: Date.now() - started }) + '\n',
    )
    return
  }

  const mermaid = globalThis.mermaid
  if (!mermaid || typeof mermaid.parse !== 'function') {
    process.stdout.write(
      JSON.stringify({ ok: false, reason: 'internal', error: 'the vendored engine exposed no parser', ms: Date.now() - started }) + '\n',
    )
    return
  }

  try {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
    const parsed = await mermaid.parse(source)
    const diagramType = parsed && parsed.diagramType ? parsed.diagramType : null
    process.stdout.write(
      JSON.stringify({ ok: true, diagramType, warnings: lintMermaid(source, diagramType), ms: Date.now() - started }) + '\n',
    )
  } catch (err) {
    const text = message(err)
    // A stub/engine failure looks nothing like a syntax error. Telling the two
    // apart is what keeps this check honest: "not validated" must never be
    // reported to the model as "your diagram is wrong".
    const internal = /DOMPurify|addHook|is not a function|document is not defined|window is not defined|not defined$/i.test(text)
    process.stdout.write(
      JSON.stringify({
        ok: false,
        reason: internal ? 'internal' : 'parse',
        error: text,
        warnings: internal ? [] : lintMermaid(source, null),
        ms: Date.now() - started,
      }) + '\n',
    )
  }
}

/** One error's readable first lines. */
function message(err) {
  const text = err && err.message ? String(err.message) : String(err)
  return text.split('\n').slice(0, 4).join('\n').trim()
}

await main()
process.exit(0)
