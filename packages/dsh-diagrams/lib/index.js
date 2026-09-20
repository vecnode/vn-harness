/**
 * dsh-diagrams — host half.
 *
 * One row owns the whole diagram capability:
 *
 *   - **Five tools** (`diagram_write`, `diagram_patch`, `diagram_read`,
 *     `diagram_verify`, `diagram_delete`) registered on `ctx.tools`. Every write
 *     is VALIDATED before it is stored - Mermaid by parsing it headlessly with
 *     the same vendored engine the browser renders with, TikZ by compiling it
 *     with the machine's own TeX engine - so a broken diagram comes back to the
 *     model as the parser's/compiler's own error lines instead of a blank
 *     picture.
 *   - **Two skills** (`mermaid-diagrams`, `tikz-diagrams`) registered on
 *     `ctx.skills` from this package's own `skills/` folder, so the model gets
 *     the craft and not just the syntax. The installer also copies those
 *     folders into `$DSH_HOME/skills`, where the harness's own filesystem
 *     provider finds them and a person can read or edit them without touching
 *     this repository.
 *   - **The state**: one JSON file per conversation (`./store.js`) plus a
 *     content-addressed artifact cache (`./cache.js`).
 *   - **The authenticated routes** under /api/dsh-diagrams/* - the same
 *     `connection.fetch` mechanism the editor, the git tab and the screenshot
 *     control use - that the browser half reads. The registry takes EXACT
 *     routes with GET/HEAD/POST only, which is why the vendored engine is one
 *     self-contained file served from one route and why every write is a POST.
 *
 * No session events are appended and nothing shipped is patched: see
 * `./store.js` for why a plugin-owned event type is a dead end on this harness
 * line, and the package README for the whole design.
 */
import { spawn } from 'node:child_process'
import { promises as fsp, readFileSync } from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { ArtifactCache, HASH_PATTERN, MAX_ARTIFACT_BYTES, ARTIFACT_FILES } from './cache.js'
import { compileTikz, normalizeTikzSource, probeEngines, stripFence } from './latex.js'
import { DiagramStore, KINDS, MAX_SOURCE_BYTES, resolveHome, verificationOf } from './store.js'

export const name = 'dsh-diagrams'

/** Services the row waits for: the tool registry and the HTTP bridge. */
export const inject = ['connection', 'tools']

/** Keep in sync with the client's hard-coded route constants. */
const API_ROOT = '/api/dsh-diagrams'
const HEALTH_ROUTE = API_ROOT + '/health'
const STATE_ROUTE = API_ROOT + '/state'
const DIAGRAM_ROUTE = API_ROOT + '/diagram'
const ARTIFACT_ROUTE = API_ROOT + '/artifact'
const EXPORT_ROUTE = API_ROOT + '/export'
const REPORT_ROUTE = API_ROOT + '/render-report'
const VENDOR_ROUTE = API_ROOT + '/vendor/mermaid.js'

/** How long the Mermaid child validator may run. */
const MERMAID_TIMEOUT_MS = 15_000
/** PNG raster density for a compiled TikZ diagram. */
const RASTER_DPI = 200
/**
 * Bump when the TikZ normalization, the preamble or the engine flags change:
 * it is part of the artifact cache key, so a change invalidates every cached
 * compile instead of serving a picture the current code would not produce.
 */
const TIKZ_RENDERER_VERSION = '1'
/** Files each kind may export. */
const EXPORT_FORMATS = { mermaid: ['mmd', 'md', 'svg', 'png'], tikz: ['tex', 'pdf', 'svg', 'png'] }
/**
 * How many names one export may try before it gives up. An export always lands
 * on the Desktop of the machine running the harness - the same place the
 * screenshot control writes - and never in the conversation folder: a diagram is
 * something a person keeps, and the Desktop is where that person is looking.
 */
const MAX_NAME_ATTEMPTS = 100

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

/** Map a thrown route error (or a store error) to its response. */
function errorToResponse(err) {
  if (err && typeof err.status === 'number') return fail(err.status, err.code ?? 'ERROR', String(err.message ?? 'request failed'))
  if (err && typeof err.code === 'string' && /^[A-Z][A-Z_]+$/.test(err.code)) {
    return fail(400, err.code, String(err.message ?? 'request failed'))
  }
  return fail(500, 'INTERNAL', err && err.message ? String(err.message) : 'unexpected failure')
}

/** Read a JSON request body with a hard cap. */
async function readJsonBody(request, maxBytes = 1024 * 1024) {
  const text = await request.text()
  if (text.length > maxBytes) throw httpError(413, 'TOO_LARGE', 'The request body is too large.')
  if (text.trim().length === 0) return {}
  try {
    return JSON.parse(text)
  } catch (err) {
    throw httpError(400, 'BAD_JSON', 'The request body is not valid JSON.')
  }
}

// ---------------------------------------------------------------------------
// The Desktop: where every export lands
// ---------------------------------------------------------------------------
/**
 * The first candidate that names an existing directory, else null.
 *
 * Deliberately duplicated from `dsh-themes` (the screenshot control) instead of
 * imported: this pack ships zero npm dependencies and a bundle may not reach
 * into another bundle's files, so the two copies are independent by design and
 * have to stay in step behaviourally rather than by import.
 *
 * @param candidates - absolute paths, any of which may be null.
 * @returns the first that exists and is a directory, or null.
 */
async function firstDirectory(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    try {
      const info = await fsp.stat(candidate)
      if (info.isDirectory()) return candidate
    } catch (err) {
      /* not there: try the next one */
    }
  }
  return null
}

/**
 * The Desktop a freedesktop host names in `user-dirs.dirs` (`XDG_DESKTOP_DIR`),
 * which is how a Linux desktop can point somewhere other than `~/Desktop`.
 *
 * @returns the configured directory, or null.
 */
async function xdgDesktop() {
  const configHome = process.env.XDG_CONFIG_HOME || (process.env.HOME ? path.join(process.env.HOME, '.config') : null)
  if (configHome === null) return null
  let text
  try {
    text = await fsp.readFile(path.join(configHome, 'user-dirs.dirs'), 'utf8')
  } catch (err) {
    return null
  }
  const match = /^[ \t]*XDG_DESKTOP_DIR[ \t]*=[ \t]*"([^"]*)"/m.exec(text)
  if (match === null) return null
  const home = process.env.HOME || os.homedir()
  const value = match[1].replace(/^\$HOME(?=\/|$)/, home)
  return path.isAbsolute(value) ? value : null
}

/**
 * Where this host keeps its Desktop. Resolved PER REQUEST and never cached: a
 * Windows profile can be redirected into OneDrive, a Linux desktop can name its
 * own folder, and either can change while this row is mounted. The home folder
 * is the last resort, so an export always has somewhere to go.
 *
 * @returns an existing directory.
 */
async function desktopDirectory() {
  const profile = process.env.USERPROFILE
  const home = process.env.HOME
  let osHome = null
  try {
    osHome = os.homedir()
  } catch (err) {
    osHome = null
  }
  const directory = await firstDirectory([
    // Windows, plain and OneDrive-redirected.
    profile ? path.join(profile, 'Desktop') : null,
    profile ? path.join(profile, 'OneDrive', 'Desktop') : null,
    // macOS / Linux, plain and configured.
    home ? path.join(home, 'Desktop') : null,
    await xdgDesktop(),
    osHome ? path.join(osHome, 'Desktop') : null,
    osHome ? path.join(osHome, 'OneDrive', 'Desktop') : null,
    // Nowhere better: the home folder itself.
    profile,
    home,
    osHome,
  ])
  if (directory === null) {
    throw httpError(500, 'NO_DESKTOP', 'This host has no Desktop or home folder to save the export into.')
  }
  return directory
}

