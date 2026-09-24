/**
 * dsh-pdf — the vendored pdf.js build.
 *
 * pdf.js is the one engine this plugin needs on BOTH sides of the app: the
 * browser draws the pages, and the host reads the same document headlessly so
 * the model gets text, layout, metadata and structure instead of a binary blob.
 * The harness profile installs this bundle as a live LINK, so a package
 * dependency is not installed and a plugin cannot `import 'pdfjs-dist'` - the
 * engine is therefore vendored, exactly like dsh-diagrams' Mermaid, the
 * editor's CodeMirror and the terminal's xterm.
 *
 * The version is PINNED TO THE HARNESS'S OWN PREVIEW (pdf.js 6.3.289, the
 * build inlined in @deepseek-ai/dsh-client-ui-sidebar-documentpreview). That is
 * deliberate: two pdf.js versions in one page disagree about a document's text
 * and its rendering, and the preview stays mounted underneath this plugin's tab
 * type, so a mismatch would be a bug the user could see.
 *
 * What is copied, and why each piece is load-bearing:
 *
 *   - `legacy/build/pdf.min.mjs` - the engine. The LEGACY variant because it is
 *     the build pdf.js documents for Node; the minified file because the same
 *     bytes then serve both halves (the browser never downloads the 1 MB
 *     unminified one).
 *   - `legacy/build/pdf.worker.min.mjs` - the render worker the browser needs.
 *     It is served as TEXT through one authenticated route and turned into a
 *     blob URL by the client, exactly like the preview does: a worker must not
 *     depend on how the route is authorized.
 *   - `cmaps/**` (169 files) - CID-keyed CJK documents map their glyphs through
 *     these. Without them a Japanese or Chinese PDF extracts as replacement
 *     characters, which for a reader/scanner tool is a wrong answer, not a
 *     degraded one.
 *   - `standard_fonts/**` (16 files) - documents that rely on the base-14
 *     fonts without embedding them. Without these, pages render with substitute
 *     metrics and the text layer drifts.
 *   - `wasm/**` (13 files, alpha.3) - pdf.js's own WASM image decoders: JBIG2
 *     (the encoding faxes and many scanners produce), OpenJPEG (JPEG2000, which
 *     high-end scanners and archives use) and qcms (ISO colour profiles). Without
 *     them an exotic scanned page draws as a blank or partial page - which for a
 *     READER is the worst kind of failure, because it looks like the document.
 *     `quickjs-eval.wasm` rides along: it is the JavaScript evaluator for a PDF's
 *     embedded scripts, and this plugin sets `isEvalSupported: false` on BOTH
 *     halves, so pdf.js never asks for it. It is vendored anyway because a
 *     partial tree invites "why is this file missing?" the day someone enables
 *     the option - and the whole tree is 1.5 MB.
 *   - `LICENSE` (and the licenses inside the trees) - pdf.js is Apache-2.0 and
 *     the bundled decoders carry their own (JBIG2, OpenJPEG, qcms); the licenses
 *     travel with the bytes.
 *
 * Usage:
 *   node build.mjs            rebuild the vendored engine from the pinned version
 *   node build.mjs --check    report drift against lib/vendor/VERSION.json
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.dirname(here)
const outDir = path.join(pkgRoot, 'lib', 'vendor')
const versionFile = path.join(outDir, 'VERSION.json')
const check = process.argv.includes('--check')

/** The two single-file products, source path -> published name. */
const FILES = [
  ['legacy/build/pdf.min.mjs', 'pdf.min.mjs'],
  ['legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
]
/** The directory products, source path -> published name. */
const TREES = [
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
  ['wasm', 'wasm'],
]
/** Files carried beside the engine for licensing, not for execution. */
const NOTICES = [['LICENSE', 'LICENSE']]

const pin = JSON.parse(readFileSync(path.join(here, 'package.json'), 'utf8'))
const version = pin.dependencies['pdfjs-dist']
if (typeof version !== 'string' || version.length === 0) {
  console.error('[dsh-pdf/vendor] vendor/package.json pins no pdfjs-dist version')
  process.exit(1)
}

const installedRoot = path.join(here, 'node_modules', 'pdfjs-dist')

/** The installed engine's own version, or undefined when it is not installed. */
function installedVersion() {
  const manifest = path.join(installedRoot, 'package.json')
  if (!existsSync(manifest)) return undefined
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).version
  } catch (err) {
    return undefined
  }
}

/** sha256 of one file. */
function hashFile(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

/** Every file under a directory, relative and sorted, as `[rel, absolute]`. */
function walk(dir) {
  const found = []
  const visit = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(current, entry.name)
      const rel = prefix === '' ? entry.name : prefix + '/' + entry.name
      if (entry.isDirectory()) visit(full, rel)
      else if (entry.isFile()) found.push([rel, full])
    }
  }
  visit(dir, '')
  return found
}

