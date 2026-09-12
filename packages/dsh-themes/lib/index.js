/**
 * dsh-themes - Node half.
 *
 * The pack's conversation-header package is mostly browser-only, and this row
 * used to be a deliberate no-op: it existed so the package's `dsh.client`
 * declaration put the browser bundle in the boot graph.
 *
 * alpha.10 gives it one job. The header's screenshot control captures the tab in
 * the browser (only the page itself can photograph the page), and the PNG then
 * has to LAND somewhere on the machine that runs the app - the point of the
 * control is a file on this host's Desktop, not a copy in whatever folder the
 * browser happens to download into. Writing to disk is host work, so it is one
 * authenticated `connection.fetch` route of this row's own:
 *
 *   POST /api/dsh-themes/screenshot   body: the PNG bytes
 *
 * The same mechanism dsh-editor and dsh-gittree use for their own routes, and
 * the same one the shipped file-upload plugin uses for raw bytes (Connection
 * buffers the body - its carrier cap is 300 MiB, far above any screenshot - and
 * the route is authenticated by the transport before this handler is reached).
 *
 * WHY A FIXED NAME AND A FIXED FOLDER. The client never names a path: the only
 * input is the PNG itself, so there is no traversal surface to defend, no
 * overwrite of a file the user already had (the write is create-exclusive and a
 * collision takes the next free suffix) and no way for a page to ask this host to
 * write anywhere but the Desktop it reports back. Validation is what makes the
 * file worth writing: the body must carry `image/png` and really start with the
 * PNG signature, and it is capped so a runaway request cannot fill the disk.
 *
 * The desktop folder is resolved PER REQUEST (never cached): Windows may have
 * the Desktop redirected into OneDrive, Linux may name it in `user-dirs.dirs`,
 * and any of that can be true before or after this row mounts. When no Desktop
 * exists at all the home folder is the fallback, and a host with neither answers
 * a typed failure instead of a stack trace.
 */
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-themes'

export const inject = ['connection']

/** Keep in sync with the client's hard-coded route constant. */
const API_ROOT = '/api/dsh-themes'
const SCREENSHOT_ROUTE = API_ROOT + '/screenshot'

/** The most a screenshot may weigh (a 4K PNG is a few MiB; this is pure ceiling). */
const MAX_PNG_BYTES = 64 * 1024 * 1024

/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The saved file's name: the pack's name plus a local timestamp. */
const FILE_PREFIX = 'vn-harness-'

/** How many `-2`, `-3` ... suffixes to try before giving up on a free name. */
const MAX_NAME_ATTEMPTS = 50

/** Respond with a JSON body and a status code (the shape dsh-editor answers in). */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** Typed failure -> HTTP response. */
function fail(status, code, message) {
  return json(status, { ok: false, error: { code, message } })
}

/**
 * The first entry of `candidates` that is an existing directory.
 * @param candidates - absolute paths to try, in order; empty entries are skipped.
 * @returns {Promise<string|null>} the directory, or `null` when none exists.
 */
async function firstDirectory(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate.length === 0) continue
    try {
      const stats = await fsp.stat(candidate)
      if (stats.isDirectory()) return candidate
    } catch (err) {
      /* not there: try the next one */
    }
  }
  return null
}

/**
 * The Desktop a freedesktop host names in `user-dirs.dirs` (`XDG_DESKTOP_DIR`),
 * which is how a Linux desktop can point somewhere other than `~/Desktop`.
 * @returns {Promise<string|null>} the configured directory, or `null`.
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
 * Where this host keeps its Desktop. Read fresh on every request, because the
 * Desktop can be redirected (OneDrive) or configured (XDG) at any time; the home
 * folder is the last resort so a screenshot always has somewhere to go.
 * @returns {Promise<string>} an existing directory.
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
  if (directory === null) throw new Error('this host has no Desktop or home folder to save into')
  return directory
}

/** `YYYYMMDD-HHMMSS` in the host's own time, so file names sort by capture. */
function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0')
  return (
    String(date.getFullYear()) +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    '-' +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  )
}

/**
 * Write the PNG under a name nobody else holds. `wx` is what makes that a
 * promise rather than a hope: the create fails instead of clobbering, and a
 * collision (a second shot inside the same second) takes `-2`, `-3`, ...
 * @param directory - the folder to write into.
 * @param baseName - the first name to try.
 * @param bytes - the PNG.
 * @returns {Promise<string>} the path written.
 */
async function writeUnique(directory, baseName, bytes) {
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const name = attempt === 0 ? baseName : baseName.replace(/\.png$/, '-' + String(attempt + 1) + '.png')
    const target = path.join(directory, name)
    try {
      await fsp.writeFile(target, bytes, { flag: 'wx' })
      return target
    } catch (err) {
      if (err && err.code === 'EEXIST') continue
      throw err
    }
  }
  throw new Error('could not find a free screenshot name on the Desktop')
}

/**
 * Save one screenshot: the body IS the picture, so the route validates it is a
 * PNG of a sane size, then writes it to the host's Desktop.
 * @param request - authenticated request from Connection.
 * @returns {Promise<Response>} the saved path (or a typed failure).
 */
async function handleScreenshot(request) {
  if (request.method !== 'POST') {
    return new Response(null, { status: 405, headers: { allow: 'POST' } })
  }
  const mediaType = (request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase()
  if (mediaType !== 'image/png') {
    return fail(415, 'UNSUPPORTED_TYPE', 'The screenshot route accepts image/png bodies only.')
  }
  let bytes
  try {
    bytes = Buffer.from(await request.arrayBuffer())
  } catch (err) {
    return fail(400, 'BAD_REQUEST', 'The screenshot body could not be read.')
  }
  if (bytes.length === 0) {
    return fail(400, 'BAD_REQUEST', 'The screenshot body is empty.')
  }
  if (bytes.length > MAX_PNG_BYTES) {
    return fail(413, 'TOO_LARGE', 'The screenshot is larger than this route accepts.')
  }
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return fail(415, 'NOT_A_PNG', 'The screenshot body is not a PNG.')
  }
  try {
    const directory = await desktopDirectory()
    const target = await writeUnique(directory, FILE_PREFIX + stamp(new Date()) + '.png', bytes)
    return json(200, { ok: true, path: target, directory: directory, bytes: bytes.length })
  } catch (err) {
    return fail(500, 'WRITE_FAILED', err && err.message ? err.message : 'The screenshot could not be saved.')
  }
}

/**
 * Activate the plugin row: register the one route.
 * @param ctx - cordis context (inject: connection).
 */
export function apply(ctx) {
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined
  if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
    ctx.logger?.warn?.('[dsh-themes] connection service unavailable - the screenshot route is not registered')
    return
  }
  ctx.effect(() => {
    // `requestBody: 'buffered'` hands the handler a Request whose body is
    // already in memory (see dsh-editor: the streaming branch cannot build a
    // Request for a bodyless method, and a PNG is small enough to buffer).
    const offScreenshot = connection.fetch.register({
      path: SCREENSHOT_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: handleScreenshot,
    })
    ctx.logger?.debug?.('[dsh-themes] screenshot route active (' + SCREENSHOT_ROUTE + ')')
    return () => {
      try {
        offScreenshot()
      } catch (e) {}
      ctx.logger?.debug?.('[dsh-themes] screenshot route disposed')
    }
  }, 'dsh-themes: screenshot route')
}
