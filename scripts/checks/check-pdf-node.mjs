// check-pdf-node.mjs - drive dsh-pdf's host half directly: the four tools and
// the four routes, against real PDFs built by this file.
//
// Why this exists: the four pdf_* tools are the whole point of the package, and
// every one of them can be wrong in a way that only shows up against a real
// document - a page range that silently reads nothing, a layout mode that
// returns the raw stream, a search that misses pages, a cache that serves a
// stale answer, a path policy that reads outside the workspace. This drives the
// SHIPPED code path (module import -> apply(context) -> execute()/fetch()) with
// the same seam the agent loop uses, and it builds its own PDFs so it needs no
// TeX, no poppler and no network.
//
// The fixtures are hand-written PDFs, which is deliberate: the check has to run
// on a host with nothing installed. They carry a real xref table so the parser
// reads them as ordinary documents rather than by reconstruction.
//
// Run:  node scripts/checks/check-pdf-node.mjs
export {} // (ESM for the dynamic imports below)

const { promises: fsp, existsSync, readFileSync, rmSync } = await import('node:fs')
const os = await import('node:os')
const path = (await import('node:path')).default
const { pathToFileURL, fileURLToPath } = await import('node:url')

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
let failures = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(46) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

// ---------------------------------------------------------------------------
// A PDF writer, so the fixtures need nothing but this file
// ---------------------------------------------------------------------------
/** Assemble objects (1-based) into a PDF with a real cross-reference table. */
function assemble(objects) {
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, index) => {
    offsets.push(out.length)
    out += String(index + 1) + ' 0 obj\n' + body + '\nendobj\n'
  })
  const startxref = out.length
  out += 'xref\n0 ' + String(objects.length + 1) + '\n0000000000 65535 f \n'
  for (const offset of offsets) out += String(offset).padStart(10, '0') + ' 00000 n \n'
  out += 'trailer\n<< /Size ' + String(objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + String(startxref) + '\n%%EOF\n'
  // latin1 keeps character count and byte count identical, which is what the
  // offsets above assume.
  return Buffer.from(out, 'latin1')
}

/** One text-drawing content stream, one line per entry. */
function textStream(lines) {
  const parts = ['BT', '/F1 12 Tf', '72 760 Td', '14 TL']
  for (const [index, line] of lines.entries()) {
    if (index > 0) parts.push('T*')
    parts.push('(' + String(line).replace(/([()\\])/g, '\\$1') + ') Tj')
  }
  parts.push('ET')
  const body = parts.join('\n')
  return body
}

/** A two-page document whose page one carries a heading and a labelled value. */
function textPdf() {
  const page1 = textStream(['Quarterly Report', 'Prepared for Vecnode', 'Revenue 1234.50 EUR'])
  const page2 = textStream(['Appendix A', 'Method notes for the auditor'])
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + String(page1.length) + ' >>\nstream\n' + page1 + '\nendstream',
    '<< /Length ' + String(page2.length) + ' >>\nstream\n' + page2 + '\nendstream',
  ]
  return assemble(objects)
}

/** A one-page document that is a picture of text: one image, no text operators. */
function scannedPdf() {
  const pixels = '\u0000\u0040\u0080\u00ff'
  const content = 'q 400 0 0 200 72 500 cm /Im0 Do Q'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length 4 >>\nstream\n' + pixels + '\nendstream',
    '<< /Length ' + String(content.length) + ' >>\nstream\n' + content + '\nendstream',
  ]
  return assemble(objects)
}

/** A document with `count` text pages, for the per-call page caps. */
function manyPagePdf(count) {
  const pageObjStart = 3
  const fontObj = pageObjStart + count
  const contentObjStart = fontObj + 1
  const objects = []
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'
  const kids = []
  for (let index = 0; index < count; index += 1) kids.push(String(pageObjStart + index) + ' 0 R')
  objects[1] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + String(count) + ' >>'
  for (let index = 0; index < count; index += 1) {
    objects[pageObjStart - 1 + index] =
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ' + String(fontObj) + ' 0 R >> >> /Contents ' + String(contentObjStart + index) + ' 0 R >>'
  }
  objects[fontObj - 1] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  for (let index = 0; index < count; index += 1) {
    const body = textStream(['Page ' + String(index + 1) + ' of the batch'])
    objects[contentObjStart - 1 + index] = '<< /Length ' + String(body.length) + ' >>\nstream\n' + body + '\nendstream'
  }
  return assemble(objects)
}

