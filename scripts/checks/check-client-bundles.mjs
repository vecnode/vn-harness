// check-client-bundles.mjs - load the pack's browser bundles the way the shell
// does (module table + factory) and drive them with a REAL React runtime.
//
// Why this exists: the client halves have no build step and no type checker, so
// a typo or a wrong hook call is otherwise only found in the running GUI. This
// harness registers each bundle through its own `window.__ModuleLoader__.load`,
// activates it against a stub cordis context, and renders the resulting React
// trees with the machine's own react-dom (server renderer: hooks that need a
// browser - useEffect, useSyncExternalStore without a server snapshot - are
// skipped, exactly like any server render).
//
// Run:  node scripts/checks/check-client-bundles.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

const repo = path.resolve(fileURLToPath(new URL('../../', import.meta.url)))

/** A React + react-dom pair to render with: the profile's, else any npm cache's. */
function loadReact() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const roots = [path.join(home, 'profiles', 'node_modules')]
  // npm's on-demand cache: the Local/AppData folders on Windows, ~/.npm/_npx
  // on macOS/Linux. Global installs are the other place a pair can live.
  const caches = [process.env.LOCALAPPDATA, process.env.APPDATA]
    .filter(Boolean)
    .map((base) => path.join(base, 'npm-cache', '_npx'))
  caches.push(path.join(os.homedir(), '.npm', '_npx'))
  for (const cache of caches) {
    if (!existsSync(cache)) continue
    for (const entry of readdirSync(cache)) roots.push(path.join(cache, entry, 'node_modules'))
  }
  roots.push('/usr/local/lib/node_modules', '/usr/lib/node_modules')
  for (const root of roots) {
    try {
      const requireFrom = createRequire(path.join(root, 'index.js'))
      const React = requireFrom('react')
      const server = requireFrom('react-dom/server')
      if (typeof server.renderToStaticMarkup === 'function') {
        return { React, jsxRuntime: requireFrom('react/jsx-runtime'), renderToStaticMarkup: server.renderToStaticMarkup }
      }
    } catch (err) {
      /* try the next root */
    }
  }
  throw new Error('no react + react-dom pair found (looked in the profile and the npm caches)')
}

const { React, jsxRuntime, renderToStaticMarkup } = loadReact()
const h = React.createElement
let failures = 0
function check(label, actual, expected) {
  const ok = expected === undefined ? Boolean(actual) : actual === expected
  if (!ok) failures += 1
  console.log((ok ? 'ok   ' : 'FAIL ') + label.padEnd(30) + (expected === undefined ? '' : ' ' + JSON.stringify(actual)))
  return ok
}

/** A DOM stand-in: enough for the style-tag injection and detached elements. */
function fakeDocument() {
  const element = () => ({
    dataset: {},
    style: {},
    children: [],
    textContent: '',
    value: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) {
      this.children.push(child)
      return child
    },
    insertBefore(child) {
      this.children.push(child)
      return child
    },
    remove() {},
    focus() {},
    select() {},
    querySelector: () => null,
    parentNode: null,
  })
  return {
    // Style tags land here, so a check can inspect what a bundle injected.
    head: {
      children: [],
      appendChild(child) {
        this.children.push(child)
        return child
      },
    },
    body: element(),
    // The theme package's own stylesheets; a check fills this in (CSSOM shape).
    styleSheets: [],
    querySelector: () => null,
    createElement: () => element(),
    addEventListener() {},
    removeEventListener() {},
    activeElement: null,
    contains: () => false,
  }
}

/** Capture one module-table bundle's factory and run it. */
function loadBundle(relative, extraRequire) {
  const file = path.join(repo, relative)
  const window = { __ModuleLoader__: {} }
  const document = fakeDocument()
  let entry = null
  window.__ModuleLoader__.load = (value) => {
    entry = value
  }
  new Function('window', 'document', 'console', readFileSync(file, 'utf8'))(window, document, console)
  if (entry === null) throw new Error('bundle did not register with the module loader: ' + relative)
  const require = (name) => {
    if (name === 'react') return React
    if (name === 'react/jsx-runtime') return jsxRuntime
    if (name === 'react-dom/client') return extraRequire.reactDomClient
    // Seeded by the shell in the real app; stubbed here.
    if (name === '@deepseek-ai/dsh-client-store') {
      return {
        createSnapshotStore: (initial) => ({ get: () => initial, set() {}, subscribe: () => () => {} }),
        notifySubscribers() {},
      }
    }
    if (name === '@deepseek-ai/dsh-client-ui-primitives') {
      const Null = () => null
      // Menu renders its anchor (the trigger); Tooltip renders its child. Both
      // are enough for a static render to reach the markup a bundle builds.
      const Anchor = (props) => (props && props.anchor !== undefined ? props.anchor : null)
      const Child = (props) => (props && props.children !== undefined ? props.children : null)
      // MarkdownText renders its text: the editor's rendered-view body draws it.
      const Text = (props) => props.text
      // Modal renders nothing while closed and its title / description / body /
      // footer when open, like the real one (which portals to document.body).
      const Dialog = (props) => {
        if (!props || props.open !== true) return null
        return React.createElement(React.Fragment, null, props.title, props.description, props.children, props.footer)
      }
      // Button renders its children, so a footer's label reaches the markup.
      const Push = (props) => (props && props.children !== undefined ? props.children : null)
      return {
        Menu: Anchor,
        Tooltip: Child,
        MarkdownText: Text,
        Modal: Dialog,
        Button: Push,
        // The toast portals a message anchored to a control; a static render only
        // needs it to exist (it is rendered after an attempt, never at rest).
        Toast: Null,
        IconChevronDownOutline14: Null,
        IconLightOutline16: Null,
        IconDarkOutline16: Null,
        IconFollowsystemOutline16: Null,
        IconDownloadOutline16: Null,
        IconCheckOutline16: Null,
        IconWarningOutline16: Null,
      }
    }
    throw new Error('unexpected require in a client bundle: ' + name)
  }
  return { id: entry.id, exports: entry.factory(require), document }
}

