/**
 * dsh-diagrams — the per-conversation diagram store.
 *
 * WHERE the state lives, and why not somewhere cleverer:
 *
 *   - **Not a session event.** A plugin that appends its own event type would
 *     make the session log unreadable: `@deepseek-ai/dsh-session-persistence`
 *     refuses a log containing a type outside `KNOWN_SESSION_EVENT_TYPES`
 *     unless the event carries `ignorable: true`, and `Session.append()` has no
 *     way to set that marker. State therefore never touches the session log.
 *   - **Not a projection.** A wire projection unit needs a `zod` schema object,
 *     and this pack ships zero npm dependencies (the profile installs bundles
 *     as live links, so a package dependency would not be installed). It would
 *     also inherit the event-type problem, since a projection folds events.
 *   - **A file per conversation**, next to the rest of the harness state under
 *     `$DSH_HOME/dsh-diagrams/sessions/`. The host is the only writer, the
 *     client reads it over the plugin's own authenticated route, and the model
 *     reads it back through `diagram_read` - which is what makes a diagram
 *     survive compaction, a reload, or the browser closing.
 *
 * Every write is atomic (private temp name, then rename over the target), the
 * whole store is capped, and one conversation's file never grows past
 * {@link MAX_STATE_BYTES}.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** At most this many diagrams per conversation. */
export const MAX_DIAGRAMS = 64
/** A single diagram's source is cut here (a diagram, not a book). */
export const MAX_SOURCE_BYTES = 256 * 1024
/** Title length cap; the id is derived from it. */
export const MAX_TITLE_CHARS = 120
/** How many history entries one diagram keeps. */
export const MAX_HISTORY = 20
/** The whole per-conversation file is refused above this size. */
export const MAX_STATE_BYTES = 1024 * 1024
/** The id grammar; also what the client puts in a tab address. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/

/** The diagram kinds this plugin owns. */
export const KINDS = ['mermaid', 'tikz']

/**
 * The harness config root: `$DSH_HOME`, else `~/.dsh` (the same resolution the
 * installer, the terminal and `dsh-skill-filesystem` use).
 *
 * @param env - environment to read.
 * @returns the absolute DSH home path.
 */
export function resolveHome(env = process.env) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return path.resolve(configured.trim())
  return path.join(os.homedir(), '.dsh')
}

/** A filesystem-safe file name for a session id, plus a short hash so two ids that sanitize alike stay apart. */
function safeSessionName(sessionId) {
  const base = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  const digest = createHash('sha1').update(String(sessionId)).digest('hex').slice(0, 10)
  return base + '-' + digest
}

/** One typed store failure. */
function storeError(code, message) {
  const err = new Error(message)
  err.code = code
  return err
}

/** Slug one title into an id candidate. */
function slugify(text, fallback) {
  const slug = String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  const trimmed = slug.replace(/-+$/g, '')
  return trimmed.length > 0 ? trimmed : fallback
}

/** `order` and `diagrams` kept consistent: summaries in a stable, useful order. */
function summarize(entry) {
  return {
    id: entry.id,
    kind: entry.kind,
    title: entry.title,
    // The SOURCE travels with the summary, and it has to: the browser half holds
    // no other copy of it. Mermaid is rendered from its source in the browser,
    // TikZ is exported from it, and the source drawer edits it - a list without
    // it leaves every diagram tab and every conversation card blank.
    source: entry.source,
    status: entry.status,
    diagramType: entry.diagramType ?? null,
    warnings: Array.isArray(entry.warnings) ? entry.warnings : [],
    render: entry.render ?? null,
    // The revision travels with the summary because the browser needs it to
    // answer "is this picture of the CURRENT source?": it keys the artifact
    // request on it and reports the revision it drew. Without it every render
    // report would look fresh, including one about text that has since changed.
    revision: Number.isFinite(entry.revision) ? entry.revision : 0,
    checkedAt: entry.checkedAt ?? null,
    updatedAt: entry.updatedAt,
    createdAt: entry.createdAt,
    by: entry.by,
    bytes: Buffer.byteLength(entry.source, 'utf8'),
    lines: entry.source.length === 0 ? 0 : entry.source.split('\n').length,
    artifact: entry.artifact
      ? {
          hash: entry.artifact.hash,
          pages: entry.artifact.pages ?? null,
          width: entry.artifact.width ?? null,
          height: entry.artifact.height ?? null,
          formats: entry.artifact.formats ?? [],
          engine: entry.artifact.engine ?? null,
          at: entry.artifact.at ?? null,
        }
      : null,
  }
}

