/**
 * dsh-terminal — Node half.
 *
 * The browser cannot open a shell, so this row owns the server side of the
 * dock:
 *
 *   GET  /api/dsh-terminal/health?session=<id>   is a PTY available on this host
 *   GET  /api/dsh-terminal/activity?session=<id> the tail of this conversation's
 *                                                command-relevant session events
 *                                                (read-only; the agent view folds
 *                                                them in the browser)
 *   GET  /api/dsh-terminal/vendor/xterm.js       the vendored xterm.js bundle
 *   GET  /api/dsh-terminal/vendor/xterm.css      its stylesheet
 *   WS   /api/dsh-terminal/pty?id=<conversation> the terminal itself
 *
 * The four HTTP routes go through `connection.fetch.register` like
 * dsh-editor's and dsh-gittree's, so they inherit the connection's own
 * authentication. The WebSocket is an UPGRADE route, which the connection
 * service does not wrap: `ctx.webServer.registerUpgrade` hands us the raw
 * socket, and this file performs the same two-step gate the product's own
 * WebSocket mux performs - `connection.requestRejection(req)` (host/origin
 * fence, then browser authentication), and a raw HTTP rejection written into
 * the socket when it answers 401 or 403. A terminal that anyone on the host
 * could attach to would be a remote shell; no unauthenticated socket ever
 * reaches a PTY.
 *
 * ## Wire protocol
 *
 * Text frames are JSON control; the shell's own bytes travel as text too
 * (node-pty decodes UTF-8 with a stateful decoder, so a multi-byte character
 * split across reads is already whole by the time it reaches us). A control
 * frame is prefixed with U+0000, because the shell's output is arbitrary text
 * and `cat` of a JSON file must never be mistaken for a control message.
 *
 *   client -> server   \0{"t":"init","session":"<conversation>","slot":0,
 *                       "cols":80,"rows":24}      (always the first frame)
 *                      \0{"t":"resize","cols":N,"rows":N}
 *                      \0{"t":"kill"}              end this terminal
 *                      \0{"t":"ping"}              liveness
 *                      <anything else>             written to the shell verbatim
 *
 *   server -> client   \0{"t":"ready","key":"…","index":0,"shell":"PowerShell 7",
 *                       "cwd":"…","pid":123,"cols":80,"rows":24,"replay":"…"}
 *                      \0{"t":"exit","code":0,"signal":null}
 *                      \0{"t":"closed","reason":"disposed"}
 *                      \0{"t":"pong"}
 *                      \0{"t":"error","code":"…","message":"…"}
 *                      <anything else>             raw terminal output
 *
 * Backpressure is honest rather than invisible: when the socket's send queue
 * passes a high-water mark the PTY is paused (`IPty.pause`), and it is resumed
 * once the queue drains. Nothing is dropped.
 */
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

import { resolveShell } from './shell.js'
import { loadNodePty, PtyHost, clampSize, ptyError } from './pty.js'

export const name = 'dsh-terminal'

export const inject = ['connection']

/** Keep in sync with the client's hard-coded route constants. */
const API_ROOT = '/api/dsh-terminal'
const HEALTH_ROUTE = API_ROOT + '/health'
const ACTIVITY_ROUTE = API_ROOT + '/activity'
const VENDOR_JS_ROUTE = API_ROOT + '/vendor/xterm.js'
const VENDOR_CSS_ROUTE = API_ROOT + '/vendor/xterm.css'
const PTY_ROUTE = API_ROOT + '/pty'
/** Largest inbound frame the socket will accept (a generous paste). */
const MAX_CONTROL_BYTES = 1024 * 1024
/** Prefix that marks a control frame (see the protocol note above). */
const CONTROL = '\u0000'
/** Pause the PTY past this many unflushed bytes on the socket. */
const HIGH_WATER_BYTES = 4 * 1024 * 1024
/** Dead sockets are dropped after this long without a pong. */
const HEARTBEAT_MS = 30 * 1000
/**
 * The session events the agent-activity view consumes: the two tool events and
 * a HUMAN message (the prompt a group is captioned with). Everything else in the
 * log - assistant messages with their embedded streams above all - is neither
 * sent nor needed, which is what keeps this route cheap enough to poll.
 */