// ---------------------------------------------------------------------------
// Mermaid validation
// ---------------------------------------------------------------------------
/** Absolute path of the child validator. */
const MERMAID_CHECK = fileURLToPath(new URL('./mermaid-check.mjs', import.meta.url))

/**
 * Validate one Mermaid source: the queued entry point every caller uses. The
 * child process, its stub and its verdicts live in {@link runMermaidCheck};
 * this only decides WHEN that child may run.
 *
 * @param source - the diagram source.
 * @param options - `{ signal }`.
 * @returns `{ ok, status, diagramType, diagnostics, warnings, ms }` - never rejects.
 */
export function checkMermaid(source, options) {
  return withMermaidSlot(() => runMermaidCheck(source, options))
}

/** At most this many Mermaid validator children run at once. */
const MERMAID_MAX_PARALLEL = 2
/** At most this many validations may WAIT for a slot before one is refused. */
const MERMAID_MAX_QUEUE = 16
/** How many validator children are running now, and who is waiting for one. */
let mermaidRunning = 0
const mermaidQueue = []

/**
 * Run one Mermaid validation inside the process-wide slot pool.
 *
 * Every validation is a `node` child that loads a 3.5 MB engine, so an
 * unbounded fan-out - several agents, or several diagrams written in one turn -
 * is a memory spike that ends as a failed spawn for all of them. Two at a time
 * with a bounded queue keeps the worst case at a known number of children. Past
 * the queue cap the verdict is `unavailable`, which is the honest answer: a
 * validation that never ran must not be reported as a diagram error.
 *
 * @param work - a thunk returning the verdict promise.
 * @returns the verdict promise (never rejects).
 */
function withMermaidSlot(work) {
  return new Promise((resolve) => {
    const finish = () => {
      mermaidRunning -= 1
      const next = mermaidQueue.shift()
      if (next) next()
    }
    const run = () => {
      mermaidRunning += 1
      Promise.resolve()
        .then(work)
        .then(
          (value) => {
            finish()
            resolve(value)
          },
          (err) => {
            finish()
            resolve(unavailable('the Mermaid validator failed: ' + message(err)))
          },
        )
    }
    if (mermaidRunning < MERMAID_MAX_PARALLEL) run()
    else if (mermaidQueue.length < MERMAID_MAX_QUEUE) mermaidQueue.push(run)
    else resolve(unavailable('too many Mermaid validations are already queued; try again in a moment'))
  })
}

/**
 * Parse one Mermaid source headlessly, in a child process, with the vendored
 * engine. A validator failure (the stub or the engine breaking) is reported as
 * `unavailable`, NEVER as a diagram error: telling the model its diagram is
 * wrong when the checker is what broke would be a lie.
 *
 * @param source - the diagram source.
 * @param options - `{ signal }`.
 * @returns `{ ok, status, diagramType, diagnostics, ms }`.
 */
function runMermaidCheck(source, { signal } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(process.execPath, [MERMAID_CHECK, '-'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      resolve(unavailable('could not start the Mermaid validator: ' + message(err)))
      return
    }
    let out = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve(value)
    }
    const kill = () => {
      try {
        child.kill('SIGKILL')
      } catch (err) {
        /* already gone */
      }
    }
    const timer = setTimeout(() => {
      kill()
      finish(unavailable('the Mermaid validator timed out'))
    }, MERMAID_TIMEOUT_MS)
    const onAbort = () => {
      kill()
      finish(unavailable('cancelled'))
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdout.on('data', (chunk) => {
      if (out.length < 64 * 1024) out += chunk.toString('utf8')
    })
    child.stderr.on('data', () => {})
    child.on('error', (err) => finish(unavailable('the Mermaid validator failed: ' + message(err))))
    child.on('close', () => {
      const line = out.trim().split('\n').filter(Boolean).pop()
      if (!line) {
        finish(unavailable('the Mermaid validator produced no verdict'))
        return
      }
      let verdict
      try {
        verdict = JSON.parse(line)
      } catch (err) {
        finish(unavailable('unreadable validator output'))
        return
      }
      if (verdict.ok) {
        finish({
          ok: true,
          status: 'ok',
          diagramType: verdict.diagramType ?? null,
          diagnostics: [],
          warnings: normalizeWarnings(verdict.warnings),
          ms: verdict.ms,
        })
        return
      }
      if (verdict.reason === 'internal') {
        finish(unavailable(String(verdict.error ?? 'the Mermaid validator failed')))
        return
      }
      finish({
        ok: false,
        status: 'error',
        diagramType: null,
        diagnostics: String(verdict.error ?? 'parse error')
          .split('\n')
          .map((text) => ({ kind: 'parse', text: text.trim() }))
          .filter((entry) => entry.text.length > 0)
          .slice(0, 4),
        warnings: normalizeWarnings(verdict.warnings),
        ms: verdict.ms,
      })
    })
    // The source goes over stdin, so no file has to exist and the bytes reach
    // the engine exactly as written on every platform.
    try {
      child.stdin.end(source, 'utf8')
    } catch (err) {
      finish(unavailable('could not hand the source to the Mermaid validator'))
    }
  })
}

/** One "not validated" verdict. */
function unavailable(text) {
  return { ok: false, status: 'unavailable', diagramType: null, diagnostics: [{ kind: 'validator', text }], warnings: [] }
}

/**
 * The lint findings one validator run produced, bounded and typed.
 *
 * Warnings are ADVISORY: they ride a successful write and never change its
 * status. A check that turned advice into a refusal would be a check the model
 * learns to route around.
 *
 * @param list - the validator's `warnings`.
 * @returns up to {@link MAX_WARNINGS} `{ kind, text }` entries.
 */
function normalizeWarnings(list) {
  if (!Array.isArray(list)) return []
  return list
    .map((entry) => ({ kind: String(entry?.kind ?? 'lint').slice(0, 24), text: String(entry?.text ?? '').trim() }))
    .filter((entry) => entry.text.length > 0)
    .slice(0, MAX_WARNINGS)
}

/** At most this many advisory findings travel back to the model. */
const MAX_WARNINGS = 8

/**
 * Why a TikZ document cannot produce a picture, or null when it can.
 *
 * Only the degenerate cases a reader would call empty: nothing at all, or a
 * document with no drawing command in it. The paragraph/section checks matter
 * because `\node` inside a float is centred by `standalone` at a point no
 * picture can be drawn at, which pdflatex accepts and the panel shows as blank.
 *
 * @param source - the raw TikZ source.
 * @returns a message, or null.
 */
export function tikzDegenerateReason(source) {
  const raw = stripFence(String(source ?? ''))
  if (raw.trim().length === 0) {
    return 'The source is empty, so there is nothing to draw. Pass a bare body of TikZ commands, one picture environment, or a complete document.'
  }
  const body = raw
    .split('\n')
    .map((line) => line.replace(/(^|[^\\])%.*$/, '$1'))
    .join('\n')
  if (/\\begin\{tikzpicture\}|\\begin\{axis\}/.test(body)) return null
  // No picture environment: the host wraps a bare body itself, so the body has
  // to carry at least one drawing command or the engine compiles a blank page.
  if (/\\(node|draw|path|fill|filldraw|shade|shadedraw|matrix|graph|foreach|addplot|clip|coordinate)\b/.test(body)) return null
  return (
    'There is no picture in this source: a bare body must hold at least one TikZ command (\\node, \\draw, \\path, \\matrix, \\graph, ...), ' +
    'and a complete document needs a tikzpicture or axis environment. As written it compiles to a blank page.'
  )
}