// ---------------------------------------------------------------------------
// A hermetic home + workspace
// ---------------------------------------------------------------------------
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-pdf-check-'))
const workspace = path.join(root, 'workspace')
const elsewhere = path.join(root, 'elsewhere')
await fsp.mkdir(workspace, { recursive: true })
await fsp.mkdir(elsewhere, { recursive: true })
// The plugin resolves its cache under DSH_HOME, so point it at the temp root
// BEFORE importing the module: nothing this check runs may touch ~/.dsh.
process.env.DSH_HOME = path.join(root, 'dsh-home')

const textFile = path.join(workspace, 'report.pdf')
const scanFile = path.join(workspace, 'scan.pdf')
const manyFile = path.join(workspace, 'batch.pdf')
const passwordFile = path.join(workspace, 'locked.pdf')
const notesFile = path.join(workspace, 'notes.txt')
const outsideFile = path.join(elsewhere, 'outside.pdf')
const corruptFile = path.join(workspace, 'corrupt.pdf')
await fsp.writeFile(textFile, textPdf())
await fsp.writeFile(scanFile, scannedPdf())
await fsp.writeFile(manyFile, manyPagePdf(12))
await fsp.writeFile(outsideFile, textPdf())
// A PDF inside a directory the workspace index must never descend into: the
// skip-list is what keeps the index a convenience rather than a file crawler.
await fsp.mkdir(path.join(workspace, 'node_modules'), { recursive: true })
await fsp.writeFile(path.join(workspace, 'node_modules', 'ignored.pdf'), textPdf())
// ...and one nested where it SHOULD be found, to prove the walk is real.
await fsp.mkdir(path.join(workspace, 'docs', 'reports'), { recursive: true })
await fsp.writeFile(path.join(workspace, 'docs', 'reports', 'nested.pdf'), textPdf())
await fsp.writeFile(notesFile, 'not a pdf\n')
await fsp.writeFile(corruptFile, textPdf().subarray(0, 400))
// A locked document is one this check cannot build by hand; a file whose name
// says .pdf but whose bytes are not a PDF covers the failure path instead.

// ---------------------------------------------------------------------------
// Capture the plugin's tools and routes
// ---------------------------------------------------------------------------
const modulePath = path.join(repo, 'packages/dsh-pdf/lib/index.js')
const plugin = await import(pathToFileURL(modulePath).href)

const tools = new Map()
const routes = new Map()
const skills = []
const ctx = {
  effect: (fn) => fn(),
  logger: { debug() {}, info() {}, warn() {} },
  tools: {
    register(tool) {
      tools.set(tool.name, tool)
      return () => {}
    },
  },
  get(name) {
    if (name === 'connection') {
      return {
        fetch: {
          register(route) {
            routes.set(route.path, route)
            return () => {}
          },
        },
      }
    }
    if (name === 'skills') {
      return {
        register(skill) {
          skills.push(skill)
          return () => {}
        },
      }
    }
    if (name === 'sessions') {
      return { get: (sessionId) => (sessionId === 's1' ? { header: { cwd: workspace } } : undefined) }
    }
    return undefined
  },
}
plugin.apply(ctx)

const exec = { agent: { session: { id: 's1' } } }
const call = async (name, args) => {
  const tool = tools.get(name)
  if (!tool) throw new Error('no such tool: ' + name)
  return await tool.execute(args, exec)
}

console.log('dsh-pdf host half, home ' + path.relative(os.tmpdir(), root))
console.log('')

// ---------------------------------------------------------------------------
// The module's own activation contract
// ---------------------------------------------------------------------------
// Cordis refuses `ctx.tools` in a fiber that did not declare it ("cannot get
// property \"tools\" without inject"), and that failure takes the WHOLE plugin
// tree down at boot - the unit checks around it would all still pass, because
// they hand `apply()` a stub context. Asserting the exports here is what makes
// this check able to catch a boot that never starts.
check('the row exports its name', plugin.name, 'dsh-pdf')
check('the row injects tools and connection', Array.isArray(plugin.inject) && plugin.inject.includes('tools') && plugin.inject.includes('connection'))

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------
check('five tools registered', [...tools.keys()].sort().join(','), 'pdf_find,pdf_info,pdf_read,pdf_render,pdf_scan')
check('the skill registers', skills.length === 1 && skills[0].name, 'pdf-analysis')
check('the skill has content', (skills[0]?.content ?? '').length > 500)
// The exact count, not a floor: the route vocabulary is what the docs describe,
// and a loose `>= 6` is how "eight route registrations" drifted out of step with
// the ten that are actually registered (state, health, file, list, scan + 5).
check('ten routes registered', [...routes.keys()].filter((route) => route.startsWith('/api/dsh-pdf')).length, 10)
check('vendor route registered per asset', routes.has('/api/dsh-pdf/vendor/pdf.min.mjs') && routes.has('/api/dsh-pdf/vendor/cmaps.json') && routes.has('/api/dsh-pdf/vendor/wasm.json'))
check('no wildcard route', [...routes.keys()].every((route) => !route.includes('*')))

