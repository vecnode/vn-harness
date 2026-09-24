/**
 * dsh-editor — Node half.
 *
 * The editor tab is a browser plugin, but reading and saving real text files
 * needs disk I/O the browser cannot reach: the served remote surface
 * (`remote.workspaceFiles`) reads files but exposes **no mutation operation**,
 * so saving needs a route of our own. This row therefore owns two
 * authenticated `connection.fetch` routes under /api/dsh-editor/* — the same
 * mechanism the shipped session-log-export plugin uses for its ZIP download:
 *
 *   GET  /api/dsh-editor/file?session=<id>&path=<rel>   read one text file
 *   PUT  /api/dsh-editor/file                           save (or create) one text file
 *   GET  /api/dsh-editor/vendor                         vendored CodeMirror 6 bundle
 *
 * The session id is what the browser tab already carries (its address is
 * `dsh-resource://file/session/<sessionId>/<path>`); the workspace root is
 * resolved HERE, from the live session header when the session is running and
 * from session persistence when it is cold — the same two-step lookup
 * `@deepseek-ai/dsh-api-workspace-files` uses for its own reads. The client
 * never names a root.
 *
 * File semantics mirror the @deepseek-ai/dsh-fs "text" contract as closely as a
 * plain-fs row reasonably can, without depending on fs sandbox/policy state
 * that belongs to the tool layer:
 *
 *   - containment:  the requested file is resolved against the session's
 *     workspace root and realpath-checked to stay inside it, so a relative path
 *     can never escape the conversation's folder;
 *   - text only:    content is decoded as strict UTF-8 and rejected when it is
 *     invalid or contains a NUL byte — binary files can never open in the text
 *     editor;
 *   - bounded:      files over 2 MiB are refused instead of buffered;
 *   - atomic write: saves go to a private temp name in the same directory and
 *     are renamed over the target, so a crash never leaves a half-written file;
 *   - create-only:  a PUT carrying `create: true` writes a NEW file at a
 *     workspace-relative path whose parent folder already exists inside the
 *     workspace. The target must not exist (409 EXISTS) and the publish is
 *     create-exclusive, so a create never overwrites a file the user did not
 *     open - neither the one they typed nor one that appeared meanwhile;
 *   - optimistic:   the client echoes the mtime/size it opened with; a save
 *     whose on-disk stat no longer matches is refused (HTTP 409) instead of
 *     silently clobbering a concurrent change.
 *
 * The plugin reads/writes exactly what its own GUI asks for (the owner's
 * session folders), so no sandbox escalation or approval flow is involved.
 */
import { promises as fsp, constants as fsConstants } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const name = 'dsh-editor'

export const inject = ['connection']

/** Keep in sync with the client's hard-coded route constants. */
const API_ROOT = '/api/dsh-editor'
const FILE_ROUTE = API_ROOT + '/file'
const VENDOR_ROUTE = API_ROOT + '/vendor'

/** Files above this many bytes are refused (read and write). */
const MAX_TEXT_BYTES = 2 * 1024 * 1024

/** A version token is just mtime (ms precision) plus size of the file. */
function versionOf(stats) {
  return String(stats.mtimeMs) + ':' + String(stats.size)
}

/** Respond with a JSON body and a status code. */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Typed failure → HTTP response. */
function fail(status, code, message) {
  return json(status, { ok: false, error: { code, message } })
}

function httpError(status, code, message, cause) {
  const err = new Error(message)
  err.status = status
  err.code = code
  if (cause) err.cause = cause
  return err
}