// ---------------------------------------------------------------- dsh-modal
const captured = {}
const modal = loadBundle('packages/dsh-modal/lib/client.js', {
  reactDomClient: {
    createRoot(container) {
      captured.container = container
      return {
        render(element) {
          captured.element = element
        },
        unmount() {},
      }
    },
  },
})
const provided = {}
modal.exports.apply({
  reflect: {
    provide(name, value) {
      provided[name] = value
      return () => {}
    },
  },
  get: () => undefined,
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('modal bundle id', modal.id, 'dsh-modal')
check('modals service provided', typeof provided.modals, 'object')
check('modals api', Object.keys(provided.modals).sort().join(','), 'alert,close,confirm,isOpen,open,prompt')
check('body-level host created', captured.container && captured.container.dataset.dshModalHost !== undefined)
check('idle render is empty', renderToStaticMarkup(captured.element), '')

const modals = provided.modals
const pending = modals.open({
  title: 'Save new file',
  message: 'Saved in the conversation folder.',
  fields: [{ name: 'path', label: 'File name (with extension)', value: 'untitled.txt', hint: 'Example: src/app.ts', required: true }],
  validate: () => '',
  confirmLabel: 'Save',
  busyLabel: 'Saving\u2026',
})
const markup = renderToStaticMarkup(captured.element)
check('dialog renders title', markup.includes('Save new file'))
check('dialog renders field', markup.includes('File name (with extension)') && markup.includes('value="untitled.txt"'))
check('dialog renders buttons', markup.includes('>Save<') && markup.includes('>Cancel<'))
check('dialog is modal', markup.includes('aria-modal="true"'))
modals.close(null)
check('cancel resolves null', await pending, null)
check('closed render is empty', renderToStaticMarkup(captured.element), '')
check('isOpen after close', modals.isOpen(), false)
const promptPromise = modals.prompt({ title: 'Name', label: 'Name', value: 'abc' })
check('prompt opens a dialog', modals.isOpen())
modals.close({ value: 'typed' })
check('prompt resolves the value', await promptPromise, 'typed')
const alertPromise = modals.alert('Done')
const alertMarkup = renderToStaticMarkup(captured.element)
check('alert has one button', alertMarkup.includes('>OK<') && !alertMarkup.includes('>Cancel<'))
modals.close()
await alertPromise

// --------------------------------------------------------------- dsh-editor
const editor = loadBundle('packages/dsh-editor/lib/client.js', {})
// The editor's stylesheet, injected at module scope: the alpha.8 resets of what
// the preview's plain-text scrollport imposes on the rendered Markdown page.
const editorCssTag = editor.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-editor/editor.css').pop()
const editorCss = editorCssTag ? editorCssTag.textContent : ''
check('md paper resets whitespace', editorCss.includes('.dse-mdviewPaper{flex:1;min-height:0;white-space:normal}'))
check('edit pill keeps the app font', editorCss.includes('var(--dsw-font-family,inherit)') && editorCss.includes('.dse-mdviewEdit{'))
check('editor bundle id', editor.id, 'dsh-editor')
check('editor inject', JSON.stringify(editor.exports.inject), '["locale","slots","sidebarRightTabs"]')
const registered = {}
const types = []
const previewCalls = []
const editorLocales = {}
const tabTypes = {
  register(definition) {
    types.push(definition)
    return () => {}
  },
  entries: () => [
    { id: '@deepseek-ai/dsh-client-ui-sidebar-documentpreview', kind: 'renamed-preview' },
    { id: 'dsh-editor', kind: 'editor' },
  ],
}
editor.exports.apply({
  get: (name) =>
    name === 'modals' ? modals : name === 'sidebarRight' ? { openResource: (address, options) => previewCalls.push({ address, options }) } : name === 'sidebarRightTabs' ? tabTypes : undefined,
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      registered[spec.name + (spec.key ? '#' + spec.key : '')] = { spec, component }
      return () => {}
    },
  },
  locale: {
    register(namespace, dictionaries) {
      editorLocales[namespace] = dictionaries
      return () => {}
    },
  },
  sidebarRightTabs: tabTypes,
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('tab type registered', types.length === 1 && types[0].id + '/' + types[0].kind, 'dsh-editor/editor')
check('page title', types[0].title('sidebar://editor'), 'Editor')
check('file title', types[0].title('dsh-resource://file/session/s1/src/app.ts'), 'app.ts')
check('claims a text file', types[0].canOpen('dsh-resource://file/session/s1/src/app.ts'), true)
check('claims markdown', types[0].canOpen('dsh-resource://file/session/s1/readme.md'), true)
check('vetoes html', types[0].canOpen('dsh-resource://file/session/s1/page.html'), false)
check('vetoes absolute', types[0].canOpen('dsh-resource://file/session/s1/C:/x.ts'), false)
check('guide entry', types[0].guide.map((entry) => entry.title()).join(','), 'Editor')
const editorSeats = Object.keys(registered).sort().join(',')
check(
  'editor seats',
  editorSeats,
  'sidebar.right.pane.tab#dsh-editor,sidebar.right.pane.tab.title#dsh-editor,sidebar.right.tab.document#@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown',
)
const facade = registered['sidebar.right.pane.tab#dsh-editor'].spec.inject()
check('body resolves modals lazily', facade.getModals(), modals)
facade.openPreview('dsh-resource://file/session/s1/readme.md', 'tab2')
check('preview names the registry kind', previewCalls[0].options.kind, 'renamed-preview')
check('preview replaces the editor tab', previewCalls[0].options.replaceTab, 'tab2')
check('preview keeps the address', previewCalls[0].address, 'dsh-resource://file/session/s1/readme.md')

// The rendered Markdown body shadows the shipped one (lower priority renders) and
// carries the Edit toggle back into the editor.
const markdownSeat = registered['sidebar.right.tab.document#@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown']
check('shadow body priority', markdownSeat.spec.priority < 0, true)
check('shadow body locale', markdownSeat.spec.locale, 'dsh-editor.markdown')
check('markdown dictionaries', Object.keys(editorLocales).join(','), 'dsh-editor.markdown')
const markdownInjected = markdownSeat.spec.inject()
check('shadow body injects edit', typeof markdownInjected.edit, 'function')
previewCalls.length = 0
markdownInjected.edit('dsh-resource://file/session/s1/readme.md', 'tab7')
check('edit reopens the file in the editor', previewCalls[0].options.kind, 'editor')
check('edit replaces the preview tab', previewCalls[0].options.replaceTab, 'tab7')
const markdownCopy = {
  'md.edit': 'Edit',
  'md.editTitle': 'Edit this file in the editor',
  'md.copy': 'Copy',
  'md.copied': 'Copied',
  'md.footnotes': 'Footnotes',
}
const markdownT = (key) => (markdownCopy[key] === undefined ? key : markdownCopy[key])
const MarkdownPreviewBody = markdownSeat.component
const renderedMarkdown = renderToStaticMarkup(
  h(MarkdownPreviewBody, {
    t: markdownT,
    content: { kind: 'text', text: '# Title', eof: true },
    resourceAddress: 'dsh-resource://file/session/s1/readme.md',
    useTabInfo: () => ({ tab: { id: 'tab7' } }),
    edit: markdownInjected.edit,
  }),
)
check('rendered body draws the page', renderedMarkdown.includes('data-document-markdown') && renderedMarkdown.includes('# Title'))
check('rendered body offers Edit', renderedMarkdown.includes('data-markdown-edit') && renderedMarkdown.includes('>Edit<'))
check('rendered body ignores non-text', renderToStaticMarkup(h(MarkdownPreviewBody, { t: markdownT, content: { kind: 'image' } })), '')
const Body = registered['sidebar.right.pane.tab#dsh-editor'].component
const blankTab = { id: 'tab1', contentId: 'sidebar://editor', title: 'Editor', navigation: { revision: 0 } }
const fileTab = { id: 'tab2', contentId: 'dsh-resource://file/session/s1/src/app.ts', title: 'app.ts', navigation: { revision: 3 } }
check(
  'blank page tab renders',
  renderToStaticMarkup(h(Body, { useTabInfo: () => ({ tab: blankTab }), sessionId: 's1', getModals: () => modals })).includes(
    'data-editor-tab="tab1"',
  ),
)
check(
  'file tab renders',
  renderToStaticMarkup(h(Body, { useTabInfo: () => ({ tab: fileTab }), sessionId: 's1', getModals: () => modals })).includes(
    'data-editor-tab="tab2"',
  ),
)

// A registry without the preview type (a deployment that never mounted it):
// "Preview" still names a kind instead of throwing a bare TypeError.
const editorBare = loadBundle('packages/dsh-editor/lib/client.js', {})
const bareCalls = []
const editorBareSeats = {}
editorBare.exports.apply({
  get: (name) => (name === 'sidebarRight' ? { openResource: (address, options) => bareCalls.push(options) } : undefined),
  slots: {
    inject: (name, fn) => fn(),
    register(spec) {
      editorBareSeats[spec.name + (spec.key ? '#' + spec.key : '')] = { spec }
      return () => {}
    },
  },
  locale: { register: () => () => {} },
  sidebarRightTabs: { register: () => () => {}, entries: () => [] },
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
editorBareSeats['sidebar.right.pane.tab#dsh-editor'].spec.inject().openPreview('dsh-resource://file/session/s1/readme.md', 'tab9')
check('preview falls back to the pinned kind', bareCalls[0].kind, 'text')

// ---------------------------------------------------------- dsh-open-in-app
const openInApp = loadBundle('packages/dsh-open-in-app/lib/client.js', {})
check('open-in-app bundle id', openInApp.id, 'dsh-open-in-app')
const oiaRegistered = {}
openInApp.exports.apply({
  get: () => undefined,
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      oiaRegistered[spec.name] = { spec, component }
      return () => {}
    },
  },
  locale: { register: () => () => {} },
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('open-in-app slot', Object.keys(oiaRegistered).join(','), 'conversation.session.header.utilities')
const launch = oiaRegistered['conversation.session.header.utilities'].spec.inject().launch
const calls = []
globalThis.location = { origin: 'http://127.0.0.1:3099' }
globalThis.fetch = async (url, init) => {
  calls.push({ path: new URL(String(url)).pathname, body: init && init.body })
  return { ok: true, status: 200, json: async () => ({ ok: true }) }
}
await launch('vscode', 'C:/work')
await launch('explorer', 'C:/work')
await launch('gitbash', 'C:/work')
check(
  'file managers take the pack route',
  calls.map((call) => call.path).join(','),
  '/open-in-app/open,/api/dsh-open-in-app/open,/open-in-app/open',
)
check('launch bodies unchanged', calls[1].body, '{"app":"explorer","path":"C:/work"}')

// --------------------------------------------------------------- dsh-themes
const themes = loadBundle('packages/dsh-themes/lib/client.js', {})
check('themes bundle id', themes.id, 'dsh-themes')
check('themes inject', JSON.stringify(themes.exports.inject), '["slots","locale"]')
let themeSnapshot = { preference: 'dark', active: { id: 'dark', colorScheme: 'dark' }, revision: 3 }
const themeWrites = []
const themeService = {
  getTheme: () => themeSnapshot,
  setTheme(id) {
    themeWrites.push(id)
    themeSnapshot = { preference: id, active: { id: 'system', colorScheme: 'light' }, revision: themeSnapshot.revision + 1 }
  },
}
const themeEvents = []
// The package registers THREE occupants of the same list slot (the screenshot
// control, the Themes control and the Session-log download seat), so the
// stand-in keys by slot#id.
const themesSeats = {}
const themeLocales = {}
// A stand-in for the shipped export controller's store - the shape the renderer
// binds a selector Hook from (`getSnapshot` / `subscribe`).
let logEntry = undefined
const logStore = {
  getSnapshot: () => ({ bySession: { s1: logEntry } }),
  subscribe: () => () => {},
}
const downloadCalls = []
const logController = {
  store: logStore,
  download: (sessionId) => downloadCalls.push(sessionId),
  dismiss: () => {},
}
themes.exports.apply({
  get: (name) => (name === 'theme' ? themeService : name === 'sessionLogDownload' ? logController : undefined),
  on: (event, listener) => {
    if (event === 'theme/change') themeEvents.push(listener)
    return () => {}
  },
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      themesSeats[spec.name + '#' + spec.id] = { spec, component }
      return () => {}
    },
  },
  locale: {
    register(namespace, dictionaries) {
      themeLocales[namespace] = dictionaries
      return () => {}
    },
  },
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check(
  'themes header seats',
  Object.keys(themesSeats).join(','),
  'conversation.session.header.utilities#dsh-themes,conversation.session.header.utilities#dsh-themes-screenshot,conversation.session.header.utilities#session-log-download',
)
const themesSpec = themesSeats['conversation.session.header.utilities#dsh-themes'].spec
check('themes seat id', themesSpec.id, 'dsh-themes')
check('themes sits left of Open In', themesSpec.order < -10, true)
check('themes dictionaries', Object.keys(themeLocales).join(','), 'themes')
const themesFacade = themesSpec.inject()
check('themes state is a snapshot source', typeof themesFacade.themeState.getSnapshot, 'function')
check('themes reads the service snapshot', themesFacade.themeState.getSnapshot().preference, 'dark')
const themesCopy = {
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.system': 'System',
  'theme.current': 'Theme: {name}',
  'theme.unavailable': 'The theme service is unavailable',
  'download.title': 'Download session log',
  'download.busy': 'Preparing the session archive',
  'download.unavailable': 'Session export is unavailable',
  'download.preparingTitle': 'Exporting Session',
  'download.preparingDescription': 'Preparing a ZIP containing this Session, its sub-Sessions, and attachments.',
  'download.successTitle': 'Session download started',
  'download.successDescription': 'The browser is downloading the Session ZIP.',
  'download.errorTitle': 'Session export failed',
  'download.close': 'Close',
  'download.commandFailed': 'Could not start the Session export.',
  'screenshot.title': 'Screenshot to the Desktop',
  'screenshot.busy': 'Capturing the window',
  'screenshot.saved': 'Screenshot saved to {path}',
  'screenshot.downloaded': 'Screenshot handed to the browser download',
  'screenshot.failed': 'The screenshot failed',
  'screenshot.unsupported': 'This browser cannot capture the page here (HTTPS or localhost is required)',
  'screenshot.cancelled': 'The screenshot was cancelled',
}
const themesT = (key, vars) => {
  const text = themesCopy[key] === undefined ? key : themesCopy[key]
  return vars ? text.replace(/\{(\w+)\}/g, (match, name) => String(vars[name] === undefined ? '' : vars[name])) : text
}
const ThemesAction = themesSeats['conversation.session.header.utilities#dsh-themes'].component
const themesMarkup = renderToStaticMarkup(h(ThemesAction, { t: themesT, themeState: themesFacade.themeState }))
// The server snapshot is the product default (`system`); the live snapshot the
// button paints in the browser is the service's own ('dark' above).
check('themes button renders', themesMarkup.includes('class="dst-button"') && themesMarkup.includes('aria-haspopup="menu"'))
check('themes button is not disabled', themesMarkup.includes('disabled'), false)
themesFacade.themeState.setTheme('light')
check('themes writes through the service', themeWrites.join(','), 'light')
check('themes adopts the written value', themesFacade.themeState.getSnapshot().preference, 'light')
for (const listener of themeEvents) listener({ preference: 'system', active: { id: 'system', colorScheme: 'dark' }, revision: 9 })
check('themes follows theme/change', themesFacade.themeState.getSnapshot().preference, 'system')
// The dictionaries really carry the download copy (the renders below use the
// registered English dictionary, so this is what the app would show).
check('download copy is registered', themeLocales.themes.en['download.title'], 'Download session log')
check('download dialog copy is registered', themeLocales.themes.en['download.errorTitle'], 'Session export failed')

// ------------------------------------------- the Session-log download seat
// The shipped browser half put a three-dot "more actions" button in this same
// header slot whose only menu item was the download. The package's second
// occupant registers the SHIPPED seat id one priority lower (`lowest renders` in
// a list slot), so the ellipsis stops rendering and one download icon button
// takes the seat; the export itself stays the shipped controller's job.
const downloadSpec = themesSeats['conversation.session.header.utilities#session-log-download'].spec
check('download seat shadows the shipped id', downloadSpec.id, 'session-log-download')
check('download seat renders below the shipped one', downloadSpec.priority < 0, true)
check('download seat keeps the shipped order', downloadSpec.order, 0)
const downloadFacade = downloadSpec.inject()
check('download seat follows the shipped store', downloadFacade.hooks.sessionLogDownload === logStore, true)
check('download seat reached the shipped controller', downloadFacade.available, true)
downloadFacade.request('s1')
check('download seat downloads on request', downloadCalls.join(','), 's1')
const DownloadAction = themesSeats['conversation.session.header.utilities#session-log-download'].component
// A renderer-bound stand-in for the Hook the host builds out of the inject face.
const useLog = (selector) => selector(downloadFacade.hooks.sessionLogDownload.getSnapshot())
const renderSeat = () =>
  renderToStaticMarkup(
    h(DownloadAction, {
      sessionId: 's1',
      t: themesT,
      request: downloadFacade.request,
      dismiss: downloadFacade.dismiss,
      available: true,
      useSessionLogDownload: useLog,
    }),
  )
const seatMarkup = renderSeat()
check(
  'download seat renders one download button',
  seatMarkup.includes('class="dst-button"') &&
    seatMarkup.includes('data-dsh-session-log-download') &&
    seatMarkup.includes('aria-label="Download session log"'),
)
check('download seat renders no ellipsis', seatMarkup.includes('aria-haspopup="menu"'), false)
check('download seat is enabled while idle', seatMarkup.includes('disabled'), false)
check('download seat is not busy while idle', seatMarkup.includes('aria-busy="false"'))
check('download seat draws no dialog while idle', seatMarkup.includes('Exporting Session'), false)
// The state machine is the shipped controller's: `downloading` disables the
// button, and the seat's own dialog describes the state.
logEntry = { open: true, status: 'downloading', error: null }
const busySeat = renderSeat()
check('download seat reports the export in flight', busySeat.includes('aria-busy="true"') && busySeat.includes('disabled'))
check('download seat draws the shipped dialog', busySeat.includes('Exporting Session'))
logEntry = { open: true, status: 'success', error: null }
check('download seat draws the success state', renderSeat().includes('Session download started'))
logEntry = { open: true, status: 'error', error: 'HTTP 500' }
check('download seat draws the error state', renderSeat().includes('HTTP 500'))
logEntry = undefined

// ------------------------------------------------------ the screenshot control
// alpha.10: one more occupant of the same list, one order step LEFT of the
// Themes control. It captures the tab with `getDisplayMedia` and hands the PNG
// to the package's host route (the browser download is the fallback), so the
// static checks here are about the seat, the dress and the copy - the capture
// itself needs a real browser surface.
const shotSpec = themesSeats['conversation.session.header.utilities#dsh-themes-screenshot'].spec
check('screenshot seat id', shotSpec.id, 'dsh-themes-screenshot')
check('screenshot sits left of the theme control', shotSpec.order < themesSpec.order, true)
check('screenshot shares the header locale namespace', shotSpec.locale, 'themes')
const ScreenshotAction = themesSeats['conversation.session.header.utilities#dsh-themes-screenshot'].component
const shotMarkup = renderToStaticMarkup(h(ScreenshotAction, { t: themesT }))
check('screenshot button renders', shotMarkup.includes('class="dst-button"') && shotMarkup.includes('data-dsh-screenshot'))
check('screenshot button is labelled', shotMarkup.includes('aria-label="Screenshot to the Desktop"'))
check('screenshot button is idle at rest', shotMarkup.includes('aria-busy="false"') && shotMarkup.includes('disabled'), false)
check('screenshot button opens no menu', shotMarkup.includes('aria-haspopup="menu"'), false)
check('screenshot button draws no toast at rest', shotMarkup.includes('Screenshot saved'), false)
check('screenshot copy is registered', themeLocales.themes.en['screenshot.title'], 'Screenshot to the Desktop')
check(
  'screenshot copy carries the saved path',
  themeLocales.themes.en['screenshot.saved'].includes('{path}') && themeLocales.themes.zh['screenshot.saved'].includes('{path}'),
)

// A profile that never mounts ui-theme: the control still renders (disabled,
// with its own copy) instead of taking the header down.
const bareSeats = {}
themes.exports.apply({
  get: () => undefined,
  on: () => () => {},
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      bareSeats[spec.name + '#' + spec.id] = { spec, component }
      return () => {}
    },
  },
  locale: { register: () => () => {} },
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
const bareState = bareSeats['conversation.session.header.utilities#dsh-themes'].spec.inject().themeState
const bareMarkup = renderToStaticMarkup(h(bareSeats['conversation.session.header.utilities#dsh-themes'].component, { t: themesT, themeState: bareState }))
check('themes survives a missing service', bareMarkup.includes('disabled') && bareMarkup.includes('aria-haspopup="menu"'))
check('themes reports the missing service', bareMarkup.includes('The theme service is unavailable'))
let refused = false
try {
  bareState.setTheme('dark')
} catch (err) {
  refused = true
}
check('themes refuses to write without the service', refused)
// A profile without the shipped export row: the button says so instead of
// pretending, and the Hook still reads a real (constant) source.
const bareDownload = bareSeats['conversation.session.header.utilities#session-log-download'].spec.inject()
check('download seat reports a missing export service', bareDownload.available, false)
check('download seat survives a missing service', typeof bareDownload.hooks.sessionLogDownload.subscribe, 'function')
let bareThrew = false
try {
  bareDownload.request('s1')
} catch (err) {
  bareThrew = true
}
check('download seat requests nothing without the service', bareThrew, false)
const bareSeatMarkup = renderToStaticMarkup(
  h(bareSeats['conversation.session.header.utilities#session-log-download'].component, {
    sessionId: 's1',
    t: themesT,
    request: bareDownload.request,
    dismiss: bareDownload.dismiss,
    available: false,
    useSessionLogDownload: (selector) => selector(bareDownload.hooks.sessionLogDownload.getSnapshot()),
  }),
)
check('download seat disables the button without the service', bareSeatMarkup.includes('disabled'))
check('download seat says the export is unavailable', bareSeatMarkup.includes('Session export is unavailable'))

// The Markdown paper: it copies ui-theme's own LIGHT declarations onto the
// rendered Markdown root. Fake stylesheets in the shape the CSSOM exposes.
function fakeStyle(pairs) {
  const values = {}
  const style = {
    length: pairs.length,
    getPropertyValue: (name) => (Object.prototype.hasOwnProperty.call(values, name) ? values[name] : ''),
  }
  pairs.forEach(([name, value], index) => {
    values[name] = value
    style[index] = name
  })
  return style
}
themes.document.styleSheets = [
  {
    ownerNode: { dataset: { pluginCss: '@deepseek-ai/dsh-client-ui-theme/design-platform.css' } },
    cssRules: [
      {
        selectorText: 'body',
        style: fakeStyle([
          ['--dsw-static-neutral-bluish-900', '#151517'],
          ['--dsw-alias-label-primary', 'var(--dsw-static-neutral-bluish-900)'],
          ['--dsl-code-block-background', '#f7f7f8'],
        ]),
      },
      { selectorText: 'body[data-ds-dark-theme]', style: fakeStyle([['--dsw-alias-label-primary', '#f5f5f5']]) },
      // An engine that does not enumerate custom properties: text only.
      { selectorText: ':root', cssText: ':root{--shiki-token-keyword:#d6336c;--shiki-token-string:#2f9e44}' },
    ],
  },
  {
    ownerNode: { dataset: { plugin: 'another-plugin' } },
    cssRules: [{ selectorText: 'body', style: fakeStyle([['--dsw-alias-label-primary', '#ff00ff']]) }],
  },
]
themes.exports.apply({
  get: () => undefined,
  on: () => () => {},
  slots: { inject: (name, fn) => fn(), register: () => () => {} },
  locale: { register: () => () => {} },
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
const paperTag = themes.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-themes/markdown-paper.css').pop()
const paper = paperTag ? paperTag.textContent : ''
check('paper rule injected', paper.includes('background:#fff') && paper.includes('data-document-markdown'))
check('paper also paints the scrollport', paper.includes('[data-textpreview-body]:has([data-document-markdown])'))
check('paper copies the light aliases', paper.includes('--dsw-alias-label-primary:var(--dsw-static-neutral-bluish-900)'))
check('paper copies the light statics', paper.includes('--dsw-static-neutral-bluish-900:#151517'))
check('paper copies the light shiki tokens', paper.includes('--shiki-token-keyword:#d6336c'))
check('paper reads a text-only rule too', paper.includes('--shiki-token-string:#2f9e44'))
check('paper copies other light sheets', paper.includes('--dsl-code-block-background:#f7f7f8'))
check('paper skips the dark palette', paper.includes('#f5f5f5'), false)
check('paper skips other plugins', paper.includes('#ff00ff'), false)

// The Markdown chrome override (alpha.3): its own tag, independent of the paper.
const chromeTag = themes.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-themes/markdown-chrome.css').pop()
const chrome = chromeTag ? chromeTag.textContent : ''
check('chrome rule injected', chrome.includes('[data-document-viewer-menu]{display:none}'))
check('chrome scoped to markdown', chrome.includes('body [data-document-preview="@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown"]'))

// The left column's top bar override (alpha.4): its own tag again. The band is
// the sidebar root's 6px top padding plus a 70px row, i.e. the 76px hairline the
// conversation header and the right column's tab header already draw; the rail
// keeps the same 6px so neither the line nor the toggle moves when it collapses.
const topBarTag = themes.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-themes/left-topbar.css').pop()
const topBar = topBarTag ? topBarTag.textContent : ''
check('top bar rule injected', topBar.includes('height:70px'))
check('top bar keeps the 76px line', topBar.includes('padding:4px 12px 35.5px 16px'))
check('top bar bleeds to both edges', topBar.includes('margin:0 -12px'))
check('top bar clears New session', topBar.includes('margin:0 -12px 8px'))
check('top bar draws the header hairline', topBar.includes('border-bottom:.5px solid var(--dsw-alias-border-l3'))
check('top bar pins the rail padding', topBar.includes('.hHd-Xa_root.hHd-Xa_collapsed{padding-top:6px}'))
check('top bar re-dresses the rail row', topBar.includes('.hHd-Xa_root.hHd-Xa_collapsed .hHd-Xa_logoRow{margin:0 -10px 12px;padding:1px 10px 32.5px}'))
check('top bar is engine-neutral', topBar.includes(':has('), false)

// The VN branding on that same row (alpha.6). The mark and the name are SLOTS the
// harness's own brand plugin occupies, so the art is hidden whatever the occupant
// is - wordmark, fish, or the layout's own fallback label - and the replacements
// are drawn on top: a plain black disc at the slot's 24px, and the product text.
check(
  'branding hides whatever occupies the brand slots',
  topBar.includes('.hHd-Xa_brandMark>*,html .hHd-Xa_root .hHd-Xa_brandName>*,html .hHd-Xa_root .hHd-Xa_railMark>*{display:none!important}'),
)
// alpha.8: the mark is the app ICON - `assets/vn-harness.svg` at the pack root -
// inlined as a data URI. The artwork carries a 1px transparent margin inside its
// 24px box, because the mark sits in boxes painted with `overflow:hidden` (the
// sidebar's brand button is exactly 24px tall) where an edge-to-edge circle loses
// a fraction of a pixel on each side, which is what alpha.7's disc looked like.
// The comparison below is against that asset, so the inlined copy cannot drift.
const iconMatch = /background:url\("data:image\/svg\+xml,([^"]+)"\)/.exec(topBar)
const inlinedIcon = iconMatch === null ? '' : decodeURIComponent(iconMatch[1])
const iconGeometry = (svg) => {
  const box = /viewBox="([^"]+)"/.exec(svg)
  const circle = /<circle[^>]*cx="([^"]+)"[^>]*cy="([^"]+)"[^>]*r="([^"]+)"[^>]*fill="([^"]+)"/.exec(svg)
  if (box === null || circle === null) return null
  return { box: box[1], cx: Number(circle[1]), cy: Number(circle[2]), r: Number(circle[3]), fill: circle[4] }
}
const assetIcon = iconGeometry(readFileSync(path.join(repo, 'assets/vn-harness.svg'), 'utf8'))
const shippedIcon = iconGeometry(inlinedIcon)
console.log('     icon inlined from the asset: ' + JSON.stringify(shippedIcon))
check('branding inlines the app icon', shippedIcon !== null)
check('the inlined icon matches assets/vn-harness.svg', JSON.stringify(shippedIcon) === JSON.stringify(assetIcon))
check('the icon is a circle centred in its box', shippedIcon !== null && shippedIcon.cx * 2 === 24 && shippedIcon.cy * 2 === 24)
check('the icon keeps a margin inside its box', shippedIcon !== null && shippedIcon.r < 12)
check('the icon is black', shippedIcon !== null && shippedIcon.fill === '#000000')
check('the mark draws the icon at 24px', topBar.includes('.hHd-Xa_brandMark::before,html .hHd-Xa_root .hHd-Xa_railMark::before{content:"";width:24px;height:24px'))
check('the icon is not stretched', topBar.includes('center/contain no-repeat'))
// The empty conversation's hero ("Into the Unknown") draws the same whale from its
// own single slot, so it gets the same treatment.
check(
  'the hero whale is replaced by the icon',
  topBar.includes('.pXSMma_fishHitbox>*{display:none!important}') && topBar.includes('.pXSMma_fishHitbox::before{content:"";width:26px;height:26px'),
)
check('branding draws the product name', topBar.includes('.hHd-Xa_brandName::before{content:"VN Harness"}'))
// The product text wears the conversation TITLE's type: ui-conversation's current
// crumb is 14px/20px at weight 500, while the shipped brand name is 18px/600 in
// the same 30px strip - they read as different sizes a few pixels apart.
check(
  'branding wears the chat title\'s type',
  topBar.includes('.hHd-Xa_brandName{font-size:14px;font-weight:500;line-height:20px;letter-spacing:0}'),
)
check('branding covers the collapsed rail too', topBar.includes('.hHd-Xa_railMark::before'))

// alpha.9: the header's icon-button RING. The pack's own header buttons draw it
// themselves, so this package's copy is pinned here; the shipped right-bar toggle
// in the header corner cannot (it lives in a GENERATED fork), so one rule keyed
// on the header's stable corner marker gives it the same outline. The marker is
// asserted to be a `data-` attribute rather than the hashed class names the top
// bar above is pinned to on purpose.
const themesCssTag = themes.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-themes/themes.css').pop()
const themesCss = themesCssTag ? themesCssTag.textContent : ''
check(
  'theme button wears the header ring',
  themesCss.includes('.dst-button{width:28px;height:28px;box-sizing:border-box;') &&
    themesCss.includes('border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:28px'),
)
// alpha.10: the captured frame leaves the pack's own controls out of the shot.
// Both selectors matter: the Themes and Screenshot controls carry a `.dst-slot`
// wrapper (and their tooltip bubble with it), the download seat does not.
check(
  'capture rule hides the pack controls',
  themesCss.includes('html[data-dsh-screenshot] .dst-slot,html[data-dsh-screenshot] .dst-button{visibility:hidden}'),
)
const ringTag = themes.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-themes/header-ring.css').pop()
const headerRing = ringTag ? ringTag.textContent : ''
check('header ring rule injected', headerRing.includes('html [data-conversation-header-corner] button{'))
check('header ring uses the same hairline', headerRing.includes('border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3))'))
check('header ring keeps the box 28px', headerRing.includes('border-radius:28px;box-sizing:border-box'))
check('header ring keys on a stable marker', headerRing.includes('_root') === false && headerRing.includes('.P3OORG_') === false)

// --------------------------------------------------------------- dsh-gittree
const gitTree = loadBundle('packages/dsh-gittree/lib/client.js', {})
const gitCssTag = gitTree.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-gittree/gittree.css').pop()
const gitCss = gitCssTag ? gitCssTag.textContent : ''
check('gittree bundle id', gitTree.id, 'dsh-gittree')
check('gittree inject', JSON.stringify(gitTree.exports.inject), '["slots","sidebarRightTabs"]')
check('gittree stylesheet injected', gitCss.includes('.dsg-root{') && gitCss.includes('.dsg-badge[data-st="m"]'))
const gitTypes = []
const gitSeats = {}
const gitTabTypes = { register: (definition) => (gitTypes.push(definition), () => {}), entries: () => [] }
gitTree.exports.apply({
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      gitSeats[spec.name + (spec.key ? '#' + spec.key : '')] = { spec, component }
      return () => {}
    },
  },
  sidebarRightTabs: gitTabTypes,
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('gittree type registered', gitTypes.length === 1 && gitTypes[0].id + '/' + gitTypes[0].kind, 'dsh-gittree/gittree')
// A page type: no `patterns`, so it never competes for a file address.
check('gittree is a page type', gitTypes[0].patterns === undefined)
check('gittree chip title', gitTypes[0].title('sidebar://gittree'), 'History')
check('gittree guide entry', gitTypes[0].guide.map((entry) => entry.order + ':' + entry.title()).join(','), '30:History')
check(
  'gittree seats',
  Object.keys(gitSeats).sort().join(','),
  'sidebar.right.pane.tab#dsh-gittree,sidebar.right.pane.tab.title#dsh-gittree',
)
const GitTreeBody = gitSeats['sidebar.right.pane.tab#dsh-gittree'].component
const gitTab = { id: 'tab9', contentId: 'sidebar://gittree', title: 'History', navigation: { revision: 0 } }
const gitMarkup = renderToStaticMarkup(h(GitTreeBody, { useTabInfo: () => ({ tab: gitTab }), sessionId: 's1' }))
check('gittree body renders', gitMarkup.includes('data-gittree-tab="tab9"') && gitMarkup.includes('data-gittree-state="loading"'))
check(
  'gittree body is history-only',
  gitMarkup.includes('data-gittree-reload') &&
    gitMarkup.includes('data-gittree-address="sidebar://gittree"') &&
    gitMarkup.includes('dsh-gittree 0.1.0-alpha.3'),
)
check(
  'gittree has no file-tree view',
  gitMarkup.includes('data-gittree-view') === false &&
    gitMarkup.includes('data-gittree-filter') === false &&
    gitMarkup.includes('data-gittree-changed') === false,
)
check(
  'gittree title seat draws the chip',
  renderToStaticMarkup(h(gitSeats['sidebar.right.pane.tab.title#dsh-gittree'].component, {})),
  '<span class="dsg-title">History</span>',
)

// ---------------------------------------------------------------- dsh-browser
const browser = loadBundle('packages/dsh-browser/lib/client.js', {})
const browserCssTag = browser.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-browser/browser.css').pop()
const browserCss = browserCssTag ? browserCssTag.textContent : ''
const browserSource = readFileSync(path.join(repo, 'packages/dsh-browser/lib/client.js'), 'utf8')
check('browser bundle id', browser.id, 'dsh-browser')
check('browser inject', JSON.stringify(browser.exports.inject), '["slots","sidebarRightTabs"]')
check(
  'browser stylesheet injected',
  browserCss.includes('.dsb-root{') && browserCss.includes('.dsb-led[data-dsb-led="live"]') && browserCss.includes('.dsb-frame{'),
)
const browserTypes = []
const browserSeats = {}
browser.exports.apply({
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      browserSeats[spec.name + (spec.key ? '#' + spec.key : '')] = { spec, component }
      return () => {}
    },
  },
  sidebarRightTabs: { register: (definition) => (browserTypes.push(definition), () => {}), entries: () => [] },
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('browser type registered', browserTypes.length === 1 && browserTypes[0].id + '/' + browserTypes[0].kind, 'dsh-browser/browser')
check('browser is a page type', browserTypes[0].patterns === undefined)
check('browser chip title', browserTypes[0].title('sidebar://browser'), 'Browser')
check('browser guide entry', browserTypes[0].guide.map((entry) => entry.order + ':' + entry.title()).join(','), '40:Browser')
check('browser guide walks the Start page', typeof browserTypes[0].guide[0].icon, 'function')
check(
  'browser seats',
  Object.keys(browserSeats).sort().join(','),
  'sidebar.right.pane.tab#dsh-browser,sidebar.right.pane.tab.title#dsh-browser',
)
const BrowserBody = browserSeats['sidebar.right.pane.tab#dsh-browser'].component
const browserTab = { id: 'tab5', contentId: 'sidebar://browser', title: 'Browser', navigation: { revision: 0 } }
const browserMarkup = renderToStaticMarkup(h(BrowserBody, { useTabInfo: () => ({ tab: browserTab }), sessionId: 's1' }))
check('browser body renders', browserMarkup.includes('data-dsb-tab="tab5"') && browserMarkup.includes('data-dsb-address="sidebar://browser"'))
check(
  'browser draws an address bar and the transport',
  browserMarkup.includes('data-dsb-url') &&
    browserMarkup.includes('data-dsb-back') &&
    browserMarkup.includes('data-dsb-forward') &&
    browserMarkup.includes('data-dsb-reload') &&
    browserMarkup.includes('data-dsb-copy') &&
    browserMarkup.includes('data-dsb-open'),
)
check('browser starts idle with a grey led', browserMarkup.includes('data-dsb-phase="idle"') && browserMarkup.includes('data-dsb-led="idle"'))
check('browser cannot go back with no history', /data-dsb-back="[^"]*"[^>]*disabled/.test(browserMarkup))
check('browser cannot go forward with no history', /data-dsb-forward="[^"]*"[^>]*disabled/.test(browserMarkup))
check('browser opens on its own card', browserMarkup.includes('data-dsb-card="idle"'))
check('browser names its surface and version', browserMarkup.includes('data-dsb-surface="iframe"') && browserMarkup.includes('dsh-browser 0.1.0-alpha.1'))
check(
  'browser title seat draws the chip',
  renderToStaticMarkup(h(browserSeats['sidebar.right.pane.tab.title#dsh-browser'].component, {})),
  '<span class="dsb-chip">Browser</span>',
)
// An opener names the first address: `openTab('browser', { params: { url } })`.
const openedTab = { id: 'tab5', contentId: 'sidebar://browser', title: 'Browser', navigation: { revision: 1, params: { url: 'example.com' } } }
const openedMarkup = renderToStaticMarkup(h(BrowserBody, { useTabInfo: () => ({ tab: openedTab }), sessionId: 's1' }))
check('browser adopts an opener address', openedMarkup.includes('value="https://example.com/"'))
const badOpenerTab = { ...browserTab, navigation: { revision: 1, params: { url: 'javascript:alert(1)' } } }
const badOpenerMarkup = renderToStaticMarkup(h(BrowserBody, { useTabInfo: () => ({ tab: badOpenerTab }), sessionId: 's1' }))
check('browser refuses an opener that is not an address', badOpenerMarkup.includes('javascript'), false)
// The seam: one surface ships, and it is a frame drawn by the browser in front of
// the user. A second entry in SURFACES (a harness-owned engine) must not need any
// other change, which is why the contract is asserted here.
check('browser ships one surface', browserSource.includes('const SURFACES = {') && browserSource.includes('iframe: createIframeSurface'))
check(
  'browser surface contract',
  browserSource.includes('mount()') &&
    browserSource.includes('goto(address)') &&
    browserSource.includes('reload()') &&
    browserSource.includes('stop()') &&
    browserSource.includes('dispose()'),
)
check('browser hides the frame without unmounting it', browserSource.includes("display: showCard ? 'none' : 'flex'"))
check('browser reports one state shape', browserSource.includes('onState: (patch) => setNav((state) => ({ ...state, ...patch }))'))
// Only a REAL framing refusal blocks a load: every other probe answer hands the
// address to the frame, which uses the browser's own session.
check('browser blocks on a refusal', /answer\.frameable === false\) \{\s*\n\s*setNav\(\{ phase: 'blocked'/.test(browserSource))
check('browser loads despite a failed check', /answer\.ok !== true\) \{[\s\S]{0,400}?surface\.goto\(address\)/.test(browserSource))
check('browser re-asks after a refusal', browserSource.includes('probeCacheRef.current.delete(address)'))
// The directive stands: the harness ships no engine and reaches for no OS browser.
check('browser reaches for no OS browser', /msedge|chrome\.exe|Google Chrome|playwright|puppeteer|chrome-headless/i.test(browserSource), false)
check('browser loads no engine', /child_process|webview|require\(['"]electron/.test(browserSource), false)

// -------------------------------------------------------------- dsh-terminal
const terminal = loadBundle('packages/dsh-terminal/lib/client.js', {})
const termCssTag = terminal.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-terminal/terminal.css').pop()
const termCss = termCssTag ? termCssTag.textContent : ''
check('terminal bundle id', terminal.id, 'dsh-terminal')
check('terminal inject', JSON.stringify(terminal.exports.inject), '["slots"]')
check(
  'terminal stylesheet injected',
  termCss.includes('.dst-dock{position:fixed;') &&
    termCss.includes('.dst-dock[data-open]:not([data-suspended]){display:flex}') &&
    termCss.includes('.dst-grip{'),
)
const termSeats = {}
terminal.exports.apply({
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      termSeats[spec.name] = { spec, component }
      return () => {}
    },
  },
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check(
  'terminal seats',
  Object.keys(termSeats).sort().join(','),
  'conversation.session.header.utilities,shell.overlay',
)
check('terminal button id', termSeats['conversation.session.header.utilities'].spec.id, 'dsh-terminal')
// Right of Open In... (-10) and left of the right bar's own toggle in the corner.
check('terminal button order', termSeats['conversation.session.header.utilities'].spec.order, 30)
check('terminal dock rides the overlay list', termSeats['shell.overlay'].spec.id, 'dsh-terminal')
const termButtonMarkup = renderToStaticMarkup(h(termSeats['conversation.session.header.utilities'].component, { sessionId: 's1' }))
check('terminal button renders', termButtonMarkup.includes('data-dsh-terminal-toggle') && termButtonMarkup.includes('aria-label="Terminal"'))
check('terminal button reports its state', termButtonMarkup.includes('aria-pressed="false"'))
// The dock is always mounted (so its effects own the geometry); `data-open` is
// the intent flag and must be absent while it is closed.
const termDockMarkup = renderToStaticMarkup(h(termSeats['shell.overlay'].component, {}))
check('terminal dock renders closed', termDockMarkup.includes('data-dsh-terminal-dock') && termDockMarkup.includes('role="region"'))
check('terminal dock closed by default', termDockMarkup.includes('data-open') === false)
check('terminal dock draws the kit', termDockMarkup.includes('class="dst-grip"') && termDockMarkup.includes('class="dst-bar"'))
check('terminal dock has no xterm before mount', termDockMarkup.includes('xterm') === false)
// Two behaviours that only exist after mount, pinned at the source level because
// a static render runs no effects:
//
//  1. the dock takes its room from the MIDDLE and RIGHT columns only. Shrinking
//     the frame instead shortens its single grid row, which shortens the left bar
//     too - its content visibly slid up the moment the dock opened (alpha.1), and
//     the left bar must look exactly the same with the dock open;
//  2. resizing the panel must re-fit the emulator (rows/cols) and leave the view
//     on the END of the output, or the panel keeps the old line count with the
//     newest lines out of sight.
const termSource = readFileSync(path.join(repo, 'packages/dsh-terminal/lib/client.js'), 'utf8')
check('terminal never resizes the frame', /frame(El)?\.style\.height\s*=/.test(termSource), false)
check('terminal insets the two columns it spans', termSource.includes('previousElementSibling') && termSource.includes('frame.children[0]'))
check('terminal gives room by column height', termSource.includes("'calc(100% - ' + String(dock.height) + 'px)'"))
check('terminal refits on resize and follows the end', termSource.includes('refit()') && termSource.includes('scrollToBottom()'))
//  3. the LEFT BAR is animated: collapsing it rewrites the grid tracks once and
//     then transitions them, so a MutationObserver on that write reads the
//     PRE-transition value and is never called again - the dock stood at the old
//     left edge. What changes on every frame of that transition is the SIZE of
//     the columns the dock spans, which is what a ResizeObserver reports.
check('terminal tracks the animated left bar', termSource.includes('new ResizeObserver(') && termSource.includes('columnObserver.observe(column)'))
check('terminal also snaps on transitionend', termSource.includes("frame.addEventListener('transitionend', onTransitionEnd)"))
check('terminal dock names the version', termDockMarkup.includes('dsh-terminal 0.1.0-alpha.3'))

console.log('')
console.log(failures === 0 ? 'all client-bundle checks passed' : failures + ' check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