// ---------------------------------------------------------------------------
// Rendering: one verdict per diagram
// ---------------------------------------------------------------------------
/**
 * Validate/compile one diagram and record the verdict on the stored entry.
 * Mermaid produces no host artifact (the browser renders it from the source,
 * live and themed); TikZ produces the cached PDF/SVG/PNG the UI draws.
 *
 * @param deps - `{ store, cache, enginesNow }`.
 * @param sessionId - the conversation id.
 * @param entry - the stored diagram.
 * @param options - `{ signal, force }`.
 * @returns the verdict `{ status, diagramType, diagnostics, artifact, ms, cached }`.
 */
async function checkAndRecord(deps, sessionId, entry, { signal, force = false } = {}) {
  const started = Date.now()
  if (entry.kind === 'mermaid') {
    const verdict = await checkMermaid(entry.source, { signal })
    const stored = deps.store.recordVerdict(sessionId, entry.id, {
      status: verdict.status,
      diagramType: verdict.diagramType ?? null,
      diagnostics: verdict.diagnostics,
      warnings: verdict.warnings ?? [],
    })
    return { ...verdict, ms: verdict.ms ?? Date.now() - started, artifact: stored ? stored.artifact : null }
  }

  // A document with no picture in it compiles cleanly and draws nothing. That is
  // a failure a person sees and a compiler never reports, so it is refused here
  // in words instead of being handed on as an empty panel.
  const degenerate = tikzDegenerateReason(entry.source)
  if (degenerate) {
    const stored = deps.store.recordVerdict(sessionId, entry.id, {
      status: 'error',
      diagramType: null,
      diagnostics: [{ kind: 'source', text: degenerate }],
      warnings: [],
    })
    return { ok: false, status: 'error', diagramType: null, diagnostics: stored.diagnostics, warnings: [], artifact: null, ms: Date.now() - started }
  }

  const engines = deps.enginesNow()
  if (!engines.available) {
    const stored = deps.store.recordVerdict(sessionId, entry.id, {
      status: 'unavailable',
      diagramType: null,
      diagnostics: [{ kind: 'engine', text: 'No TeX engine found on this host (looked for pdflatex, xelatex, lualatex).' }],
      warnings: [],
    })
    return {
      ok: false,
      status: 'unavailable',
      diagramType: null,
      diagnostics: stored.diagnostics,
      warnings: [],
      artifact: stored.artifact,
      ms: Date.now() - started,
      unavailable: true,
    }
  }

  const normalized = normalizeTikzSource(entry.source)
  const key = deps.cache.keyFor({
    kind: 'tikz',
    source: normalized.document,
    engine: engines.engine ?? '',
    renderer: engines.svg ?? '',
    version: TIKZ_RENDERER_VERSION,
  })
  const cachedMeta = force ? null : deps.cache.meta(key)
  if (cachedMeta) {
    // The cache is keyed on the document, the engine and the renderer, so a hit
    // means THIS document already compiled exactly this way - diagnostics
    // included. The verdict is therefore read back from the cached meta and not
    // assumed: a compile that failed but still wrote a PDF is cached too (the
    // partial picture is evidence), and calling that "ok" on the next call would
    // be the plugin lying to the model about its own diagram.
    const cachedDiagnostics = Array.isArray(cachedMeta.diagnostics) ? cachedMeta.diagnostics : []
    const cachedStatus = cachedDiagnostics.length > 0 ? 'error' : 'ok'
    const warnings = tikzWarnings({ source: normalized.document, meta: cachedMeta, diagnostics: cachedDiagnostics })
    const stored = deps.store.recordVerdict(sessionId, entry.id, {
      status: cachedStatus,
      diagramType: 'tikz',
      diagnostics: cachedDiagnostics,
      warnings,
      artifact: {
        hash: key,
        formats: cachedMeta.formats ?? [],
        pages: cachedMeta.pages ?? null,
        width: cachedMeta.width ?? null,
        height: cachedMeta.height ?? null,
        engine: cachedMeta.engine ?? engines.engine,
        at: cachedMeta.at ?? new Date().toISOString(),
      },
    })
    return {
      ok: cachedStatus === 'ok',
      status: cachedStatus,
      diagramType: 'tikz',
      diagnostics: cachedDiagnostics,
      warnings,
      artifact: stored.artifact,
      ms: Date.now() - started,
      cached: true,
    }
  }

  const result = await withCompileSlot(() => compileTikz({ document: normalized.document, engines, signal, dpi: RASTER_DPI }))
  const diagnostics = result.diagnostics ?? []
  const status = result.unavailable ? 'unavailable' : diagnostics.length > 0 ? 'error' : 'ok'
  const warnings = tikzWarnings({
    source: normalized.document,
    meta: { pages: result.pages, width: result.width, height: result.height },
    diagnostics,
  })
  let artifact = null
  if (result.pdf || result.svg || result.png) {
    const meta = deps.cache.write(key, {
      tex: normalized.document,
      pdf: result.pdf,
      svg: result.svg,
      png: result.png,
      meta: {
        kind: 'tikz',
        engine: result.engine ?? engines.engine,
        pages: result.pages,
        width: result.width,
        height: result.height,
        compileMs: result.ms ?? Date.now() - started,
        diagnostics: diagnostics.slice(0, 12),
        wrapped: normalized.wrapped,
      },
    })
    artifact = {
      hash: key,
      formats: meta.formats ?? [],
      pages: result.pages,
      width: result.width,
      height: result.height,
      engine: meta.engine ?? engines.engine,
      at: meta.at,
    }
  }
  const stored = deps.store.recordVerdict(sessionId, entry.id, { status, diagramType: 'tikz', diagnostics, warnings, artifact })
  return { ok: status === 'ok', status, diagramType: 'tikz', diagnostics, warnings, artifact: stored.artifact, ms: Date.now() - started }
}

/**
 * The advisory findings of one TikZ document.
 *
 * A compile that succeeded can still be a picture nobody wanted: several pages
 * where one was meant, a canvas far larger than a panel, or the engine's own
 * warnings about a font or a package it had to substitute. None of these change
 * the verdict - `status` stays `ok` - they only tell the model what to look at.
 *
 * @param input - `{ source, meta, diagnostics }`.
 * @returns up to {@link MAX_WARNINGS} `{ kind, text }` entries.
 */
export function tikzWarnings({ source, meta, diagnostics } = {}) {
  const warnings = []
  const pages = meta && typeof meta.pages === 'number' ? meta.pages : null
  const width = meta && typeof meta.width === 'number' ? meta.width : null
  const height = meta && typeof meta.height === 'number' ? meta.height : null
  if (pages !== null && pages > 1) {
    warnings.push({
      kind: 'size',
      text:
        'This document compiled to ' +
        pages +
        ' pages. A diagram is one page: check for a stray page break, or a figure that overflowed. The panel shows the first page only.',
    })
  }
  if (width !== null && height !== null && width > 2000) {
    warnings.push({
      kind: 'size',
      text: 'The picture is ' + Math.round(width) + 'pt wide, which the panel will scale down until labels are hard to read. Shrink it with scale=, node distance= or a smaller font.',
    })
  }
  for (const diagnostic of diagnostics ?? []) {
    const text = String(diagnostic && diagnostic.text ? diagnostic.text : '')
    if (/Overfull|Underfull/i.test(text)) continue
    if (/Font shape|Font Warning|LaTeX Font Warning/i.test(text)) {
      warnings.push({ kind: 'font', text: 'The engine substituted a font: ' + text.slice(0, 200) })
    }
    if (warnings.length >= MAX_WARNINGS) break
  }
  const normalized = String(source ?? '')
  const length = normalized.split('\n').filter((line) => line.trim().length > 0).length
  if (length > 250) {
    warnings.push({ kind: 'size', text: length + ' non-empty lines is a large document for one picture; consider splitting it into two diagrams.' })
  }
  return warnings.slice(0, MAX_WARNINGS)
}