/**
 * The workspace root of one session: the live session header while the session
 * is running, otherwise the stored header from session persistence. Mirrors the
 * lookup `@deepseek-ai/dsh-api-workspace-files` performs for its own reads, and
 * degrades to a typed failure (never a guess) when neither knows the session.
 *
 * @param ctx - the plugin context (services are re-read per request).
 * @param sessionId - the session the edited tab belongs to.
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
    // fall through to persistence
  }
  try {
    const persistence = get('sessionPersistence')
    if (persistence && typeof persistence.stat === 'function') {
      const snapshot = await persistence.stat(sessionId)
      const header = snapshot && snapshot.header
      if (header && typeof header.cwd === 'string' && header.cwd.length > 0) return header.cwd
    }
  } catch (err) {
    // fall through to the typed failure below
  }
  throw httpError(409, 'NO_WORKSPACE', 'The workspace folder for this conversation is not available.')
}

/**
 * Resolve a workspace-relative path against the session root and verify, via
 * realpath, that the result stays inside it. The client may pass any string;
 * nothing outside the workspace is ever reachable.
 *
 * @param cwd - the session workspace root (absolute).
 * @param rel - the file path, relative to the workspace root.
 * @returns {Promise<string>} the realpath of the file.
 */
async function resolveInside(cwd, rel) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw httpError(400, 'BAD_REQUEST', 'A workspace folder is required.')
  }
  if (typeof rel !== 'string' || rel.length === 0) {
    throw httpError(400, 'BAD_REQUEST', 'A path is required.')
  }
  const normalized = rel.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw httpError(400, 'BAD_REQUEST', 'The path must be relative to the conversation folder.')
  }
  const rootAbs = path.resolve(cwd)
  let rootReal
  try {
    rootReal = await fsp.realpath(rootAbs)
  } catch (err) {
    throw httpError(400, 'NO_FOLDER', 'The conversation folder does not exist on disk.', err)
  }
  const fileAbs = path.resolve(rootReal, normalized)
  const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep
  if (fileAbs !== rootReal && !fileAbs.startsWith(rootPrefix)) {
    throw httpError(403, 'OUTSIDE_WORKSPACE', 'The path escapes the conversation folder.')
  }
  let fileReal
  try {
    fileReal = await fsp.realpath(fileAbs)
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw httpError(404, 'NOT_FOUND', 'The file does not exist in the conversation folder.', err)
    }
    throw httpError(500, 'IO_ERROR', 'Could not resolve the file on disk.', err)
  }
  return fileReal
}

/**
 * Resolve a workspace-relative path for a file that does NOT exist yet.
 *
 * The parent folder must already exist inside the workspace and is
 * realpath-checked, so a symlinked folder cannot smuggle the write outside the
 * conversation folder; nothing here creates directories. The target itself
 * must not exist: this route creates, it never overwrites a file the user did
 * not open.
 *
 * @param cwd - the session workspace root (absolute).
 * @param rel - the new file's path, relative to the workspace root.
 * @returns {Promise<string>} the absolute target path.
 */
async function resolveNewInside(cwd, rel) {
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw httpError(400, 'BAD_REQUEST', 'A workspace folder is required.')
  }
  if (typeof rel !== 'string' || rel.length === 0) {
    throw httpError(400, 'BAD_REQUEST', 'A path is required.')
  }
  const normalized = rel.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw httpError(400, 'BAD_REQUEST', 'The path must be relative to the conversation folder.')
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw httpError(400, 'BAD_REQUEST', 'The path cannot contain empty, "." or ".." segments.')
  }
  const name = segments.pop()
  if (name === undefined || name.length === 0) {
    throw httpError(400, 'BAD_REQUEST', 'A file name is required.')
  }
  let rootReal
  try {
    rootReal = await fsp.realpath(path.resolve(cwd))
  } catch (err) {
    throw httpError(400, 'NO_FOLDER', 'The conversation folder does not exist on disk.', err)
  }
  const rootPrefix = rootReal.endsWith(path.sep) ? rootReal : rootReal + path.sep
  const parentAbs = path.resolve(rootReal, ...segments)
  if (parentAbs !== rootReal && !parentAbs.startsWith(rootPrefix)) {
    throw httpError(403, 'OUTSIDE_WORKSPACE', 'The path escapes the conversation folder.')
  }
  let parentReal
  try {
    parentReal = await fsp.realpath(parentAbs)
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw httpError(404, 'NO_FOLDER', 'The folder for this file does not exist in the conversation folder.', err)
    }
    throw httpError(500, 'IO_ERROR', 'Could not resolve the folder on disk.', err)
  }
  if (parentReal !== rootReal && !parentReal.startsWith(rootPrefix)) {
    throw httpError(403, 'OUTSIDE_WORKSPACE', 'The path escapes the conversation folder.')
  }
  let parentStats
  try {
    parentStats = await fsp.stat(parentReal)
  } catch (err) {
    throw httpError(500, 'IO_ERROR', 'Could not read the folder on disk.', err)
  }
  if (!parentStats.isDirectory()) {
    throw httpError(400, 'NOT_FOLDER', 'The parent path is not a folder.')
  }
  const target = path.join(parentReal, name)
  try {
    await fsp.stat(target)
  } catch (err) {
    if (err && err.code === 'ENOENT') return target
    throw httpError(500, 'IO_ERROR', 'Could not check the target path on disk.', err)
  }
  throw httpError(409, 'EXISTS', 'A file with this name already exists in the conversation folder.')
}