const ACTIVITY_TYPES = { 'tool/call': true, 'tool/result': true, 'user/message': true }
/** Most events one answer carries (a long conversation is read from its tail). */
const ACTIVITY_LIMIT = 400
/** Rough ceiling on the JSON one answer carries; older events are dropped. */
const ACTIVITY_BYTES = 512 * 1024

/** Respond with a JSON body and a status code. */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/** Typed failure -> HTTP response. */
function errorResponse(err) {
  const status = typeof err.status === 'number' ? err.status : 500
  const code = err.code || 'TERMINAL_ERROR'
  const message = err.message || String(err)
  return json(status, { ok: false, error: { code, message } })
}

/**
 * The workspace root of one conversation: the live session header while the
 * session is running, otherwise the stored header from session persistence.
 * The same two-step lookup dsh-editor and dsh-gittree use; it degrades to a
 * typed failure rather than guessing a folder.
 *
 * @param ctx - the plugin context (services are re-read per request).
 * @param sessionId - the conversation the terminal belongs to.
 * @returns {Promise<string>} the session's cwd.
 */
async function sessionRoot(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw ptyError(400, 'BAD_REQUEST', 'A session id is required.')
  }
  const get = typeof ctx.get === 'function' ? (serviceName) => ctx.get(serviceName) : () => undefined
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
  throw ptyError(409, 'NO_WORKSPACE', 'The workspace folder for this conversation is not available.')
}

// ---------------------------------------------------------------------------
// Vendored xterm assets (GENERATED files: never edited by hand)
// ---------------------------------------------------------------------------
let vendorState = null

/**
 * The vendored xterm.js bundle and stylesheet, read once and served with an
 * ETag. The browser fetches them lazily the first time a terminal opens - the
 * same shape dsh-editor uses for CodeMirror.
 */
async function loadVendor() {
  if (vendorState !== null) return vendorState
  const here = path.dirname(fileURLToPath(import.meta.url))
  const [js, css] = await Promise.all([
    fsp.readFile(path.join(here, 'vendor', 'xterm.js')),
    fsp.readFile(path.join(here, 'vendor', 'xterm.css')),
  ])
  const etag = '"' + String(js.length) + '-' + String(css.length) + '"'
  vendorState = { js, css, etag }
  return vendorState
}

/** GET /api/dsh-terminal/vendor/<asset> — the vendored xterm files. */
async function handleVendor(request, asset) {
  try {
    const vendor = await loadVendor()
    const body = asset === 'css' ? vendor.css : vendor.js
    const etag = vendor.etag + (asset === 'css' ? '-css' : '-js')
    const headers = {
      'content-type': asset === 'css' ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
      'cache-control': 'no-cache',
      etag,
    }
    if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers })
    return new Response(body, { status: 200, headers })
  } catch (err) {
    return json(500, {
      ok: false,
      error: {
        code: 'VENDOR_MISSING',
        message: 'The vendored xterm assets are missing (run the vendoring build in packages/dsh-terminal/vendor).',
      },
    })
  }
}

/** GET /api/dsh-terminal/health — whether this host can open a terminal at all. */
function handleHealth(state) {
  return json(200, {
    ok: true,
    available: state.host !== null,
    shell: state.shell ? { file: state.shell.file, label: state.shell.label } : null,
    reason: state.ptyError || null,
    capacity: state.host === null ? 0 : state.maxSessions,
    platform: process.platform,
  })
}

// ---------------------------------------------------------------------------
// The agent's own terminal use
//
// The dock's second view reads the commands the AGENT ran, which are not this
// panel's: they execute in the harness's own process through its shell tool.
// This route answers the conversation's OWN log instead, and it belongs on the
// HOST for one decisive reason: the log is here whether or not a particular
// browser has opened that conversation yet. A client-side read of the live
// session window has to be STAGED first, and a panel that opens with the app
// would have nothing to show until something else moved the session onto the
// stage - which is exactly the bug this route removes.
//
// It is READ-ONLY, bounded and filtered: only the two tool events and a human
// prompt are sent, from the TAIL of the log, at most ACTIVITY_LIMIT events and
// roughly ACTIVITY_BYTES. Nothing is derived here - the browser folds these
// events with the SAME pure fold it uses everywhere else, so the panel and the
// check cannot drift about what a command is.
// ---------------------------------------------------------------------------
/**
 * The live session for one conversation, or null.
 *
 * The host's own `sessions` service is the authority; it holds the in-memory log
 * this route reads. `snapshotEvents` is the whole contiguous log (inherited seed
 * history included), which is what makes a resumed or forked conversation show
 * the commands its context already contains.
 *
 * @param ctx - the plugin context (services are re-read per request).
 * @param sessionId - the conversation to read.
 * @returns the session, or null when it is not live on this host.
 */