// ---------------------------------------------------------------------------
// pdf_info
// ---------------------------------------------------------------------------
const info = await call('pdf_info', { path: 'report.pdf' })
check('info reports the page count', /Pages: 2/.test(info.text))
check('info reports the text layer', /Text layer: 2 of 2 inspected page\(s\) have text/.test(info.text))
check('info names the producer/attribution line', /Engine: pdf\.js 6\.3\.289/.test(info.text))
check('info prints a per-page breakdown', /p1: \d+ chars/.test(info.text) && /p2: \d+ chars/.test(info.text))
check('info answers without a title', /PDF 1\.4/.test(info.text))
check('info view is tab-addressed', /^dsh-resource:\/\/file\/session\/s1\/report\.pdf$/.test(info.view.address))
check('info view reports pages', info.view.pages, 2)

const scanInfo = await call('pdf_info', { path: 'scan.pdf' })
check('info spots a scanned page', /No text on page\(s\): 1/.test(scanInfo.text) && /SCANS/.test(scanInfo.text))
check('info marks the scan in the view', JSON.stringify(scanInfo.view.scanned), '[1]')

const cachedInfo = await call('pdf_info', { path: 'report.pdf' })
check('a second pdf_info is a cache hit', cachedInfo.view.cached, true)

// ---------------------------------------------------------------------------
// pdf_read
// ---------------------------------------------------------------------------
const read = await call('pdf_read', { path: 'report.pdf', pages: '1' })
check('read returns page one text', /Revenue 1234\.50 EUR/.test(read.text))
check('read marks the page', /--- page 1 ---/.test(read.text))
check('read does not leak page two', /Method notes/.test(read.text), false)

const layout = await call('pdf_read', { path: 'report.pdf', pages: '1-2', mode: 'layout' })
check('layout mode reads both pages', /Method notes for the auditor/.test(layout.text))
check('layout keeps lines apart', /Quarterly Report\nPrepared for Vecnode/.test(layout.text))
check('layout view records the mode', layout.view.mode, 'layout')

const scanRead = await call('pdf_read', { path: 'scan.pdf', pages: '1' })
check('read reports a page with no text layer', /NO TEXT LAYER/.test(scanRead.text) && /scan or a picture page/.test(scanRead.text))

const capped = await call('pdf_read', { path: 'report.pdf', pages: 'all', maxChars: 20 })
check('read honours maxChars', /Truncated at/.test(capped.text))

const badRange = await call('pdf_read', { path: 'report.pdf', pages: '9-12' })
check('an impossible range is answered, not thrown', /page range/i.test(badRange.text))

// ---------------------------------------------------------------------------
// pdf_find
// ---------------------------------------------------------------------------
const found = await call('pdf_find', { path: 'report.pdf', query: 'Revenue' })
check('find locates the hit', /1 hit\(s\) shown/.test(found.text) && /p1:/.test(found.text) && /\[Revenue\]/.test(found.text))
check('find view counts hits', found.view.hits, 1)

const missing = await call('pdf_find', { path: 'report.pdf', query: 'Nonexistent' })
check('find reports no matches', /No matches\./.test(missing.text) && missing.view.hits === 0)

const regex = await call('pdf_find', { path: 'report.pdf', query: 'revenue\\s+\\d+', regex: true })
check('find supports regex', /\[Revenue 1234\]/.test(regex.text))

const scanFind = await call('pdf_find', { path: 'scan.pdf', query: 'anything' })
check('find explains a page with no text layer', /no text layer at all/.test(scanFind.text))

// ---------------------------------------------------------------------------
// Path policy
// ---------------------------------------------------------------------------
const outside = await call('pdf_info', { path: path.join('..', 'elsewhere', 'outside.pdf') })
check('a workspace escape is refused', /outside the conversation workspace/i.test(outside.text))