/** One compile at a time: parallel pdflatex runs are the fastest route to a wedged host. */
let compileChain = Promise.resolve()
function withCompileSlot(work) {
  const run = compileChain.then(work, work)
  compileChain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------
/** The skills this package ships, in the order the catalog should list them. */
const SKILL_FILES = [
  { name: 'mermaid-diagrams', file: '../skills/mermaid-diagrams/SKILL.md' },
  { name: 'tikz-diagrams', file: '../skills/tikz-diagrams/SKILL.md' },
]

/**
 * Split one SKILL.md into its YAML frontmatter and its body. The parse is
 * deliberately minimal (flat `key: value` scalars, quoted or plain) because
 * these two files are ours; the harness's filesystem provider parses the same
 * files with a real YAML parser, so they must stay valid YAML.
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    meta[entry[1]] = value
  }
  return { meta, content: normalized.slice(match[0].length).trim() }
}

/**
 * Register the bundled skills on the skill registry, reading the markdown from
 * this package's own `skills/` folder. The registry is resolved lazily (its
 * absence only skips the skills, never the tools) and a missing file is a
 * warning rather than a failure - the installer also copies those files into
 * `$DSH_HOME/skills`, so a host without them still gets the catalog entries
 * from the filesystem provider.
 *
 * @param ctx - the cordis context.
 * @param log - `{ warn }`.
 * @returns the number of skills registered.
 */
export function registerSkills(ctx, log) {
  const skills = typeof ctx.get === 'function' ? ctx.get('skills') : undefined
  if (!skills || typeof skills.register !== 'function') {
    log.warn('skill registry unavailable - the bundled diagram skills were not registered')
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
            provider: 'dsh-diagrams',
          }),
        'dsh-diagrams: skill ' + name,
      )
      count += 1
    } catch (err) {
      log.warn('could not register skill ' + entry.name + ': ' + message(err))
    }
  }
  return count
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
/** JSON Schema for a diagram id. */
const ID_SCHEMA = { type: 'string', description: 'The diagram id (lowercase letters, digits and dashes).' }
/** JSON Schema for a diagram kind. */
const KIND_SCHEMA = { type: 'string', enum: [...KINDS], description: 'mermaid | tikz' }
/** The durable, UI-facing shape one write/patch returns. */
const VIEW_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'string' },
    diagramType: { type: 'string' },
    address: { type: 'string' },
    lines: { type: 'integer' },
    bytes: { type: 'integer' },
    warnings: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string' }, text: { type: 'string' } }, required: ['text'] } },
    // What the BROWSER reported about this revision, when a browser has
    // reported. Always present, so a card never has to distinguish "absent"
    // from "not yet".
    verification: {
      type: 'object',
      properties: {
        state: { type: 'string', description: 'drawn | failed | stale | pending - what the browser reported about THIS revision.' },
        revision: { type: 'integer', description: 'The revision this verdict is about (the current one).' },
        reported: { type: 'integer', description: 'The revision the newest report names; differs from `revision` only when the state is stale.' },
        kind: { type: 'string', description: 'What the report was about: mermaid | tikz.' },
        error: { type: 'string' },
        at: { type: 'string' },
      },
      required: ['state', 'revision'],
    },
  },
  required: ['id', 'kind', 'title', 'status', 'address', 'verification'],
}
/** Diagnostics array shared by the write/patch output schemas. */
const DIAGNOSTICS_SCHEMA = {
  type: 'array',
  items: { type: 'object', properties: { kind: { type: 'string' }, text: { type: 'string' } }, required: ['text'] },
}

/** The description of `diagram_write`; the skills carry the depth, this carries the rules. */
function writeDescription(engines) {
  const engineLine = engines.available
    ? 'TikZ diagrams are compiled on this host by ' + engines.engine + ', and the first compile error comes straight back to you.'
    : 'This host has NO TeX engine, so a TikZ diagram is stored and returned as .tex but cannot be compiled or previewed here.'
  return [
    'Create or replace ONE diagram in this conversation and validate it immediately.',
    '',
    'kind "mermaid": the source is Mermaid text (flowchart, sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, pie, mindmap, timeline, quadrantChart, journey, ...). It is parsed exactly as written; a parse error returns the offending line.',
    'kind "tikz": the source is TikZ/LaTeX. A bare body of TikZ commands, one picture environment, or a complete document are all accepted - a preamble with the standard libraries (arrows.meta, positioning, shapes.geometric, shapes.misc, calc, fit, backgrounds, matrix, chains, decorations, patterns, quotes, angles, intersections, pgfplots) is supplied for you, and leading \\usepackage / \\usetikzlibrary / \\tikzset lines are moved into it.',
    engineLine,
    '',
    'Pass `id` to replace an existing diagram (check it with diagram_read first); omit it to create a new one, whose id is derived from the title.',
    'Always read the returned `status` and `diagnostics`, and fix the diagram until the status is "ok". A diagram the user cannot see is a failed call.',
    '',
    'The result carries three separate things, and they answer different questions:',
    '  - `status` is the host verdict: ok (it parses/compiles), error (it does not - fix the diagnostics), or unavailable (the host has no validator/engine, so the diagram is STORED BUT NOT VERIFIED - say so rather than implying it is fine).',
    '  - `warnings` are advisory and never change the status: a picture with no edges, more nodes than a person reads at once, an unclosed-looking label, a TikZ document with no picture in it, a multi-page result. Fix the ones that are right; say which ones you deliberately ignored.',
    '  - the "Browser:" line says what a real renderer reported about THIS revision: drawn (a browser reported DREW), failed (it reported the picture could not be made - what the user sees is that error text), stale (the newest report names an older revision, so this revision has never been drawn), or pending (no report at all, which is normal with no client open). Use diagram_verify to re-check later without rewriting anything.',
  ].join('\n')
}

/**
 * Build the four tool definitions. They are plain objects with raw JSON Schema:
 * this pack ships no npm dependencies, so `defineTool` (a harness package) is
 * not imported. The registry validates arguments against `parameters` and the
 * returned canonical value against `output.schema`.
 *
 * @param deps - `{ store, cache, enginesNow }`.
 * @returns the tool definitions.
 */