/** One tree's identity: a digest over its sorted (name, hash) pairs, plus totals. */
function treeRecord(dir) {
  const files = walk(dir)
  const hash = createHash('sha256')
  let bytes = 0
  for (const [rel, full] of files) {
    bytes += statSync(full).size
    hash.update(rel + '\u0000' + hashFile(full) + '\n')
  }
  return { files: files.length, bytes, sha256: hash.digest('hex') }
}

/** The record this build writes and `--check` verifies. */
function manifest() {
  const files = {}
  for (const [, published] of FILES) {
    const target = path.join(outDir, published)
    files['lib/vendor/' + published] = { bytes: statSync(target).size, sha256: hashFile(target) }
  }
  const trees = {}
  for (const [, published] of TREES) {
    const dir = path.join(outDir, published)
    trees['lib/vendor/' + published] = treeRecord(dir)
  }
  return {
    package: 'pdfjs-dist',
    version,
    build: 'legacy',
    files,
    trees,
    notices: NOTICES.map(([, published]) => 'lib/vendor/' + published),
    note: 'GENERATED by vendor/build.mjs - never hand-edit anything under lib/vendor/.',
  }
}

if (check) {
  if (!existsSync(versionFile)) {
    console.error('[dsh-pdf/vendor] no vendored engine - run: node packages/dsh-pdf/vendor/build.mjs')
    process.exit(1)
  }
  const recorded = JSON.parse(readFileSync(versionFile, 'utf8'))
  let actual
  try {
    actual = manifest()
  } catch (err) {
    console.error('[dsh-pdf/vendor] the vendored tree is incomplete: ' + (err && err.message ? err.message : err))
    process.exit(1)
  }
  if (JSON.stringify(recorded) !== JSON.stringify(actual)) {
    console.error('[dsh-pdf/vendor] DRIFT: recorded ' + JSON.stringify(recorded).slice(0, 400))
    console.error('[dsh-pdf/vendor] actual   ' + JSON.stringify(actual).slice(0, 400))
    console.error('[dsh-pdf/vendor] rebuild with: node packages/dsh-pdf/vendor/build.mjs')
    process.exit(1)
  }
  const engine = actual.files['lib/vendor/pdf.min.mjs']
  console.log(
    '[dsh-pdf/vendor] up to date: pdfjs-dist@' +
      actual.version +
      ' (' +
      actual.build +
      '), engine ' +
      engine.bytes +
      ' bytes, cmaps ' +
      actual.trees['lib/vendor/cmaps'].files +
      ' files, standard_fonts ' +
      actual.trees['lib/vendor/standard_fonts'].files +
      ' files',
  )
  process.exit(0)
}

const present = installedVersion()
if (present !== version) {
  console.log('[dsh-pdf/vendor] installing pdfjs-dist@' + version + ' (found ' + (present ?? 'nothing') + ') ...')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  // A `.cmd` cannot be spawned without a shell on Windows (node refuses with
  // EINVAL), so the Windows half runs it through the command interpreter; the
  // stdio stays inherited so npm's own output is what the maintainer reads.
  const install = spawnSync(npm, ['install', '--no-audit', '--no-fund'], {
    cwd: here,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (install.error) console.error('[dsh-pdf/vendor] npm could not start: ' + install.error.message)
  if (install.status !== 0) {
    console.error('[dsh-pdf/vendor] npm install failed with status ' + install.status)
    process.exit(1)
  }
}

if (installedVersion() !== version) {
  console.error('[dsh-pdf/vendor] pdfjs-dist@' + version + ' is not installed under vendor/node_modules')
  process.exit(1)
}

// Every source is checked BEFORE anything is removed, so a failed build never
// leaves a half-empty lib/vendor behind.
for (const [from] of [...FILES, ...TREES, ...NOTICES]) {
  if (!existsSync(path.join(installedRoot, from))) {
    console.error('[dsh-pdf/vendor] ' + from + ' is missing from the installed pdfjs-dist tree')
    process.exit(1)
  }
}

mkdirSync(outDir, { recursive: true })
for (const [from, published] of FILES) {
  cpSync(path.join(installedRoot, from), path.join(outDir, published))
}
for (const [from, published] of NOTICES) {
  cpSync(path.join(installedRoot, from), path.join(outDir, published))
}
for (const [from, published] of TREES) {
  const target = path.join(outDir, published)
  rmSync(target, { recursive: true, force: true })
  cpSync(path.join(installedRoot, from), target, { recursive: true })
}

const record = manifest()
writeFileSync(versionFile, JSON.stringify(record, null, 2) + '\n', 'utf8')
console.log('[dsh-pdf/vendor] wrote the vendored pdf.js tree (pdfjs-dist@' + record.version + ', ' + record.build + ')')
for (const [name, entries] of Object.entries(record.files)) {
  console.log('[dsh-pdf/vendor]   ' + name + '  ' + entries.bytes + ' bytes  sha256 ' + entries.sha256.slice(0, 16) + '...')
}
for (const [name, entries] of Object.entries(record.trees)) {
  console.log('[dsh-pdf/vendor]   ' + name + '/  ' + entries.files + ' files  ' + Math.round(entries.bytes / 1024) + ' KiB  sha256 ' + entries.sha256.slice(0, 16) + '...')
}