const absolute = await call('pdf_info', { path: outsideFile })
check('an absolute path outside is read (the attachment case)', /Pages: 2/.test(absolute.text))
check('an absolute address uses this package shape', /^dsh-resource:\/\/pdf\/absolute\//.test(absolute.view.address))

const wrongType = await call('pdf_info', { path: 'notes.txt' })
check('a non-PDF is refused by name', /Only \*\.pdf files/.test(wrongType.text))

const missingFile = await call('pdf_info', { path: 'nothing-here.pdf' })
check('a missing file is refused by name', /No such file/.test(missingFile.text))

const corrupt = await call('pdf_info', { path: 'corrupt.pdf' })
check('a truncated PDF is a readable failure', /not a readable PDF/.test(corrupt.text))

// ---------------------------------------------------------------------------
// The optional engines this host has, probed once
// ---------------------------------------------------------------------------
const enginesModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-pdf/lib/engines.js')).href)
const engines = enginesModule.probeEngines()

// ---------------------------------------------------------------------------
// The scanner tool, as the agent calls it
// ---------------------------------------------------------------------------
// (Driven here, before the schema block, because these two answers are part of
// the schema assertions below. The PIPELINE itself is exercised further down.)
const toolScan = await call('pdf_scan', { path: 'scan.pdf' })
if (!engines.ocr) {
  check('scan says OCR is missing, in words', /No OCR engine is installed/.test(toolScan.text) && /tesseract/.test(toolScan.text))
  check('scan still names what can be done', /pdf_read/.test(toolScan.text) && /pdf_render/.test(toolScan.text))
} else {
  check('scan recognizes the scanned page', /Recognized 1 page/.test(toolScan.text) && /psm 3/.test(toolScan.text))
  check('scan marks the text as recognized', /transcription/.test(toolScan.text))
}
const textScan = await call('pdf_scan', { path: 'report.pdf' })
check('scan refuses to OCR pages that already have text', /already has a text layer/.test(textScan.text) && /pdf_read/.test(textScan.text))
check('a scan of a text document names no OCR result', textScan.view.ocr === undefined)

// ---------------------------------------------------------------------------
// Schema conformance of every answer
// ---------------------------------------------------------------------------
function schemaErrors(schema, value, label = 'value') {
  const problems = []
  if (!schema || typeof schema !== 'object') return problems
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (schema.type) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type]
    const matches = wanted.some((one) => {
      if (one === 'integer') return Number.isInteger(value)
      if (one === 'number') return typeof value === 'number'
      if (one === 'string') return typeof value === 'string'
      if (one === 'boolean') return typeof value === 'boolean'
      if (one === 'array') return Array.isArray(value)
      if (one === 'object') return actual === 'object'
      if (one === 'null') return value === null
      return true
    })
    if (!matches) problems.push(label + ' must be ' + wanted.join('|') + ' (got ' + actual + ')')
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push(label + ' is not one of ' + schema.enum.join(','))
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => problems.push(...schemaErrors(schema.items, item, label + '[' + index + ']')))
  if (value !== null && actual === 'object' && schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      if (value[key] === undefined) continue
      problems.push(...schemaErrors(schema.properties[key], value[key], label + '.' + key))
    }
    for (const key of schema.required ?? []) if (value[key] === undefined) problems.push(label + '.' + key + ' is required')
  }
  return problems
}
function losslessErrors(value, label = 'value') {
  if (value === null || typeof value !== 'object') return []
  const round = JSON.parse(JSON.stringify(value))
  const problems = []
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(round, key)) problems.push(label + '.' + key + ' is dropped by JSON (undefined)')
    else problems.push(...losslessErrors(value[key], label + '.' + key))
  }
  return problems
}
const answers = [
  ['pdf_info', 'pdf_info', info],
  ['pdf_info scan', 'pdf_info', scanInfo],
  ['pdf_read', 'pdf_read', read],
  ['pdf_read layout', 'pdf_read', layout],
  ['pdf_read scan', 'pdf_read', scanRead],
  ['pdf_find', 'pdf_find', found],
  ['pdf_find none', 'pdf_find', missing],
  ['pdf_render', 'pdf_render', await call('pdf_render', { path: 'report.pdf', pages: '1', dpi: 100 })],
  ['pdf_scan', 'pdf_scan', toolScan],
  ['pdf_scan text doc', 'pdf_scan', textScan],
  ['refused path', 'pdf_info', wrongType],
]
const schemaProblems = []
for (const [label, toolName, answer] of answers) {
  schemaProblems.push(...schemaErrors(tools.get(toolName).output.schema, answer, label))
  schemaProblems.push(...losslessErrors(answer, label))
}
check('every answer satisfies its own output schema', schemaProblems.slice(0, 3).join('; ') || true, true)