export function buildTools(deps) {
  const { store } = deps

  /** The acting conversation of one tool run. */
  const sessionOf = (exec) => {
    const session = exec && exec.agent && exec.agent.session
    if (!session || typeof session.id !== 'string') throw new Error('diagram tools require an owning agent session')
    return session.id
  }
  /** The address the right bar opens this diagram with. */
  const addressOf = (sessionId, id) => 'dsh-resource://diagram/session/' + sessionId + '/' + id
  /** The durable, UI-facing projection of one stored diagram. */
  const viewOf = (sessionId, entry) => ({
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    status: entry.status,
    diagramType: entry.diagramType ?? '',
    address: addressOf(sessionId, entry.id),
    lines: entry.source.length === 0 ? 0 : entry.source.split('\n').length,
    bytes: Buffer.byteLength(entry.source, 'utf8'),
    warnings: entry.warnings ?? [],
    verification: verificationOf(entry),
  })

  /**
   * The one line `diagram_read` / `diagram_verify` carry about the browser.
   *
   * It names the state, the revision it is about and - when there is one - the
   * report's own time, theme and error, so the sentence can be checked against
   * the stored report instead of being taken on faith.
   */
  const renderLine = (entry) => {
    const verification = verificationOf(entry)
    const theme = entry.render && entry.render.theme ? ' (' + entry.render.theme + ' theme)' : ''
    if (verification.state === 'pending') {
      return (
        'Browser: pending - no render report for revision ' +
        verification.revision +
        '; nothing has drawn it where the host can see. It is drawn when this conversation is open in the app.'
      )
    }
    if (verification.state === 'stale') {
      return (
        'Browser: stale - the newest report is about revision ' +
        verification.reported +
        (entry.render && entry.render.at ? ' (at ' + entry.render.at + ')' : '') +
        ', but the current revision is ' +
        verification.revision +
        '; revision ' +
        verification.revision +
        ' has not been drawn.'
      )
    }
    if (verification.state === 'drawn') {
      return 'Browser: DREW revision ' + verification.revision + (verification.at ? ' at ' + verification.at : '') + theme + '.'
    }
    return (
      'Browser: FAILED to draw revision ' +
      verification.revision +
      (verification.at ? ' at ' + verification.at : '') +
      ': ' +
      String(verification.error || 'the renderer did not report a reason') +
      ' - what the user sees is that error, not the picture.'
    )
  }
  /** The advisory findings, as text lines. */
  const warningLines = (entry) => (entry.warnings ?? []).map((warning) => '  ! ' + warning.text)
  /** Model-facing text for one finished write/patch. */
  const resultText = (verb, sessionId, entry, verdict) => {
    const lines = [verb + ' diagram "' + entry.id + '" (' + entry.kind + ') - status: ' + verdict.status + '.']
    if (verdict.status === 'ok') {
      if (entry.kind === 'mermaid') {
        lines.push('It parses as a ' + (verdict.diagramType ?? 'diagram') + ' and is rendering in the conversation and in its own tab.')
      } else if (verdict.artifact) {
        lines.push(
          'Compiled with ' +
            (verdict.artifact.engine ?? 'the TeX engine') +
            (verdict.artifact.pages ? ' (' + verdict.artifact.pages + ' page' + (verdict.artifact.pages === 1 ? '' : 's') + ')' : '') +
            (verdict.cached ? ', served from the artifact cache' : '') +
            '.',
        )
      }
    } else if (verdict.status === 'unavailable') {
      lines.push('The diagram was stored, but it could NOT be validated on this host:')
    } else {
      lines.push('It did NOT validate. Fix these and write again:')
    }
    for (const diagnostic of verdict.diagnostics ?? []) lines.push('  - ' + diagnostic.text)
    if (verdict.status !== 'unavailable') lines.push(renderLine(entry))
    const warnings = warningLines(entry)
    if (warnings.length > 0) {
      lines.push('Advisory (the diagram is still valid - these are judgement calls, fix them only if they are wrong):')
      for (const warning of warnings) lines.push(warning)
    }
    lines.push('Tab address: ' + addressOf(sessionId, entry.id))
    if (entry.kind === 'tikz' && verdict.status !== 'ok' && verdict.artifact) {
      lines.push('(A best-effort render of the failing document is cached and shown, flagged as errored.)')
    }
    return lines.join('\n')
  }
  /** Shared pending-call presentation. */
  const callView = (args, verb) => ({
    card: 'generic',
    title: verb + ' ' + (args && args.kind ? args.kind + ' ' : '') + 'diagram' + (args && args.id ? ' "' + args.id + '"' : ''),
    kind: 'other',
    rawInput: args && args.title ? { title: args.title } : undefined,
  })
  /** Shared completed-call presentation. */
  const resultView = (_args, result) => ({
    card: 'generic',
    title: 'Diagram ' + (result.meta && result.meta.id ? '"' + result.meta.id + '" ' : '') + (result.meta ? result.meta.status : ''),
    content: result.content,
  })

  const write = {
    name: 'diagram_write',
    description: writeDescription(deps.enginesNow()),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'source'],
      properties: {
        kind: KIND_SCHEMA,
        source: { type: 'string', description: 'The complete diagram source (Mermaid text, or TikZ/LaTeX).' },
        id: ID_SCHEMA,
        title: { type: 'string', description: 'A short human title; the tab chip and the diagram list show it.' },
        note: { type: 'string', description: 'One line on what changed, kept in the diagram history.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' }, view: VIEW_SCHEMA, diagnostics: DIAGNOSTICS_SCHEMA },
        required: ['text', 'view'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: (args) => callView(args, 'Write'),
    presentResult: resultView,
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const entry = store.write(sessionId, {
        id: typeof args.id === 'string' && args.id.length > 0 ? args.id : undefined,
        kind: String(args.kind),
        title: typeof args.title === 'string' ? args.title : undefined,
        source: stripFence(String(args.source ?? '')),
        by: 'model',
        note: typeof args.note === 'string' ? args.note : undefined,
      })
      const verdict = await checkAndRecord(deps, sessionId, entry, { signal: exec.signal })
      const fresh = store.get(sessionId, entry.id)
      return { text: resultText('Wrote', sessionId, fresh, verdict), view: viewOf(sessionId, fresh), diagnostics: verdict.diagnostics ?? [] }
    },
  }
  const patch = {
    name: 'diagram_patch',
    description: [
      'Replace a literal string inside ONE existing diagram\'s source and re-validate the whole diagram.',
      'Use this instead of rewriting a diagram when only part of it changes: it is far cheaper than re-emitting a long TikZ picture.',
      '`oldString` must appear exactly once unless `replaceAll` is true; the call is refused with NO_MATCH or AMBIGUOUS otherwise, so a wrong edit never silently corrupts the picture.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'oldString', 'newString'],
      properties: {
        id: ID_SCHEMA,
        oldString: { type: 'string', description: 'The exact text to replace.' },
        newString: { type: 'string', description: 'The replacement text (empty deletes it).' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' },
        note: { type: 'string', description: 'One line on what changed, kept in the diagram history.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          view: VIEW_SCHEMA,
          occurrences: { type: 'integer' },
          diagnostics: DIAGNOSTICS_SCHEMA,
        },
        required: ['text', 'view'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => value.view,
    },
    presentCall: (args) => callView(args, 'Patch'),
    presentResult: resultView,
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const { entry, occurrences } = store.patch(sessionId, {
        id: String(args.id),
        oldString: String(args.oldString ?? ''),
        newString: String(args.newString ?? ''),
        replaceAll: args.replaceAll === true,
        by: 'model',
        note: typeof args.note === 'string' ? args.note : undefined,
      })
      const verdict = await checkAndRecord(deps, sessionId, entry, { signal: exec.signal })
      const fresh = store.get(sessionId, entry.id)
      return {
        text: resultText('Patched', sessionId, fresh, verdict) + '\nReplaced ' + occurrences + ' occurrence(s).',
        view: viewOf(sessionId, fresh),
        occurrences,
        diagnostics: verdict.diagnostics ?? [],
      }
    },
  }

  const read = {
    name: 'diagram_read',
    description: [
      'Read the diagrams of this conversation.',
      'With `id`: that diagram\'s complete source, kind, status, last diagnostics, the advisory warnings, and what the BROWSER reported about this revision (drawn / failed / stale / pending) plus the exact address of its tab.',
      'Without `id`: the index of every diagram (id, kind, title, status, size, last update).',
      'Read before patching or replacing a diagram you did not just write - your context may have been compacted since.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: ID_SCHEMA,
        includeSource: { type: 'boolean', description: 'With an id, pass false for a status-only answer. Defaults to true.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          id: { type: 'string' },
          kind: { type: 'string' },
          status: { type: 'string' },
          address: { type: 'string' },
          verification: { type: 'object', properties: { state: { type: 'string' } }, required: ['state'] },
        },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: (args) => callView(args, 'Read'),
    execute(args, exec) {
      const sessionId = sessionOf(exec)
      if (typeof args.id === 'string' && args.id.length > 0) {
        const entry = store.get(sessionId, args.id)
        if (!entry) {
          const known = store.ids(sessionId)
          return {
            text:
              'No diagram "' +
              args.id +
              '" in this conversation.' +
              (known.length > 0 ? ' Known ids: ' + known.join(', ') + '.' : ' No diagrams yet.'),
          }
        }
        const header = ['Diagram "' + entry.id + '" (' + entry.kind + '), status: ' + entry.status + (entry.title ? ', title: ' + entry.title : '') + '.']
        if (entry.diagnostics && entry.diagnostics.length > 0) {
          header.push('Last diagnostics:')
          for (const diagnostic of entry.diagnostics) header.push('  - ' + diagnostic.text)
        }
        header.push(renderLine(entry))
        const warnings = warningLines(entry)
        if (warnings.length > 0) {
          header.push('Advisory (valid, but worth a look):')
          for (const warning of warnings) header.push(warning)
        }
        header.push('Tab address: ' + addressOf(sessionId, entry.id))
        if (args.includeSource === false) {
          return {
            text: header.join('\n'),
            id: entry.id,
            kind: entry.kind,
            status: entry.status,
            address: addressOf(sessionId, entry.id),
            verification: verificationOf(entry),
          }
        }
        const body = '---8<--- source ---8<---\n' + entry.source + '\n---8<--- end source ---8<---'
        return {
          text: header.join('\n') + '\n\n' + body,
          id: entry.id,
          kind: entry.kind,
          status: entry.status,
          address: addressOf(sessionId, entry.id),
          verification: verificationOf(entry),
        }
      }
      const listed = store.list(sessionId)
      if (listed.diagrams.length === 0) {
        return { text: 'This conversation has no diagrams yet. Write one with diagram_write (kind "mermaid" or "tikz").' }
      }
      const lines = ['This conversation has ' + listed.diagrams.length + ' diagram(s):']
      for (const entry of listed.diagrams) {
        lines.push(
          '  - ' +
            entry.id +
            ' [' +
            entry.kind +
            ', ' +
            entry.status +
            '] ' +
            entry.title +
            ' (' +
            entry.lines +
            ' line' +
            (entry.lines === 1 ? '' : 's') +
            ', updated ' +
            entry.updatedAt +
            ')',
        )
      }
      lines.push('Read one with diagram_read { id } to get its source.')
      return { text: lines.join('\n') }
    },
  }

  const verify = {
    name: 'diagram_verify',
    description: [
      'Validate ONE diagram again, from the source the host has NOW, without writing anything.',
      'Use it when you need to confirm a diagram is still sound but do not want to change it: after a person edited it in the panel, ' +
        'after a long gap in the conversation, or when you are about to build on a diagram whose last verdict you no longer trust.',
      'It re-parses a Mermaid diagram with the vendored engine and recompiles TikZ (through the artifact cache, so an unchanged document costs nothing), ' +
        'then reports the status, the diagnostics, the advisory warnings, and what the BROWSER last did with this revision.',
      'Unlike diagram_write it never bumps the revision and never invents an id, so it is always safe to call.',
    ].join('\n'),
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: ID_SCHEMA } },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          id: { type: 'string' },
          status: { type: 'string' },
          diagnostics: DIAGNOSTICS_SCHEMA,
          verification: { type: 'object', properties: { state: { type: 'string' } }, required: ['state'] },
        },
        required: ['text', 'id', 'status'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({ id: value.id, status: value.status }),
    },
    presentCall: (args) => callView(args, 'Verify'),
    presentResult: resultView,
    async execute(args, exec) {
      const sessionId = sessionOf(exec)
      const entry = store.get(sessionId, args.id)
      if (!entry) {
        const known = store.ids(sessionId)
        return {
          text:
            'No diagram "' +
            String(args.id) +
            '" in this conversation.' +
            (known.length > 0 ? ' Known ids: ' + known.join(', ') + '.' : ' No diagrams yet.'),
          id: String(args.id),
          status: 'missing',
        }
      }
      const verdict = await checkAndRecord(deps, sessionId, entry, { signal: exec.signal })
      const fresh = store.get(sessionId, entry.id)
      const lines = ['Checked diagram "' + entry.id + '" (' + entry.kind + '), revision ' + entry.revision + ' - status: ' + verdict.status + '.']
      if (verdict.status === 'ok') {
        lines.push(
          entry.kind === 'mermaid'
            ? 'It parses as a ' + (verdict.diagramType ?? 'diagram') + '.'
            : 'It compiles' + (verdict.cached ? ' (served from the artifact cache, so the document is unchanged)' : '') + '.',
        )
      }
      for (const diagnostic of verdict.diagnostics ?? []) lines.push('  - ' + diagnostic.text)
      lines.push(renderLine(fresh))
      const warnings = warningLines(fresh)
      if (warnings.length > 0) {
        lines.push('Advisory (valid, but worth a look):')
        for (const warning of warnings) lines.push(warning)
      }
      lines.push('Tab address: ' + addressOf(sessionId, entry.id))
      return {
        text: lines.join('\n'),
        id: entry.id,
        status: verdict.status,
        diagnostics: verdict.diagnostics ?? [],
        verification: verificationOf(fresh),
      }
    },
  }

  const remove = {
    name: 'diagram_delete',
    description: 'Delete one diagram from this conversation. Its tab shows the diagram is gone; its cached artifacts are dropped.',
    parameters: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: ID_SCHEMA } },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' }, deleted: { type: 'boolean' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    presentCall: (args) => callView(args, 'Delete'),
    execute(args, exec) {
      const sessionId = sessionOf(exec)
      const entry = store.get(sessionId, args.id)
      const hash = entry && entry.artifact ? entry.artifact.hash : null
      const deleted = store.remove(sessionId, args.id)
      if (deleted && hash) deps.cache.drop(hash)
      return {
        text: deleted ? 'Deleted diagram "' + args.id + '".' : 'No diagram "' + args.id + '" in this conversation.',
        deleted,
      }
    },
  }

  return [write, patch, read, verify, remove]
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
/** The vendored engine, resolved once. */
const VENDOR_FILE = fileURLToPath(new URL('./vendor/mermaid.min.js', import.meta.url))
/** Cache the served bytes + their ETag; the file never changes at runtime. */
let vendorState = null