function liveSession(ctx, sessionId) {
  const get = typeof ctx.get === 'function' ? (serviceName) => ctx.get(serviceName) : () => undefined
  try {
    const sessions = get('sessions')
    if (sessions === null || sessions === undefined || typeof sessions.get !== 'function') return null
    const session = sessions.get(sessionId)
    if (session === null || session === undefined) return null
    return typeof session.snapshotEvents === 'function' ? session : null
  } catch (err) {
    return null
  }
}

/** One event's rough JSON weight, so the byte budget is a real bound. */
function eventWeight(event) {
  try {
    return JSON.stringify(event).length + 1
  } catch (err) {
    return 1024
  }
}

/**
 * The tail of one conversation's log, filtered to what the panel draws.
 *
 * Walked BACKWARDS from the newest event and reversed at the end, so a
 * conversation longer than the budget answers with its most recent commands -
 * the ones a reader is looking for - plus `hasMore`, which the panel states
 * instead of silently truncating.
 *
 * @param session - the live session.
 * @returns `{ entries, hasMore }` in the wire shape the client folds.
 */
function activityEntries(session) {
  const all = session.snapshotEvents()
  const entries = []
  let hasMore = false
  let bytes = 0
  for (let index = all.length - 1; index >= 0; index -= 1) {
    const event = all[index]
    if (event === null || typeof event !== 'object' || ACTIVITY_TYPES[event.type] !== true) continue
    // Injected context is not a prompt: the panel groups commands under what a
    // person asked for, and every other `user/message` is producer text.
    if (event.type === 'user/message') {
      const source = event.data === null || typeof event.data !== 'object' ? null : event.data.source
      if (source === null || typeof source !== 'object' || source.kind !== 'user') continue
    }
    // The NEWEST event is always included, even alone and even oversized: a
    // single enormous command must not leave the panel with nothing to draw.
    // Past that first one, the count and the byte budget are what bound the
    // answer, and `hasMore` is what says so instead of truncating silently.
    const weight = eventWeight(event)
    if (entries.length > 0 && (entries.length >= ACTIVITY_LIMIT || bytes + weight > ACTIVITY_BYTES)) {
      hasMore = true
      break
    }
    bytes += weight
    entries.push({ type: 'event', event })
  }
  entries.reverse()
  return { entries, hasMore }
}

/** GET /api/dsh-terminal/activity?session=<id> — the commands one conversation ran. */
function handleActivity(request, ctx) {
  let sessionId = ''
  try {
    sessionId = new URL(request.url).searchParams.get('session') || ''
  } catch (err) {
    sessionId = ''
  }
  if (sessionId === '') {
    return json(400, { ok: false, error: { code: 'BAD_REQUEST', message: 'A session id is required.' } })
  }
  const session = liveSession(ctx, sessionId)
  if (session === null) {
    // A capability refusal, not a bad request: the conversation exists, it is
    // just not open on this host (a stored conversation reads from its log
    // through the session UI, and this panel is bound to what is live).
    return json(200, {
      ok: false,
      reason: 'NOT_LIVE',
      message: 'This conversation is not open on this host, so the commands it ran cannot be read here.',
    })
  }
  let tail = { entries: [], hasMore: false }
  try {
    tail = activityEntries(session)
  } catch (err) {
    return json(200, { ok: false, reason: 'UNREADABLE', message: 'The conversation log could not be read: ' + String((err && err.message) || err) })
  }
  return json(200, { ok: true, session: sessionId, entries: tail.entries, hasMore: tail.hasMore })
}

// ---------------------------------------------------------------------------
// The WebSocket upgrade
// ---------------------------------------------------------------------------
/**
 * Load `ws` the way node-pty is loaded: from the harness's own installation.
 * It is part of the closure (`dsh-api-gateway` speaks WebSocket), so nothing is
 * installed for it either.
 */