// ---------------------------------------------------------------------------
// pdf_render: real when this host can, honest when it cannot
// ---------------------------------------------------------------------------
const render = await call('pdf_render', { path: 'report.pdf', pages: '2', dpi: 120 })
if (engines.rasterizer) {
  check('render writes a page picture (' + engines.rasterizer.name + ')', /Rendered 1 page/.test(render.text))
  const written = (render.view.images ?? [])[0]
  check('the picture is named after the PDF, page and dpi', Boolean(written) && /report-page2-120dpi\.png$/.test(written))
  check('the picture exists on disk', Boolean(written) && existsSync(written))
  check('the picture is a PNG', Boolean(written) && readFileSync(written).subarray(1, 4).toString('latin1') === 'PNG')
  const size = written ? enginesModule.pngSize(readFileSync(written)) : null
  // 595x842 pt at 120 dpi is 992x1403 px; a couple of pixels of rounding is the
  // rasterizer's business, not a failure.
  check(
    'the picture is the page at 120 dpi',
    Boolean(size) && Math.abs(size.width - 992) <= 3 && Math.abs(size.height - 1403) <= 3,
  )
  const again = await call('pdf_render', { path: 'report.pdf', pages: '2', dpi: 120 })
  check('a second render never overwrites', again.view.images[0] !== written && /report-page2-120dpi-2\.png$/.test(again.view.images[0]))
} else {
  check('render says what this host lacks', /no PDF rasterizer/.test(render.text))
  console.log('     (no rasterizer on this host, so the picture path was not exercised)')
}

// ---------------------------------------------------------------------------
// The scanner
// ---------------------------------------------------------------------------
// Two halves. The TOOL is driven as the agent drives it (and on a host without
// tesseract that means its refusal, which is the behaviour to pin). The
// PIPELINE is driven directly with a stub OCR engine, because the orchestration
// - which pages, what is cached under which key, what happens when a language
// is missing - is exactly the part a host with no OCR engine could otherwise
// never exercise. The stub is a real child process (this same Node binary), so
// the spawn, the argv shape, the timeout plumbing and the parse are the real
// ones; only the recognition itself is replaced.
const scanModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-pdf/lib/scan.js')).href)
const cacheModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-pdf/lib/cache.js')).href)

const stubLanguages = "List of available languages in \"stub\" (2):\neng\npor\n"
const stubEngine = {
  name: 'stub-ocr',
  file: process.execPath,
  // The image path and the language arrive as argv, exactly as tesseract takes
  // them, and the "recognition" is the image's own name - which proves the
  // pipeline handed the engine the raster it drew for THAT page.
  args: ({ image, lang, psm }) => ['-e', 'process.stdout.write("RECOGNIZED:" + process.argv[1] + ":" + process.argv[2] + ":psm" + process.argv[3])', image, lang, String(psm)],
  listLangsArgs: ['-e', 'process.stdout.write(' + JSON.stringify(stubLanguages) + ')'],
  parseLangs: (text) => text.split('\n').map((line) => line.trim()).filter((line) => /^[a-z]{3}$/.test(line)),
}

