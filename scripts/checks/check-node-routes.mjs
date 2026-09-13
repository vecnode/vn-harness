// check-node-routes.mjs - drive the pack's host-side route handlers directly,
// with real Requests and a real temp workspace.
//
// Why this exists: the two Node halves register their handlers through
// `connection.fetch.register`, so importing the module and capturing that
// handler exercises the shipped code path (path resolution, containment,
// optimistic concurrency, create-only semantics, wire validation) without a
// running harness.
//
// Run:  node scripts/checks/check-node-routes.mjs
export {} // (kept import-free: this file is ESM for the dynamic import below)

const { promises: fsp } = await import('node:fs')
const { existsSync, readdirSync } = await import('node:fs')
const { createRequire } = await import('node:module')
const os = await import('node:os')
const path = (await import('node:path')).default
const { pathToFileURL, fileURLToPath } = await import('node:url')
const { spawnSync } = await import('node:child_process')

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))
let failures = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(34) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

/** Register one row against a stub context and hand back its route handler. */
async function capture(modulePath, routePath, ctx) {
  const module = await import(pathToFileURL(modulePath).href)
  let handler = null
  const context = {
    ...ctx,
    effect: (fn) => fn(),
    logger: { debug() {}, warn() {} },
    get(name) {
      if (name === 'connection') {
        return {
          fetch: {
            register(route) {
              if (route.path === routePath) handler = route.fetch
              return () => {}
            },
          },
        }
      }
      return ctx.get ? ctx.get(name) : undefined
    },
  }
  module.apply(context)
  if (typeof handler !== 'function') throw new Error('route not registered: ' + routePath)
  return handler
}