/**
 * Publish a freshly written temp file as a NEW file without ever replacing an
 * existing one: a hard link is atomic and refuses an existing target, and the
 * create-exclusive copy keeps the same guarantee on a filesystem without hard
 * links. A target that appeared since the name was checked answers 409.
 *
 * @param tmp - the private temp file holding the bytes (same directory).
 * @param target - the new file's absolute path.
 */
async function publishNew(tmp, target) {
  const exists = httpError(409, 'EXISTS', 'A file with this name already exists in the conversation folder.')
  try {
    await fsp.link(tmp, target)
    return
  } catch (err) {
    if (err && err.code === 'EEXIST') throw exists
    const unsupported = err && (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOSYS' || err.code === 'EXDEV' || err.code === 'EPLATFORM')
    if (!unsupported) throw err
  }
  try {
    await fsp.copyFile(tmp, target, fsConstants.COPYFILE_EXCL)
  } catch (err) {
    if (err && err.code === 'EEXIST') throw exists
    throw err
  }
}

/** A coarse but reliable text probe: strict UTF-8 and no NUL bytes. */
function decodeText(buffer) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch (err) {
    throw httpError(415, 'NOT_TEXT', 'This file is not UTF-8 text and cannot open in the text editor.', err)
  }
  if (text.indexOf('\u0000') >= 0) {
    throw httpError(415, 'NOT_TEXT', 'This file looks binary and cannot open in the text editor.')
  }
  return text
}

function readErrorToResponse(err) {
  const status = typeof err.status === 'number' ? err.status : 500
  const code = err.code || 'IO_ERROR'
  const message = err.message || String(err)
  return json(status, { ok: false, error: { code, message } })
}

/**
 * GET/HEAD/PUT /api/dsh-editor/file — read or write one text file of one
 * session's workspace.
 *
 * @param ctx - the plugin context, used to resolve the session workspace root.
 * @param request - the incoming request.
 * @returns {Promise<Response>} the JSON answer.
 */
