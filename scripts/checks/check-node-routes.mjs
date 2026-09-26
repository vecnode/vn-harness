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

/**
 * The subset of JSON Schema the tool registry enforces, applied to a returned
 * value.
 *
 * The diagrams below drive `execute()` directly - the same seam the agent loop
 * uses - so NOTHING else here would notice a value that contradicts the schema
 * the model was handed. That gap shipped two bugs: `verification.reported: null`
 * against `type: "integer"` made every fresh write fail at the registry with
 * "must be an integer", and `error: undefined` failed the registry's
 * lossless-JSON rule. A key that is only sometimes meaningful must be ABSENT,
 * and this is what says so.
 *
 * @param schema - the tool's declared `output.schema`.
 * @param value - the value `execute()` returned.
 * @param label - the path shown in a failure.
 * @returns an array of problems (empty when the value conforms).
 */
function schemaErrors(schema, value, label = 'value') {
  const problems = []
  if (!schema || typeof schema !== 'object') return problems
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
  if (schema.type) {
    const wanted = Array.isArray(schema.type) ? schema.type : [schema.type]
    const matches = wanted.some((one) => {
      if (one === 'integer') return Number.isInteger(value)
      if (one === 'number') return typeof value === 'number'
      if (one === 'string') return typeof value === 'string'
      if (one === 'boolean') return typeof value === 'boolean'
      if (one === 'array') return Array.isArray(value)
      if (one === 'object') return actual === 'object'
      if (one === 'null') return value === null
      return true
    })
    if (!matches) problems.push(label + ' must be ' + wanted.join('|') + ' (got ' + actual + ')')
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push(label + ' is not one of ' + schema.enum.join(','))
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => problems.push(...schemaErrors(schema.items, item, label + '[' + index + ']')))
  }
  if (value !== null && actual === 'object' && schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      if (value[key] === undefined) continue
      problems.push(...schemaErrors(schema.properties[key], value[key], label + '.' + key))
    }
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) problems.push(label + '.' + key + ' is required')
    }
  }
  return problems
}

