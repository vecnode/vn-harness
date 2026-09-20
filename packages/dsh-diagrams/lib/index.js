/**
 * dsh-diagrams — host half.
 *
 * One row owns the whole diagram capability:
 *
 *   - **Four tools** (`diagram_write`, `diagram_patch`, `diagram_read`,
 *     `diagram_delete`) registered on `ctx.tools`. Every write is VALIDATED
 *     before it is stored - Mermaid by parsing it headlessly with the same
 *     vendored engine the browser renders with, TikZ by compiling it with the
 *     machine's own TeX engine - so a broken diagram comes back to the model as
 *     the parser's/compiler's own error lines instead of a blank picture.
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
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { ArtifactCache, HASH_PATTERN, MAX_ARTIFACT_BYTES, ARTIFACT_FILES } from './cache.js'
import { compileTikz, normalizeTikzSource, probeEngines, stripFence } from './latex.js'
import { DiagramStore, KINDS, MAX_SOURCE_BYTES, resolveHome } from './store.js'

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

/**
 * The workspace root of one session: the live session header while the session
 * is running, otherwise the stored header from session persistence (the same
 * two-step lookup the editor's own routes perform).
 */
async function sessionRoot(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw httpError(400, 'BAD_REQUEST', 'A session id is required.')
  }
  const get = typeof ctx.get === 'function' ? (service) => ctx.get(service) : () => undefined
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
    /* fall through to the typed failure */
  }
  throw httpError(409, 'NO_WORKSPACE', 'The workspace folder for this conversation is not available.')
}

/** Resolve a workspace-relative path and prove, by realpath, that it stays inside. */
async function resolveInside(cwd, rel) {
  if (typeof rel !== 'string' || rel.length === 0) throw httpError(400, 'BAD_REQUEST', 'A file name is required.')
  if (rel.includes('\0')) throw httpError(400, 'BAD_REQUEST', 'The file name is not valid.')
  const root = await fsp.realpath(cwd)
  const target = path.resolve(root, rel)
  const relative = path.relative(root, target)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw httpError(400, 'OUTSIDE_WORKSPACE', 'That path is outside the conversation folder.')
  }
  return target
}

// ---------------------------------------------------------------------------
// Mermaid validation
// ---------------------------------------------------------------------------
/** Absolute path of the child validator. */
const MERMAID_CHECK = fileURLToPath(new URL('./mermaid-check.mjs', import.meta.url))

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
export function checkMermaid(source, { signal } = {}) {
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
        finish({ ok: true, status: 'ok', diagramType: verdict.diagramType ?? null, diagnostics: [], ms: verdict.ms })
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
  return { ok: false, status: 'unavailable', diagramType: null, diagnostics: [{ kind: 'validator', text }] }
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
    })
    return { ...verdict, ms: verdict.ms ?? Date.now() - started, artifact: stored ? stored.artifact : null }
  }

  const engines = deps.enginesNow()
  if (!engines.available) {
    const stored = deps.store.recordVerdict(sessionId, entry.id, {
      status: 'unavailable',
      diagramType: null,
      diagnostics: [{ kind: 'engine', text: 'No TeX engine found on this host (looked for pdflatex, xelatex, lualatex).' }],
    })
    return {
      ok: false,
      status: 'unavailable',
      diagramType: null,
      diagnostics: stored.diagnostics,
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
    const stored = deps.store.recordVerdict(sessionId, entry.id, {
      status: 'ok',
      diagramType: 'tikz',
      diagnostics: [],
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
    return { ok: true, status: 'ok', diagramType: 'tikz', diagnostics: [], artifact: stored.artifact, ms: Date.now() - started, cached: true }
  }

  const result = await withCompileSlot(() => compileTikz({ document: normalized.document, engines, signal, dpi: RASTER_DPI }))
  const diagnostics = result.diagnostics ?? []
  const status = result.unavailable ? 'unavailable' : diagnostics.length > 0 ? 'error' : 'ok'
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
  const stored = deps.store.recordVerdict(sessionId, entry.id, { status, diagramType: 'tikz', diagnostics, artifact })
  return { ok: status === 'ok', status, diagramType: 'tikz', diagnostics, artifact: stored.artifact, ms: Date.now() - started }
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
  },
  required: ['id', 'kind', 'title', 'status', 'address'],
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
  })
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
      'With `id`: that diagram\'s complete source, kind, status, last diagnostics and the exact address of its tab.',
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
        const header = [
          'Diagram "' + entry.id + '" (' + entry.kind + '), status: ' + entry.status + (entry.title ? ', title: ' + entry.title : '') + '.',
          'Tab address: ' + addressOf(sessionId, entry.id),
        ]
        if (entry.diagnostics && entry.diagnostics.length > 0) {
          header.push('Last diagnostics:')
          for (const diagnostic of entry.diagnostics) header.push('  - ' + diagnostic.text)
        }
        if (args.includeSource === false) return { text: header.join('\n'), id: entry.id, kind: entry.kind, status: entry.status }
        const body = '---8<--- source ---8<---\n' + entry.source + '\n---8<--- end source ---8<---'
        return {
          text: header.join('\n') + '\n\n' + body,
          id: entry.id,
          kind: entry.kind,
          status: entry.status,
          address: addressOf(sessionId, entry.id),
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

  return [write, patch, read, remove]
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

/** Write one export into the workspace, create-exclusively. */
async function writeExclusive(target, bytes) {
  const extension = path.extname(target)
  const stem = target.slice(0, target.length - extension.length)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = attempt === 0 ? target : stem + '-' + (attempt + 1) + extension
    try {
      await fsp.writeFile(candidate, bytes, { flag: 'wx' })
      return candidate
    } catch (err) {
      if (err && err.code === 'EEXIST') continue
      throw err
    }
  }
  throw httpError(409, 'NAME_TAKEN', 'Could not find a free file name in the conversation folder.')
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
    const root = await sessionRoot(ctx, session)
    const target = await resolveInside(root, exportName(entry, format))
    const written = await writeExclusive(target, bytes)
    return json(200, { ok: true, path: path.relative(root, written).split(path.sep).join('/'), bytes: bytes.byteLength })
  })

  register(VENDOR_ROUTE, ['GET', 'HEAD'], (request) => serveVendor(request))

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