/** The per-conversation diagram state. */
export class DiagramStore {
  /**
   * @param options - `{ root }`, the store root (defaults to `$DSH_HOME/dsh-diagrams`).
   * @param options.root - absolute directory the store owns.
   */
  constructor({ root } = {}) {
    this.root = root ?? path.join(resolveHome(), 'dsh-diagrams')
    this.sessionsDir = path.join(this.root, 'sessions')
    /** Loaded conversations, by session id; the memory copy is authoritative while loaded. */
    this.loaded = new Map()
  }

  /** Absolute path of one conversation's state file. */
  fileFor(sessionId) {
    return path.join(this.sessionsDir, safeSessionName(sessionId) + '.json')
  }

  /** The empty state for a conversation that has none yet. */
  empty(sessionId) {
    return { version: 1, sessionId: String(sessionId), updatedAt: new Date().toISOString(), order: [], diagrams: {} }
  }

  /**
   * The conversation's state, read from memory or from disk on first use.
   * A file that is unreadable, malformed or claims a different session is
   * treated as empty rather than crashing the row: losing diagrams must never
   * break the conversation.
   *
   * @param sessionId - the conversation id.
   * @returns the live state object (callers must not mutate it directly).
   */
  state(sessionId) {
    const key = String(sessionId)
    const cached = this.loaded.get(key)
    if (cached) return cached
    let state = this.empty(key)
    const file = this.fileFor(key)
    try {
      if (existsSync(file) && statSync(file).size <= MAX_STATE_BYTES) {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (parsed && typeof parsed === 'object' && Array.isArray(parsed.order) && parsed.diagrams && typeof parsed.diagrams === 'object') {
          state = {
            version: 1,
            sessionId: key,
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
            order: parsed.order.filter((id) => typeof id === 'string' && parsed.diagrams[id]).slice(0, MAX_DIAGRAMS),
            diagrams: parsed.diagrams,
          }
        }
      }
    } catch (err) {
      state = this.empty(key)
    }
    this.loaded.set(key, state)
    return state
  }

  /** Persist one conversation's state atomically. */
  save(sessionId) {
    const state = this.state(sessionId)
    state.updatedAt = new Date().toISOString()
    mkdirSync(this.sessionsDir, { recursive: true })
    const file = this.fileFor(sessionId)
    const tmp = file + '.' + process.pid + '.' + Date.now() + '.tmp'
    try {
      writeFileSync(tmp, JSON.stringify(state), { encoding: 'utf8', flag: 'wx' })
      renameSync(tmp, file)
    } catch (err) {
      try {
        rmSync(tmp, { force: true })
      } catch (cleanupErr) {
        /* nothing else to do */
      }
      throw err
    }
    return state
  }

  /**
   * The conversation's diagrams, newest activity first is NOT applied - the
   * order is creation order, which is what the index page and the model read.
   *
   * @param sessionId - the conversation id.
   * @returns `{ sessionId, updatedAt, diagrams: summaries[] }`.
   */
  list(sessionId) {
    const state = this.state(sessionId)
    return {
      sessionId: state.sessionId,
      updatedAt: state.updatedAt,
      diagrams: state.order.map((id) => summarize(state.diagrams[id])).filter(Boolean),
    }
  }

  /** One diagram, or undefined. */
  get(sessionId, id) {
    const state = this.state(sessionId)
    const entry = state.diagrams[id]
    if (!entry) return undefined
    // A file written by an older version of this plugin has neither field; the
    // read path normalizes them so no caller has to guard for it.
    if (!Array.isArray(entry.warnings)) entry.warnings = []
    if (entry.render === undefined) entry.render = null
    return { ...entry, summary: summarize(entry) }
  }

  /** Every id in the conversation (in creation order). */
  ids(sessionId) {
    return [...this.state(sessionId).order]
  }