/** The value must also survive a JSON round trip with every key intact. */
function losslessErrors(value, label = 'value') {
  if (value === null || typeof value !== 'object') return []
  const keys = Object.keys(value)
  const round = JSON.parse(JSON.stringify(value))
  const problems = []
  for (const key of keys) {
    if (!Object.hasOwn(round, key)) problems.push(label + '.' + key + ' is dropped by JSON.stringify (undefined)')
    else problems.push(...losslessErrors(value[key], label + '.' + key))
  }
  return problems
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

// The vendored engine route. Its artifact is GENERATED and regenerated in place
// at a stable URL, so it must never be served from a freshness window: alpha.11
// served it with `public, max-age=3600`, and a browser handed the engine it had
// cached an hour earlier to a client bundle that had just gained a `rust` mode -
// `StreamLanguage.define(undefined)` then killed the whole tab. Revalidation (a
// 304 against the content-hash ETag) is what keeps engine and bundle in step.
const vendorHandler = await capture(path.join(repo, 'packages/dsh-editor/lib/index.js'), '/api/dsh-editor/vendor', {})
const vendorResponse = await vendorHandler(new Request('http://x/api/dsh-editor/vendor', { method: 'GET' }))
const vendorEtag = vendorResponse.headers.get('etag')
const vendorBody = await vendorResponse.text()
check('vendor route answers', vendorResponse.status, 200)
check('vendor body is the committed engine', vendorBody.length, (await fsp.stat(path.join(repo, 'packages/dsh-editor/lib/vendor/cm6.min.js'))).size)
check('vendor must be revalidated, never trusted for a freshness window', vendorResponse.headers.get('cache-control'), 'no-cache')
check('vendor etag is a content hash', /^"[0-9a-f]{40}"$/.test(vendorEtag || ''), true)
check(
  'vendor revalidates to 304',
  (await vendorHandler(new Request('http://x/api/dsh-editor/vendor', { method: 'GET', headers: { 'if-none-match': vendorEtag } }))).status,
  304,
)
check('vendor answers HEAD without a body', (await vendorHandler(new Request('http://x/api/dsh-editor/vendor', { method: 'HEAD' }))).status, 200)
// The engine the route serves must be the one the client bundle asks for: the
// five stream modes languageExtensionFor names, wrapped exactly as it wraps them.
const vendorEngine = new Function(
  'window',
  'document',
  'console',
  vendorBody + '\nreturn DSHEditorCM',
)(undefined, undefined, console)
check(
  'vendor engine carries every stream mode the client names',
  ['shell', 'powerShell', 'batch', 'rust', 'toml'].every((name) => vendorEngine[name] && Boolean(vendorEngine.StreamLanguage.define(vendorEngine[name]))),
  true,
)

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
  // One live session double per conversation the activity route is driven with.
  // `snapshotEvents` is what the harness's own Session exposes (the whole
  // contiguous in-memory log), and the events are the durable shapes the client
  // fold reads: `tool/call`, `tool/result` and a HUMAN `user/message`.
  const actEvents = [
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 2, time: 1001, data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'do it' }], source: { kind: 'user' } } },
    { type: 'user/message', seq: 3, time: 1002, data: { id: 'm2', role: 'user', content: [{ type: 'text', text: 'injected context' }], source: { kind: 'plugin', plugin: 'x' } } },
    { type: 'assistant/message', seq: 4, time: 1003, data: { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [], source: { kind: 'model' } }, stream: [] } },
    { type: 'tool/call', seq: 5, time: 1004, data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls","description":"list"}' } },
    {
      type: 'tool/result',
      seq: 6,
      time: 1005,
      data: {
        turn: 1,
        step: 1,
        message: { id: 'r1', role: 'user', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a\nb\n[exit code: 0]' }] }] },
      },
    },
  ]
  const bigEvents = []
  for (let index = 0; index < 420; index += 1) {
    bigEvents.push({
      type: 'tool/call',
      seq: index + 1,
      time: 2000 + index,
      data: { turn: 1, step: 1, callId: 'b' + String(index), name: 'bash', arguments: '{"command":"echo ' + String(index) + '","description":"d"}' },
    })
  }
  const hugeEvents = [{ type: 'tool/result', seq: 1, time: 1, data: { turn: 1, step: 1, message: { id: 'r', role: 'user', source: { kind: 'tool', callId: 'huge' }, content: [{ type: 'tool-result', toolCallId: 'huge', content: [{ type: 'text', text: 'x'.repeat(600 * 1024) }] }] } } }]
  const brokenEvents = []
  const liveSessions = {
    'session-term': { header: { cwd: termCwd }, snapshotEvents: () => actEvents },
    'session-big': { header: { cwd: termCwd }, snapshotEvents: () => bigEvents },
    'session-huge': { header: { cwd: termCwd }, snapshotEvents: () => hugeEvents },
    'session-broken': {
      header: { cwd: termCwd },
      snapshotEvents: () => {
        throw new Error('unreadable')
      },
    },
  }
  const sessions = { get: (id) => liveSessions[id] }
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
    '/api/dsh-terminal/activity,/api/dsh-terminal/health,/api/dsh-terminal/vendor/xterm.css,/api/dsh-terminal/vendor/xterm.js',
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

  // The agent view's read (alpha.7). It reads the HOST's copy of the
  // conversation log, which is what makes the panel work the moment the app
  // opens instead of waiting for a browser to stage the conversation.
  const activityCall = (query) => routeHandlers.get('/api/dsh-terminal/activity')(new Request('http://x/api/dsh-terminal/activity' + query))
  const activityRes = await activityCall('?session=session-term')
  const activityBody = await activityRes.json()
  check('terminal: activity answers', activityRes.status === 200 && activityBody.ok === true, true)
  check('terminal: activity sends only what the panel draws', activityBody.entries.map((entry) => entry.event.type).join(','), 'user/message,tool/call,tool/result')
  check('terminal: activity drops injected context', activityBody.entries.some((entry) => entry.event.seq === 3), false)
  check('terminal: activity drops assistant streams', activityBody.entries.some((entry) => entry.event.type === 'assistant/message'), false)
  check('terminal: activity is in log order', activityBody.entries.map((entry) => entry.event.seq).join(','), '2,5,6')
  check('terminal: activity says whether older ones remain', activityBody.hasMore, false)
  const missing = await activityCall('')
  check('terminal: activity without a session is refused', missing.status, 400)
  const notLive = await activityCall('?session=nope')
  const notLiveBody = await notLive.json()
  check('terminal: activity names an unopened conversation', notLive.status === 200 && notLiveBody.ok === false && notLiveBody.reason, 'NOT_LIVE')
  const broken = await activityCall('?session=session-broken')
  const brokenBody = await broken.json()
  check('terminal: activity reports an unreadable log', broken.status === 200 && brokenBody.reason, 'UNREADABLE')
  // A conversation past the count budget answers with its TAIL: the newest
  // commands are the ones a reader is looking for.
  const bigRes = await activityCall('?session=session-big')
  const bigBody = await bigRes.json()
  check('terminal: activity bounds the answer', bigBody.entries.length, 400)
  check('terminal: activity keeps the newest commands', bigBody.entries[bigBody.entries.length - 1].event.seq, 420)
  check('terminal: activity flags what it left behind', bigBody.hasMore, true)
  // One enormous command is still sent: a byte budget must not leave the panel
  // with nothing to draw at all.
  const hugeRes = await activityCall('?session=session-huge')
  const hugeBody = await hugeRes.json()
  check('terminal: activity keeps an oversized newest command', hugeBody.entries.length, 1)

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

// ------------------------------------------------------------- dsh-diagrams
// One row owns the tools, the per-conversation state file, the artifact cache
// and the routes. DSH_HOME points at a temp folder for this block, so the store
// and the cache are never touched for real; the tool bodies are driven directly
// with a fake exec, which is the same seam the agent loop uses.
const diagramsHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-diagrams-home-'))
const diagramsWorkspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-diagrams-ws-'))
// An export lands on the HOST's Desktop, and the route resolves that folder PER
// REQUEST from USERPROFILE / HOME / XDG. Both are redirected into a temp profile
// here: a check must never write to a real person's Desktop, and this is also
// what proves which folder the answer came from.
const diagramsProfile = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-diagrams-profile-'))
const diagramsDesktop = path.join(diagramsProfile, 'Desktop')
await fsp.mkdir(diagramsDesktop, { recursive: true })
const previousDshHome = process.env.DSH_HOME
// `previousProfile` / `previousHome` are the originals captured by the themes
// block above, which restores them in its own finally - so they are still the
// real values here and are reused rather than redeclared.
process.env.DSH_HOME = diagramsHome
process.env.USERPROFILE = diagramsProfile
delete process.env.HOME
try {
  const diagramsModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-diagrams/lib/index.js')).href)
  const diagRoutes = new Map()
  const diagTools = []
  const diagSessions = { get: (id) => (id === 'session-diagrams' ? { header: { cwd: diagramsWorkspace } } : undefined) }
  diagramsModule.apply({
    get(name) {
      if (name === 'connection') {
        return {
          fetch: {
            register(route) {
              diagRoutes.set(route.path, route)
              return () => {}
            },
          },
        }
      }
      if (name === 'sessions') return diagSessions
      // No skill registry on this stub: the row must activate anyway.
      return undefined
    },
    tools: { register: (tool) => (diagTools.push(tool), () => {}) },
    effect: (fn) => fn(),
    logger: { debug() {}, warn() {} },
  })

  check('diagrams: route set', [...diagRoutes.keys()].sort().join(','), [
    '/api/dsh-diagrams/artifact',
    '/api/dsh-diagrams/diagram',
    '/api/dsh-diagrams/export',
    '/api/dsh-diagrams/health',
    '/api/dsh-diagrams/render-report',
    '/api/dsh-diagrams/state',
    '/api/dsh-diagrams/vendor/mermaid.js',
  ].join(','))
  check(
    'diagrams: tools registered',
    diagTools.map((tool) => tool.name).sort().join(','),
    'diagram_delete,diagram_patch,diagram_publish,diagram_read,diagram_verify,diagram_write',
  )
  check(
    'diagrams: every tool declares a JSON-schema surface',
    diagTools.every(
      (tool) =>
        tool.parameters &&
        tool.parameters.type === 'object' &&
        Object.keys(tool.parameters.properties ?? {}).length > 0 &&
        (tool.parameters.required ?? []).every((key) => Object.hasOwn(tool.parameters.properties, key)) &&
        tool.output &&
        tool.output.schema &&
        typeof tool.output.render === 'function' &&
        typeof tool.execute === 'function',
    ),
  )
  // The Connection registry takes GET/HEAD/POST only, and every write must be
  // a POST for that reason (not a stylistic choice).
  check(
    'diagrams: methods stay inside the registry vocabulary',
    [...diagRoutes.values()].every((route) => route.methods.every((method) => ['GET', 'HEAD', 'POST'].includes(method))),
  )

  const call = (routePath, request) => diagRoutes.get(routePath).fetch(request)
  const post = (routePath, body) =>
    call(
      routePath,
      new Request('http://x' + routePath, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    )
  const getJson = (routePath, query) => call(routePath, new Request('http://x' + routePath + '?' + query, { method: 'GET' }))
  const tool = (toolName) => diagTools.find((entry) => entry.name === toolName)
  const exec = { agent: { session: { id: 'session-diagrams' } }, signal: new AbortController().signal }

  // --- the vendored engine, and the drift check on the generated tree
  const vendor = await call('/api/dsh-diagrams/vendor/mermaid.js', new Request('http://x/api/dsh-diagrams/vendor/mermaid.js'))
  const vendorBytes = Buffer.from(await vendor.arrayBuffer())
  check('diagrams: serves the vendored engine', vendor.status === 200 && vendorBytes.length > 1000000, true)
  check('diagrams: engine content type', vendor.headers.get('content-type'), 'text/javascript; charset=utf-8')
  const vendorEtag = vendor.headers.get('etag')
  const vendorCached = await call(
    '/api/dsh-diagrams/vendor/mermaid.js',
    new Request('http://x/api/dsh-diagrams/vendor/mermaid.js', { headers: { 'if-none-match': vendorEtag } }),
  )
  check('diagrams: engine is etag-cached', vendorCached.status, 304)
  const { createHash } = await import('node:crypto')
  const recorded = JSON.parse(await fsp.readFile(path.join(repo, 'packages/dsh-diagrams/lib/vendor/VERSION.json'), 'utf8'))
  check(
    'diagrams: vendored engine matches its recorded hash',
    createHash('sha256').update(vendorBytes).digest('hex') === recorded.sha256 && recorded.bytes === vendorBytes.length,
    true,
  )
  check('diagrams: vendored engine is the single-file build', vendorBytes.toString('utf8', -400).includes('globalThis["mermaid"]'), true)

  const health = await getJson('/api/dsh-diagrams/health', '')
  const healthBody = await health.json()
  check('diagrams: health answers', health.status === 200 && healthBody.ok === true)
  check('diagrams: health names the vendored mermaid', healthBody.mermaid.version, recorded.version)
  check('diagrams: health reports the TeX capability', typeof healthBody.tex.available, 'boolean')

  // --- model writes: mermaid (validated through the vendored engine)
  const goodMermaid = await tool('diagram_write').execute(
    { kind: 'mermaid', title: 'Auth flow', source: 'flowchart TD\n  A[Client] --> B{OK?}\n  B -->|yes| C[Home]' },
    exec,
  )
  check('diagrams: mermaid write validates', goodMermaid.view.status, 'ok')
  check('diagrams: write names the parse type', goodMermaid.view.diagramType, 'flowchart-v2')
  check('diagrams: write hands back a tab address', goodMermaid.view.address, 'dsh-resource://diagram/session/session-diagrams/auth-flow')
  const badMermaid = await tool('diagram_write').execute({ kind: 'mermaid', id: 'broken', source: 'flowchart TD\n  A[Start --> B{{{' }, exec)
  check('diagrams: a broken mermaid is reported', badMermaid.view.status, 'error')
  check('diagrams: the parse error travels to the model', badMermaid.diagnostics.length > 0 && /Parse error|Expecting/.test(badMermaid.diagnostics[0].text), true)
  // The DOM stub has to expose `window.CSS`: without it the engine's
  // sequence-diagram box parser takes a `new Option()` fallback that does not
  // exist in a stub, and EVERY `box` diagram came back "unavailable" - stored
  // but never checked, with a real browser as the only judge of the source.
  const boxed = await tool('diagram_write').execute(
    {
      kind: 'mermaid',
      id: 'boxed',
      title: 'Boxed',
      source: 'sequenceDiagram\n  box rgb(240,240,255) Team\n    participant A as Alice\n  end\n  A->>A: solo',
    },
    exec,
  )
  check('diagrams: a boxed sequence diagram validates', boxed.view.status, 'ok')
  check('diagrams: the boxed diagram is a sequence', boxed.view.diagramType, 'sequence')

  const read = await tool('diagram_read').execute({ id: 'auth-flow' }, exec)
  check('diagrams: read returns the source', read.text.includes('flowchart TD') && read.text.includes('Auth flow'), true)
  const list = await tool('diagram_read').execute({}, exec)
  check('diagrams: read lists both diagrams', list.text.includes('auth-flow') && list.text.includes('broken'), true)

  // --- advisory linting: the parser's verdict is unchanged by a warning
  const warned = await tool('diagram_write').execute(
    {
      kind: 'mermaid',
      title: 'Node soup',
      source: 'flowchart LR\n  A[One]\n  B[Two]\n  C[Three]\n  D[Four]\n  E[Five]\n  F[Six]\n  G[Seven]\n  H[Eight]\n  I[Nine]',
    },
    exec,
  )
  check('diagrams: a warning never changes the verdict', warned.view.status, 'ok')
  check('diagrams: an unconnected picture is warned about', (warned.view.warnings ?? []).some((entry) => entry.kind === 'shape'), true)
  check('diagrams: warnings reach the model', /Advisory/.test(warned.text) && /no edges/.test(warned.text), true)
  check('diagrams: warnings travel in the view too', (warned.view.warnings ?? []).length > 0, true)
  const quiet = await tool('diagram_write').execute({ kind: 'mermaid', id: 'warned-one', title: 'Quiet', source: 'flowchart TD\n  A[Client] --> B[API]' }, exec)
  check('diagrams: a clean diagram carries no warnings', (quiet.view.warnings ?? []).length, 0)

  // --- an empty source is refused in words the model can act on, not by the engine
  const blank = await tool('diagram_write').execute({ kind: 'mermaid', id: 'blank-one', title: 'Blank', source: '   \n\n' }, exec)
  check('diagrams: an empty source is an error', blank.view.status, 'error')
  check('diagrams: the empty source is explained', /source is empty/i.test(blank.diagnostics[0].text), true)
  const blankTikz = await tool('diagram_write').execute({ kind: 'tikz', id: 'blank-tikz', title: 'Blank TikZ', source: '\\documentclass{article}\\begin{document}hello\\end{document}' }, exec)
  check('diagrams: a TikZ document with no picture is refused', blankTikz.view.status, 'error')
  check('diagrams: the empty TikZ is explained', /no picture in this source/i.test(blankTikz.diagnostics[0].text), true)

  // --- diagram_verify: re-validates, writes nothing, and does not bump the revision
  const patched = await tool('diagram_patch').execute({ id: 'auth-flow', oldString: 'B{OK?}', newString: 'B{Credentials?}' }, exec)
  check('diagrams: patch reports the occurrence count', patched.occurrences, 1)
  check('diagrams: patch kept the diagram valid', patched.view.status, 'ok')
  const ambiguous = await tool('diagram_patch')
    .execute({ id: 'auth-flow', oldString: 'o', newString: '0' }, exec)
    .then(() => 'no error')
    .catch((err) => err.code)
  check('diagrams: an ambiguous patch is refused', ambiguous, 'AMBIGUOUS')

  const beforeVerify = await tool('diagram_read').execute({ id: 'auth-flow', includeSource: false }, exec)
  check('diagrams: a fresh diagram has no browser report yet', beforeVerify.verification.state, 'pending')
  const revisionBefore = (await (await getJson('/api/dsh-diagrams/state', 'session=session-diagrams')).json()).diagrams.find(
    (entry) => entry.id === 'auth-flow',
  ).revision
  const verified = await tool('diagram_verify').execute({ id: 'auth-flow' }, exec)
  check('diagrams: verify re-checks the diagram', verified.status, 'ok')
  const stateAfterVerify = await (await getJson('/api/dsh-diagrams/state', 'session=session-diagrams')).json()
  check(
    'diagrams: verify left the revision alone',
    stateAfterVerify.diagrams.find((entry) => entry.id === 'auth-flow').revision,
    revisionBefore,
  )
  const missingVerify = await tool('diagram_verify').execute({ id: 'nope' }, exec)
  check('diagrams: verify says so when the diagram is gone', missingVerify.status, 'missing')

  // --- the browser render report: the one question the host cannot answer alone
  const report = await (
    await post('/api/dsh-diagrams/render-report', {
      session: 'session-diagrams',
      id: 'auth-flow',
      revision: revisionBefore,
      kind: 'mermaid',
      ok: true,
      theme: 'default',
      ms: 42,
    })
  ).json()
  check('diagrams: a render report is stored', report.stored, true)
  const afterReport = await tool('diagram_read').execute({ id: 'auth-flow', includeSource: false }, exec)
  check('diagrams: the browser verdict reaches diagram_read', afterReport.verification.state, 'drawn')
  check('diagrams: the model is told the browser drew it', /Browser: DREW/.test(afterReport.text), true)
  const failedReport = await (
    await post('/api/dsh-diagrams/render-report', {
      session: 'session-diagrams',
      id: 'auth-flow',
      revision: revisionBefore,
      kind: 'mermaid',
      ok: false,
      phase: 'render',
      error: 'the engine produced an empty picture',
    })
  ).json()
  check('diagrams: a failed render is stored too', failedReport.stored, true)
  const afterFailure = await tool('diagram_read').execute({ id: 'auth-flow', includeSource: false }, exec)
  check('diagrams: a failed render reads as failed', afterFailure.verification.state, 'failed')
  // A write invalidates the report: the picture was of the PREVIOUS source.
  await tool('diagram_patch').execute({ id: 'auth-flow', oldString: 'C[Home]', newString: 'C[Dashboard]', note: 'rename' }, exec)
  const afterRewrite = await tool('diagram_read').execute({ id: 'auth-flow', includeSource: false }, exec)
  check('diagrams: a rewrite invalidates the browser report', afterRewrite.verification.state, 'pending')
  // ...but a report about the OLD revision is still the truth about that revision.
  await post('/api/dsh-diagrams/render-report', { session: 'session-diagrams', id: 'auth-flow', revision: revisionBefore, ok: true })
  check(
    'diagrams: a report about an older revision reads as stale',
    (await tool('diagram_read').execute({ id: 'auth-flow', includeSource: false }, exec)).verification.state,
    'stale',
  )
  check(
    'diagrams: a report about a deleted diagram is accepted, not an error',
    (await post('/api/dsh-diagrams/render-report', { session: 'session-diagrams', id: 'gone', ok: true })).status,
    200,
  )
  check(
    'diagrams: a report without an id is refused',
    (await post('/api/dsh-diagrams/render-report', { session: 'session-diagrams', ok: true })).status,
    400,
  )

  // --- the browser verdict as a pure function: four honest answers, and a
  // report about an OLDER revision is never read as this revision's picture.
  const { DiagramStore, verificationOf, MAX_SOURCE_BYTES, MAX_STATE_BYTES } = await import(
    pathToFileURL(path.join(repo, 'packages/dsh-diagrams/lib/store.js')).href
  )
  const drawnState = verificationOf({ revision: 3, render: { revision: 3, ok: true, kind: 'mermaid', at: 'T', theme: 'dark', error: null } })
  check('diagrams: a report about this revision reads drawn', drawnState.state + ':' + drawnState.revision + ':' + drawnState.reported, 'drawn:3:3')
  const failedState = verificationOf({ revision: 3, render: { revision: 3, ok: false, kind: 'mermaid', error: 'boom' } })
  check('diagrams: a failed report reads failed, with its error', failedState.state + ':' + failedState.error, 'failed:boom')
  const staleState = verificationOf({ revision: 4, render: { revision: 3, ok: true, kind: 'mermaid' } })
  check('diagrams: a report about an older revision reads stale', staleState.state + ':' + staleState.revision + ':' + staleState.reported, 'stale:4:3')
  const pendingState = verificationOf({ revision: 4, render: null })
  check('diagrams: no report at all reads pending', pendingState.state + ':' + pendingState.revision, 'pending:4')
  // The registry refuses a tool output that does not survive a JSON round trip,
  // and a property whose value is `undefined` is dropped by `JSON.stringify`.
  // Comparing the KEYS (not the serialization) is what catches it: a report that
  // carried `error: null` used to become `undefined` on a DRAWN verdict, and
  // every diagram the browser had rendered came back "value is not lossless
  // JSON" - unreadable to the model.
  const lossless = (value) => {
    const keys = Object.keys(value)
    const round = JSON.parse(JSON.stringify(value))
    return keys.length === Object.keys(round).length && keys.every((key) => round[key] === value[key])
  }
  check(
    'diagrams: every verdict survives a JSON round trip',
    [drawnState, failedState, staleState, pendingState].every(lossless),
  )

  // --- hardening: one diagram's ceiling, and the conversation's source budget,
  // which binds BEFORE the state-file cap. It used to be possible to fill a
  // conversation past that cap, and the store then read the file as empty -
  // every diagram in the conversation vanishing at once.
  const budgetStore = new DiagramStore({ root: path.join(diagramsHome, 'budget-state') })
  const tooBig = (() => {
    try {
      budgetStore.write('session-budget', { kind: 'mermaid', id: 'huge', source: 'x'.repeat(MAX_SOURCE_BYTES + 1), by: 'model' })
      return 'written'
    } catch (err) {
      return err.code
    }
  })()
  check('diagrams: one diagram keeps its own ceiling', tooBig, 'TOO_LARGE')
  const perDiagram = 200 * 1024
  const filler = 'flowchart TD\n' + 'A --> B\n'.repeat(Math.ceil(perDiagram / 8)).slice(0, perDiagram)
  let written = 0
  let refusal = null
  for (let index = 0; index < 40 && refusal === null; index += 1) {
    try {
      budgetStore.write('session-budget', { kind: 'mermaid', id: 'big-' + index, source: filler, by: 'model' })
      written += 1
    } catch (err) {
      refusal = err.code
    }
  }
  check('diagrams: the conversation source budget is enforced', refusal, 'BUDGET')
  check('diagrams: the budget admits a real conversation first', written >= 15, true)
  check('diagrams: the budget binds before the state-file cap', written * perDiagram < MAX_STATE_BYTES, true)
  const replaced = (() => {
    try {
      budgetStore.write('session-budget', { kind: 'mermaid', id: 'big-0', source: filler, by: 'model' })
      return 'ok'
    } catch (err) {
      return err.code
    }
  })()
  check('diagrams: replacing a diagram is charged once, not twice', replaced, 'ok')

  // --- hardening: a cache hit keeps the verdict the compile was cached WITH.
  // A failed compile that still produced a picture is cached deliberately (the
  // partial picture is evidence), and reading that back as "ok" was the plugin
  // telling the model its own diagram was fine.
  const stubStore = new DiagramStore({ root: path.join(diagramsHome, 'stub-state') })
  const stubLibrary = new DiagramStore({ root: path.join(diagramsHome, 'stub-state'), fixedFile: 'library.json' })
  const stubTools = diagramsModule.buildTools({
    store: stubStore,
    library: stubLibrary,
    storeFor: (scopeKey) => (scopeKey === 'library' ? stubLibrary : stubStore),
    cache: {
      keyFor: () => 'a'.repeat(24),
      meta: () => ({
        kind: 'tikz',
        engine: 'stub',
        pages: 1,
        width: 20,
        height: 20,
        formats: ['pdf'],
        at: 'now',
        diagnostics: [{ kind: 'compile', text: 'diagram.tex:3: Package pgf Error: stubbed' }],
      }),
      write: () => ({ formats: ['pdf'], at: 'now' }),
      read: () => null,
      drop: () => {},
    },
    enginesNow: () => ({ available: true, engine: 'stub', svg: 'stub', png: 'stub' }),
  })
  stubStore.write('session-cached', { kind: 'tikz', id: 'cached-failure', source: '\\draw (0,0) -- (1,1);', by: 'model' })
  const cachedVerdict = await stubTools
    .find((entry) => entry.name === 'diagram_verify')
    .execute({ id: 'cached-failure' }, { agent: { session: { id: 'session-cached' } }, signal: new AbortController().signal })
  check('diagrams: a cache hit keeps the verdict it was cached with', cachedVerdict.status, 'error')
  check('diagrams: the cached diagnostics still reach the model', /stubbed/.test(cachedVerdict.text), true)

  // --- THE LIBRARY. One store for the whole harness, which is what makes an id
  // citable from a conversation that never saw it written - and what makes a
  // diagram outlive the chat it was drawn in. `session-elsewhere` stands in for
  // "another chat" everywhere below.
  const otherExec = { agent: { session: { id: 'session-elsewhere' } }, signal: new AbortController().signal }
  const sharedWrite = await tool('diagram_write').execute(
    { kind: 'mermaid', id: 'jepa-model', title: 'JEPA model', scope: 'library', source: 'flowchart TD\n  A[Context x] --> B[Encoder]' },
    exec,
  )
  check('diagrams: a library write lands in the library', sharedWrite.view.scope, 'library')
  check('diagrams: the library address names no conversation', sharedWrite.view.address, 'dsh-resource://diagram/library/jepa-model')
  const fromElsewhere = await tool('diagram_read').execute({ id: 'jepa-model' }, otherExec)
  check('diagrams: another conversation reads a library id alone', /in the shared library/.test(fromElsewhere.text) && /flowchart TD/.test(fromElsewhere.text), true)
  check('diagrams: the reading conversation resolved the library', fromElsewhere.scope, 'library')
  check('diagrams: the library is ONE file at the store root', existsSync(path.join(diagramsHome, 'dsh-diagrams', 'library.json')), true)

  const published = await tool('diagram_publish').execute({ id: 'auth-flow' }, exec)
  check('diagrams: publishing copies into the library', published.view.scope + ':' + published.address, 'library:dsh-resource://diagram/library/auth-flow')
  const readPublished = await tool('diagram_read').execute({ id: 'auth-flow', includeSource: false }, otherExec)
  check('diagrams: the published diagram reaches another chat', readPublished.scope + ':' + readPublished.status, 'library:ok')
  const missingPublish = await tool('diagram_publish').execute({ id: 'nothing-here' }, exec)
  check('diagrams: publishing what is not there says so', /nothing to publish/.test(missingPublish.text), true)

  // The library WINS over a conversation id of the same name: "read X" has to
  // mean the shared diagram, or a citation would resolve differently per chat.
  await tool('diagram_write').execute({ kind: 'mermaid', id: 'shadow', title: 'local shadow', source: 'flowchart TD\n  L[local] --> M[local]' }, exec)
  await tool('diagram_write').execute({ kind: 'mermaid', id: 'shadow', title: 'library shadow', scope: 'library', source: 'flowchart TD\n  S[shared] --> T[shared]' }, exec)
  check('diagrams: a bare id resolves to the library first', (await tool('diagram_read').execute({ id: 'shadow', includeSource: false }, exec)).scope, 'library')
  check(
    'diagrams: an explicit scope reaches the conversation copy',
    (await tool('diagram_read').execute({ id: 'shadow', scope: 'conversation', includeSource: false }, exec)).scope,
    'conversation',
  )
  await tool('diagram_write').execute({ kind: 'mermaid', id: 'local-only', title: 'Local only', source: 'flowchart TD\n  P[private] --> Q[private]' }, exec)
  const elsewhereLocal = await tool('diagram_read').execute({ id: 'local-only', scope: 'conversation' }, otherExec)
  check('diagrams: a conversation diagram is invisible elsewhere', /No diagram "local-only"/.test(elsewhereLocal.text), true)
  check(
    'diagrams: this conversation still sees its own diagram',
    (await tool('diagram_read').execute({ id: 'local-only', scope: 'conversation', includeSource: false }, exec)).scope,
    'conversation',
  )
  check(
    'diagrams: the library is patched by id from another chat',
    (await tool('diagram_patch').execute({ id: 'jepa-model', oldString: 'Context x', newString: 'Context $x$' }, otherExec)).view.scope,
    'library',
  )

  // --- the routes carry the library too: the client shows it in every
  // conversation without a second store.
  const stateHere = await (await getJson('/api/dsh-diagrams/state', 'session=session-diagrams')).json()
  const stateElsewhere = await (await getJson('/api/dsh-diagrams/state', 'session=session-elsewhere')).json()
  check('diagrams: state carries the library', stateHere.library.some((entry) => entry.id === 'jepa-model'), true)
  check('diagrams: library summaries name their scope', stateHere.library.every((entry) => entry.scope === 'library'), true)
  check('diagrams: the library is the same in every conversation', stateElsewhere.library.length, stateHere.library.length)
  check('diagrams: another conversation has no diagrams of its own', stateElsewhere.diagrams.length, 0)
  const oneShared = await (await getJson('/api/dsh-diagrams/diagram', 'session=session-elsewhere&id=jepa-model&scope=library')).json()
  check('diagrams: one library diagram is readable by scope', oneShared.diagram.scope + ':' + oneShared.diagram.address, 'library:dsh-resource://diagram/library/jepa-model')
  const elsewhereReport = await (
    await post('/api/dsh-diagrams/render-report', { session: 'session-elsewhere', id: 'jepa-model', scope: 'library', revision: 1, kind: 'mermaid', ok: true })
  ).json()
  check('diagrams: a render report lands on the library copy', elsewhereReport.stored + ':' + elsewhereReport.scope, 'true:library')
  const droppedShared = await (await post('/api/dsh-diagrams/diagram', { session: 'session-diagrams', id: 'shadow', scope: 'library', delete: true })).json()
  check('diagrams: the library copy can be deleted by scope', droppedShared.deleted, true)

  // --- the state file is the source of truth for the panels
  const state = await (await getJson('/api/dsh-diagrams/state', 'session=session-diagrams')).json()
  check(
    'diagrams: state lists the conversation',
    state.diagrams.slice(0, 2).map((entry) => entry.id).join(','),
    'auth-flow,broken',
  )
  const stored = JSON.parse(await fsp.readFile(path.join(diagramsHome, 'dsh-diagrams', 'sessions', (await fsp.readdir(path.join(diagramsHome, 'dsh-diagrams', 'sessions')))[0]), 'utf8'))
  check('diagrams: state is one file per conversation', stored.sessionId, 'session-diagrams')
  // The browser half has no other copy of the source: the state route has to
  // carry it, or every diagram tab and card renders from `undefined`. It needs
  // the revision too, or it cannot tell a current picture from a stale one.
  check(
    'diagrams: state carries the source the browser renders',
    state.diagrams.find((entry) => entry.id === 'auth-flow').source.includes('flowchart'),
    true,
  )
  check(
    'diagrams: state carries the revision the browser draws',
    Number.isInteger(state.diagrams.find((entry) => entry.id === 'auth-flow').revision),
    true,
  )
  // The tab pill must not have to recompute the verdict: the state route carries
  // the same four-state answer the tool result does.
  check(
    'diagrams: state carries the browser verdict for the pill',
    typeof state.diagrams.find((entry) => entry.id === 'auth-flow').verification?.state,
    'string',
  )

  const one = await (await getJson('/api/dsh-diagrams/diagram', 'session=session-diagrams&id=auth-flow')).json()
  check('diagrams: one diagram carries its source', one.diagram.source.includes('Credentials?'), true)
  const missing = await getJson('/api/dsh-diagrams/diagram', 'session=session-diagrams&id=nope')
  check('diagrams: an unknown diagram is a 404', missing.status, 404)

  // --- the panel's own edit path (POST, never PUT)
  const edited = await (
    await post('/api/dsh-diagrams/diagram', {
      session: 'session-diagrams',
      id: 'auth-flow',
      source: 'flowchart LR\n  A[Client] --> B[API]',
    })
  ).json()
  check('diagrams: the panel edit is validated too', edited.status, 'ok')
  check('diagrams: the panel edit is marked as the user\'s', edited.diagram.by, 'user')
  const created = await (await post('/api/dsh-diagrams/diagram', { session: 'session-diagrams', kind: 'mermaid', title: 'New one', source: 'pie title P\n "a" : 1', create: true })).json()
  check('diagrams: the panel can create a diagram', created.diagram.status, 'ok')
  const deleted = await (await post('/api/dsh-diagrams/diagram', { session: 'session-diagrams', id: 'broken', delete: true })).json()
  check('diagrams: the panel can delete a diagram', deleted.deleted, true)

  // --- artifacts: mermaid has none (the browser draws it), TikZ does
  const noArtifact = await getJson('/api/dsh-diagrams/artifact', 'session=session-diagrams&id=auth-flow&format=svg')
  check('diagrams: mermaid has no host artifact', noArtifact.status, 404)
  const sourceArtifact = await getJson('/api/dsh-diagrams/artifact', 'session=session-diagrams&id=auth-flow&format=mmd')
  check('diagrams: mermaid source is servable', (await sourceArtifact.text()).startsWith('flowchart LR'), true)

  // --- export saves to the HOST's Desktop (never the conversation folder),
  // create-exclusively, and answers with the absolute path it wrote.
  const export1 = await (await post('/api/dsh-diagrams/export', { session: 'session-diagrams', id: 'auth-flow', format: 'mmd' })).json()
  const export2 = await (await post('/api/dsh-diagrams/export', { session: 'session-diagrams', id: 'auth-flow', format: 'mmd' })).json()
  check(
    'diagrams: export lands on the Desktop',
    export1.ok === true && existsSync(export1.path) && path.dirname(export1.path) === diagramsDesktop,
  )
  check(
    'diagrams: the export answers with an absolute path',
    path.isAbsolute(export1.path) && export1.name === path.basename(export1.path) && export1.format === 'mmd',
  )
  check('diagrams: the export names the Desktop', export1.directory, diagramsDesktop)
  check('diagrams: a second export never clobbers the first', export2.path !== export1.path && existsSync(export1.path))
  check('diagrams: export leaves the conversation folder alone', readdirSync(diagramsWorkspace).length, 0)
  check(
    'diagrams: export refuses an unknown format',
    (await post('/api/dsh-diagrams/export', { session: 'session-diagrams', id: 'auth-flow', format: 'exe' })).status,
    400,
  )

  // --- TikZ: compiled when the host has an engine, stored either way
  const tikz = await tool('diagram_write').execute(
    { kind: 'tikz', title: 'Layers', source: '\\node[draw,rounded corners,fill=blue!8] (a) {Client};\n\\node[draw,right=of a] (b) {API};\n\\draw[-{Latex[length=2mm]}] (a) -- (b);' },
    exec,
  )
  if (healthBody.tex.available === true) {
    check('diagrams: tikz compiles', tikz.view.status, 'ok')
    check('diagrams: tikz compiles to an artifact', (await getJson('/api/dsh-diagrams/artifact', 'session=session-diagrams&id=layers&format=svg')).status, 200)
    // A bare pgfplots body used to come back "Environment axis undefined": at the
    // top level of a `standalone` document that environment is not usable, so the
    // host now wraps it in a tikzpicture like any other bare body.
    const chart = await tool('diagram_write').execute(
      {
        kind: 'tikz',
        id: 'chart',
        title: 'Chart',
        source: '\\begin{axis}[width=6cm, height=4cm]\n  \\addplot[domain=0:4, samples=20] {x^2};\n\\end{axis}',
      },
      exec,
    )
    check('diagrams: a bare axis chart compiles', chart.view.status, 'ok')
    const pdf = await getJson('/api/dsh-diagrams/artifact', 'session=session-diagrams&id=layers&format=pdf')
    check('diagrams: the PDF artifact is cached too', pdf.headers.get('content-type'), 'application/pdf')
    const exported = await (await post('/api/dsh-diagrams/export', { session: 'session-diagrams', id: 'layers', format: 'svg' })).json()
    check('diagrams: a compiled diagram exports its SVG', exported.ok === true && path.dirname(exported.path) === diagramsDesktop && existsSync(exported.path))
    // A compile error is reported against the wrapped document.
    const badTikz = await tool('diagram_write').execute({ kind: 'tikz', id: 'bad-tikz', source: '\\draw (a) -- (nowhere);' }, exec)
    check('diagrams: a broken tikz is reported', badTikz.view.status, 'error')
    check('diagrams: the compiler line reaches the model', /diagram\.tex:\d+|Package pgf Error/.test(badTikz.diagnostics.map((entry) => entry.text).join('\n')), true)
  } else {
    console.log('skip diagrams tikz compile          (no TeX engine on this host)')
    check('diagrams: tikz is stored without an engine', tikz.view.status, 'unavailable')
  }

  const removed = await tool('diagram_delete').execute({ id: 'layers' }, exec)
  check('diagrams: delete removes the diagram', removed.deleted, true)
  const afterDelete = await (await getJson('/api/dsh-diagrams/state', 'session=session-diagrams')).json()
  check('diagrams: the state no longer lists it', afterDelete.diagrams.some((entry) => entry.id === 'layers'), false)

  // --- every returned value must satisfy the schema the tool DECLARES and
  // survive a JSON round trip: the registry enforces both, and nothing else in
  // this file would notice a value it refuses. That gap let `reported: null`
  // against `type: "integer"` ship, which made every fresh write fail in front
  // of the model with "must be an integer".
  const shapeProblems = [
    ['diagram_write', goodMermaid],
    ['diagram_patch', patched],
    ['diagram_read', read],
    ['diagram_verify', verified],
    ['diagram_publish', published],
    ['diagram_delete', removed],
  ].flatMap(([name, value]) => [...schemaErrors(tool(name).output.schema, value, name), ...losslessErrors(value, name)])
  check('diagrams: tool results match their declared schema', shapeProblems.length === 0 ? 'ok' : shapeProblems.join(' | '), 'ok')

  // --- the child validator itself: a parse error is a verdict, not a crash
  const { spawnSync } = await import('node:child_process')
  const child = spawnSync(
    process.execPath,
    [path.join(repo, 'packages/dsh-diagrams/lib/mermaid-check.mjs'), '-'],
    { input: 'flowchart TD\n  A[Start --> B{{{', encoding: 'utf8' },
  )
  const verdict = JSON.parse(child.stdout.trim().split('\n').pop())
  check('diagrams: the validator exits cleanly', child.status, 0)
  check('diagrams: the validator calls a broken diagram a parse error', verdict.reason, 'parse')
} finally {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  if (previousProfile === undefined) delete process.env.USERPROFILE
  else process.env.USERPROFILE = previousProfile
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  await fsp.rm(diagramsHome, { recursive: true, force: true })
  await fsp.rm(diagramsWorkspace, { recursive: true, force: true })
  await fsp.rm(diagramsProfile, { recursive: true, force: true })
}

// ------------------------------------------------------------ dsh-ui-state
// The pack's durable UI state has no route to capture: its whole host surface is
// ONE settings registration plus the page-zoom bootstrap row, so this block
// drives `apply` against a stub and reads what it registered. Two things are
// load-bearing and pinned here - the schema really resolves the defaults the
// browser half's DEFAULTS mirror (drift between the two is what would make a
// fresh install read a field nobody set), and a value the schema accepts is the
// only thing that can reach the inlined boot script.
const uiStateModule = await import(pathToFileURL(path.join(repo, 'packages/dsh-ui-state/lib/index.js')).href)
const uiStateNamespaces = []
const uiStateInjected = []
const uiStateIndexHandlers = []
let uiStateSection
uiStateModule.apply({
  logger: { debug() {}, warn() {} },
  get: (name) => (name === 'settings' ? { get: (ns) => (ns === 'vn-harness' ? uiStateSection : undefined) } : undefined),
  inject: (deps, callback) => {
    uiStateInjected.push(deps.join(','))
    callback({ settings: { register: (ns, schema) => uiStateNamespaces.push({ ns, schema }) } })
  },
  on: (event, handler) => {
    if (event === 'webserver/index-inject') uiStateIndexHandlers.push(handler)
  },
})
check('ui-state: registers exactly one namespace', uiStateNamespaces.map((entry) => entry.ns).join(','), 'vn-harness')
check('ui-state: asks for the optional settings service', uiStateInjected.join(','), 'settings')
const uiStateSchema = uiStateNamespaces[0].schema
check(
  'ui-state: the schema resolves the documented defaults',
  JSON.stringify(uiStateSchema({})),
  JSON.stringify({ theme: '', pageZoom: 100, dockHeight: 280, sidebarWidth: -1, rightbarWidth: -1 }),
)
check('ui-state: no field remembers the dock being open', Object.hasOwn(uiStateSchema({}), 'dockOpen'), false)
check('ui-state: an extension theme id is kept', uiStateSchema({ theme: 'nord' }).theme, 'nord')
let zoomRefusal = 'accepted'
try {
  uiStateSchema({ pageZoom: 900 })
} catch (err) {
  zoomRefusal = 'refused'
}
check('ui-state: a zoom outside the ladder is refused', zoomRefusal, 'refused')
let heightRefusal = 'accepted'
try {
  uiStateSchema({ dockHeight: 4 })
} catch (err) {
  heightRefusal = 'refused'
}
check('ui-state: an unusable dock height is refused', heightRefusal, 'refused')
// The bootstrap row: silent at the resting level (a page nobody has zoomed keeps
// the markup the harness shipped), the remembered level otherwise.
const bootRows = (section) => {
  uiStateSection = section
  const table = []
  for (const handler of uiStateIndexHandlers) handler(table)
  return table
}
check('ui-state: the boot row is silent at the resting level', bootRows({ pageZoom: 100 }).length, 0)
const booted = bootRows({ pageZoom: 125 })
check('ui-state: the boot row carries the remembered level', booted.length === 1 && booted[0].kind === 'script' && booted[0].placement === 'body', true)
check('ui-state: the boot row sets the zoom and its seam marker', booted[0].text.includes("style.zoom = String(level) + '%'") && booted[0].text.includes('data-dsh-page-zoomed'), true)
check('ui-state: the boot row is silent with no settings service', (() => {
  const table = []
  const bare = { logger: { warn() {}, debug() {} }, get: () => undefined, inject: (deps, cb) => cb({ settings: { register: () => {} } }), on: (event, handler) => { if (event === 'webserver/index-inject') handler(table) } }
  uiStateModule.apply(bare)
  return table.length
})(), 0)

// --------------------------------------------------------- the repo manifest
// `.dsh-version.json` is documentation, but it is documentation a PERSON reads
// to know what is installed and at which version, and nothing else keeps it
// honest: the installers discover bundles from the FILESYSTEM (packages/*/
// package.json with `dsh.bundle`) and read only the `dsh` pin out of this file,
// so a bundle whose package.json moved on leaves a stale version and a stale
// description behind with no error anywhere. It had already drifted (dsh-terminal
// sat at alpha.6 through alpha.8, dsh-pdf counted SEVEN routes where the code
// registers TEN). These three checks fail the moment it happens again.
{
  const manifest = JSON.parse(await fsp.readFile(path.join(repo, '.dsh-version.json'), 'utf8'))
  const declared = manifest.packages !== null && typeof manifest.packages === 'object' ? manifest.packages : {}
  const versions = new Map()
  const bundles = []
  for (const entry of readdirSync(path.join(repo, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    let pkg = null
    try {
      pkg = JSON.parse(await fsp.readFile(path.join(repo, 'packages', entry.name, 'package.json'), 'utf8'))
    } catch (err) {
      continue
    }
    versions.set(pkg.name, pkg.version)
    if (pkg.dsh !== undefined && pkg.dsh.bundle !== undefined) bundles.push(pkg.name)
  }
  check(
    'manifest: every bundle is declared',
    bundles.filter((name) => declared[name] === undefined).join(','),
    '',
  )
  check(
    'manifest: every declared version matches package.json',
    Object.entries(declared)
      .filter(([name, entry]) => versions.get(name) !== entry.version)
      .map(([name]) => name)
      .join(','),
    '',
  )
  check(
    'manifest: the dsh pin is present',
    typeof manifest.dsh === 'string' && manifest.dsh !== '' && typeof manifest.vendoredFrom === 'string' && manifest.vendoredFrom !== '',
    true,
  )
}

console.log('')
console.log(failures === 0 ? 'all node-route checks passed' : failures + ' check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