// ------------------------------------------------------------- dsh-editor
const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-editor-check-'))
const sessionId = 'session-check'
const fileHandler = await capture(path.join(repo, 'packages/dsh-editor/lib/index.js'), '/api/dsh-editor/file', {
  get: (name) => (name === 'sessions' ? { get: (id) => (id === sessionId ? { header: { cwd: root } } : undefined) } : undefined),
})
const put = (body) =>
  fileHandler(
    new Request('http://x/api/dsh-editor/file', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  )
const get = (query) => fileHandler(new Request('http://x/api/dsh-editor/file?' + query, { method: 'GET' }))
const code = async (response) => {
  const payload = await response.json().catch(() => null)
  return payload && payload.error ? payload.error.code : payload && payload.ok ? 'ok' : 'http ' + response.status
}

check('create needs an existing folder', await code(await put({ session: sessionId, path: 'notes/a.md', text: '# a\n', create: true })), 'NO_FOLDER')
await fsp.mkdir(path.join(root, 'notes'))
check('create', await code(await put({ session: sessionId, path: 'notes/a.md', text: '# a\n', create: true })), 'ok')
check('created on disk', await fsp.readFile(path.join(root, 'notes', 'a.md'), 'utf8'), '# a\n')
check('create never overwrites', await code(await put({ session: sessionId, path: 'notes/a.md', text: 'x', create: true })), 'EXISTS')
for (const bad of ['../out.txt', 'a/../../b.txt', '/abs.txt', 'C:/abs.txt', 'notes/', '.', 'notes/..']) {
  check('rejects ' + JSON.stringify(bad), await code(await put({ session: sessionId, path: bad, text: 'x', create: true })), 'BAD_REQUEST')
}
check(
  'nothing escaped the workspace',
  await fsp
    .stat(path.join(root, '..', 'out.txt'))
    .then(() => 'exists')
    .catch(() => 'absent'),
  'absent',
)
check('read back', await fsp.readFile(path.join(root, 'notes', 'a.md'), 'utf8'), '# a\n')
const reader = await get('session=' + sessionId + '&path=notes/a.md')
check('GET route answers', reader.status, 200)
check('save of an unknown file', await code(await put({ session: sessionId, path: 'notes/b.md', text: 'x' })), 'NOT_FOUND')
const before = await fsp.stat(path.join(root, 'notes', 'a.md'))
check(
  'save in place',
  await code(await put({ session: sessionId, path: 'notes/a.md', text: '# a2\n', expected: { mtimeMs: before.mtimeMs, size: before.size } })),
  'ok',
)
check(
  'stale save is refused',
  await code(await put({ session: sessionId, path: 'notes/a.md', text: 'z', expected: { mtimeMs: before.mtimeMs, size: before.size } })),
  'CHANGED_ON_DISK',
)
check('unknown session', await code(await put({ session: 'nope', path: 'x.txt', text: 'x', create: true })), 'NO_WORKSPACE')
await fsp.rm(root, { recursive: true, force: true })

// -------------------------------------------------------- dsh-open-in-app
const openHandler = await capture(path.join(repo, 'packages/dsh-open-in-app/lib/index.js'), '/api/dsh-open-in-app/open', {})
const open = (body) =>
  openHandler(
    new Request('http://x/api/dsh-open-in-app/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
const openCode = async (response) => {
  const payload = await response.json().catch(() => null)
  return payload && payload.error ? payload.error.code : payload && payload.ok ? 'ok' : 'http ' + response.status
}
const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-open-check-'))
check('only file managers are accepted', await code(await open({ app: 'vscode', path: dir })), 'BAD_REQUEST')
check('the path must be absolute', await code(await open({ app: 'explorer', path: 'relative/dir' })), 'BAD_REQUEST')
check('the directory must exist', await code(await open({ app: 'explorer', path: path.join(dir, 'nope') })), 'NOT_FOUND')
check('the body must be JSON', await code(await open('not json')), 'BAD_REQUEST')
// The happy path SPAWNS the real file browser (an Explorer/Finder window), so it
// is opt-in: DSH_CHECK_LAUNCH=1 node scripts/checks/check-node-routes.mjs
if (process.env.DSH_CHECK_LAUNCH === '1') {
  const launched = await open({ app: 'explorer', path: dir })
  check('a valid request launches', launched.status, 200)
  // Give the file browser a moment to open the folder before it disappears.
  await new Promise((resolve) => setTimeout(resolve, 1500))
} else {
  console.log('skip a valid request launches       (set DSH_CHECK_LAUNCH=1 to open a file browser)')
}
await fsp.rm(dir, { recursive: true, force: true })

// ------------------------------------------------------------- dsh-gittree
// The git routes are driven against a REAL scratch repository (init, commit,
// rename, untracked file, plus a workspace that is a subfolder of it), because
// the wire formats they parse - `status --porcelain=v2 -z` and
// `diff-tree --name-status -z` - are exactly the contract under test.
const hasGit = (() => {
  try {
    return spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
  } catch (err) {
    return false
  }
})()
if (!hasGit) {
  console.log('skip dsh-gittree routes             (git is not on PATH)')
} else {
  const gitRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-gittree-check-'))
  const gitModule = path.join(repo, 'packages/dsh-gittree/lib/index.js')
  const stateRoute = '/api/dsh-gittree/state'
  const historyRoute = '/api/dsh-gittree/history'
  const commitRoute = '/api/dsh-gittree/commit'
  const sessionFor = (cwd) => ({
    get: (name) => (name === 'sessions' ? { get: (id) => (id === 'session-git' ? { header: { cwd } } : undefined) } : undefined),
  })
  const stateHandler = await capture(gitModule, stateRoute, sessionFor(gitRoot))
  const historyHandler = await capture(gitModule, historyRoute, sessionFor(gitRoot))
  const commitHandler = await capture(gitModule, commitRoute, sessionFor(gitRoot))
  const ask = async (handler, route, query) => {
    const response = await handler(new Request('http://x' + route + (query === '' ? '' : '?' + query), { method: 'GET' }))
    return { status: response.status, payload: await response.json().catch(() => null) }
  }
  const outcome = async (handler, route, query) => {
    const answer = await ask(handler, route, query)
    return answer.payload && answer.payload.error ? answer.payload.error.code : answer.payload && answer.payload.ok ? 'ok' : 'http ' + answer.status
  }
  const git = (args) => {
    const result = spawnSync('git', ['-C', gitRoot, ...args], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } })
    if (result.status !== 0) throw new Error('git ' + args.join(' ') + ': ' + String(result.stderr || '').trim())
    return result.stdout
  }
  const session = 'session-git'
  check('gittree: not a repo yet', await outcome(stateHandler, stateRoute, 'session=' + session), 'NOT_A_REPO')
  check('gittree: unknown session', await outcome(stateHandler, stateRoute, 'session=nope'), 'NO_WORKSPACE')
  check('gittree: a session is required', await outcome(stateHandler, stateRoute, ''), 'BAD_REQUEST')
  git(['init', '-q', '.'])
  git(['config', 'user.email', 'check@example.invalid'])
  git(['config', 'user.name', 'check'])
  await fsp.writeFile(path.join(gitRoot, 'readme.md'), '# one\n')
  await fsp.mkdir(path.join(gitRoot, 'sub'))
  await fsp.writeFile(path.join(gitRoot, 'sub', 'inner.txt'), 'inner\n')
  git(['add', '-A'])
  git(['commit', '-qm', 'first commit'])
  await fsp.writeFile(path.join(gitRoot, 'sub', 'inner.txt'), 'inner changed\n')
  await fsp.writeFile(path.join(gitRoot, 'new file.txt'), 'untracked\n')
  const state = await ask(stateHandler, stateRoute, 'session=' + session)
  const entries = state.payload && Array.isArray(state.payload.entries) ? state.payload.entries : []
  const byPath = Object.fromEntries(entries.map((entry) => [entry.path, entry.status]))
  check('gittree: state answers', state.status, 200)
  check('gittree: names the branch', typeof state.payload.branch === 'string' && state.payload.branch.length > 0)
  check('gittree: names the head', typeof state.payload.head === 'string' && state.payload.head.length > 0)
  check('gittree: a clean tracked file has no status', byPath['readme.md'], '')
  check('gittree: a modified file is marked', (byPath['sub/inner.txt'] || '').indexOf('M') >= 0)
  check('gittree: an untracked file is marked', byPath['new file.txt'], '??')
  check('gittree: counts the changed files', state.payload.changed >= 2)
  // `brief=1` is the tab's own form: the facts the bar shows, and no file list.
  const brief = await ask(stateHandler, stateRoute, 'session=' + session + '&brief=1')
  check('gittree: brief state answers', brief.status, 200)
  check('gittree: brief names the commit', brief.payload.head, state.payload.head)
  check('gittree: brief counts the changes', brief.payload.changed, state.payload.changed)
  check('gittree: brief sends no file list', brief.payload.entries === undefined && brief.payload.total === undefined)
  const history = await ask(historyHandler, historyRoute, 'session=' + session + '&limit=5')
  const commits = history.payload && Array.isArray(history.payload.commits) ? history.payload.commits : []
  check('gittree: history answers', history.status, 200)
  check('gittree: one commit, with its subject', commits.length === 1 && commits[0].subject, 'first commit')
  const detail = await ask(commitHandler, commitRoute, 'session=' + session + '&sha=' + commits[0].sha)
  const files = detail.payload && Array.isArray(detail.payload.files) ? detail.payload.files : []
  check(
    'gittree: the root commit lists its files',
    files.map((file) => file.status + ':' + file.path).sort().join(','),
    'A:readme.md,A:sub/inner.txt',
  )
  // A commit id is never allowed to reach argv as an option.
  check('gittree: a commit needs a valid id', await outcome(commitHandler, commitRoute, 'session=' + session + '&sha=--all'), 'BAD_REQUEST')
  // A workspace that is a SUBFOLDER of the repository: the tree is scoped to it
  // and every path stays workspace-relative.
  const subHandler = await capture(gitModule, stateRoute, {
    get: (name) =>
      name === 'sessions'
        ? { get: (id) => (id === 'session-git' ? { header: { cwd: path.join(gitRoot, 'sub') } } : undefined) }
        : undefined,
  })
  const subState = await ask(subHandler, stateRoute, 'session=' + session)
  const subPaths = (subState.payload && Array.isArray(subState.payload.entries) ? subState.payload.entries : []).map((entry) => entry.path).sort().join(',')
  check('gittree: a subfolder workspace is scoped', subPaths, 'inner.txt')
  await fsp.rm(gitRoot, { recursive: true, force: true })
}

// -------------------------------------------------------------- dsh-browser
// The framing probe, driven against a REAL local HTTP server this block starts:
// the header classification (X-Frame-Options, frame-ancestors, and the precedence
// between them), the title sniff, the notes, and the guards. The probe request's
// own origin is `http://x`, so "same origin" and a `frame-ancestors http://x`
// source can both be exercised without a second host.
//
// This block runs BEFORE the terminal's: the terminal's checks spawn a real PTY,
// which a sandbox without a console host cannot do, and that failure takes the
// process down with it - the browser's checks must not be collateral.
const { createServer } = await import('node:http')
const browserPages = {
  '/plain': { type: 'text/html; charset=utf-8', body: '<!doctype html><title>Plain &amp; Simple</title><h1>ok</h1>' },
  '/deny': { type: 'text/html', headers: { 'x-frame-options': 'DENY' }, body: '<title>Denied</title>' },
  '/sameorigin': { type: 'text/html', headers: { 'x-frame-options': 'SAMEORIGIN' }, body: '<title>Same</title>' },
  '/csp-none': { type: 'text/html', headers: { 'content-security-policy': "default-src 'self'; frame-ancestors 'none'; script-src 'self'" }, body: '<title>None</title>' },
  '/csp-empty': { type: 'text/html', headers: { 'content-security-policy': 'frame-ancestors' }, body: '<title>Empty</title>' },
  '/csp-star': { type: 'text/html', headers: { 'content-security-policy': 'frame-ancestors *', 'x-frame-options': 'SAMEORIGIN' }, body: '<title>Star</title>' },
  '/csp-origin': { type: 'text/html', headers: { 'content-security-policy': 'frame-ancestors http://x' }, body: '<title>Origin</title>' },
  '/csp-self': { type: 'text/html', headers: { 'content-security-policy': "frame-ancestors 'self'" }, body: '<title>Self</title>' },
  '/head-refused': { type: 'text/html', body: '<title>Sniffed</title>', refuseHead: true },
  '/attachment': { type: 'application/zip', headers: { 'content-disposition': 'attachment; filename="a.zip"' }, body: 'PK' },
  '/nothtml': { type: 'application/octet-stream', body: 'binary' },
  '/no-title': { type: 'text/html', body: '<!doctype html><h1>No title here</h1>' },
}
const browserServer = createServer((request, response) => {
  const route = browserPages[String(request.url).split('?')[0]]
  if (route === undefined) {
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not here')
    return
  }
  if (route.refuseHead === true && request.method === 'HEAD') {
    response.writeHead(405, { 'content-type': 'text/plain' })
    response.end()
    return
  }
  response.writeHead(200, { 'content-type': route.type, ...(route.headers || {}) })
  if (request.method === 'HEAD') response.end()
  else response.end(route.body)
})
await new Promise((resolve) => browserServer.listen(0, '127.0.0.1', resolve))
const browserBase = 'http://127.0.0.1:' + String(browserServer.address().port)

const probeHandler = await capture(path.join(repo, 'packages/dsh-browser/lib/index.js'), '/api/dsh-browser/probe', {})
// The directive stands on the host side too: no engine is installed, downloaded
// or looked up on this machine - the probe is Node's own fetch and nothing else.
const browserNodeSource = await fsp.readFile(path.join(repo, 'packages/dsh-browser/lib/index.js'), 'utf8')
check('probe host reaches for no OS browser', /msedge|chrome\.exe|Google Chrome|playwright|puppeteer|chrome-headless|child_process/i.test(browserNodeSource), false)
const probe = (url) => probeHandler(new Request('http://x/api/dsh-browser/probe?url=' + encodeURIComponent(url), { method: 'GET' }))
const probeJson = async (routePath) => {
  const response = await probe(browserBase + routePath)
  const body = await response.json().catch(() => null)
  return { status: response.status, body: body === null ? {} : body }
}
const noteOf = (payload) => String(payload.body.note || '')

const plain = await probeJson('/plain')
check('probe allows an ordinary page', plain.body.frameable, true)
check('probe reads the document title', plain.body.title, 'Plain & Simple')
check('probe reports the status', plain.body.status, 200)
check('probe reports the final address', plain.body.finalUrl, browserBase + '/plain')
const deny = await probeJson('/deny')
check('probe catches X-Frame-Options DENY', deny.body.frameable, false)
check('probe names the header', deny.body.blockedBy && deny.body.blockedBy.value, 'X-Frame-Options: DENY')
check('probe names the kind', deny.body.blockedBy && deny.body.blockedBy.kind, 'xfo')
check('probe catches SAMEORIGIN from another origin', (await probeJson('/sameorigin')).body.frameable, false)
const cspNone = await probeJson('/csp-none')
check('probe catches frame-ancestors none', cspNone.body.frameable, false)
check('probe names the directive', cspNone.body.blockedBy && cspNone.body.blockedBy.value, "frame-ancestors 'none'")
check('probe catches an empty directive', (await probeJson('/csp-empty')).body.frameable, false)
check('probe lets a star through', (await probeJson('/csp-star')).body.frameable, true)
check('probe lets THIS origin through', (await probeJson('/csp-origin')).body.frameable, true)
check("probe refuses frame-ancestors 'self'", (await probeJson('/csp-self')).body.frameable, false)
const sniffed = await probeJson('/head-refused')
check('probe ignores a server that refuses HEAD', sniffed.body.frameable, true)
check('probe still reads that title', sniffed.body.title, 'Sniffed')
check('probe notes a download', noteOf(await probeJson('/attachment')).includes('downloads a file'), true)
check('probe notes a non-page type', noteOf(await probeJson('/nothtml')).includes('application/octet-stream'), true)
check('probe leaves an absent title empty', (await probeJson('/no-title')).body.title, '')
check('probe requires a url', (await probeHandler(new Request('http://x/api/dsh-browser/probe'))).status, 400)
check('probe rejects a non-address', (await probe('notaurl')).status, 400)
check('probe rejects a non-http scheme', (await probe('file:///etc/passwd')).status, 400)
check('probe rejects credentials in the address', (await probe('http://user:pass@127.0.0.1:1/x')).status, 400)
check('probe refuses an overlong address', (await probe('http://example.com/' + 'a'.repeat(2100))).status, 414)
const dead = await probe('http://127.0.0.1:1/')
check('probe reports an unreachable host', dead.status, 502)
check('probe types the failure', (await dead.json()).error.code, 'UNREACHABLE')
browserServer.close()

// ------------------------------------------------------------ dsh-terminal
// The terminal's Node half is three HTTP routes and ONE WebSocket upgrade. The
// HTTP ones are driven directly; the upgrade is driven over a real socket
// against a real PTY, because the contract under test is the wire protocol
// (init -> ready -> output -> kill) and the authentication gate in front of it.
// `ws` and `node-pty` both come from the harness's own installation, so the
// live part is skipped (loudly) where they are not resolvable.
/** Resolve one package from the profile closure or the npm caches. */
function loadFromHarness(name) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const roots = [path.join(home, 'profiles', 'node_modules')]
  for (const base of [process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean)) {
    const cache = path.join(base, 'npm-cache', '_npx')
    if (existsSync(cache)) for (const entry of readdirSync(cache)) roots.push(path.join(cache, entry, 'node_modules'))
  }
  const cache = path.join(os.homedir(), '.npm', '_npx')
  if (existsSync(cache)) for (const entry of readdirSync(cache)) roots.push(path.join(cache, entry, 'node_modules'))
  for (const root of roots) {
    try {
      return createRequire(path.join(root, 'index.js'))(name)
    } catch (err) {
      /* try the next root */
    }
  }
  return null
}