/** One response carrying the vendored engine. */
async function serveVendor(request) {
  if (!vendorState) {
    let bytes
    try {
      bytes = await fsp.readFile(VENDOR_FILE)
    } catch (err) {
      throw httpError(500, 'VENDOR_MISSING', 'The vendored Mermaid engine is missing (run the vendor build in packages/dsh-diagrams/vendor).', err)
    }
    const { createHash } = await import('node:crypto')
    vendorState = { bytes, etag: '"' + createHash('sha1').update(bytes).digest('hex') + '"' }
  }
  const headers = {
    'content-type': 'text/javascript; charset=utf-8',
    // The bytes are pinned by version and never edited in place.
    'cache-control': 'public, max-age=31536000, immutable',
    etag: vendorState.etag,
  }
  if (request.headers.get('if-none-match') === vendorState.etag) return new Response(null, { status: 304, headers })
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
  return new Response(vendorState.bytes, { status: 200, headers })
}

/** The capability block the health and state routes answer with. */
function healthSnapshot(deps) {
  const engines = deps.enginesNow()
  return {
    tex: { available: engines.available, engine: engines.engine, svg: engines.svg, png: engines.png },
    mermaid: { version: deps.version },
  }
}

/** One diagram as the client sees it. */
function publicDiagram(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    source: entry.source,
    status: entry.status,
    diagramType: entry.diagramType ?? null,
    diagnostics: entry.diagnostics ?? [],
    warnings: entry.warnings ?? [],
    render: entry.render ?? null,
    // The same verdict the tool result carries, computed by the same function:
    // the tab's pill and the model's "Browser:" line can never disagree.
    verification: verificationOf(entry),
    checkedAt: entry.checkedAt ?? null,
    artifact: entry.artifact ?? null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    by: entry.by,
    revision: entry.revision,
  }
}

