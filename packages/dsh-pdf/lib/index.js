/**
 * dsh-pdf — host half.
 *
 * PDF as a surface the agent can actually WORK with. Four tools, one cache and
 * a handful of authenticated routes, all of them read-only:
 *
 *   - `pdf_info`   what this document IS: pages, sizes, metadata, outline,
 *                  attachments, signatures/forms, and whether each page has a
 *                  text layer at all (which is how a scan announces itself).
 *   - `pdf_read`   the text of a page range, in plain reading order or in a
 *                  geometric LAYOUT reconstruction - lines grouped by baseline
 *                  and columns/values kept apart, so an invoice or a two-column
 *                  paper reads as itself instead of as one run-on line.
 *   - `pdf_find`   where a document says something: literal or regex, with the
 *                  page, the surrounding context and what was not searched.
 *   - `pdf_render` page pictures through whichever rasterizer this host has
 *                  (poppler / mutool / Ghostscript), written as new PNG files.
 *
 * Everything else in this file is the machinery that makes those four honest:
 *
 *   - **One engine, vendored.** pdf.js 6.3.289 - the same build and version the
 *     harness's own preview ships - lives in `lib/vendor` and runs in a CHILD
 *     process (`lib/extract.mjs`) with a deadline and a heap ceiling. A PDF is
 *     untrusted input; the worst case has to be a reported failure.
 *   - **A content-addressed cache.** `$DSH_HOME/dsh-pdf/artifacts/<sha256>` per
 *     document, per page. Nothing keys on a path, so a changed file can never
 *     serve a stale answer, and the same document read from two conversations
 *     costs one parse.
 *   - **A path policy that is stated, not implied.** A session-relative path is
 *     resolved inside the conversation's workspace and realpath-checked to stay
 *     there; an absolute path is read directly, which is what makes a PDF
 *     attached in chat (`$DSH_HOME/attachments/v1/files/...`) and a file in
 *     Downloads readable. Either way the target must be a regular file whose
 *     name ends in `.pdf`, and reads are capped - this plugin never becomes a
 *     general "read any file on this machine" route.
 *   - **Writes only as new files.** `pdf_render` writes PNGs create-exclusively
 *     under a name this plugin generates; nothing here can ever modify, move or
 *     delete a PDF, and no route accepts a caller-chosen output name.
 *
 * Routes (GET/HEAD only, the registry's own vocabulary):
 *   GET /api/dsh-pdf/state     capabilities, cache facts, the vendored version
 *   GET /api/dsh-pdf/file      one PDF's bytes, for the tab (session + path, or
 *                              an absolute path), with the content hash as ETag
 *   GET /api/dsh-pdf/vendor/*  the vendored engine, its worker, and the cMap /
 *                              standard-font maps the browser decodes on demand
 *   GET /api/dsh-pdf/health    the same snapshot, for the tracked checks
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MAX_CACHE_BYTES, PdfCache, resolveHome } from './cache.js'
import { DEFAULT_DPI, MAX_DPI, MIN_DPI, clampDpi, probeEngines, rasterize } from './engines.js'
import { MAX_PAGES_PER_RUN, Reader } from './runner.js'
import { DEFAULT_LANG, DEFAULT_PSM, MAX_SCAN_PAGES, SCAN_DPI, languagesFor, scanPages, scanReasonText } from './scan.js'

/**
 * The row's identity, and the services activation waits for.
 *
 * `tools` MUST be declared: a Cordis fiber refuses `ctx.tools` without it
 * ("cannot get property \"tools\" without inject") and the whole plugin tree
 * fails to load at boot. `connection` is declared for the same reason even
 * though the route registration resolves it with `ctx.get(...)`, because that
 * is the service this row's routes live on. Both were missing in the first
 * build of this file, and only a real boot (`dsh web`) reported it - which is
 * why the tracked check now asserts these exports.
 */
export const name = 'dsh-pdf'
export const inject = ['connection', 'tools']

// ---------------------------------------------------------------------------
// Names and caps
// ---------------------------------------------------------------------------
/** Every route this plugin owns, kept in sync with lib/client.js by hand. */
const API_ROOT = '/api/dsh-pdf'
const HEALTH_ROUTE = API_ROOT + '/health'
const STATE_ROUTE = API_ROOT + '/state'
const FILE_ROUTE = API_ROOT + '/file'
const SCAN_ROUTE = API_ROOT + '/scan'
const LIST_ROUTE = API_ROOT + '/list'
const VENDOR_ROUTE = API_ROOT + '/vendor'

/** Refuse anything larger: a PDF is read into memory to be parsed. */
const MAX_PDF_BYTES = 512 * 1024 * 1024
/** The tab route keeps its own, lower ceiling (the whole file goes to a canvas). */
const MAX_TAB_BYTES = 256 * 1024 * 1024
/** `pdf_read`'s own output ceiling, and its default. */
const DEFAULT_READ_CHARS = 40_000
const MAX_READ_CHARS = 200_000
/** A document at or below this many pages is inspected page by page. */
const MAX_INFO_PAGES = 60
/** How many pages `pdf_info` samples from a larger document. */
const INFO_SAMPLE_PAGES = 20
/** `pdf_render` refuses to write more than this many page pictures in one call. */
const RENDER_MAX_PAGES = 20
/** `pdf_find`'s hit ceiling, and its wall-clock budget for walking pages. */
const FIND_MAX_HITS = 40
const FIND_BUDGET_MS = 45_000
/** `pdf_find` refuses to walk past this many pages. */
const FIND_MAX_PAGES = 2_000
/** How many pages `pdf_scan` inspects when no range is given and none is cached. */
const SCAN_PROBE_PAGES = 20
/** The workspace index: how many PDFs it lists, how deep it looks, and how many
 *  of them it opens just to report a page count. */
const LIST_MAX_FILES = 200
const LIST_MAX_DEPTH = 6
const LIST_PAGE_COUNT_FILES = 12
/** Directory names the workspace index never descends into. */
const LIST_SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.venv', 'venv', '.next', '.cache'])

/** The bundled skill, as a file beside this module. */
const SKILL_FILES = [{ name: 'pdf-analysis', file: '../skills/pdf-analysis/SKILL.md' }]

/** The vendored engine's own record (also what the state route reports). */
function vendoredVersion() {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('./vendor/VERSION.json', import.meta.url)), 'utf8')).version ?? 'unknown'
  } catch (err) {
    return 'unknown'
  }
}

/** One error's message, whatever was thrown. */
function messageOf(err) {
  return err && err.message ? String(err.message) : String(err)
}

/** Response with a JSON body. */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Typed failure body. */
function fail(status, code, message, extra) {
  return json(status, { ok: false, error: { code, message, ...(extra ?? {}) } })
}

/** One typed route error. */
function httpError(status, code, message, cause) {
  const err = new Error(message)
  err.status = status
  err.code = code
  if (cause) err.cause = cause
  return err
}

/** Map a thrown route error to its response. */
function errorToResponse(err) {
  if (err && typeof err.status === 'number') return fail(err.status, err.code ?? 'ERROR', String(err.message ?? 'request failed'))
  if (err && typeof err.code === 'string' && /^[A-Z][A-Z_]+$/.test(err.code)) return fail(400, err.code, String(err.message ?? 'request failed'))
  return fail(500, 'INTERNAL', err && err.message ? String(err.message) : 'unexpected failure')
}

/**
 * Read a JSON request body with a hard cap.
 *
 * The only POST this plugin accepts is the reader's scan request, so the cap is
 * small: a page range and a language tag are not a document.
 */
async function readJsonBody(request, maxBytes = 64 * 1024) {
  const text = await request.text()
  if (text.length > maxBytes) throw httpError(413, 'TOO_LARGE', 'The request body is too large.')
  if (text.trim().length === 0) return {}
  try {
    return JSON.parse(text)
  } catch (err) {
    throw httpError(400, 'BAD_JSON', 'The request body is not valid JSON.')
  }
}

/**
 * The workspace root of one session: the live session header while the session
 * is running, otherwise the stored header from session persistence. The same
 * two-step lookup dsh-editor and dsh-gittree perform - duplicated on purpose,
 * because a bundle may not reach into another bundle's files - and it degrades
 * to a typed failure (never a guess) when neither knows the session.
 *
 * @param ctx - the plugin context (services are re-read per request).
 * @param sessionId - the session the request belongs to.
 * @returns {Promise<string>} the session's cwd.
 */
async function sessionRoot(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw httpError(400, 'BAD_REQUEST', 'A session id is required.')
  }
  const get = typeof ctx.get === 'function' ? (name) => ctx.get(name) : () => undefined
  try {
    const sessions = get('sessions')
    const live = sessions && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    const header = live && live.header
    if (header && typeof header.cwd === 'string' && header.cwd.length > 0) return header.cwd
  } catch (err) {
    /* fall through to persistence */
  }
  try {
    const persistence = get('sessionPersistence')
    if (persistence && typeof persistence.stat === 'function') {
      const snapshot = await persistence.stat(sessionId)
      const header = snapshot && snapshot.header
      if (header && typeof header.cwd === 'string' && header.cwd.length > 0) return header.cwd
    }
  } catch (err) {
    /* fall through to the typed failure below */
  }
  throw httpError(409, 'NO_WORKSPACE', 'The workspace folder for this conversation is not available.')
}

/** Whether a path is absolute in either spelling Windows and POSIX accept. */
function isAbsolutePath(value) {
  return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[/\\]/.test(value)
}

