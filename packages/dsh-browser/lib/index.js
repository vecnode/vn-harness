/**
 * dsh-browser — host half.
 *
 * The Browser tab itself is drawn by the browser that is already showing this
 * GUI: `lib/client.js` mounts one `<iframe>` and nothing is shipped with the
 * harness to render a page. What a frame CANNOT do is tell the page around it
 * anything about the page inside it - a cross-origin frame is opaque - so this
 * half answers the one question the panel cannot: **will an address let itself
 * be framed at all?**
 *
 *   GET /api/dsh-browser/probe?url=<address>
 *
 * It fetches the address from the HOST (Node's own https stack: system TLS is
 * not involved), follows redirects, and reports what the final answer says about
 * being embedded:
 *
 *   { ok, url, finalUrl, status, title, contentType,
 *     frameable, blockedBy: {kind:'xfo'|'csp', value} | null, note }
 *
 * `frameable:false` is only ever a REAL framing refusal - `X-Frame-Options:
 * DENY`/`SAMEORIGIN` or a `Content-Security-Policy: frame-ancestors` that does
 * not list this GUI. Everything else (a 401 because this peek is anonymous, a
 * DNS failure, a timeout, a non-HTML answer) is reported as a `note` with
 * `frameable:true`, because the frame itself uses the browser's own session and
 * cookies and may well render a page this anonymous request cannot see. Blocking
 * a navigation on anything less would be wrong - that is why the client blocks on
 * `frameable === false` and on nothing else.
 *
 * Trust boundary: this route makes the host issue an HTTP request to an address
 * the CLIENT names. That is a request the GUI could already make from its own
 * origin, against a harness that also mounts a full unsandboxed shell
 * (dsh-terminal), so the gate is the connection's own authentication - the same
 * one every /api/dsh-* route here stands behind - and the route is deliberately
 * a poor exfiltration tool anyway: no cookies are sent, no request body is
 * accepted, and the answer never carries more than a status, a content type and
 * a capped <title>.
 *
 * No fork, no core row disabled, nothing for scripts/sync-vendored.ps1 to track.
 */
export const name = 'dsh-browser'

export const inject = ['connection']

/** Keep in sync with the client's hard-coded route constants. */
const API_ROOT = '/api/dsh-browser'
const PROBE_ROUTE = API_ROOT + '/probe'

/** Version marker shared with the client bundle. */
const PLUGIN_VERSION = '0.1.0-alpha.1'

/** An address longer than this is refused before any request is made. */
const MAX_URL_CHARS = 2048

/** How long the host waits for the address before reporting a timeout. */
const PROBE_TIMEOUT_MS = 9000

/** How much of a body is read to find the <title> (never returned whole). */
const SNIFF_BYTES = 64 * 1024

/** A plain identity: no cookies, no referrer, no browser cover story. */
const USER_AGENT = 'Mozilla/5.0 (compatible; vn-harness-dsh-browser/0.1; +probe)'

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

/** Typed failure -> HTTP response. */
function fail(status, code, message) {
  return json(status, { ok: false, error: { code, message } })
}

// ---------------------------------------------------------------------------
// The framing verdict
// ---------------------------------------------------------------------------

/** Two origins that are the same, textually and by port defaulting. */
function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch (err) {
    return false
  }
}

/**
 * The `frame-ancestors` directive's sources, or `undefined` when the policy has
 * no such directive. Directive names are case-insensitive and the value runs to
 * the next `;`.
 *
 * @param csp - the response's `content-security-policy` header, if any.
 * @returns the source list as written (possibly ''), or `undefined`.
 */
function frameAncestorsSources(csp) {
  if (typeof csp !== 'string' || csp === '') return undefined
  for (const part of csp.split(';')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    const space = trimmed.search(/\s/)
    const name = (space === -1 ? trimmed : trimmed.slice(0, space)).toLowerCase()
    if (name !== 'frame-ancestors') continue
    return space === -1 ? '' : trimmed.slice(space + 1).trim()
  }
  return undefined
}