function loadWebSocket(logger) {
  const anchors = [process.argv[1], path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh'), 'profiles', 'index.js'), fileURLToPath(import.meta.url)]
  for (const anchor of anchors) {
    if (typeof anchor !== 'string' || anchor === '') continue
    try {
      const resolved = createRequire(anchor).resolve('ws')
      const ws = createRequire(anchor)('ws')
      if (ws && typeof ws.WebSocketServer === 'function') return ws
    } catch (err) {
      /* try the next anchor */
    }
  }
  logger?.warn?.('[dsh-terminal] the `ws` package is not resolvable; the terminal WebSocket route is disabled.')
  return null
}

/** Reject an upgrade without handing the socket to `ws` (401/403 only). */
function rejectUpgrade(socket, status) {
  const reason = status === 401 ? 'Unauthorized' : 'Forbidden'
  const body = reason.toLowerCase()
  try {
    socket.end(
      [
        'HTTP/1.1 ' + String(status) + ' ' + reason,
        'Connection: close',
        'Content-Type: text/plain; charset=utf-8',
        'Content-Length: ' + String(Buffer.byteLength(body)),
        '',
        body,
      ].join('\r\n'),
    )
  } catch (err) {
    try {
      socket.destroy()
    } catch (e) {}
  }
}

/** Send one JSON control frame if the socket is still open. */
function send(socket, payload) {
  if (socket.readyState !== 1) return
  try {
    socket.send(CONTROL + JSON.stringify(payload))
  } catch (err) {
    /* the close handler owns the cleanup */
  }
}

/** Attach one browser socket to one PTY session. */
function attachSocket({ socket, host, ctx, logger }) {
  let session = null
  let unsubscribe = null
  let paused = false
  let alive = true
  const socketKey = 'dsh-terminal/' + String(Math.random()).slice(2)

  const heartbeat = setInterval(() => {
    if (socket.readyState !== 1) return
    if (!alive) {
      try {
        socket.terminate()
      } catch (err) {}
      return
    }
    alive = false
    try {
      socket.ping()
    } catch (err) {}
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  socket.on('pong', () => {
    alive = true
  })

  socket.on('message', (raw, isBinary) => {
    void (async () => {
      try {
        const text = isBinary ? raw.toString('utf8') : String(raw)
        if (session === null) {
          let message = null
          if (text.charCodeAt(0) === 0) {
            try {
              message = JSON.parse(text.slice(1))
            } catch (err) {
              message = null
            }
          }
          if (message === null || message.t !== 'init') {
            send(socket, { t: 'error', code: 'BAD_FRAME', message: 'The first frame must be a control {"t":"init",...} message.' })
            return
          }
          const conversation = typeof message.session === 'string' ? message.session : ''
          const cwd = await sessionRoot(ctx, conversation)
          const slot = Number.isInteger(message.slot) ? message.slot : undefined
          const size = clampSize(Number(message.cols), Number(message.rows))
          session = host.ensure({ sessionId: conversation, slot, cwd, cols: size.cols, rows: size.rows })
          unsubscribe = host.subscribe(session, (event) => {
            if (event.type === 'data') {
              if (socket.readyState !== 1) return
              try {
                socket.send(event.data)
              } catch (err) {
                /* the close handler owns the cleanup */
              }
              // Backpressure: pause the pty instead of piling up in memory.
              if (!paused && socket.bufferedAmount > HIGH_WATER_BYTES) {
                paused = true
                host.flow(session, true)
              }
              if (paused && socket.bufferedAmount < HIGH_WATER_BYTES / 2) {
                paused = false
                host.flow(session, false)
              }
              return
            }
            if (event.type === 'exit') {
              send(socket, { t: 'exit', code: event.exit.code, signal: event.exit.signal })
              return
            }
            send(socket, { t: 'closed', reason: event.reason })
          })
          const snapshot = host.snapshot(session)
          send(socket, { t: 'ready', ...snapshot, replay: session.replay() })
          logger?.debug?.('[dsh-terminal] ' + socketKey + ' attached to ' + session.key)
          return
        }
        if (text.length > 0 && text.charCodeAt(0) === 0 /* CONTROL */) {
          let message = null
          try {
            message = JSON.parse(text.slice(1))
          } catch (err) {
            message = null
          }
          if (message !== null && typeof message === 'object' && typeof message.t === 'string') {
            if (message.t === 'resize') {
              host.resize(session, Number(message.cols), Number(message.rows))
              return
            }
            if (message.t === 'kill') {
              host.kill(session, 'client')
              return
            }
            if (message.t === 'ping') {
              send(socket, { t: 'pong' })
              return
            }
            send(socket, { t: 'error', code: 'BAD_FRAME', message: 'Unknown control frame "' + message.t + '".' })
            return
          }
        }
        host.write(session, text)
      } catch (err) {
        const status = typeof err.status === 'number' ? err.status : 500
        send(socket, { t: 'error', code: err.code || 'TERMINAL_ERROR', message: String((err && err.message) || err) })
        logger?.debug?.('[dsh-terminal] ' + socketKey + ' failed: ' + String((err && err.message) || err) + ' (' + String(status) + ')')
        try {
          socket.close(1011, 'terminal error')
        } catch (e) {}
      }
    })()
  })

  const cleanup = () => {
    clearInterval(heartbeat)
    if (unsubscribe !== null) unsubscribe()
    unsubscribe = null
    // The PTY is NOT killed here: a reload must be able to reattach. The host's
    // reaper ends a session nobody comes back to.
    session = null
  }
  socket.on('close', cleanup)
  socket.on('error', cleanup)
}

/**
 * Activate the row: load the PTY and `ws`, then register one HTTP route family
 * and one authenticated upgrade route.
 *
 * @param ctx - cordis context (inject: connection).
 */
export function apply(ctx) {
  const shell = (() => {
    try {
      return resolveShell()
    } catch (err) {
      ctx.logger?.warn?.('[dsh-terminal] no shell for this host: ' + String((err && err.message) || err))
      return null
    }
  })()
  const loaded = loadNodePty(ctx.logger)
  const ws = loadWebSocket(ctx.logger)
  const host = loaded.pty !== undefined && shell !== null ? new PtyHost({ pty: loaded.pty, shell, logger: ctx.logger }) : null
  const state = { host, shell, ptyError: loaded.error, maxSessions: host === null ? 0 : host.maxSessions }

  ctx.effect(() => {
    const disposers = []
    const connection = ctx.get ? ctx.get('connection') : undefined
    if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') {
      ctx.logger?.warn?.('[dsh-terminal] connection service unavailable - terminal routes not registered')
      return () => {}
    }
    // `requestBody: 'buffered'` is required by the connection bridge (a route
    // that leaves it undefined takes the streaming branch, which throws for a
    // bodyless method before the handler runs).
    disposers.push(
      connection.fetch.register({
        path: HEALTH_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () => handleHealth(state),
      }),
    )
    disposers.push(
      connection.fetch.register({
        path: ACTIVITY_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => handleActivity(request, ctx),
      }),
    )
    disposers.push(
      connection.fetch.register({
        path: VENDOR_JS_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => handleVendor(request, 'js'),
      }),
    )
    disposers.push(
      connection.fetch.register({
        path: VENDOR_CSS_ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: (request) => handleVendor(request, 'css'),
      }),
    )

    const webServer = ctx.get ? ctx.get('webServer') : undefined
    if (host !== null && ws !== null && webServer && typeof webServer.registerUpgrade === 'function') {
      const wss = new ws.WebSocketServer({ noServer: true, maxPayload: MAX_CONTROL_BYTES })
      disposers.push(
        webServer.registerUpgrade({
          path: PTY_ROUTE,
          handler: (req, socket, head) => {
            const rejection = typeof connection.requestRejection === 'function' ? connection.requestRejection(req) : 403
            if (rejection !== undefined) {
              rejectUpgrade(socket, rejection)
              return
            }
            if (host.disposed) {
              rejectUpgrade(socket, 503)
              return
            }
            wss.handleUpgrade(req, socket, head, (client) => {
              attachSocket({ socket: client, host, ctx, logger: ctx.logger })
            })
          },
        }),
      )
      disposers.push(() => {
        try {
          wss.close()
        } catch (err) {}
      })
      ctx.logger?.info?.('[dsh-terminal] terminal ready: ' + shell.label + ' via ' + loaded.resolved)
    } else {
      ctx.logger?.warn?.('[dsh-terminal] terminal dock mounted without a PTY: ' + String(state.ptyError || 'no webserver'))
    }

    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch (err) {}
      }
      if (host !== null) host.dispose()
      ctx.logger?.debug?.('[dsh-terminal] node half disposed')
    }
  }, 'dsh-terminal: terminal routes')
}