/** A safe, readable file name for one export. */
function exportName(entry, format) {
  const base = String(entry.title || entry.id)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return (base.length > 0 ? base : entry.id) + '.' + format
}

/**
 * The bytes one export carries. `tex`/`mmd`/`md` come from the source, a
 * compiled artifact comes from the cache, and an `svg`/`png` of a MERMAID
 * diagram comes from the CLIENT - that is where the picture exists, because the
 * browser is what rendered it.
 */
function exportBytes(deps, entry, format, clientData) {
  if (format === 'mmd' || format === 'tex') return Buffer.from(entry.source + '\n', 'utf8')
  if (format === 'md') {
    const language = entry.kind === 'mermaid' ? 'mermaid' : 'latex'
    return Buffer.from('# ' + entry.title + '\n\n```' + language + '\n' + entry.source + '\n```\n', 'utf8')
  }
  if (typeof clientData === 'string' && clientData.length > 0) {
    const bytes = Buffer.from(clientData, 'base64')
    if (bytes.byteLength === 0) return null
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw httpError(413, 'TOO_LARGE', 'That image is too large to export.')
    return bytes
  }
  if (entry.kind === 'tikz' && entry.artifact) {
    const file = format === 'svg' ? 'doc.svg' : format === 'png' ? 'doc.png' : format === 'pdf' ? 'doc.pdf' : null
    if (file) return deps.cache.read(entry.artifact.hash, file)
  }
  return null
}

/**
 * Write one export into a directory, create-exclusively.
 *
 * `wx` is what makes "never clobbers a file you already had" a promise rather
 * than a hope: a collision takes `-2`, `-3`, ... instead of overwriting.
 *
 * @param directory - the folder to write into (the host's Desktop).
 * @param baseName - the first name to try.
 * @param bytes - the file's contents.
 * @returns the absolute path written.
 */
async function writeUnique(directory, baseName, bytes) {
  const extension = path.extname(baseName)
  const stem = baseName.slice(0, baseName.length - extension.length)
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const name = attempt === 0 ? baseName : stem + '-' + (attempt + 1) + extension
    const target = path.join(directory, name)
    try {
      await fsp.writeFile(target, bytes, { flag: 'wx' })
      return target
    } catch (err) {
      if (err && err.code === 'EEXIST') continue
      throw err
    }
  }
  throw httpError(409, 'NAME_TAKEN', 'Could not find a free file name on the Desktop.')
}

/**
 * Register every route the browser half talks to. The Connection fetch registry
 * takes EXACT routes whose methods are GET, HEAD and POST, so reads are GETs
 * and every write (including delete) is a POST.
 *
 * @param ctx - the cordis context.
 * @param deps - `{ store, cache, enginesNow, reprobe, version }`.
 * @returns a disposer that unregisters everything.
 */