/**
 * Whether ONE `frame-ancestors` source would let this GUI frame the page.
 *
 * Approximate by design and documented as such: `*` and host-sources are
 * matched (optionally with a scheme, a port, or a leading `*.` host wildcard),
 * while `'self'`/`'none'`/nonces/hashes are decided exactly. A source's PATH is
 * ignored - browsers match it, this verdict does not - so the answer can only be
 * too permissive, never a false refusal.
 *
 * @param source - one source token from the directive.
 * @param guiOrigin - the origin of the page doing the framing.
 * @param targetOrigin - the origin of the page being framed.
 * @returns `true` when the source admits `guiOrigin`.
 */
function frameSourceAllows(source, guiOrigin, targetOrigin) {
  const raw = String(source === undefined || source === null ? '' : source).trim()
  if (raw === '') return false
  if (raw === '*') return true
  if (raw === "'self'") return sameOrigin(targetOrigin, guiOrigin)
  if (raw.charAt(0) === "'") return false
  let gui
  try {
    gui = new URL(guiOrigin)
  } catch (err) {
    return false
  }
  let rest = raw
  let scheme = null
  const schemeAt = rest.indexOf('://')
  if (schemeAt !== -1) {
    scheme = rest.slice(0, schemeAt).toLowerCase()
    rest = rest.slice(schemeAt + 3)
  }
  // Strip any path, query or fragment: not matched here (see above).
  const cut = rest.search(/[/?#]/)
  if (cut !== -1) rest = rest.slice(0, cut)
  let host = rest
  let port = null
  const colon = rest.lastIndexOf(':')
  if (colon > 0 && rest.indexOf(']') < colon) {
    host = rest.slice(0, colon)
    port = rest.slice(colon + 1)
  }
  host = host.toLowerCase()
  if (scheme !== null && scheme !== gui.protocol.replace(':', '')) return false
  if (host !== '' && host.charAt(0) === '*') {
    const tail = host.slice(1)
    if (!gui.hostname.toLowerCase().endsWith(tail)) return false
  } else if (host !== '' && host !== gui.hostname.toLowerCase()) {
    return false
  }
  if (port !== null && port !== '' && port !== '*') {
    const effective = gui.port !== '' ? gui.port : gui.protocol === 'https:' ? '443' : '80'
    if (port !== effective) return false
  }
  return true
}

/**
 * The verdict for one response: a real framing refusal, or nothing.
 *
 * `frame-ancestors` wins over `X-Frame-Options` when both are present, which is
 * what browsers do (the CSP directive makes the header obsolete).
 *
 * @param headers - the response headers.
 * @param targetOrigin - the origin of the framed page (after redirects).
 * @param guiOrigin - the origin of the page doing the framing.
 * @returns `{ frameable, blockedBy }`.
 */
function framingVerdict(headers, targetOrigin, guiOrigin) {
  const sources = frameAncestorsSources(headers.get('content-security-policy'))
  if (sources !== undefined) {
    const tokens = sources.split(/\s+/).filter((token) => token !== '')
    if (tokens.length === 0 || tokens.indexOf("'none'") !== -1) {
      return { frameable: false, blockedBy: { kind: 'csp', value: 'frame-ancestors ' + (sources === '' ? '(empty)' : sources) } }
    }
    const allowed = tokens.some((token) => frameSourceAllows(token, guiOrigin, targetOrigin))
    if (!allowed) {
      return { frameable: false, blockedBy: { kind: 'csp', value: 'frame-ancestors ' + sources } }
    }
    return { frameable: true, blockedBy: null }
  }
  const xfo = headers.get('x-frame-options')
  if (typeof xfo !== 'string' || xfo.trim() === '') return { frameable: true, blockedBy: null }
  const value = xfo.trim().toLowerCase()
  if (value === 'deny') return { frameable: false, blockedBy: { kind: 'xfo', value: 'X-Frame-Options: DENY' } }
  if (value === 'sameorigin') {
    if (sameOrigin(targetOrigin, guiOrigin)) return { frameable: true, blockedBy: null }
    return { frameable: false, blockedBy: { kind: 'xfo', value: 'X-Frame-Options: SAMEORIGIN' } }
  }
  if (value.indexOf('allow-from') === 0) {
    return { frameable: false, blockedBy: { kind: 'xfo', value: 'X-Frame-Options: ALLOW-FROM (obsolete: browsers ignore it)' } }
  }
  return { frameable: false, blockedBy: { kind: 'xfo', value: 'X-Frame-Options: ' + xfo.trim() } }
}

/** The five entities an HTML title realistically carries. */
function decodeEntities(text) {
  return text
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
}

/** The document title inside a capped HTML prefix, or ''. */
function extractTitle(html) {
  if (typeof html !== 'string' || html === '') return ''
  const match = /<title[^>]*>([\s\S]{0,400}?)<\/title>/i.exec(html)
  if (match === null) return ''
  return decodeEntities(match[1]).replace(/\s+/g, ' ').trim()
}

/** Read at most `cap` bytes of a response body as text. */
async function readCapped(response, cap) {
  const body = response.body
  if (body === undefined || body === null || typeof body.getReader !== 'function') return ''
  const reader = body.getReader()
  const chunks = []
  let received = 0
  try {
    while (received < cap) {
      const step = await reader.read()
      if (step.done === true) break
      const chunk = step.value
      chunks.push(Buffer.from(chunk))
      received += chunk.length
    }
  } catch (err) {
    // A body that dies mid-read still leaves the headers (and so the verdict).
  }
  try {
    await reader.cancel()
  } catch (err) {
    /* already closed */
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks).subarray(0, cap))
}

/** A typed probe failure. */
function probeError(status, code, message) {
  const err = new Error(message)
  err.status = status
  err.code = code
  return err
}

/**
 * One host-side request, with this route's two failure shapes attached: a
 * timeout is 504, anything else is 502 carrying the transport's own code.
 *
 * @param href - the address to request.
 * @param method - 'HEAD' or 'GET'.
 * @param headers - request headers.
 * @param signal - the probe's abort signal.
 * @returns the response.
 */
async function requestOnce(href, method, headers, signal) {
  try {
    return await fetch(href, { method, redirect: 'follow', signal, headers })
  } catch (err) {
    if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) {
      throw probeError(504, 'TIMEOUT', 'The address did not answer within ' + String(Math.round(PROBE_TIMEOUT_MS / 1000)) + ' s.')
    }
    const cause = err && err.cause ? err.cause : null
    const detail = cause && cause.code ? String(cause.code) : err && err.message ? String(err.message) : 'unknown error'
    throw probeError(502, 'UNREACHABLE', 'The address could not be reached (' + detail + ').')
  }
}