async function handleFile(ctx, request) {
  try {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const url = new URL(request.url)
      const sessionId = url.searchParams.get('session') || ''
      const rel = url.searchParams.get('path') || ''
      const cwd = await sessionRoot(ctx, sessionId)
      const target = await resolveInside(cwd, rel)
      let stats
      try {
        stats = await fsp.stat(target)
      } catch (err) {
        throw httpError(404, 'NOT_FOUND', 'The file does not exist in the conversation folder.', err)
      }
      if (!stats.isFile()) {
        throw httpError(400, 'NOT_FILE', 'The path is not a regular file.')
      }
      if (stats.size > MAX_TEXT_BYTES) {
        throw httpError(413, 'TOO_LARGE', 'The file is larger than ' + Math.round(MAX_TEXT_BYTES / 1024 / 1024) + ' MiB and was not opened.')
      }
      const buffer = await fsp.readFile(target)
      const text = decodeText(buffer)
      if (request.method === 'HEAD') {
        return new Response(null, {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        })
      }
      return json(200, {
        ok: true,
        path: rel,
        text,
        bytes: buffer.byteLength,
        version: versionOf(stats),
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      })
    }

    // PUT — save or create. { session, path, text, expected?: { mtimeMs, size }, create?: true }
    let payload
    try {
      payload = await request.json()
    } catch (err) {
      return fail(400, 'BAD_REQUEST', 'Expected a JSON body.')
    }
    const sessionId = typeof payload.session === 'string' ? payload.session : ''
    const rel = typeof payload.path === 'string' ? payload.path : ''
    const text = typeof payload.text === 'string' ? payload.text : null
    if (text === null) {
      return fail(400, 'BAD_REQUEST', 'Expected a text field.')
    }
    const content = Buffer.from(text, 'utf8')
    if (content.byteLength > MAX_TEXT_BYTES) {
      throw httpError(413, 'TOO_LARGE', 'The file would be larger than ' + Math.round(MAX_TEXT_BYTES / 1024 / 1024) + ' MiB and was not saved.')
    }
    const cwd = await sessionRoot(ctx, sessionId)

    // A create names a file that does not exist yet: the parent folder is what
    // must be verified, and the publish below never replaces anything.
    if (payload.create === true) {
      const created = await resolveNewInside(cwd, rel)
      const tmp = created + '.dsh-editor-' + process.pid + '-' + Date.now() + '.tmp'
      try {
        await fsp.writeFile(tmp, content, { flag: 'wx' })
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {})
        throw httpError(500, 'IO_ERROR', 'Could not write the new file on disk.', err)
      }
      try {
        await publishNew(tmp, created)
      } finally {
        await fsp.rm(tmp, { force: true }).catch(() => {})
      }
      const fresh = await fsp.stat(created)
      return json(200, {
        ok: true,
        path: rel,
        bytes: content.byteLength,
        version: versionOf(fresh),
        mtimeMs: fresh.mtimeMs,
        size: fresh.size,
      })
    }

    const target = await resolveInside(cwd, rel)
    let before
    try {
      before = await fsp.stat(target)
    } catch (err) {
      throw httpError(404, 'NOT_FOUND', 'The file no longer exists on disk.', err)
    }
    if (!before.isFile()) {
      throw httpError(400, 'NOT_FILE', 'The path is not a regular file.')
    }

    // Optimistic concurrency: the client opened version V; refuse to clobber a
    // file whose stat moved since then.
    const expected = payload.expected
    if (expected && typeof expected.mtimeMs === 'number') {
      const sameMtime = Math.abs(before.mtimeMs - expected.mtimeMs) < 1
      const sameSize = expected.size === undefined || before.size === expected.size
      if (!sameMtime || !sameSize) {
        return json(409, {
          ok: false,
          error: {
            code: 'CHANGED_ON_DISK',
            message: 'The file changed on disk since it was opened.',
            current: { mtimeMs: before.mtimeMs, size: before.size },
          },
        })
      }
    }

    // Atomic publish: write a private temp next to the target, then rename it
    // over the target (node's rename replaces existing files on Windows too).
    const tmp = target + '.dsh-editor-' + process.pid + '-' + Date.now() + '.tmp'
    try {
      await fsp.writeFile(tmp, content, { flag: 'wx' })
      try {
        await fsp.rename(tmp, target)
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {})
        throw err
      }
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      throw err
    }
    const after = await fsp.stat(target)
    return json(200, {
      ok: true,
      path: rel,
      bytes: content.byteLength,
      version: versionOf(after),
      mtimeMs: after.mtimeMs,
      size: after.size,
    })
  } catch (err) {
    return readErrorToResponse(err)
  }
}