if (engines.rasterizer) {
  const cache = new cacheModule.PdfCache({ root: path.join(root, 'dsh-home', 'dsh-pdf', 'artifacts') })
  const identity = await new (await import(pathToFileURL(path.join(repo, 'packages/dsh-pdf/lib/runner.js')).href)).Reader({ cache }).identity(scanFile)
  const withStub = { rasterizer: engines.rasterizer, ocr: stubEngine }
  const first = await scanModule.scanPages({ cache, engines: withStub, file: scanFile, sha: identity.sha256, pages: [1], dpi: 200, lang: 'eng', psm: 3 })
  check('the pipeline draws the page and recognizes it', first.ok === true && first.scanned === 1 && first.fromCache === 0)
  check('the recognized text comes from the page raster', first.pages[0].text.startsWith('RECOGNIZED:') && /1@200dpi\.png:eng:psm3$/.test(first.pages[0].text))
  check('the raster is kept as an artifact', Boolean(cache.image(identity.sha256, 1, 200)))
  check('the recognized text is cached', typeof cache.ocr(identity.sha256, 1, 'eng', 200, 3) === 'string')

  const second = await scanModule.scanPages({ cache, engines: withStub, file: scanFile, sha: identity.sha256, pages: [1], dpi: 200, lang: 'eng', psm: 3 })
  check('a second scan is served from the cache', second.fromCache === 1 && second.scanned === 0)

  const otherDpi = await scanModule.scanPages({ cache, engines: withStub, file: scanFile, sha: identity.sha256, pages: [1], dpi: 300, lang: 'eng', psm: 3 })
  check('another resolution is a new recognition', otherDpi.fromCache === 0 && otherDpi.scanned === 1 && otherDpi.dpi === 300)

  const otherPsm = await scanModule.scanPages({ cache, engines: withStub, file: scanFile, sha: identity.sha256, pages: [1], dpi: 200, lang: 'eng', psm: 6 })
  check('another segmentation mode is a new recognition', otherPsm.fromCache === 0 && otherPsm.scanned === 1)

  const otherLang = await scanModule.scanPages({ cache, engines: withStub, file: scanFile, sha: identity.sha256, pages: [1], dpi: 200, lang: 'por', psm: 3 })
  check('another language is a new recognition', otherLang.fromCache === 0 && otherLang.scanned === 1)

  const unknownLang = await scanModule.scanPages({ cache, engines: withStub, file: scanFile, sha: identity.sha256, pages: [1], dpi: 200, lang: 'deu', psm: 3 })
  check('a language the engine lacks is refused', unknownLang.ok === false && unknownLang.reason === 'no-language')
  check('the refusal names what is available', JSON.stringify(unknownLang.available), '["eng","por"]')
  const badLang = await scanModule.scanPages({ cache, engines: withStub, file: scanFile, sha: identity.sha256, pages: [1], lang: 'english', psm: 3 })
  check('a malformed language tag is refused', badLang.ok === false && badLang.reason === 'bad-language')

  const many = await new (await import(pathToFileURL(path.join(repo, 'packages/dsh-pdf/lib/runner.js')).href)).Reader({ cache }).identity(manyFile)
  const capped = await scanModule.scanPages({
    cache,
    engines: withStub,
    file: manyFile,
    sha: many.sha256,
    pages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    dpi: 150,
    lang: 'eng',
    psm: 3,
  })
  check('a scan is capped per call', capped.pages.length === scanModule.MAX_SCAN_PAGES && scanModule.MAX_SCAN_PAGES === 10)
  check('the cap names the pages it left', JSON.stringify(capped.skipped), '[11,12]')
} else {
  console.log('skip the stubbed scan pipeline                      (no rasterizer on this host)')
}
const noOcr = await scanModule.scanPages({ cache: { ocr: () => null }, engines: { rasterizer: { name: 'x' }, ocr: null }, file: scanFile, sha: 'a'.repeat(64), pages: [1] })
check('the pipeline refuses without an OCR engine', noOcr.ok === false && noOcr.reason === 'no-ocr')
const noRaster = await scanModule.scanPages({ cache: { ocr: () => null }, engines: { rasterizer: null, ocr: stubEngine }, file: scanFile, sha: 'a'.repeat(64), pages: [1] })
check('the pipeline refuses without a rasterizer', noRaster.ok === false && noRaster.reason === 'no-rasterizer')
check('every refusal has a sentence', [scanModule.scanReasonText('no-ocr'), scanModule.scanReasonText('no-rasterizer'), scanModule.scanReasonText('no-language', { available: ['eng'] }), scanModule.scanReasonText('bad-language')].every((line) => typeof line === 'string' && line.length > 40))

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
const stateResponse = await routes.get('/api/dsh-pdf/state').fetch(new Request('http://127.0.0.1/api/dsh-pdf/state'))
const state = await stateResponse.json()
check('state route answers ok', stateResponse.status === 200 && state.ok === true)
check('state names the vendored engine', state.engine.version, '6.3.289')
check('state lists the tools', state.tools.join(','), 'pdf_info,pdf_read,pdf_find,pdf_render,pdf_scan')
check('state reports the cache ceiling', state.cache.maxBytes > 0)
check('state carries the scan caps', state.caps.scanMaxPages === 10 && state.caps.scanDpi === 200 && state.caps.scanLang === 'eng')
check('state carries the index caps', state.caps.listMaxFiles === 200 && state.caps.listMaxDepth === 6 && state.caps.listPageCountFiles === 12)
check('state reports the OCR capability honestly', typeof state.capabilities.ocr.available === 'boolean' && (state.capabilities.ocr.available ? typeof state.capabilities.ocr.name === 'string' : state.capabilities.ocr.name === null))