/** Whether a content type is something a frame realistically shows. */
function looksRenderable(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase()
  if (type === '') return true
  if (type.indexOf('text/') === 0) return true
  if (type.indexOf('image/') === 0) return true
  return ['application/xhtml+xml', 'application/xml', 'application/xhtml', 'application/json', 'application/pdf'].indexOf(type) !== -1
}

/**
 * Ask one address whether it lets itself be framed.
 *
 * One ranged GET answers both questions: the response headers decide whether the
 * address may be framed, and the first `SNIFF_BYTES` of the body carry its title.
 *
 * @param href - the absolute http(s) address to check.
 * @param guiOrigin - the origin of the page that would frame it.
 * @returns the probe payload.
 */
async function probeAddress(href, guiOrigin) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  if (typeof timer.unref === 'function') timer.unref()
  try {
    // ONE request: its headers are the whole verdict and its first bytes are the
    // title. The read is capped and the stream cancelled, so a large page costs a
    // bounded read instead of a download - and there is no HEAD/GET double round
    // trip for a verdict that HEAD alone could not complete anyway (no title).
    const response = await requestOnce(
      href,
      'GET',
      { 'user-agent': USER_AGENT, accept: 'text/html,*/*', range: 'bytes=0-' + String(SNIFF_BYTES - 1) },
      controller.signal,
    )
    const text = await readCapped(response, SNIFF_BYTES)
    const finalUrl = response.url !== '' ? response.url : href
    let targetOrigin = href
    try {
      targetOrigin = new URL(finalUrl).origin
    } catch (err) {
      /* keep the request address */
    }
    const verdict = framingVerdict(response.headers, targetOrigin, guiOrigin)
    const contentType = String(response.headers.get('content-type') || '')
    const disposition = String(response.headers.get('content-disposition') || '')
    const title = extractTitle(text)
    const notes = []
    if (disposition.toLowerCase().indexOf('attachment') === 0) {
      notes.push('This address downloads a file instead of showing a page.')
    }
    if (response.status === 401 || response.status === 403) {
      notes.push('The host answered ' + String(response.status) + ' to this anonymous check; the frame itself uses your own browser session, so it may still render.')
    }
    if (verdict.frameable === true && looksRenderable(contentType) === false) {
      notes.push('This address answers ' + contentType.split(';')[0].trim() + ' rather than a page.')
    }
    return {
      url: href,
      finalUrl,
      status: response.status,
      title,
      contentType,
      frameable: verdict.frameable,
      blockedBy: verdict.blockedBy,
      note: notes.join(' '),
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * GET /api/dsh-browser/probe — will this address let itself be framed here?
 *
 * @param request - the incoming request (`?url=<address>`).
 * @returns a JSON `Response`.
 */
async function handleProbe(request) {
  let raw
  let guiOrigin
  try {
    const requestUrl = new URL(request.url)
    raw = requestUrl.searchParams.get('url')
    guiOrigin = requestUrl.origin
  } catch (err) {
    return fail(400, 'BAD_REQUEST', 'The probe request could not be read.')
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return fail(400, 'NO_URL', 'A url parameter is required.')
  }
  if (raw.length > MAX_URL_CHARS) {
    return fail(414, 'URL_TOO_LONG', 'That address is longer than ' + String(MAX_URL_CHARS) + ' characters.')
  }
  let target
  try {
    target = new URL(raw.trim())
  } catch (err) {
    return fail(400, 'BAD_URL', 'That is not a complete address.')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    return fail(400, 'BAD_SCHEME', 'Only http and https addresses can be loaded in the tab.')
  }
  if (target.username !== '' || target.password !== '') {
    return fail(400, 'BAD_URL', 'Credentials inside the address are not supported.')
  }
  try {
    const probe = await probeAddress(target.href, guiOrigin)
    return json(200, { ok: true, ...probe })
  } catch (err) {
    const status = typeof err.status === 'number' ? err.status : 502
    const code = err.code || 'UNREACHABLE'
    const message = err && err.message ? String(err.message) : 'The address could not be reached.'
    return fail(status, code, message)
  }
}

/**
 * Activate the row: register the one probe route.
 *
 * @param ctx - cordis context (inject: connection).
 */
export function apply(ctx) {
  ctx.effect(() => {
    const connection = ctx.get ? ctx.get('connection') : undefined
    if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
      ctx.logger?.warn?.('[dsh-browser] connection service unavailable - probe route not registered')
      return () => {}
    }
    // `requestBody: 'buffered'` is required by the connection bridge (a route
    // that leaves it undefined takes the streaming branch, which throws for a
    // bodyless method before the handler runs).
    const dispose = connection.fetch.register({
      path: PROBE_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: (request) => handleProbe(request),
    })
    ctx.logger?.debug?.('[dsh-browser] probe route registered (' + PLUGIN_VERSION + ')')
    return () => {
      try {
        dispose()
      } catch (err) {
        /* already gone */
      }
    }
  }, 'dsh-browser: probe route')
}