{
  const terminalModule = path.join(repo, 'packages/dsh-terminal/lib/index.js')
  const termCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-terminal-check-'))
  const routeHandlers = new Map()
  let upgradeRoute = null
  const termModule = await import(pathToFileURL(terminalModule).href)
  const sessions = { get: (id) => (id === 'session-term' ? { header: { cwd: termCwd } } : undefined) }
  termModule.apply({
    effect: (fn) => fn(),
    logger: { debug() {}, info() {}, warn() {} },
    get(name) {
      if (name === 'connection') {
        return {
          fetch: {
            register(route) {
              routeHandlers.set(route.path, route.fetch)
              return () => {}
            },
          },
          requestRejection: (req) => (req.headers['x-check-unauthenticated'] === '1' ? 401 : undefined),
        }
      }
      if (name === 'webServer') {
        return {
          registerUpgrade(route) {
            upgradeRoute = route
            return () => {}
          },
        }
      }
      if (name === 'sessions') return sessions
      return undefined
    },
  })
  check(
    'terminal: routes registered',
    [...routeHandlers.keys()].sort().join(','),
    '/api/dsh-terminal/health,/api/dsh-terminal/vendor/xterm.css,/api/dsh-terminal/vendor/xterm.js',
  )
  check('terminal: upgrade registered', upgradeRoute !== null && upgradeRoute.path, '/api/dsh-terminal/pty')
  const health = await routeHandlers.get('/api/dsh-terminal/health')(new Request('http://x/api/dsh-terminal/health?session=session-term'))
  const healthBody = await health.json()
  check('terminal: health answers', health.status, 200)
  check('terminal: health names the host platform', healthBody.platform, process.platform)
  check('terminal: health reports capacity', healthBody.available === true ? healthBody.capacity > 0 : typeof healthBody.reason === 'string', true)
  const vendorJs = await routeHandlers.get('/api/dsh-terminal/vendor/xterm.js')(new Request('http://x/api/dsh-terminal/vendor/xterm.js'))
  const jsBytes = Buffer.from(await vendorJs.arrayBuffer())
  check('terminal: serves the vendored engine', vendorJs.status === 200 && jsBytes.length > 100000, true)
  check('terminal: engine content type', vendorJs.headers.get('content-type'), 'text/javascript; charset=utf-8')
  const etag = vendorJs.headers.get('etag')
  const cached = await routeHandlers.get('/api/dsh-terminal/vendor/xterm.js')(new Request('http://x/api/dsh-terminal/vendor/xterm.js', { headers: { 'if-none-match': etag } }))
  check('terminal: engine is etag-cached', cached.status, 304)
  const vendorCss = await routeHandlers.get('/api/dsh-terminal/vendor/xterm.css')(new Request('http://x/api/dsh-terminal/vendor/xterm.css'))
  const cssText = await vendorCss.text()
  check('terminal: serves the xterm stylesheet', vendorCss.status === 200 && cssText.includes('.xterm-viewport'), true)

  const WebSocket = loadFromHarness('ws')
  if (healthBody.available !== true || WebSocket === null) {
    console.log('skip dsh-terminal live socket       (' + (healthBody.available !== true ? 'no PTY on this host' : 'ws is not resolvable') + ')')
  } else {
    const { createServer } = await import('node:http')
    const server = createServer((req, res) => {
      const handler = routeHandlers.get(new URL(req.url, 'http://x').pathname)
      if (handler) {
        void Promise.resolve(handler(new Request(new URL(req.url, 'http://127.0.0.1').href, { method: req.method, headers: req.headers }))).then(async (response) => {
          res.writeHead(response.status, Object.fromEntries(response.headers))
          res.end(Buffer.from(await response.arrayBuffer()))
        })
        return
      }
      res.writeHead(404).end('no')
    })
    server.on('upgrade', (req, socket, head) => {
      if (upgradeRoute !== null && new URL(req.url, 'http://x').pathname === upgradeRoute.path) {
        void upgradeRoute.handler(req, socket, head)
        return
      }
      socket.destroy()
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    const wsUrl = 'ws://127.0.0.1:' + String(port) + '/api/dsh-terminal/pty'
    const socket = new WebSocket(wsUrl)
    const output = []
    let ready = null
    let closed = null
    socket.on('message', (raw) => {
      const text = String(raw)
      if (text.charCodeAt(0) === 0) {
        const message = JSON.parse(text.slice(1))
        if (message.t === 'ready') ready = message
        if (message.t === 'closed') closed = message.reason
        return
      }
      output.push(text)
    })
    await new Promise((resolve, reject) => {
      socket.on('open', resolve)
      socket.on('error', reject)
    })
    socket.send('\u0000' + JSON.stringify({ t: 'init', session: 'session-term', slot: 0, cols: 90, rows: 24 }))
    const waitFor = async (predicate, ms) => {
      const started = Date.now()
      while (!predicate()) {
        if (Date.now() - started > ms) return false
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return true
    }
    check('terminal: ready frame arrives', await waitFor(() => ready !== null, 20000))
    check('terminal: ready names the shell', typeof (ready && ready.shell) === 'string' && ready.shell.length > 0, true)
    check('terminal: ready carries the session cwd', ready !== null && path.resolve(ready.cwd) === path.resolve(termCwd), true)
    check('terminal: ready reports the size', ready !== null && ready.cols + 'x' + ready.rows, '90x24')
    check('terminal: ready pid is null or a number', ready !== null && (ready.pid === null || typeof ready.pid === 'number'), true)
    // A real command through a real shell: this is the whole feature in one line.
    socket.send(process.platform === 'win32' ? 'Write-Output DSH_TERM_CHECK_$((2+5))\r' : 'echo DSH_TERM_CHECK_$((2+5))\n')
    check('terminal: the shell answered', await waitFor(() => output.join('').includes('DSH_TERM_CHECK_7'), 30000))
    socket.send('\u0000' + JSON.stringify({ t: 'kill' }))
    check('terminal: kill is honoured', await waitFor(() => closed !== null, 15000))
    socket.close()
    // A shell's own JSON must never be mistaken for a control frame.
    const plain = new WebSocket(wsUrl)
    let plainReady = false
    const echo = []
    plain.on('message', (raw) => {
      const text = String(raw)
      if (text.charCodeAt(0) === 0) {
        if (JSON.parse(text.slice(1)).t === 'ready') plainReady = true
        return
      }
      echo.push(text)
    })
    await new Promise((resolve, reject) => {
      plain.on('open', resolve)
      plain.on('error', reject)
    })
    plain.send('\u0000' + JSON.stringify({ t: 'init', session: 'session-term', slot: 1, cols: 90, rows: 24 }))
    await waitFor(() => plainReady, 20000)
    const json = '{"t":"not-a-control-frame","ok":true}'
    plain.send(process.platform === 'win32' ? "Write-Output '" + json + "'\r" : "echo '" + json + "'\n")
    check('terminal: a JSON line is shell input, not a frame', await waitFor(() => echo.join('').includes('not-a-control-frame'), 30000))
    let plainClosed = false
    plain.on('message', (raw) => {
      const text = String(raw)
      if (text.charCodeAt(0) === 0 && JSON.parse(text.slice(1)).t === 'closed') plainClosed = true
    })
    plain.send('\u0000' + JSON.stringify({ t: 'kill' }))
    await waitFor(() => plainClosed, 15000)
    plain.close()
    // The authentication gate runs before ws takes the socket.
    const unauthenticated = await new Promise((resolve) => {
      const client = new WebSocket(wsUrl, { headers: { 'x-check-unauthenticated': '1' } })
      client.on('unexpected-response', (req, response) => resolve(response.statusCode))
      client.on('error', () => resolve(0))
      client.on('open', () => {
        client.close()
        resolve(200)
      })
    })
    check('terminal: unauthenticated upgrade is refused', unauthenticated, 401)
    server.close()
  }
  // The scratch folder was two shells' cwd: on Windows a process that has not
  // finished exiting keeps it busy, which must never fail the check.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fsp.rm(termCwd, { recursive: true, force: true })
      break
    } catch (err) {
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

// --------------------------------------------------------------- dsh-themes
// The screenshot route: the client's PNG body is written to the host's Desktop.
// HOME / USERPROFILE point at a temp folder for this block, so the check never
// touches the real Desktop - the route resolves the folder per request, which is
// exactly what makes that possible.
const themesHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-themes-home-'))
await fsp.mkdir(path.join(themesHome, 'Desktop'))
const previousHome = process.env.HOME
const previousProfile = process.env.USERPROFILE
process.env.HOME = themesHome
process.env.USERPROFILE = themesHome
try {
  const screenshotHandler = await capture(path.join(repo, 'packages/dsh-themes/lib/index.js'), '/api/dsh-themes/screenshot', {})
  const postShot = (body, type) =>
    screenshotHandler(
      new Request('http://x/api/dsh-themes/screenshot', {
        method: 'POST',
        headers: { 'content-type': type === undefined ? 'image/png' : type },
        body,
      }),
    )
  // A real 1x1 PNG: the signature check is exercised by an actual picture.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
    'base64',
  )
  check('screenshot rejects another content type', (await postShot(png, 'application/json')).status, 415)
  check('screenshot rejects an empty body', (await postShot(Buffer.alloc(0))).status, 400)
  check('screenshot rejects a body that is not a PNG', (await postShot(Buffer.from('not a png at all'))).status, 415)
  const saved = await (await postShot(png)).json()
  check('screenshot reports the save', saved.ok, true)
  check('screenshot writes to the Desktop', saved.directory, path.join(themesHome, 'Desktop'))
  const written = await fsp.readFile(saved.path).catch(() => null)
  check('screenshot bytes are on disk', written !== null && written.equals(png))
  check(
    'screenshot name carries the pack name',
    path.basename(saved.path).startsWith('vn-harness-') && saved.path.endsWith('.png'),
  )
  const again = await (await postShot(png)).json()
  check('a second shot takes the next free name', again.path !== saved.path, true)
  check('the first shot survives the second', existsSync(saved.path))
  check('screenshot refuses a GET', (await screenshotHandler(new Request('http://x/api/dsh-themes/screenshot'))).status, 405)
} finally {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousProfile
  await fsp.rm(themesHome, { recursive: true, force: true })
}

console.log('')
console.log(failures === 0 ? 'all node-route checks passed' : failures + ' check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