  /** Claim a unique id for a new diagram in one conversation. */
  claimId(sessionId, requested, title, kind) {
    const state = this.state(sessionId)
    if (typeof requested === 'string' && requested.length > 0) {
      if (!ID_PATTERN.test(requested)) {
        throw storeError('BAD_ID', 'A diagram id must be lowercase letters, digits and dashes (max 48 characters).')
      }
      return requested
    }
    const base = slugify(title, kind)
    if (!state.diagrams[base]) return base
    for (let n = 2; n < 1000; n += 1) {
      const candidate = (base + '-' + n).slice(0, 48)
      if (!state.diagrams[candidate]) return candidate
    }
    throw storeError('LIMIT', 'Could not find a free diagram id.')
  }

  /**
   * Create or replace one diagram. The state-carrying write the tool uses.
   *
   * @param sessionId - the conversation id.
   * @param input - `{ id?, kind, title?, source, by?, note? }`.
   * @returns the stored diagram entry.
   */
  write(sessionId, input) {
    const state = this.state(sessionId)
    const kind = String(input.kind ?? '')
    if (!KINDS.includes(kind)) {
      throw storeError('BAD_KIND', 'A diagram kind must be one of: ' + KINDS.join(', ') + '.')
    }
    const source = String(input.source ?? '')
    if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
      throw storeError('TOO_LARGE', 'The diagram source is larger than ' + Math.round(MAX_SOURCE_BYTES / 1024) + ' KiB.')
    }
    const existing = typeof input.id === 'string' && input.id.length > 0 ? state.diagrams[input.id] : undefined
    if (!existing && state.order.length >= MAX_DIAGRAMS) {
      throw storeError('LIMIT', 'This conversation already has ' + MAX_DIAGRAMS + ' diagrams; delete one first.')
    }
    // An explicit id that names an existing diagram replaces it - engine
    // included: a diagram is a name plus a source, and rewriting a Mermaid
    // picture as a TikZ one under the same name is a legitimate edit.
    const id = existing ? existing.id : this.claimId(sessionId, input.id, input.title, kind)
    const now = new Date().toISOString()
    const title = String(input.title ?? (existing ? existing.title : '')).trim().slice(0, MAX_TITLE_CHARS)
    const entry = {
      id,
      kind,
      title: title.length > 0 ? title : defaultTitle(kind, id),
      source,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      by: input.by === 'user' ? 'user' : 'model',
      revision: (existing ? existing.revision : 0) + 1,
      status: 'unchecked',
      diagramType: null,
      diagnostics: [],
      warnings: [],
      // The new source has not been drawn yet, and the old report was about a
      // different revision: keeping it would let a stale "drawn" read as a
      // verdict on text no browser has seen.
      render: null,
      artifact: null,
      history: (existing ? existing.history : []).concat([
        { at: now, by: input.by === 'user' ? 'user' : 'model', note: String(input.note ?? (existing ? 'rewritten' : 'created')).slice(0, 200) },
      ]).slice(-MAX_HISTORY),
    }
    state.diagrams[id] = entry
    if (!existing) state.order.push(id)
    this.save(sessionId)
    return entry
  }

  /**
   * Literal replacement inside one diagram's source - the cheap iteration path
   * for a large TikZ picture, with the same uniqueness rule the pack's editor
   * uses: an ambiguous `oldString` is refused instead of guessing.
   *
   * @param sessionId - the conversation id.
   * @param input - `{ id, oldString, newString, replaceAll?, by?, note? }`.
   * @returns `{ entry, occurrences }`.
   */
  patch(sessionId, input) {
    const state = this.state(sessionId)
    const existing = state.diagrams[input.id]
    if (!existing) throw storeError('NOT_FOUND', 'No diagram "' + input.id + '" in this conversation.')
    const oldString = String(input.oldString ?? '')
    const newString = String(input.newString ?? '')
    if (oldString.length === 0) throw storeError('BAD_PATCH', '`oldString` must not be empty.')
    const occurrences = countOccurrences(existing.source, oldString)
    if (occurrences === 0) throw storeError('NO_MATCH', '`oldString` does not appear in the diagram source.')
    if (occurrences > 1 && input.replaceAll !== true) {
      throw storeError('AMBIGUOUS', '`oldString` appears ' + occurrences + ' times; pass a longer unique string or set replaceAll.')
    }
    const source = input.replaceAll === true ? existing.source.split(oldString).join(newString) : existing.source.replace(oldString, newString)
    if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
      throw storeError('TOO_LARGE', 'The diagram source is larger than ' + Math.round(MAX_SOURCE_BYTES / 1024) + ' KiB.')
    }
    const now = new Date().toISOString()
    existing.source = source
    existing.updatedAt = now
    existing.by = input.by === 'user' ? 'user' : 'model'
    existing.revision += 1
    existing.status = 'unchecked'
    existing.diagnostics = []
    existing.warnings = []
    existing.render = null
    existing.artifact = null
    existing.history = existing.history
      .concat([
        {
          at: now,
          by: input.by === 'user' ? 'user' : 'model',
          note: String(input.note ?? 'patched ' + (input.replaceAll === true ? occurrences : 1) + ' occurrence(s)').slice(0, 200),
        },
      ])
      .slice(-MAX_HISTORY)
    this.save(sessionId)
    return { entry: existing, occurrences }
  }

  /**
   * Record the last validation/compile verdict for one diagram. Kept apart from
   * {@link write} because it must not bump the revision (nothing about the
   * source changed) but must reach the UI, which shows the status pill.
   */
  recordVerdict(sessionId, id, verdict) {
    const state = this.state(sessionId)
    const entry = state.diagrams[id]
    if (!entry) return undefined
    entry.status = verdict.status
    entry.diagramType = verdict.diagramType ?? null
    entry.diagnostics = Array.isArray(verdict.diagnostics) ? verdict.diagnostics.slice(0, 12) : []
    entry.warnings = Array.isArray(verdict.warnings) ? verdict.warnings.slice(0, 8) : []
    if (verdict.artifact !== undefined) entry.artifact = verdict.artifact
    entry.checkedAt = new Date().toISOString()
    this.save(sessionId)
    return entry
  }

  /**
   * Record what the BROWSER did with one revision of a diagram.
   *
   * Kept apart from {@link recordVerdict} because it answers a different
   * question - the host says "this source parses", only the renderer says "this
   * picture exists" - and apart from the revision itself, because a render is
   * not an edit. A report about a revision that is no longer current is still
   * stored (it is the truth about that revision) and simply reads as stale.
   *
   * @param sessionId - the conversation id.
   * @param id - the diagram id.
   * @param report - `{ revision, kind, ok, phase, error, diagnostics, theme, ms, bytes }`.
   * @returns the stored entry, or undefined when the diagram is gone.
   */
  recordRender(sessionId, id, report) {
    const state = this.state(sessionId)
    const entry = state.diagrams[id]
    if (!entry) return undefined
    entry.render = {
      revision: Number.isFinite(report.revision) ? report.revision : entry.revision,
      kind: report.kind === 'tikz' ? 'tikz' : 'mermaid',
      ok: report.ok === true,
      phase: typeof report.phase === 'string' ? report.phase.slice(0, 24) : null,
      error: typeof report.error === 'string' && report.error.length > 0 ? report.error.slice(0, 2000) : null,
      diagnostics: Array.isArray(report.diagnostics)
        ? report.diagnostics
            .map((entry) => ({ kind: String(entry?.kind ?? 'render').slice(0, 24), text: String(entry?.text ?? '').slice(0, 400) }))
            .filter((entry) => entry.text.length > 0)
            .slice(0, 8)
        : [],
      theme: report.theme === 'dark' ? 'dark' : report.theme === 'default' ? 'default' : null,
      ms: Number.isFinite(report.ms) ? report.ms : null,
      bytes: Number.isFinite(report.bytes) ? report.bytes : null,
      at: new Date().toISOString(),
    }
    this.save(sessionId)
    return entry
  }

  /** Remove one diagram. */
  remove(sessionId, id) {
    const state = this.state(sessionId)
    if (!state.diagrams[id]) return false
    delete state.diagrams[id]
    state.order = state.order.filter((entry) => entry !== id)
    this.save(sessionId)
    return true
  }

  /** Drop one conversation from memory (its file stays until the session is deleted). */
  forget(sessionId) {
    this.loaded.delete(String(sessionId))
  }
}

/** A readable default title when the model gave none. */
function defaultTitle(kind, id) {
  return (kind === 'tikz' ? 'TikZ diagram' : 'Mermaid diagram') + ' ' + id
}

/** How many times `needle` occurs in `haystack` (non-overlapping, literal). */
function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count += 1
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}

/** Every session file the store owns, for diagnostics and pruning. */
export function listSessionFiles(root) {
  const dir = path.join(root, 'sessions')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
}