/**
 * The vendored bundle in hand: its bytes, the file stamp they were read at, and
 * the ETag (a hash of the bytes, so it changes exactly when the artifact does).
 *
 * Read ONCE and then re-validated per request with a `stat`, because the file is
 * GENERATED: a rebuild - or a `git pull` of one - must not require a harness
 * restart. The engine is one artifact at one stable URL, so a process-lifetime
 * cache let the browser keep an engine older than the client bundle that asked
 * for it (alpha.11: a `.rs` tab requested a `rust` mode the cached engine did not
 * carry). A missing file never discards a good copy.
 */
let vendorState = null
async function readVendor() {
  const vendorUrl = new URL('./vendor/cm6.min.js', import.meta.url)
  const vendorPath = fileURLToPath(vendorUrl)
  const missing = () =>
    httpError(500, 'VENDOR_MISSING', 'The vendored editor bundle is missing (run the CM6 vendor build in packages/dsh-editor/vendor).')
  let stamp
  try {
    const stat = await fsp.stat(vendorPath)
    stamp = String(stat.size) + '@' + String(stat.mtimeMs)
  } catch (err) {
    if (vendorState) return vendorState
    throw missing()
  }
  if (vendorState && vendorState.stamp === stamp) return vendorState
  let bytes
  try {
    bytes = await fsp.readFile(vendorPath)
  } catch (err) {
    if (vendorState) return vendorState
    throw missing()
  }
  const { createHash } = await import('node:crypto')
  vendorState = {
    bytes,
    stamp,
    etag: '"' + createHash('sha1').update(bytes).digest('hex') + '"',
  }
  return vendorState
}

/** GET/HEAD /api/dsh-editor/vendor — the vendored CodeMirror 6 classic bundle. */
async function handleVendor(request) {
  try {
    const state = await readVendor()
    const headers = {
      'content-type': 'text/javascript; charset=utf-8',
      // Revalidate rather than trust a freshness window: the URL is stable while
      // the artifact is regenerated whenever the CM6 version set changes, so a
      // max-age once let a browser serve a stale engine to a newer client bundle.
      // The ETag is the content hash, so revalidation costs a 304, never a
      // re-download.
      'cache-control': 'no-cache',
      etag: state.etag,
    }
    if (request.headers.get('if-none-match') === state.etag) {
      return new Response(null, { status: 304, headers })
    }
    if (request.method === 'HEAD') {
      return new Response(null, { status: 200, headers })
    }
    return new Response(state.bytes, { status: 200, headers })
  } catch (err) {
    return readErrorToResponse(err)
  }
}

/**
 * Activate the plugin row: register the authenticated routes.
 * @param ctx - cordis context (inject: connection).
 */
export function apply(ctx) {
  const connection = ctx.get ? ctx.get('connection') : undefined
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    ctx.logger?.warn?.('[dsh-editor] connection service unavailable - file routes not registered')
    return
  }
  ctx.effect(() => {
    ctx.logger?.debug?.('[dsh-editor] node half active (alpha)')
    // `requestBody: 'buffered'` is REQUIRED: Connection's HTTP bridge picks the
    // streaming branch for a route that leaves it undefined, and building a
    // streaming Request for a bodyless method (GET/HEAD) throws before the
    // handler ever runs (the web server then answers a bare 400).
    const offFile = connection.fetch.register({
      path: FILE_ROUTE,
      methods: ['GET', 'HEAD', 'PUT'],
      requestBody: 'buffered',
      fetch: (request) => handleFile(ctx, request),
    })
    const offVendor = connection.fetch.register({
      path: VENDOR_ROUTE,
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: handleVendor,
    })
    return () => {
      try {
        offFile()
      } catch (e) {}
      try {
        offVendor()
      } catch (e) {}
      ctx.logger?.debug?.('[dsh-editor] node half disposed')
    }
  }, 'dsh-editor: file routes')
}