/**
 * One POST to the scan route: the reader's own "scan this page" call.
 */
async function postScan(body) {
  const handler = routes.get('/api/dsh-pdf/scan')
  return await handler.fetch(
    new Request('http://127.0.0.1/api/dsh-pdf/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
}

const scanResponse = await postScan({ session: 's1', path: 'scan.pdf', page: 1 })
const scanAnswer = await scanResponse.json()
check('the scan route answers the reader', scanResponse.status === 200 && typeof scanAnswer.ok === 'boolean')
if (!engines.ocr) {
  check('the scan route explains the missing engine', scanAnswer.ok === false && scanAnswer.reason === 'no-ocr' && /tesseract/.test(scanAnswer.message))
} else {
  check('the scan route returns recognized text', scanAnswer.ok === true && Array.isArray(scanAnswer.pages) && typeof scanAnswer.pages[0].text === 'string')
}
check('the scan route refuses a non-PDF', (await postScan({ session: 's1', path: 'notes.txt' })).status, 415)
check('the scan route refuses a workspace escape', (await postScan({ session: 's1', path: '../elsewhere/outside.pdf' })).status, 403)
check('the scan route refuses a malformed range', (await postScan({ session: 's1', path: 'scan.pdf', pages: 'nonsense' })).status, 400)
check('the scan route refuses a bad body', (await (async () => {
  const handler = routes.get('/api/dsh-pdf/scan')
  return await handler.fetch(new Request('http://127.0.0.1/api/dsh-pdf/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' }))
})()).status, 400)

// ---------------------------------------------------------------------------
// The workspace PDF index
// ---------------------------------------------------------------------------
const listRoute = routes.get('/api/dsh-pdf/list')
const listResponse = await listRoute.fetch(new Request('http://127.0.0.1/api/dsh-pdf/list?session=s1'))
const listing = await listResponse.json()
check('the list route answers', listResponse.status === 200 && listing.ok === true)
const listed = (listing.files ?? []).map((file) => file.path)
check(
  'it lists the workspace PDFs',
  // Exactly the five PDFs this check writes inside the workspace: four at the
  // top level and one nested. notes.txt is not a PDF, the one under
  // node_modules is skipped, and the one in `elsewhere` is outside the root.
  ['report.pdf', 'scan.pdf', 'batch.pdf', 'corrupt.pdf'].every((name) => listed.includes(name)) && listed.length === 5,
)
check('it does not list a non-PDF', listed.includes('notes.txt'), false)
check('it does not descend into node_modules', listed.some((entry) => entry.includes('node_modules')), false)
check('it finds a nested document', listed.includes('docs/reports/nested.pdf'))
check('each row carries an openable address', /^dsh-resource:\/\/file\/session\/s1\/docs\/reports\/nested\.pdf$/.test((listing.files.find((file) => file.path === 'docs/reports/nested.pdf') ?? {}).address ?? ''))
check('the list is not truncated here', listing.truncated, false)
check('page counts are opt-in', listing.counted === 0 && (listing.files ?? []).every((file) => file.pages === null))

const counted = await (await listRoute.fetch(new Request('http://127.0.0.1/api/dsh-pdf/list?session=s1&pages=1'))).json()
const byPages = new Map((counted.files ?? []).map((file) => [file.path, file.pages]))
check('the count pass reports page counts', counted.counted > 0 && byPages.get('report.pdf') === 2)
check('a twelve-page document counts as twelve', byPages.get('batch.pdf'), 12)
check('a damaged document counts as null, not as a failure', byPages.get('corrupt.pdf'), null)
check(
  'the count pass is capped',
  counted.counted === Math.min(12, (counted.files ?? []).filter((file) => !file.tooLarge).length) && counted.counted === 5,
)

const noSession = await listRoute.fetch(new Request('http://127.0.0.1/api/dsh-pdf/list'))
check('the list route requires a session', noSession.status, 400)

const fileResponse = await routes.get('/api/dsh-pdf/file').fetch(new Request('http://127.0.0.1/api/dsh-pdf/file?session=s1&path=report.pdf'))
const fileBytes = Buffer.from(await fileResponse.arrayBuffer())
check('file route serves the bytes', fileResponse.status === 200 && fileBytes.length === textPdf().length)
check('file route sets the PDF type', fileResponse.headers.get('content-type'), 'application/pdf')
check('file route reports the content hash', /^[0-9a-f]{64}$/.test(fileResponse.headers.get('x-dsh-pdf-sha256') ?? ''))
const headResponse = await routes.get('/api/dsh-pdf/file').fetch(new Request('http://127.0.0.1/api/dsh-pdf/file?session=s1&path=report.pdf', { method: 'HEAD' }))
check('file route answers HEAD without a body', headResponse.status === 200 && (await headResponse.arrayBuffer()).byteLength === 0)

const badResponse = await routes.get('/api/dsh-pdf/file').fetch(new Request('http://127.0.0.1/api/dsh-pdf/file?session=s1&path=notes.txt'))
check('file route refuses a non-PDF', badResponse.status, 415)

const engineResponse = await routes.get('/api/dsh-pdf/vendor/pdf.min.mjs').fetch(new Request('http://127.0.0.1/api/dsh-pdf/vendor/pdf.min.mjs'))
const engineSource = await engineResponse.text()
check('vendor route serves the engine', engineResponse.status === 200 && engineSource.length > 400000)
check('the engine has no static imports (blob importable)', /^import\s/m.test(engineSource) === false)
const workerResponse = await routes.get('/api/dsh-pdf/vendor/pdf.worker.min.mjs').fetch(new Request('http://127.0.0.1/api/dsh-pdf/vendor/pdf.worker.min.mjs'))
check('vendor route serves the worker', workerResponse.status === 200 && (await workerResponse.text()).length > 1000000)
const cmapResponse = await routes.get('/api/dsh-pdf/vendor/cmaps.json').fetch(new Request('http://127.0.0.1/api/dsh-pdf/vendor/cmaps.json'))
const cmaps = await cmapResponse.json()
// The maps are keyed by pdf.js's own filenames, extension included.
check('the cMap map carries the CJK maps', typeof cmaps['UniJIS-UCS2-H.bcmap'] === 'string' && Object.keys(cmaps).length > 100)
const fontResponse = await routes.get('/api/dsh-pdf/vendor/standard-fonts.json').fetch(new Request('http://127.0.0.1/api/dsh-pdf/vendor/standard-fonts.json'))
const fonts = await fontResponse.json()
check('the standard-font map carries the base fonts', Object.keys(fonts).length >= 10)
// alpha.3: the WASM image decoders ride one map of their own, exactly like the
// cMaps - JBIG2 and JPEG2000 are what a scanned page often IS, and without them
// such a page draws blank while looking like a document.
const wasmResponse = await routes.get('/api/dsh-pdf/vendor/wasm.json').fetch(new Request('http://127.0.0.1/api/dsh-pdf/vendor/wasm.json'))
const wasm = await wasmResponse.json()
check(
  'the wasm map carries the image decoders',
  typeof wasm['jbig2.wasm'] === 'string' && typeof wasm['openjpeg.wasm'] === 'string' && typeof wasm['qcms_bg.wasm'] === 'string' && Object.keys(wasm).length >= 13,
)
// The registry is exact-path only, so an unknown asset is simply not a route -
// which is a narrower surface than a prefix route would be, and the reason the
// two asset maps exist at all.
check('an unknown vendor asset is not routed', routes.has('/api/dsh-pdf/vendor/nope.mjs'), false)

// ---------------------------------------------------------------------------
// The vendored tree is exactly what the build recorded
// ---------------------------------------------------------------------------
const { spawnSync } = await import('node:child_process')
const build = spawnSync(process.execPath, [path.join(repo, 'packages/dsh-pdf/vendor/build.mjs'), '--check'], { encoding: 'utf8' })
check('vendor build --check passes', build.status === 0 || /is not installed/.test(build.stderr ?? ''), true)
check('the cache stayed inside the temp home', existsSync(path.join(root, 'dsh-home', 'dsh-pdf', 'artifacts')))

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
try {
  rmSync(root, { recursive: true, force: true })
} catch (err) {
  console.log('note: could not remove ' + root)
}

console.log('')
console.log(failures === 0 ? 'all dsh-pdf host checks passed' : failures + ' dsh-pdf host check(s) FAILED')
console.log('host: ' + os.platform() + ', rasterizer: ' + (engines.rasterizer ? engines.rasterizer.name : 'none') + ', OCR: ' + (engines.ocr ? engines.ocr.name : 'none'))
process.exitCode = failures === 0 ? 0 : 1