export function registerRoutes(ctx, deps) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    return () => {}
  }
  const offs = []
  const register = (routePath, methods, handler) => {
    offs.push(
      connection.fetch.register({
        path: routePath,
        methods,
        requestBody: 'buffered',
        fetch: async (request) => {
          try {
            return await handler(request)
          } catch (err) {
            return errorToResponse(err)
          }
        },
      }),
    )
  }

  register(HEALTH_ROUTE, ['GET', 'HEAD'], async (request) => {
    const url = new URL(request.url)
    if (url.searchParams.get('refresh') === '1') deps.reprobe()
    const engines = deps.enginesNow()
    return json(200, {
      ok: true,
      plugin: name,
      mermaid: { version: deps.version, vendored: true, route: VENDOR_ROUTE },
      tex: { available: engines.available, engine: engines.engine, engines: engines.engines, svg: engines.svg, png: engines.png },
      store: { root: deps.store.root, artifacts: deps.cache.root, entries: deps.cache.entries().length },
    })
  })

  register(STATE_ROUTE, ['GET', 'HEAD'], async (request) => {
    const session = new URL(request.url).searchParams.get('session')
    if (!session) throw httpError(400, 'BAD_REQUEST', 'A session id is required.')
    const listed = deps.store.list(session)
    return json(200, { ok: true, session, diagrams: listed.diagrams, capabilities: healthSnapshot(deps) })
  })

  register(DIAGRAM_ROUTE, ['GET', 'HEAD', 'POST'], async (request) => {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const url = new URL(request.url)
      const session = url.searchParams.get('session')
      const id = url.searchParams.get('id')
      if (!session || !id) throw httpError(400, 'BAD_REQUEST', 'A session id and a diagram id are required.')
      const entry = deps.store.get(session, id)
      if (!entry) throw httpError(404, 'NOT_FOUND', 'No such diagram in this conversation.')
      return json(200, { ok: true, diagram: publicDiagram(entry) })
    }

    const body = await readJsonBody(request)
    const session = typeof body.session === 'string' ? body.session : ''
    if (!session) throw httpError(400, 'BAD_REQUEST', 'A session id is required.')

    if (body.delete === true) {
      const entry = deps.store.get(session, String(body.id ?? ''))
      const deleted = deps.store.remove(session, String(body.id ?? ''))
      if (deleted && entry && entry.artifact) deps.cache.drop(entry.artifact.hash)
      return json(200, { ok: true, deleted })
    }

    if (Buffer.byteLength(String(body.source ?? ''), 'utf8') > MAX_SOURCE_BYTES) {
      throw httpError(413, 'TOO_LARGE', 'The diagram source is larger than ' + Math.round(MAX_SOURCE_BYTES / 1024) + ' KiB.')
    }
    const existing = typeof body.id === 'string' && body.id.length > 0 ? deps.store.get(session, body.id) : undefined
    const kind = typeof body.kind === 'string' && KINDS.includes(body.kind) ? body.kind : (existing ? existing.kind : 'mermaid')
    const entry = deps.store.write(session, {
      id: existing ? existing.id : undefined,
      kind,
      title: typeof body.title === 'string' ? body.title : existing ? existing.title : undefined,
      source: String(body.source ?? ''),
      by: 'user',
      note: existing ? 'edited in the diagram panel' : 'created from the diagram panel',
    })
    const verdict = await checkAndRecord(deps, session, entry, { force: body.recompile === true })
    const fresh = deps.store.get(session, entry.id)
    return json(200, { ok: true, diagram: publicDiagram(fresh), status: verdict.status, diagnostics: verdict.diagnostics ?? [] })
  })

  register(ARTIFACT_ROUTE, ['GET', 'HEAD'], async (request) => {
    const url = new URL(request.url)
    const session = url.searchParams.get('session')
    const id = url.searchParams.get('id')
    const hash = url.searchParams.get('hash')
    const format = (url.searchParams.get('format') ?? 'svg').toLowerCase()
    if (!session) throw httpError(400, 'BAD_REQUEST', 'A session id is required.')
    let key = hash
    if (!key) {
      if (!id) throw httpError(400, 'BAD_REQUEST', 'Either a diagram id or an artifact hash is required.')
      const entry = deps.store.get(session, id)
      if (!entry) throw httpError(404, 'NOT_FOUND', 'No such diagram in this conversation.')
      if (entry.kind === 'mermaid') {
        // A Mermaid diagram has no host-side picture: the source IS the product,
        // and the browser is what draws it.
        if (format === 'mmd' || format === 'source') {
          return new Response(entry.source, {
            status: 200,
            headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
          })
        }
        throw httpError(404, 'NO_ARTIFACT', 'A Mermaid diagram has no compiled artifact; export its source, or its rendered SVG from the panel.')
      }
      if (!entry.artifact) throw httpError(404, 'NO_ARTIFACT', 'This diagram has not been compiled yet.')
      key = entry.artifact.hash
    }
    if (!HASH_PATTERN.test(key)) throw httpError(400, 'BAD_REQUEST', 'A malformed artifact hash.')
    const file = format === 'tex' || format === 'source' ? 'doc.tex' : format === 'pdf' ? 'doc.pdf' : format === 'png' ? 'doc.png' : format === 'svg' ? 'doc.svg' : null
    if (!file || !ARTIFACT_FILES.includes(file)) throw httpError(400, 'BAD_FORMAT', 'Supported artifact formats: svg, png, pdf, tex.')
    const bytes = deps.cache.read(key, file)
    if (!bytes || bytes.byteLength === 0) throw httpError(404, 'NO_ARTIFACT', 'That artifact is not cached.')
    const headers = {
      'content-type':
        file === 'doc.svg' ? 'image/svg+xml' : file === 'doc.png' ? 'image/png' : file === 'doc.pdf' ? 'application/pdf' : 'text/plain; charset=utf-8',
      'cache-control': 'private, max-age=3600',
    }
    if (request.method === 'HEAD') return new Response(null, { status: 200, headers })
    return new Response(bytes, { status: 200, headers })
  })

  /**
   * Save one export to the Desktop of the machine running the harness.
   *
   * The client never names a path: it asks for a format and the host decides
   * where a person keeps things, which is the same deal the screenshot control
   * makes. That leaves no traversal surface and no way to overwrite a file the
   * user already had - the write is create-exclusive and a collision takes the
   * next free name. An image the HOST cannot produce (a Mermaid SVG/PNG) arrives
   * in the body, because the browser is what rendered it.
   */
  register(EXPORT_ROUTE, ['POST'], async (request) => {
    const body = await readJsonBody(request, MAX_ARTIFACT_BYTES * 2)
    const session = typeof body.session === 'string' ? body.session : ''
    const id = typeof body.id === 'string' ? body.id : ''
    const format = String(body.format ?? '').toLowerCase()
    if (!session || !id) throw httpError(400, 'BAD_REQUEST', 'A session id and a diagram id are required.')
    const entry = deps.store.get(session, id)
    if (!entry) throw httpError(404, 'NOT_FOUND', 'No such diagram in this conversation.')
    const allowed = EXPORT_FORMATS[entry.kind] ?? []
    if (!allowed.includes(format)) throw httpError(400, 'BAD_FORMAT', 'A ' + entry.kind + ' diagram exports as: ' + allowed.join(', ') + '.')
    const bytes = exportBytes(deps, entry, format, body.data)
    if (bytes === null) {
      throw httpError(404, 'NO_ARTIFACT', 'There is nothing to export as ' + format + ' yet - render or compile the diagram first.')
    }
    const directory = await desktopDirectory()
    const written = await writeUnique(directory, exportName(entry, format), bytes)
    return json(200, {
      ok: true,
      path: written,
      directory,
      name: path.basename(written),
      bytes: bytes.byteLength,
      format,
    })
  })

  register(VENDOR_ROUTE, ['GET', 'HEAD'], (request) => serveVendor(request))

  /**
   * What the BROWSER did with one revision of one diagram.
   *
   * The client posts this after every render attempt, which is what lets the
   * model answer the one question the host cannot: did a picture actually
   * appear? The route is deliberately forgiving - a report about a diagram that
   * was deleted, or about a revision that is no longer current, answers 200 with
   * `stored: false`. A verification channel that can fail loudly would make the
   * browser's render loop look broken for reasons that are not its business.
   */
  register(REPORT_ROUTE, ['POST'], async (request) => {
    const body = await readJsonBody(request, 128 * 1024)
    const session = typeof body.session === 'string' ? body.session : ''
    const id = typeof body.id === 'string' ? body.id : ''
    if (!session || !id) throw httpError(400, 'BAD_REQUEST', 'A session id and a diagram id are required.')
    const entry = deps.store.get(session, id)
    if (!entry) return json(200, { ok: true, stored: false, reason: 'no such diagram in this conversation' })
    const stored = deps.store.recordRender(session, id, {
      revision: Number.isFinite(body.revision) ? body.revision : entry.revision,
      kind: body.kind,
      ok: body.ok === true,
      phase: body.phase,
      error: body.error,
      diagnostics: body.diagnostics,
      theme: body.theme,
      ms: body.ms,
      bytes: body.bytes,
    })
    return json(200, {
      ok: true,
      stored: Boolean(stored),
      id,
      revision: stored ? stored.render.revision : null,
      current: stored ? stored.revision : null,
    })
  })

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
/** The vendored engine's recorded version (also what the health route reports). */
function vendoredVersion() {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL('./vendor/VERSION.json', import.meta.url)), 'utf8')).version ?? 'unknown'
  } catch (err) {
    return 'unknown'
  }
}

/**
 * Activate the row.
 *
 * @param ctx - cordis context (inject: connection, tools).
 */
export function apply(ctx) {
  const log = {
    warn: (text) => ctx.logger?.warn?.('[dsh-diagrams] ' + text),
    info: (text) => ctx.logger?.info?.('[dsh-diagrams] ' + text),
  }
  const root = path.join(resolveHome(), 'dsh-diagrams')
  const store = new DiagramStore({ root })
  const cache = new ArtifactCache({ root: path.join(root, 'artifacts') })
  let engines = probeEngines()
  const deps = {
    store,
    cache,
    version: vendoredVersion(),
    enginesNow: () => engines,
    reprobe: () => {
      engines = probeEngines()
      return engines
    },
  }

  log.info(
    'active: mermaid@' +
      deps.version +
      ', tex ' +
      (engines.available ? engines.engine + ' + ' + (engines.svg ?? 'no SVG converter') : 'UNAVAILABLE') +
      ', state ' +
      root,
  )

  const skillCount = registerSkills(ctx, log)
  log.info('registered ' + skillCount + ' bundled skill(s)')

  for (const tool of buildTools(deps)) {
    ctx.effect(() => ctx.tools.register(tool), 'dsh-diagrams: tool ' + tool.name)
  }

  ctx.effect(() => registerRoutes(ctx, deps), 'dsh-diagrams: routes')
}

/** One error's message, whatever was thrown. */
function message(err) {
  return err && err.message ? String(err.message) : String(err)
}