/** The lower-cased extension of a path ('' for none and for dotfiles). */
function extensionOf(file) {
  const name = file.slice(file.lastIndexOf('/') + 1).split('\\').pop()
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * Resolve one requested path to a readable PDF, under the stated policy.
 *
 * A session-relative path is resolved inside the session's workspace and both
 * sides go through `realpath`, so a symlink that points out of the workspace is
 * refused rather than followed. An absolute path is used as given (through
 * `realpath`, so the reported path is the real one) - that is the door a chat
 * attachment or a file in Downloads comes through, and it stays a narrow one:
 * the target must be a regular `.pdf` file within the size ceiling.
 *
 * @param ctx - the plugin context, for the workspace lookup.
 * @param request - `{ session, path }`.
 * @returns `{ file, scope, relative }`.
 */
async function resolveTarget(ctx, { session, path: requested }) {
  const value = typeof requested === 'string' ? requested.trim() : ''
  if (value === '') throw httpError(400, 'BAD_REQUEST', 'A PDF path is required.')
  if (value.includes('\u0000')) throw httpError(400, 'BAD_REQUEST', 'That path is not a path.')
  const normalized = value.replace(/\\/g, '/')
  const absolute = isAbsolutePath(value)
  let target
  let scope
  let relative = null
  if (absolute) {
    try {
      target = await fsp.realpath(path.resolve(value))
    } catch (err) {
      throw httpError(404, 'NOT_FOUND', 'No such file: ' + value)
    }
    scope = 'absolute'
  } else {
    const root = await sessionRoot(ctx, session)
    let rootReal
    try {
      rootReal = await fsp.realpath(path.resolve(root))
    } catch (err) {
      throw httpError(409, 'NO_WORKSPACE', 'The workspace folder for this conversation is not readable.')
    }
    const candidate = path.resolve(rootReal, ...normalized.split('/').filter((segment) => segment !== '' && segment !== '.'))
    try {
      target = await fsp.realpath(candidate)
    } catch (err) {
      throw httpError(404, 'NOT_FOUND', 'No such file in this workspace: ' + value)
    }
    const inside = target === rootReal || target.startsWith(rootReal + path.sep)
    if (!inside) throw httpError(403, 'OUTSIDE_WORKSPACE', 'That path points outside the conversation workspace: ' + value)
    scope = 'workspace'
    relative = path.relative(rootReal, target).split(path.sep).join('/')
  }
  if (extensionOf(target) !== 'pdf') {
    throw httpError(415, 'NOT_PDF', 'Only *.pdf files are read here: ' + path.basename(target))
  }
  let stats
  try {
    stats = statSync(target)
  } catch (err) {
    throw httpError(404, 'NOT_FOUND', 'No such file: ' + target)
  }
  if (!stats.isFile()) throw httpError(400, 'NOT_A_FILE', 'That is not a regular file: ' + target)
  if (stats.size > MAX_PDF_BYTES) {
    throw httpError(413, 'TOO_LARGE', 'That PDF is ' + Math.round(stats.size / (1024 * 1024)) + ' MB; this plugin reads up to ' + Math.round(MAX_PDF_BYTES / (1024 * 1024)) + ' MB.')
  }
  if (stats.size < 5) throw httpError(415, 'NOT_PDF', 'That file is too small to be a PDF.')
  return { file: target, scope, relative, session: typeof session === 'string' ? session : '', size: stats.size, mtimeMs: stats.mtimeMs }
}

/** The `dsh-resource:` address a PDF's tab is opened at. */
function addressFor(target, session) {
  if (target.scope === 'workspace' && typeof session === 'string' && session.length > 0) {
    const encoded = target.relative.split('/').map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')).join('/')
    return 'dsh-resource://file/session/' + encodeURIComponent(session) + '/' + encoded
  }
  // A path outside any workspace rides this package's own address shape, with
  // the whole path as ONE encoded segment: the ordinary file grammar drops the
  // leading slash of a POSIX absolute path, which would silently point at the
  // wrong place.
  return 'dsh-resource://pdf/absolute/' + encodeURIComponent(target.file)
}

/** Parse a page-range argument: `"3"`, `"1-5"`, `"all"`, or absent. */
function parsePages(value, numPages) {
  if (value === undefined || value === null || value === '' || value === 'all') return { from: 1, to: numPages, all: true }
  const text = String(value).trim()
  const range = /^(\d+)\s*(?:-|–|to)\s*(\d+)$/i.exec(text)
  const single = /^(\d+)$/.exec(text)
  if (range) {
    const from = Math.max(1, Number(range[1]))
    const to = Math.min(numPages, Number(range[2]))
    if (to < from) throw new Error('That page range is empty (pages run 1 to ' + numPages + ').')
    return { from, to, all: from === 1 && to === numPages }
  }
  if (single) {
    const n = Number(single[1])
    if (n < 1 || n > numPages) throw new Error('Page ' + n + ' does not exist; this document has ' + numPages + ' page' + (numPages === 1 ? '' : 's') + '.')
    return { from: n, to: n, all: numPages === 1 }
  }
  throw new Error('Could not read a page range from "' + text + '". Use "3", "1-5", or "all".')
}

/** The pages `pdf_info` inspects: everything in a small document, a sample in a big one. */
function infoSample(numPages) {
  if (numPages <= MAX_INFO_PAGES) {
    const all = []
    for (let n = 1; n <= numPages; n++) all.push(n)
    return { pages: all, sampled: false }
  }
  const step = Math.max(1, Math.floor(numPages / INFO_SAMPLE_PAGES))
  const pages = new Set()
  for (let n = 1; n <= INFO_SAMPLE_PAGES; n++) pages.add(n)
  for (let n = INFO_SAMPLE_PAGES; n <= numPages; n += step) pages.add(n)
  pages.add(numPages)
  return { pages: [...pages].sort((a, b) => a - b), sampled: true }
}

/** A page's character count, as stored. */
function charsOf(stats, n) {
  const entry = stats[String(n)]
  return entry && Number.isFinite(entry.chars) ? entry.chars : null
}

/** Human bytes. */
function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'unknown size'
  if (bytes < 1024) return bytes + ' bytes'
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KiB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

/** The ability block every answer may quote: what this host can and cannot do. */
function capabilities(engines, ocrLanguages) {
  return {
    rasterizer: engines.rasterizer ? { available: true, name: engines.rasterizer.name } : { available: false, name: null },
    ocr: {
      available: Boolean(engines.ocr),
      name: engines.ocr ? engines.ocr.name : null,
      languages: Array.isArray(ocrLanguages) ? ocrLanguages : null,
    },
  }
}

/** One line naming the optional engines, so a model can stop guessing. */
function capabilityLine(engines, ocrLanguages) {
  const parts = []
  parts.push(engines.rasterizer ? 'page rasterizer: ' + engines.rasterizer.name : 'page rasterizer: none on PATH (pdf_render cannot write pictures, and pdf_scan cannot draw a page to recognize; install poppler, mutool or Ghostscript)')
  if (!engines.ocr) parts.push('OCR: tesseract not on PATH (pdf_scan cannot recognize a scanned page)')
  else if (Array.isArray(ocrLanguages) && ocrLanguages.length > 0) parts.push('OCR: ' + engines.ocr.name + ' (' + ocrLanguages.slice(0, 12).join(', ') + (ocrLanguages.length > 12 ? ', ...' : '') + ')')
  else parts.push('OCR: ' + engines.ocr.name)
  return parts.join(' | ')
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
/**
 * Split one skill document into its frontmatter and its body.
 *
 * @param text - the file's contents.
 * @returns `{ meta, content }`.
 */
export function parseSkillFile(text) {
  const normalized = String(text).replace(/\r\n?/g, '\n')
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized)
  if (!match) return { meta: {}, content: normalized.trim() }
  const meta = {}
  for (const line of match[1].split('\n')) {
    const entry = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (!entry) continue
    let value = entry[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    meta[entry[1]] = value
  }
  return { meta, content: normalized.slice(match[0].length).trim() }
}

/**
 * Register the bundled skill on the skill registry, reading the markdown from
 * this package's own `skills/` folder. The registry is resolved lazily (its
 * absence only skips the skill, never the tools) and a missing file is a
 * warning rather than a failure - the installer also copies that file into
 * `$DSH_HOME/skills`, so a host without it still gets the catalog entry from
 * the filesystem provider.
 *
 * @param ctx - the cordis context.
 * @param log - `{ warn }`.
 * @returns the number of skills registered.
 */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (!skills || typeof skills.register !== 'function') {
    log.warn('skill registry unavailable - the bundled PDF skill was not registered')
    return 0
  }
  let count = 0
  for (const entry of SKILL_FILES) {
    try {
      const file = fileURLToPath(new URL(entry.file, import.meta.url))
      const { meta, content } = parseSkillFile(readFileSync(file, 'utf8'))
      if (content.length === 0) {
        log.warn('skill file is empty: ' + file)
        continue
      }
      const name = typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : entry.name
      ctx.effect(
        () =>
          skills.register({
            name,
            description: typeof meta.description === 'string' ? meta.description : '',
            whenToUse: typeof meta.whenToUse === 'string' ? meta.whenToUse : undefined,
            content,
            provider: 'dsh-pdf',
          }),
        'dsh-pdf: skill ' + name,
      )
      count += 1
    } catch (err) {
      log.warn('could not register skill ' + entry.name + ': ' + messageOf(err))
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
/** The tab-facing view a settled call hands the conversation card. */
const VIEW_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    name: { type: 'string' },
    address: { type: 'string' },
    scope: { type: 'string', enum: ['workspace', 'absolute'] },
    pages: { type: 'number' },
    mode: { type: 'string' },
    sampled: { type: 'boolean' },
    scanned: { type: 'array', items: { type: 'number' } },
    hits: { type: 'number' },
    images: { type: 'array', items: { type: 'string' } },
    dpi: { type: 'number' },
    cached: { type: 'boolean' },
    ocr: {
      type: 'object',
      properties: {
        engine: { type: 'string' },
        lang: { type: 'string' },
        dpi: { type: 'number' },
        pages: { type: 'array', items: { type: 'number' } },
      },
      required: ['engine'],
    },
  },
  required: ['file'],
}

const PATH_SCHEMA = {
  type: 'string',
  description:
    'The PDF to read: a path inside this conversation\'s workspace (relative), or an absolute path - an attachment from this chat lives under <DSH_HOME>/attachments/v1/files/..., which is absolute.',
}

/**
 * Build the four tools.
 *
 * @param deps - `{ reader, cache, enginesNow, reprobe, version, log }`.
 * @returns the tool definitions to register.
 */
export function buildTools(deps) {
  const { reader, cache } = deps

  /**
   * Resolve a tool's path under the stated policy, turning a typed refusal into
   * readable text: a model that asked for the wrong file should read why, not
   * get a crashed tool call.
   */
  const toolTarget = async (args, exec) => {
    try {
      return { ok: true, target: await resolveTarget(deps.ctx, { session: sessionOf(exec), path: args.path }) }
    } catch (err) {
      return { ok: false, text: messageOf(err), file: typeof args.path === 'string' ? args.path : '' }
    }
  }

  /** Shared completed-call presentation. */
  const resultView = (args, result) => ({
    card: 'generic',
    title: 'PDF ' + (result.meta && result.meta.name ? result.meta.name : args && args.path ? String(args.path) : ''),
    content: result.content,
  })

  /** Shared pending-call presentation. */
  const callView = (args, verb) => ({ card: 'generic', title: verb + ' ' + (args && args.path ? String(args.path) : 'a PDF'), kind: 'other' })

  const info = {
    name: 'pdf_info',
    description: [
      'Describe a PDF before reading it: page count and page sizes, document metadata (title, author, subject, keywords, producer, dates, PDF version), whether it is encrypted, linearized, or carries a form, signatures or attachments, its bookmark OUTLINE with page numbers, and - per page - how much text it has and how many images.',
      'The text-layer numbers are the point: a page with 0 characters and images is a SCAN, and no amount of reading will produce its text. This tool is what tells you that up front.',
      'A large document is SAMPLED (first pages, then every n-th page, plus the last) and says so; pass `pages` to inspect an exact range instead.',
      'Costs one parse of the document; the result is cached per page, so pdf_read and pdf_find afterwards are cheap.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: PATH_SCHEMA,
        pages: { type: 'string', description: 'An exact page range to inspect instead of the automatic sample, e.g. "1-10".' },
        refresh: { type: 'boolean', description: 'Ignore the cached facts and parse the document again.' },
        password: { type: 'string', description: 'Only for an encrypted document. Never stored, never cached.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA }, required: ['text', 'view'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: (args) => callView(args, 'Inspect'),
    presentResult: resultView,
    async execute(args, exec) {
      const resolved = await toolTarget(args, exec)
      if (!resolved.ok) return { text: resolved.text, view: { file: resolved.file } }
      const target = resolved.target
      const facts = await reader.facts(target.file, { signal: exec.signal, password: args.password, refresh: args.refresh === true })
      if (!facts.ok) return { text: failureText(target, facts), view: viewOf(target, {}, { pages: 0 }) }
      const doc = facts.doc
      const numPages = doc.numPages
      const sample =
        typeof args.pages === 'string' && args.pages.trim() !== ''
          ? (() => {
              const range = parsePages(args.pages, numPages)
              return { pages: rangeOf(range.from, range.to), sampled: false }
            })()
          : infoSample(numPages)
      const stats = await ensureStats(reader, target.file, facts.sha, sample.pages, exec)
      const ocrLanguages = (await languagesFor(deps.enginesNow().ocr)).list
      const text = infoText({ target, doc, facts, sample, stats, engines: deps.enginesNow(), ocrLanguages, version: deps.version })
      return {
        text,
        view: viewOf(target, { pages: numPages, scanned: scannedPages(stats, sample.pages), sampled: sample.sampled, cached: facts.cached }),
      }
    },
  }

  const read = {
    name: 'pdf_read',
    description: [
      'Read the TEXT of a PDF, page by page. This is how you actually read a document: a PDF is not text on disk, and reading its bytes gives you nothing.',
      'Two modes. `text` is the plain stream in reading order. `layout` reconstructs the page geometry: runs are grouped into lines by their baseline and joined left-to-right, so columns stay apart and a label and its value stay on one line - use it for invoices, statements, tables and academic papers. Try `layout` when `text` looks scrambled.',
      'Read a RANGE, not the whole document: `pages: "1-5"`. The answer is capped (`maxChars`) and says exactly what it dropped, so you can ask for the rest. A page with no text layer is reported as such instead of being returned empty.',
      'Pages are cached: reading a range twice costs nothing, and pdf_find warms the same cache.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: PATH_SCHEMA,
        pages: { type: 'string', description: 'The range to read: "3", "1-5", or "all" (default "1-3").' },
        mode: { type: 'string', enum: ['text', 'layout'], description: '`layout` reconstructs lines and columns; `text` is the raw reading order. Default text.' },
        maxChars: { type: 'number', description: 'Character ceiling for this answer (default ' + DEFAULT_READ_CHARS + ', max ' + MAX_READ_CHARS + ').' },
        password: { type: 'string', description: 'Only for an encrypted document. Never stored.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA }, required: ['text', 'view'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: (args) => callView(args, 'Read'),
    presentResult: resultView,
    async execute(args, exec) {
      const resolved = await toolTarget(args, exec)
      if (!resolved.ok) return { text: resolved.text, view: { file: resolved.file } }
      const target = resolved.target
      const mode = args.mode === 'layout' ? 'layout' : 'text'
      const maxChars = Math.min(MAX_READ_CHARS, Math.max(1, Number.isFinite(args.maxChars) ? Math.floor(args.maxChars) : DEFAULT_READ_CHARS))
      const facts = await reader.facts(target.file, { signal: exec.signal, password: args.password })
      if (!facts.ok) return { text: failureText(target, facts), view: viewOf(target, {}, { pages: 0 }) }
      const doc = facts.doc
      let range
      try {
        range = parsePages(args.pages ?? '1-3', doc.numPages)
      } catch (err) {
        return { text: 'Could not read that page range: ' + messageOf(err), view: viewOf(target, { pages: doc.numPages }) }
      }
      const result = await reader.pages({
        file: target.file,
        sha: facts.sha,
        from: range.from,
        to: range.to,
        signal: exec.signal,
        password: args.password,
      })
      const built = readText({ target, range, mode, maxChars, result })
      return {
        text: built.text,
        view: viewOf(target, {
          pages: doc.numPages,
          mode,
          scanned: result.pages.filter((page) => (page.chars ?? 0) === 0).map((page) => page.n),
          cached: result.extracted === 0,
        }),
      }
    },
  }

  const find = {
    name: 'pdf_find',
    description: [
      'Find where a PDF says something, without reading all of it: a literal string (default) or a regular expression, with the page, the line and the surrounding context of every hit.',
      'This is the cheap way to answer "does this document mention X" and "what does it say about X": it walks the pages once, remembers them in the cache, and then pdf_read on the interesting pages is free.',
      'A big document is walked under a wall-clock budget; the answer always states how many pages were searched and where to continue if it stopped early.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'query'],
      properties: {
        path: PATH_SCHEMA,
        query: { type: 'string', description: 'What to look for.' },
        regex: { type: 'boolean', description: 'Treat `query` as a regular expression (case-insensitive unless caseSensitive).' },
        caseSensitive: { type: 'boolean', description: 'Match case exactly. Default false.' },
        pages: { type: 'string', description: 'Restrict the search to a range, e.g. "1-20".' },
        maxHits: { type: 'number', description: 'Hit ceiling (default 20, max ' + FIND_MAX_HITS + ').' },
        context: { type: 'number', description: 'Characters of context around each hit (default 90, max 300).' },
        mode: { type: 'string', enum: ['text', 'layout'], description: 'Which text to search. `layout` is usually better for tables. Default text.' },
        password: { type: 'string', description: 'Only for an encrypted document. Never stored.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA }, required: ['text', 'view'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: (args) => callView(args, 'Search'),
    presentResult: resultView,
    async execute(args, exec) {
      const resolved = await toolTarget(args, exec)
      if (!resolved.ok) return { text: resolved.text, view: { file: resolved.file } }
      const target = resolved.target
      const query = String(args.query ?? '')
      if (query === '') return { text: 'A query is required.', view: viewOf(target, {}) }
      let matcher
      try {
        matcher = buildMatcher(query, args.regex === true, args.caseSensitive === true)
      } catch (err) {
        return { text: 'That regular expression is not valid: ' + messageOf(err), view: viewOf(target, {}) }
      }
      const facts = await reader.facts(target.file, { signal: exec.signal, password: args.password })
      if (!facts.ok) return { text: failureText(target, facts), view: viewOf(target, {}, { pages: 0 }) }
      const doc = facts.doc
      let range
      try {
        range = parsePages(args.pages ?? 'all', doc.numPages)
      } catch (err) {
        return { text: 'Could not read that page range: ' + messageOf(err), view: viewOf(target, { pages: doc.numPages }) }
      }
      const to = Math.min(range.to, range.from + FIND_MAX_PAGES - 1)
      const maxHits = Math.min(FIND_MAX_HITS, Math.max(1, Number.isFinite(args.maxHits) ? Math.floor(args.maxHits) : 20))
      const context = Math.min(300, Math.max(0, Number.isFinite(args.context) ? Math.floor(args.context) : 90))
      const mode = args.mode === 'layout' ? 'layout' : 'text'
      const walked = await reader.walk({
        file: target.file,
        sha: facts.sha,
        from: range.from,
        to,
        budgetMs: FIND_BUDGET_MS,
        signal: exec.signal,
        password: args.password,
      })
      const built = findText({ target, query, matcher, walked, mode, maxHits, context })
      return {
        text: built.text,
        view: viewOf(target, {
          pages: doc.numPages,
          mode,
          hits: built.hits.length,
          scanned: walked.pages.filter((page) => (page.chars ?? 0) === 0).map((page) => page.n).slice(0, 40),
        }),
      }
    },
  }

  const render = {
    name: 'pdf_render',
    description: [
      'Render PDF pages as PNG pictures, written as NEW files. Use it to look at a page that has no text (a scan, a chart, a signature, a stamp), to check the layout of a page you are describing, or to hand the user a picture of a page.',
      'Needs a rasterizer on this host (poppler `pdftoppm`, `mutool`, or Ghostscript). If none is installed the tool says so instead of guessing.',
      'Files are written create-exclusively under a name this tool generates - `<pdf-name>-page<N>-<dpi>dpi.png` - either in the conversation workspace (default) or in a directory you name. It never overwrites an existing file and never writes to the PDF itself.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: PATH_SCHEMA,
        pages: { type: 'string', description: 'Which pages to render: "3", "1-5" (default "1"). At most ' + RENDER_MAX_PAGES + ' pages per call.' },
        dpi: { type: 'number', description: 'Resolution, ' + MIN_DPI + '-' + MAX_DPI + ' (default ' + DEFAULT_DPI + '). 150 is readable; 300 is OCR/print quality.' },
        out: { type: 'string', description: 'Directory to write into (relative to the workspace, or absolute). Default: the conversation workspace.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA }, required: ['text', 'view'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: (args) => callView(args, 'Render'),
    presentResult: resultView,
    async execute(args, exec) {
      const session = sessionOf(exec)
      const resolved = await toolTarget(args, exec)
      if (!resolved.ok) return { text: resolved.text, view: { file: resolved.file } }
      const target = resolved.target
      const engines = deps.enginesNow()
      if (!engines.rasterizer) {
        return {
          text:
            'This host has no PDF rasterizer, so no picture can be written.\n' +
            'Install one of poppler (`pdftoppm`), `mutool` (MuPDF) or Ghostscript, then call pdf_render again.\n' +
            'The PDF itself is readable without it: pdf_read gives the text, and the PDF opens in the right bar\u2019s reader.',
          view: viewOf(target, {}),
        }
      }
      const facts = await reader.facts(target.file, { signal: exec.signal })
      if (!facts.ok) return { text: failureText(target, facts), view: viewOf(target, {}, { pages: 0 }) }
      const doc = facts.doc
      let range
      try {
        range = parsePages(args.pages ?? '1', doc.numPages)
      } catch (err) {
        return { text: 'Could not read that page range: ' + messageOf(err), view: viewOf(target, { pages: doc.numPages }) }
      }
      let from = range.from
      let to = Math.min(range.to, range.from + RENDER_MAX_PAGES - 1)
      const dropped = range.to - to
      const dpi = clampDpi(args.dpi)
      const outDir = await resolveOutputDir(deps.ctx, session, args.out)
      const ra = await rasterize({ engine: engines.rasterizer, file: target.file, from, to, dpi })
      if (!ra.ok) {
        return {
          text:
            'The rasterizer (' +
            engines.rasterizer.name +
            ') could not produce a picture' +
            (ra.reason === 'timeout' ? ' before the deadline' : '') +
            '.\n' +
            (ra.stderr ? 'It said: ' + ra.stderr.split(/\r?\n/).filter(Boolean).slice(0, 4).join(' / ') : ''),
          view: viewOf(target, { pages: doc.numPages, dpi }),
        }
      }
      const stem = path.basename(target.file).replace(/\.pdf$/i, '')
      const written = []
      for (const page of ra.pages) {
        const name = sanitizeName(stem) + '-page' + page.page + '-' + dpi + 'dpi.png'
        const destination = uniquePath(outDir, name)
        try {
          writeFileSync(destination, page.bytes, { flag: 'wx' })
          written.push({ page: page.page, file: destination, bytes: page.bytes.byteLength, width: page.width, height: page.height })
        } catch (err) {
          deps.log.warn('could not write ' + destination + ': ' + messageOf(err))
        }
      }
      const lines = [
        'Rendered ' + written.length + ' page' + (written.length === 1 ? '' : 's') + ' of ' + path.basename(target.file) + ' at ' + dpi + ' dpi (' + engines.rasterizer.name + '):',
      ]
      for (const entry of written) {
        lines.push('  p' + entry.page + '  ' + entry.file + '  ' + (entry.width && entry.height ? entry.width + 'x' + entry.height + ' px, ' : '') + humanBytes(entry.bytes))
      }
      if (dropped > 0) lines.push('(' + dropped + ' more page(s) were not rendered: at most ' + RENDER_MAX_PAGES + ' per call.)')
      lines.push('These are new files; the PDF itself was not touched. The right bar\u2019s reader shows the same pages without writing anything.')
      return {
        text: lines.join('\n'),
        view: viewOf(target, { pages: doc.numPages, dpi, images: written.map((entry) => entry.file) }),
      }
    },
  }

  /**
   * `pdf_scan` - the scanner.
   *
   * The default page selection is the whole point: with no `pages` it scans
   * exactly the pages `pdf_info` found to have NO text layer, because those are
   * the only pages where recognition is better than reading. A page that already
   * carries text is never sent to OCR behind the caller's back - recognized text
   * of a page that already had real text is strictly worse than the real text,
   * and offering it as a default would tempt a model into quoting the copy.
   */
  const scan = {
    name: 'pdf_scan',
    description: [
      'Recognize the text of SCANNED pages - pages that are a picture of text and carry no text layer, so pdf_read can only report that they are empty.',
      'With no `pages`, it scans exactly the pages that pdf_info found to have no text layer (at most ' + MAX_SCAN_PAGES + ' per call, and the answer names any it left). Pass `pages` to recognize a specific page or range instead - including a page that already has text, when you want to compare.',
      'It needs TWO engines on the server host: a rasterizer (poppler `pdftoppm`, `mutool` or Ghostscript) to draw the page, and `tesseract` with the language data for the document. If either is missing the answer says so in plain words and names what to install; nothing else in this plugin depends on them.',
      'Results are cached per page, language, resolution and segmentation mode, so recognizing a page twice costs nothing - but re-reading it at 300 dpi for a table after reading it at 200 dpi for prose is a NEW recognition, which is what `dpi` is for.',
      'What comes back is a TRANSCRIPTION, not ground truth: OCR misreads digits, names, accents and punctuation, and it invents nothing but can drop a column. Quote it as recognized text, say that it was recognized, and prefer pdf_read on any page that has a real text layer.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: PATH_SCHEMA,
        pages: { type: 'string', description: 'Page(s) to recognize: "7", "1-5", or "all". Default: the pages with no text layer, up to ' + MAX_SCAN_PAGES + '.' },
        dpi: { type: 'number', description: 'Raster resolution the page is drawn at, ' + MIN_DPI + '-' + MAX_DPI + ' (default ' + SCAN_DPI + '). Higher is slower and reads small print better.' },
        lang: { type: 'string', description: 'OCR language tag, e.g. "eng", "por", or "eng+por". Default ' + DEFAULT_LANG + '. The answer lists what this host has.' },
        psm: { type: 'number', description: 'tesseract page-segmentation mode 0-13 (default ' + DEFAULT_PSM + ': automatic, no orientation detection). Use 6 for one uniform block, 11 for sparse text.' },
        password: { type: 'string', description: 'Only for an encrypted document. Never stored.' },
      },
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, view: VIEW_SCHEMA }, required: ['text', 'view'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: (args) => callView(args, 'Scan'),
    presentResult: resultView,
    async execute(args, exec) {
      const resolved = await toolTarget(args, exec)
      if (!resolved.ok) return { text: resolved.text, view: { file: resolved.file } }
      const target = resolved.target
      const engines = deps.enginesNow()
      const facts = await reader.facts(target.file, { signal: exec.signal, password: args.password })
      if (!facts.ok) return { text: failureText(target, facts), view: viewOf(target, {}, { pages: 0 }) }
      const doc = facts.doc
      const lang = (typeof args.lang === 'string' && args.lang.trim() !== '' ? args.lang : DEFAULT_LANG).toLowerCase()
      const psm = Number.isInteger(args.psm) ? args.psm : DEFAULT_PSM
      const dpi = clampDpi(args.dpi ?? SCAN_DPI)

      // Which pages need scanning, and how that was decided - the answer always
      // says which, because "which pages did you read" is the model's business.
      let chosen = []
      let how = ''
      if (typeof args.pages === 'string' && args.pages.trim() !== '' && args.pages.trim() !== 'auto') {
        try {
          const range = parsePages(args.pages, doc.numPages)
          chosen = rangeOf(range.from, range.to)
          how = 'the pages you asked for'
        } catch (err) {
          return { text: 'Could not read that page range: ' + messageOf(err), view: viewOf(target, { pages: doc.numPages }) }
        }
      } else {
        const stats = await ensureStats(reader, target.file, facts.sha, probePages(doc.numPages), exec)
        chosen = Object.keys(stats)
          .map(Number)
          .filter((n) => (stats[String(n)] ?? {}).chars === 0)
          .sort((a, b) => a - b)
        how = 'the inspected pages that carry no text'
      }

      const capped = chosen.slice(0, MAX_SCAN_PAGES)
      const left = chosen.slice(MAX_SCAN_PAGES)
      const result =
        capped.length === 0
          ? { ok: false, reason: 'no-pages', pages: [], scanned: 0, fromCache: 0, skipped: [] }
          : await scanPages({
              cache,
              engines,
              file: target.file,
              sha: facts.sha,
              pages: capped,
              dpi,
              lang,
              psm,
              signal: exec.signal,
              log: deps.log.warn,
            })
      const text = scanText({ target, doc, result, chosen: capped, left, how, lang, dpi, psm, engines, ocrLanguages: (await languagesFor(engines.ocr)).list })
      return {
        text,
        view: viewOf(target, {
          pages: doc.numPages,
          dpi,
          mode: 'ocr',
          ...(result.ok
            ? {
                ocr: {
                  engine: String(result.engine ?? engines.ocr?.name ?? 'ocr'),
                  lang: String(result.lang ?? lang),
                  dpi: Number(result.dpi ?? dpi),
                  pages: (result.pages ?? []).filter((page) => !page.error).map((page) => page.n),
                },
                cached: result.scanned === 0,
              }
            : {}),
        }),
      }
    },
  }

  return [info, read, find, render, scan]
}

/** The pages `pdf_scan` inspects to find the ones with no text layer. */
function probePages(numPages) {
  const pages = []
  for (let n = 1; n <= Math.min(numPages, SCAN_PROBE_PAGES); n++) pages.push(n)
  return pages
}

/** The `pdf_scan` answer. */
function scanText({ target, doc, result, chosen, left, how, lang, dpi, psm, engines, ocrLanguages }) {
  const name = path.basename(target.file)
  const lines = []
  if (!result.ok) {
    lines.push(scanReasonText(result.reason, { available: result.available }))
    if (result.reason === 'no-pages') {
      lines.push('Every inspected page of ' + name + ' already has a text layer, so there is nothing to recognize: read it with pdf_read. To recognize a page anyway (to compare, or because its text is unusable), pass `pages`, e.g. { "path": ' + JSON.stringify(target.file) + ', "pages": "1" }.')
      lines.push('This host can: ' + capabilityLine(engines, ocrLanguages))
      return lines.join('\n')
    }
    if (result.reason === 'no-ocr' || result.reason === 'no-rasterizer') {
      lines.push('Pages of ' + name + ' still readable without OCR: pdf_read gives whatever text layer exists, and the right bar\u2019s reader shows the pages as pictures. pdf_render can write a page as a PNG.')
      lines.push('This host can: ' + capabilityLine(engines, ocrLanguages))
    }
    return lines.join('\n')
  }

  const recognized = result.pages.filter((page) => typeof page.text === 'string')
  const failed = result.pages.filter((page) => page.error)
  const characters = recognized.reduce((sum, page) => sum + (page.chars ?? 0), 0)
  lines.push(
    'Recognized ' +
      recognized.length +
      ' page' +
      (recognized.length === 1 ? '' : 's') +
      ' of ' +
      name +
      ' with ' +
      result.engine +
      ' (' +
      result.lang +
      ', ' +
      result.dpi +
      ' dpi, psm ' +
      result.psm +
      ') - ' +
      characters +
      ' characters from ' +
      how +
      '.',
  )
  if (result.fromCache > 0) lines.push('(' + result.fromCache + ' page(s) came from the cache; ' + result.scanned + ' were recognized now.)')
  for (const page of result.pages) {
    lines.push('')
    if (page.error) {
      lines.push('--- page ' + page.n + ': NOT RECOGNIZED --- ' + page.error)
      continue
    }
    lines.push('--- page ' + page.n + ' (recognized text, not extracted) ---')
    lines.push(page.text === '' ? '(the engine found no text on this page)' : page.text)
  }
  if (left.length > 0) {
    lines.push('')
    lines.push('(' + left.length + ' more page(s) need scanning (' + left.slice(0, 20).join(', ') + (left.length > 20 ? ', ...' : '') + '): at most ' + MAX_SCAN_PAGES + ' per call. Call pdf_scan again with `pages` for the next batch.)')
  }
  if (failed.length > 0) {
    lines.push('')
    lines.push('(' + failed.length + ' page(s) could not be recognized: ' + failed.map((page) => page.n).join(', ') + '. A higher `dpi` often helps a page the engine refused; `psm` 6 or 11 helps a page whose layout confused it.)')
  }
  lines.push('')
  lines.push('This is a transcription: OCR misreads digits, names, accents and punctuation, and can drop a column. Say that these pages were recognized rather than extracted when you quote them, and read any page that has a real text layer with pdf_read instead.')
  return lines.join('\n')
}

/** The session id one tool call belongs to. */
function sessionOf(exec) {
  const session = exec && exec.agent && exec.agent.session
  const id = session && session.id
  if (typeof id !== 'string' || id === '') throw new Error('the pdf tools require an owning agent session')
  return id
}

/** The tab view for one target. */
function viewOf(target, extra = {}, override = {}) {
  return {
    file: target.file,
    name: path.basename(target.file),
    address: addressFor(target, target.session),
    scope: target.scope,
    ...override,
    ...extra,
  }
}

/** Text for a failed read, always naming what was actually wrong. */
function failureText(target, facts) {
  const name = path.basename(target.file)
  const kind = facts.failure && facts.failure.kind ? facts.failure.kind : 'error'
  if (kind === 'password') {
    return name + ' is encrypted. Pass its password as `password` - it is used for this call only and never stored.'
  }
  if (kind === 'invalid') {
    return name + ' is not a readable PDF (the parser says: ' + (facts.error ?? 'invalid structure') + '). A truncated download is the usual cause.'
  }
  if (kind === 'timeout') {
    return name + ' took longer than the extraction deadline and was stopped. It may be damaged, or enormous; try pdf_info on a page range.'
  }
  return 'Could not read ' + name + ': ' + (facts.error ?? kind)
}

/** A `[from, to]` page number list. */
function rangeOf(from, to) {
  const pages = []
  for (let n = from; n <= to; n++) pages.push(n)
  return pages
}

/** Extract (or take from cache) the stats for a set of pages. */
async function ensureStats(reader, file, sha, pages, exec) {
  const wanted = [...pages].sort((a, b) => a - b)
  if (wanted.length === 0) return {}
  const result = await reader.pages({ file, sha, from: wanted[0], to: wanted[wanted.length - 1], signal: exec.signal })
  const stats = {}
  for (const page of result.pages) {
    stats[page.n] = {
      n: page.n,
      width: page.width,
      height: page.height,
      rotate: page.rotate,
      chars: page.chars,
      images: page.images,
      annots: page.annots,
      fonts: (page.fonts ?? []).length,
    }
  }
  return stats
}

/** The pages inspected that carry no text at all - the scan signal. */
function scannedPages(stats, wanted) {
  return wanted.filter((n) => charsOf(stats, n) === 0).slice(0, 60)
}

/** The `pdf_info` answer. */
function infoText({ target, doc, facts, sample, stats, engines, ocrLanguages, version }) {
  const info = doc.info ?? {}
  const numPages = doc.numPages
  const lines = []
  lines.push('PDF: ' + path.basename(target.file))
  lines.push('Path: ' + target.file)
  lines.push('Size: ' + humanBytes(doc.bytes ?? target.size) + ' | Pages: ' + numPages + ' | PDF ' + (info.PDFFormatVersion ?? '?') + ' | Engine: pdf.js ' + (doc.engine ?? version))
  const attribution = [info.Title, info.Author && 'by ' + info.Author, info.Producer && 'produced by ' + info.Producer, info.Creator && 'created with ' + info.Creator]
    .filter(Boolean)
    .join(' | ')
  if (attribution !== '') lines.push('Title/Producer: ' + attribution)
  if (info.Subject) lines.push('Subject: ' + info.Subject)
  if (info.Keywords) lines.push('Keywords: ' + info.Keywords)
  const dates = [info.CreationDate && 'created ' + info.CreationDate, info.ModDate && 'modified ' + info.ModDate].filter(Boolean).join(', ')
  if (dates !== '') lines.push('Dates: ' + dates)
  const flags = [
    info.EncryptFilterName ? 'encrypted (' + info.EncryptFilterName + ')' : 'not encrypted',
    info.IsLinearized ? 'linearized' : null,
    info.IsAcroFormPresent ? 'has a form' : null,
    info.IsXFAPresent ? 'has XFA' : null,
    info.IsSignaturesPresent ? 'has signatures' : null,
    info.IsCollectionPresent ? 'is a collection' : null,
    (doc.attachments ?? []).length > 0 ? (doc.attachments ?? []).length + ' attachment(s)' : null,
  ].filter(Boolean)
  lines.push('Document: ' + flags.join(', '))

  // ---- the text layer: the number that decides what you can even try ----
  const inspected = Object.keys(stats).map(Number).sort((a, b) => a - b)
  const withText = inspected.filter((n) => (charsOf(stats, n) ?? 0) > 0)
  const empty = inspected.filter((n) => charsOf(stats, n) === 0)
  lines.push(
    'Text layer: ' +
      withText.length +
      ' of ' +
      inspected.length +
      ' inspected page(s) have text' +
      (sample.sampled ? ' (sampled - pass `pages` to inspect an exact range)' : ''),
  )
  if (empty.length > 0) {
    const withImages = empty.filter((n) => (stats[String(n)] ?? {}).images > 0)
    lines.push(
      '  No text on page(s): ' +
        empty.slice(0, 40).join(', ') +
        (empty.length > 40 ? ' (+' + (empty.length - 40) + ' more)' : '') +
        (withImages.length > 0 ? ' - these carry image data, so they are almost certainly SCANS (pdf_scan can recognize their text where an OCR engine is installed; pdf_render shows them as pictures)' : ''),
    )
  }
  const first = inspected.length > 0 ? stats[String(inspected[0])] : null
  if (first && first.width && first.height) {
    const pt = first.width + 'x' + first.height + ' pt'
    lines.push('Page size: ' + pt + describeFormat(first.width, first.height) + (first.rotate ? ', rotated ' + first.rotate + '\u00b0' : ''))
  }
  if (inspected.length > 0 && inspected.length <= 40) {
    lines.push('Per page:')
    for (const n of inspected) {
      const entry = stats[String(n)] ?? {}
      lines.push(
        '  p' +
          n +
          ': ' +
          (entry.chars ?? 0) +
          ' chars' +
          (entry.images ? ', ' + entry.images + ' image(s)' : '') +
          (entry.annots ? ', ' + entry.annots + ' annotation(s)' : '') +
          (entry.fonts ? ', ' + entry.fonts + ' font(s)' : '') +
          (entry.rotate ? ', rotated' : ''),
      )
    }
  } else if (inspected.length > 40) {
    lines.push('  (' + inspected.length + ' pages inspected; per-page detail is omitted - use pdf_read or pdf_find.)')
  }

  const outline = flattenOutline(doc.outline ?? [])
  if (outline.length > 0) {
    lines.push('Outline (' + outline.length + '):')
    for (const entry of outline.slice(0, 40)) lines.push('  ' + '  '.repeat(entry.depth) + '- ' + entry.title + (entry.page ? ' (p' + entry.page + ')' : ''))
    if (outline.length > 40) lines.push('  (+' + (outline.length - 40) + ' more)')
  } else {
    lines.push('Outline: none')
  }
  if ((doc.attachments ?? []).length > 0) {
    lines.push('Embedded files:')
    for (const attachment of (doc.attachments ?? []).slice(0, 10)) lines.push('  - ' + attachment.name + (attachment.size ? ' (' + humanBytes(attachment.size) + ')' : ''))
  }
  for (const warning of facts.warnings ?? []) lines.push('Note: ' + warning)
  lines.push('This host can: ' + capabilityLine(engines, ocrLanguages))
  lines.push('Tab: ' + addressFor(target, target.session) + ' (opens this PDF in the right bar)')
  return lines.join('\n')
}

/** A rough paper-format naming for a page size, when it is one. */
function describeFormat(width, height) {
  const known = [
    [595, 842, 'A4'],
    [612, 792, 'Letter'],
    [612, 1008, 'Legal'],
    [420, 595, 'A5'],
    [842, 1191, 'A3'],
  ]
  const short = Math.min(width, height)
  const long = Math.max(width, height)
  for (const [w, h, name] of known) {
    if (Math.abs(short - w) <= 3 && Math.abs(long - h) <= 3) return ' (' + name + ')'
  }
  return ''
}

/** The outline as flat `{ depth, title, page }` rows. */
function flattenOutline(entries, depth = 0) {
  const out = []
  for (const entry of entries) {
    out.push({ depth, title: String(entry.title ?? ''), page: entry.page ?? null })
    if (Array.isArray(entry.children) && entry.children.length > 0) out.push(...flattenOutline(entry.children, depth + 1))
  }
  return out
}

/** The `pdf_read` answer. */
function readText({ target, range, mode, maxChars, result }) {
  const lines = []
  const name = path.basename(target.file)
  let used = 0
  let truncated = false
  const header =
    name + ' — page' + (range.from === range.to ? ' ' + range.from : 's ' + range.from + '-' + range.to) + ' (' + (mode === 'layout' ? 'layout' : 'text') + ' mode)'
  lines.push(header)
  for (const page of result.pages) {
    const body = mode === 'layout' ? page.layout ?? page.text ?? '' : page.text ?? ''
    lines.push('')
    if (body === '') {
      const images = page.images ?? 0
      lines.push(
        '--- page ' + page.n + ': NO TEXT LAYER ---' + (images > 0 ? ' (this page is ' + images + ' image(s): a scan or a picture page)' : ' (empty page)'),
      )
      continue
    }
    const room = maxChars - used
    if (room <= 0) {
      truncated = true
      break
    }
    const slice = body.length > room ? body.slice(0, room) : body
    if (slice.length < body.length) truncated = true
    used += slice.length
    lines.push('--- page ' + page.n + ' ---')
    lines.push(slice)
  }
  if (result.missing.length > 0) {
    lines.push('')
    lines.push('(Page(s) ' + result.missing.slice(0, 20).join(', ') + (result.missing.length > 20 ? ' and more' : '') + ' could not be extracted.)')
  }
  for (const warning of result.warnings.slice(0, 6)) lines.push('Note: ' + warning)
  if (truncated) {
    lines.push('')
    lines.push('(Truncated at ' + used + ' of ' + maxChars + ' allowed characters. Ask for a smaller page range, or a higher maxChars, to see the rest.)')
  }
  const empty = result.pages.filter((page) => (page.chars ?? 0) === 0)
  if (empty.length > 0) {
    lines.push('')
    lines.push(
      '(' +
        empty.length +
        ' page(s) here have no text at all: ' +
        empty.map((page) => page.n).slice(0, 20).join(', ') +
        '. Their content is an image. pdf_scan recognizes their text where an OCR engine is installed; pdf_render turns a page into a PNG, and the right bar shows it.)',
    )
  }
  return { text: lines.join('\n'), truncated }
}

/** A test for one search query, with the flags applied. */
function buildMatcher(query, isRegex, caseSensitive) {
  if (isRegex) {
    const matcher = (text) => {
      const pattern = new RegExp(query, caseSensitive ? 'g' : 'gi')
      const hits = []
      let match
      while ((match = pattern.exec(text)) !== null) {
        hits.push({ index: match.index, length: Math.max(1, match[0].length), value: match[0] })
        if (match[0] === '') pattern.lastIndex += 1
        if (hits.length > 500) break
      }
      return hits
    }
    matcher.regex = true
    // Fail here rather than per page, so a bad pattern is one clear message.
    new RegExp(query, caseSensitive ? 'g' : 'gi')
    return matcher
  }
  const needle = caseSensitive ? query : query.toLowerCase()
  const matcher = (text) => {
    const haystack = caseSensitive ? text : text.toLowerCase()
    const hits = []
    let index = haystack.indexOf(needle)
    while (index !== -1) {
      hits.push({ index, length: needle.length, value: text.slice(index, index + needle.length) })
      index = haystack.indexOf(needle, index + Math.max(1, needle.length))
      if (hits.length > 500) break
    }
    return hits
  }
  matcher.regex = false
  return matcher
}

/** The `pdf_find` answer. */
function findText({ target, query, matcher, walked, mode, maxHits, context }) {
  const lines = []
  const name = path.basename(target.file)
  const hits = []
  const perPage = new Map()
  for (const page of walked.pages) {
    const body = mode === 'layout' ? page.layout ?? page.text ?? '' : page.text ?? ''
    if (body === '') continue
    const found = matcher(body)
    if (found.length === 0) continue
    perPage.set(page.n, found.length)
    for (const hit of found) {
      if (hits.length >= maxHits) break
      const start = Math.max(0, hit.index - context)
      const end = Math.min(body.length, hit.index + hit.value.length + context)
      hits.push({
        page: page.n,
        index: hit.index,
        before: (start > 0 ? '…' : '') + body.slice(start, hit.index).replace(/\s+/g, ' '),
        match: hit.value,
        after: body.slice(hit.index + hit.value.length, end).replace(/\s+/g, ' ') + (end < body.length ? '…' : ''),
      })
    }
    if (hits.length >= maxHits) break
  }
  lines.push(name + ' — search for ' + (matcher.regex ? '/' + query + '/i' : '"' + query + '"') + ' in ' + (mode === 'layout' ? 'layout' : 'text') + ' mode')
  lines.push('Searched ' + walked.scanned + ' page(s)' + (walked.exhausted ? ' (stopped early: ' + walked.skipped + ' page(s) not searched' + (walked.nextPage ? ', continue from page ' + walked.nextPage : '') + ')' : '') + '.')
  if (hits.length === 0) {
    lines.push('No matches.')
    const empty = walked.pages.filter((page) => (page.chars ?? 0) === 0)
    if (empty.length > 0) {
      lines.push(
        '(' + empty.length + ' of those pages have no text layer at all - page(s) ' + empty.map((page) => page.n).slice(0, 20).join(', ') + '. Their content is an image, so nothing can be found in them; pdf_scan can recognize their text where an OCR engine is installed, and pdf_render can show one as a picture.)',
      )
    }
  } else {
    const total = [...perPage.values()].reduce((sum, n) => sum + n, 0)
    lines.push(hits.length + ' hit(s) shown' + (total > hits.length ? ' of ' + total : '') + ', on page(s) ' + [...perPage.keys()].join(', ') + ':')
    for (const hit of hits) {
      lines.push('  p' + hit.page + ': …' + hit.before + '[' + hit.match + ']' + hit.after + '…')
    }
    if (total > hits.length) lines.push('(Raise maxHits to see more.)')
  }
  for (const warning of walked.warnings.slice(0, 6)) lines.push('Note: ' + warning)
  return { text: lines.join('\n'), hits }
}

/** A file name that is safe on every platform. */
function sanitizeName(value) {
  return String(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'document'
}

/** The first free name in a directory: `x.png`, then `x-2.png`, ... */
function uniquePath(dir, name) {
  const extension = path.extname(name)
  const stem = name.slice(0, name.length - extension.length)
  let candidate = path.join(dir, name)
  let attempt = 1
  while (existsSync(candidate) && attempt < 1000) {
    attempt += 1
    candidate = path.join(dir, stem + '-' + attempt + extension)
  }
  return candidate
}

/**
 * Where `pdf_render` writes. A caller names a DIRECTORY (never a file), so no
 * request can ever choose the name of what is written; a relative directory is
 * resolved inside the conversation workspace and an absolute one is used as
 * given. The directory must already exist.
 */
async function resolveOutputDir(ctx, session, requested) {
  if (typeof requested !== 'string' || requested.trim() === '') {
    const root = await sessionRoot(ctx, session)
    return path.resolve(root)
  }
  const value = requested.trim()
  if (isAbsolutePath(value)) {
    const resolved = path.resolve(value)
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw httpError(404, 'NO_SUCH_DIRECTORY', 'That output directory does not exist: ' + value)
    }
    return resolved
  }
  const root = await sessionRoot(ctx, session)
  const rootReal = await fsp.realpath(path.resolve(root))
  const resolved = path.resolve(rootReal, ...value.replace(/\\/g, '/').split('/').filter((segment) => segment !== '' && segment !== '.'))
  if (resolved !== rootReal && !resolved.startsWith(rootReal + path.sep)) {
    throw httpError(403, 'OUTSIDE_WORKSPACE', 'That output directory is outside the conversation workspace: ' + value)
  }
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw httpError(404, 'NO_SUCH_DIRECTORY', 'That output directory does not exist inside the workspace: ' + value)
  }
  return resolved
}

// ---------------------------------------------------------------------------
// The workspace index
// ---------------------------------------------------------------------------
/**
 * Every PDF in one conversation's workspace, bounded.
 *
 * The walk is deliberately timid: a fixed depth, a fixed file count, a small
 * skip-list of directories no PDF lives in, and no following of anything
 * unusual (a symlinked directory is skipped rather than trusted, because the
 * index is a convenience and never an authority - opening a file re-validates
 * it through the same `resolveTarget` every other read uses).
 *
 * Page counts are OPT-IN and capped: reporting one means parsing the document
 * (a child process each), which is worth 12 files on a click and never worth
 * doing for a directory nobody asked about.
 *
 * @param root - the realpath'd workspace root.
 * @param options - `{ withPages, reader, signal }`.
 * @returns `{ files, truncated }`.
 */
async function listWorkspacePdfs(root, { withPages = false, reader, signal } = {}) {
  const found = []
  let truncated = false
  const visit = async (dir, depth) => {
    if (truncated) return
    let entries
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch (err) {
      return
    }
    for (const entry of entries) {
      if (truncated) return
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth >= LIST_MAX_DEPTH || LIST_SKIP_DIRECTORIES.has(entry.name)) continue
        await visit(full, depth + 1)
        continue
      }
      // A symlink is not followed here: the index lists what is really there.
      if (!entry.isFile()) continue
      if (extensionOf(entry.name) !== 'pdf') continue
      if (found.length >= LIST_MAX_FILES) {
        truncated = true
        return
      }
      let stats
      try {
        stats = await fsp.stat(full)
      } catch (err) {
        continue
      }
      found.push({
        path: path.relative(root, full).split(path.sep).join('/'),
        bytes: stats.size,
        mtimeMs: stats.mtimeMs,
        tooLarge: stats.size > MAX_PDF_BYTES,
        pages: null,
      })
    }
  }
  await visit(root, 0)

  if (withPages) {
    let counted = 0
    for (const file of found) {
      if (counted >= LIST_PAGE_COUNT_FILES) break
      if (file.tooLarge) continue
      counted += 1
      try {
        const facts = await reader.facts(path.resolve(root, ...file.path.split('/')), { signal })
        if (facts.ok) file.pages = facts.doc.numPages
      } catch (err) {
        /* a document that will not parse keeps pages: null */
      }
      if (signal && signal.aborted) break
    }
    return { files: found, truncated, counted }
  }
  return { files: found, truncated, counted: 0 }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
/** Cache of the browser-facing asset maps (cMaps and standard fonts). */
const assetCache = new Map()

/** Read one vendored file from this package's own tree. */
async function vendoredFile(name) {
  const allowed = {
    'pdf.min.mjs': { file: './vendor/pdf.min.mjs', type: 'text/javascript; charset=utf-8' },
    'pdf.worker.min.mjs': { file: './vendor/pdf.worker.min.mjs', type: 'text/javascript; charset=utf-8' },
  }
  const entry = allowed[name]
  if (!entry) return null
  try {
    const bytes = await fsp.readFile(fileURLToPath(new URL(entry.file, import.meta.url)))
    const etag = '"' + createHash('sha1').update(bytes).digest('hex') + '"'
    return { bytes, type: entry.type, etag }
  } catch (err) {
    throw httpError(500, 'VENDOR_MISSING', 'The vendored pdf.js engine is missing (run: node packages/dsh-pdf/vendor/build.mjs).', err)
  }
}

/**
 * One tree of vendored assets as a name -> base64 map.
 *
 * The Connection fetch registry registers EXACT routes only - there is no
 * wildcard - so serving pdf.js's 169 cMap files and 16 standard fonts one route
 * each would mean 185 registrations. One map per kind, built once and held in
 * memory, is what keeps this plugin's route surface at four, and the client
 * decodes a single asset on demand exactly as pdf.js asks for it.
 *
 * @param kind - `'cmaps'` or `'standard_fonts'`.
 * @returns `{ body, etag }`.
 */
async function assetMap(kind) {
  const cached = assetCache.get(kind)
  if (cached) return cached
  const dir = fileURLToPath(new URL('./vendor/' + kind + '/', import.meta.url))
  const map = {}
  let names = []
  try {
    names = readdirSync(dir).sort()
  } catch (err) {
    throw httpError(500, 'VENDOR_MISSING', 'The vendored ' + kind + ' tree is missing (run: node packages/dsh-pdf/vendor/build.mjs).', err)
  }
  for (const name of names) {
    const full = path.join(dir, name)
    try {
      if (!statSync(full).isFile()) continue
      map[name] = (await fsp.readFile(full)).toString('base64')
    } catch (err) {
      /* a file that will not read is simply absent from the map */
    }
  }
  const body = Buffer.from(JSON.stringify(map), 'utf8')
  const entry = { body, etag: '"' + createHash('sha1').update(body).digest('hex') + '"' }
  assetCache.set(kind, entry)
  return entry
}

/** The vendored assets the browser asks for, each an EXACT route of its own. */
const VENDOR_ASSETS = ['pdf.min.mjs', 'pdf.worker.min.mjs', 'standard-fonts.json', 'cmaps.json', 'wasm.json']

/** One response for a fixed vendored asset name. */
async function serveVendorAsset(request, name) {
  let asset = null
  if (name === 'standard-fonts.json') {
    const map = await assetMap('standard_fonts')
    asset = { bytes: map.body, type: 'application/json; charset=utf-8', etag: map.etag }
  } else if (name === 'cmaps.json') {
    const map = await assetMap('cmaps')
    asset = { bytes: map.body, type: 'application/json; charset=utf-8', etag: map.etag }
  } else if (name === 'wasm.json') {
    const map = await assetMap('wasm')
    asset = { bytes: map.body, type: 'application/json; charset=utf-8', etag: map.etag }
  } else {
    asset = await vendoredFile(name)
  }
  if (!asset) throw httpError(404, 'NO_SUCH_ASSET', 'No vendored asset named ' + name + '.')
  const headers = {
    'content-type': asset.type,
    'cache-control': 'public, max-age=31536000, immutable',
    etag: asset.etag,
  }
  if (request.headers.get('if-none-match') === asset.etag) return new Response(null, { status: 304, headers })
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(asset.bytes, { status: 200, headers })
}

/** The capability snapshot both the state and health routes answer with. */
function snapshot(deps, ocrLanguages) {
  const engines = deps.enginesNow()
  const cache = deps.cache
  return {
    version: deps.version,
    engine: { name: 'pdf.js', version: deps.version, build: 'legacy' },
    capabilities: capabilities(engines, ocrLanguages),
    cache: { documents: cache.entries().length, bytes: cache.size(), maxBytes: MAX_CACHE_BYTES },
    caps: {
      maxPdfBytes: MAX_PDF_BYTES,
      maxTabBytes: MAX_TAB_BYTES,
      maxReadChars: MAX_READ_CHARS,
      defaultReadChars: DEFAULT_READ_CHARS,
      maxPagesPerRun: MAX_PAGES_PER_RUN,
      renderMaxPages: RENDER_MAX_PAGES,
      renderDpi: { min: MIN_DPI, max: MAX_DPI, default: DEFAULT_DPI },
      findMaxHits: FIND_MAX_HITS,
      findMaxPages: FIND_MAX_PAGES,
      infoSamplePages: INFO_SAMPLE_PAGES,
      infoFullPages: MAX_INFO_PAGES,
      scanMaxPages: MAX_SCAN_PAGES,
      scanDpi: SCAN_DPI,
      scanPsm: DEFAULT_PSM,
      scanLang: DEFAULT_LANG,
      listMaxFiles: LIST_MAX_FILES,
      listMaxDepth: LIST_MAX_DEPTH,
      listPageCountFiles: LIST_PAGE_COUNT_FILES,
    },
    tools: ['pdf_info', 'pdf_read', 'pdf_find', 'pdf_render', 'pdf_scan'],
  }
}

/**
 * Register the routes on the connection's fetch registry.
 *
 * @param ctx - the plugin context.
 * @param deps - the plugin's shared dependencies.
 * @returns a disposer that unregisters everything.
 */
export function registerRoutes(ctx, deps) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    deps.log.warn('connection service unavailable - the /api/dsh-pdf/* routes were not registered')
    return () => {}
  }
  const offs = []
  const register = (routePath, methods, handler) => {
    offs.push(
      connection.fetch.register({
        path: routePath,
        methods,
        // GET/HEAD carry no body; the registry's own vocabulary offers nothing
        // smaller, and every sibling plugin registers this same mode.
        requestBody: 'buffered',
        async fetch(request) {
          try {
            return await handler(request)
          } catch (err) {
            return errorToResponse(err)
          }
        },
      }),
    )
  }

  register(STATE_ROUTE, ['GET', 'HEAD'], async () => json(200, { ok: true, ...snapshot(deps, (await languagesFor(deps.enginesNow().ocr)).list) }))
  register(HEALTH_ROUTE, ['GET', 'HEAD'], async () => json(200, { ok: true, ...snapshot(deps, (await languagesFor(deps.enginesNow().ocr)).list) }))

  /**
   * One PDF's bytes for the reader tab. The address the tab was opened at is
   * what was validated, not a path a caller invented: a workspace-relative path
   * is re-checked against the session's workspace, and an absolute path is
   * realpath'd and required to be a `.pdf` file within the tab's own ceiling.
   */
  register(FILE_ROUTE, ['GET', 'HEAD'], async (request) => {
    const url = new URL(request.url)
    const session = url.searchParams.get('session') ?? ''
    const target = await resolveTarget(ctx, { session, path: url.searchParams.get('path') ?? '' })
    const stats = statSync(target.file)
    if (stats.size > MAX_TAB_BYTES) {
      throw httpError(
        413,
        'TOO_LARGE',
        'That PDF is ' + humanBytes(stats.size) + '; the reader loads up to ' + humanBytes(MAX_TAB_BYTES) + '. The pdf_* tools can still read it page by page.',
      )
    }
    // HEAD never reads the file: the ETag is derived from what the stat already
    // knows, and a GET reports the content hash it computed.
    const weakEtag = '"' + String(stats.size) + '-' + String(Math.round(stats.mtimeMs)) + '"'
    const headers = {
      'content-type': 'application/pdf',
      'content-length': String(stats.size),
      'cache-control': 'no-store',
      etag: weakEtag,
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    const bytes = await fsp.readFile(target.file)
    headers.etag = '"' + createHash('sha256').update(bytes).digest('hex').slice(0, 32) + '"'
    headers['x-dsh-pdf-sha256'] = createHash('sha256').update(bytes).digest('hex')
    return new Response(bytes, { status: 200, headers })
  })

  /**
   * The workspace's PDFs, for the index page. Same authority as every other
   * read: a session or an explicit profile, resolved through `sessionRoot`, and
   * the answer is relative paths inside that workspace - never a way to browse
   * the machine.
   */
  register(LIST_ROUTE, ['GET', 'HEAD'], async (request) => {
    const url = new URL(request.url)
    const session = url.searchParams.get('session') ?? ''
    const root = await sessionRoot(ctx, session)
    let rootReal
    try {
      rootReal = await fsp.realpath(path.resolve(root))
    } catch (err) {
      throw httpError(409, 'NO_WORKSPACE', 'The workspace folder for this conversation is not readable.')
    }
    const withPages = url.searchParams.get('pages') === '1'
    const listed = await listWorkspacePdfs(rootReal, { withPages, reader: deps.reader })
    return json(200, {
      ok: true,
      root: rootReal,
      truncated: listed.truncated,
      counted: listed.counted,
      maxFiles: LIST_MAX_FILES,
      maxDepth: LIST_MAX_DEPTH,
      files: listed.files.map((file) => ({
        path: file.path,
        name: path.basename(file.path),
        bytes: file.bytes,
        mtimeMs: file.mtimeMs,
        tooLarge: file.tooLarge,
        pages: file.pages,
        address: 'dsh-resource://file/session/' + encodeURIComponent(session) + '/' + file.path.split('/').map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')).join('/'),
      })),
    })
  })

  /**
   * Recognize pages for the READER - the same pipeline the `pdf_scan` tool uses
   * (one code path, so what the model is told and what a person sees cannot
   * drift), driven by the tab's own "scan this page" action.
   *
   * A missing engine answers 200 with `{ ok: false, reason, message }` rather
   * than an HTTP error: it is a fact about this host, not a bad request, and the
   * reader renders the sentence. HTTP errors are kept for an unusable address.
   */
  register(SCAN_ROUTE, ['POST'], async (request) => {
    const body = await readJsonBody(request, 64 * 1024)
    const session = typeof body.session === 'string' ? body.session : ''
    const target = await resolveTarget(ctx, { session, path: typeof body.path === 'string' ? body.path : '' })
    const engines = deps.enginesNow()
    const facts = await deps.reader.facts(target.file, { password: typeof body.password === 'string' ? body.password : undefined })
    if (!facts.ok) {
      return json(200, { ok: false, reason: facts.failure?.kind ?? 'error', message: failureText(target, facts) })
    }
    const doc = facts.doc
    const requested = typeof body.pages === 'string' && body.pages.trim() !== '' ? body.pages : Number.isInteger(body.page) ? String(body.page) : 'all'
    let range
    try {
      range = parsePages(requested, doc.numPages)
    } catch (err) {
      throw httpError(400, 'BAD_RANGE', messageOf(err))
    }
    const lang = (typeof body.lang === 'string' && body.lang.trim() !== '' ? body.lang : DEFAULT_LANG).toLowerCase()
    const psm = Number.isInteger(body.psm) ? body.psm : DEFAULT_PSM
    const dpi = clampDpi(body.dpi ?? SCAN_DPI)
    const result = await scanPages({
      cache: deps.cache,
      engines,
      file: target.file,
      sha: facts.sha,
      pages: rangeOf(range.from, range.to),
      dpi,
      lang,
      psm,
      log: deps.log.warn,
    })
    if (!result.ok) {
      return json(200, {
        ok: false,
        reason: result.reason,
        message: scanReasonText(result.reason, { available: result.available }),
        pages: doc.numPages,
      })
    }
    return json(200, {
      ok: true,
      engine: result.engine,
      lang: result.lang,
      dpi: result.dpi,
      psm: result.psm,
      ms: result.ms,
      scanned: result.scanned,
      fromCache: result.fromCache,
      skipped: result.skipped,
      pages: result.pages,
    })
  })

  // The registry matches EXACT paths only (there is no wildcard), so the
  // vendored engine, its worker and the two asset maps are four registrations
  // rather than one prefix route.
  for (const name of VENDOR_ASSETS) {
    register(VENDOR_ROUTE + '/' + name, ['GET', 'HEAD'], async (request) => serveVendorAsset(request, name))
  }

  return () => {
    for (const off of offs) {
      try {
        const result = off()
        if (result && typeof result.catch === 'function') result.catch(() => {})
      } catch (err) {
        /* already disposed */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
/**
 * Activate the row.
 *
 * @param ctx - cordis context (inject: connection, tools).
 */
export function apply(ctx) {
  const log = {
    warn: (text) => ctx.logger?.warn?.('[dsh-pdf] ' + text),
    info: (text) => ctx.logger?.info?.('[dsh-pdf] ' + text),
  }
  const root = path.join(resolveHome(), 'dsh-pdf')
  const cache = new PdfCache({ root: path.join(root, 'artifacts') })
  const version = vendoredVersion()
  const reader = new Reader({ cache, engineVersion: version, log: log.info })
  let engines = probeEngines()
  const deps = {
    ctx,
    cache,
    reader,
    log,
    version,
    enginesNow: () => engines,
    reprobe: () => {
      engines = probeEngines()
      return engines
    },
  }

  log.info(
    'active: pdf.js@' +
      version +
      ', rasterizer ' +
      (engines.rasterizer ? engines.rasterizer.name : 'NONE') +
      ', OCR ' +
      (engines.ocr ? engines.ocr.name : 'NONE') +
      ', cache ' +
      path.join(root, 'artifacts'),
  )

  const skillCount = registerSkills(ctx, log)
  log.info('registered ' + skillCount + ' bundled skill(s)')

  for (const tool of buildTools(deps)) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-pdf: tool ' + tool.name)
  }

  ctx.effect(() => registerRoutes(ctx, deps), 'dsh-pdf: routes')
}
