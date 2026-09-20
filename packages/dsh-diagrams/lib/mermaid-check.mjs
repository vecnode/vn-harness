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
 *   { ok: true,  diagramType: 'flowchart-v2', ms: 87 }
 *   { ok: false, reason: 'parse' | 'internal', error: '...', ms: 84 }
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
    process.stdout.write(
      JSON.stringify({ ok: true, diagramType: parsed && parsed.diagramType ? parsed.diagramType : null, ms: Date.now() - started }) + '\n',
    )
  } catch (err) {
    const text = message(err)
    // A stub/engine failure looks nothing like a syntax error. Telling the two
    // apart is what keeps this check honest: "not validated" must never be
    // reported to the model as "your diagram is wrong".
    const internal = /DOMPurify|addHook|is not a function|document is not defined|window is not defined|not defined$/i.test(text)
    process.stdout.write(
      JSON.stringify({ ok: false, reason: internal ? 'internal' : 'parse', error: text, ms: Date.now() - started }) + '\n',
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
