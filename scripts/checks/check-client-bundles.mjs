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
// The toolbar IS the tab's top bar (alpha.9): 38px with box-sizing:border-box is
// the box the shipped Files tab and the document preview use, so this pane's
// first hairline lands on the y=76 line the 38px docking strip and the
// conversation header (min-height:76px) draw. It was 8px + 26px + 8px = 42.5px.
check(
  'editor top bar is the 38px pane header',
  editorCss.includes('.dse-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;padding:0 10px 0 12px;') &&
    editorCss.includes('.dse-find{flex:1;min-width:0;height:24px;') &&
    editorCss.includes('gap:6px;height:24px;box-sizing:border-box;border:0;') &&
    editorCss.includes('.dse-preview{flex:none;display:inline-flex;align-items:center;height:24px;'),
)
check('editor bundle id', editor.id, 'dsh-editor')
check('editor inject', JSON.stringify(editor.exports.inject), '["locale","slots","sidebarRightTabs"]')
// The language map is internal (the tab builds the extension when a file opens),
// so it is asserted from the source: alpha.10 added the three shell languages,
// which have no Lezer parser and therefore ride on StreamLanguage. Without a map
// entry a .bat/.sh/.ps1 drew as ONE flat colour in the light theme.
const editorSource = readFileSync(path.join(repo, 'packages/dsh-editor/lib/client.js'), 'utf8')
check(
  'editor maps the shell extensions',
  ['sh', 'bash', 'zsh', 'ksh', 'dash', 'ps1', 'psm1', 'psd1', 'bat', 'cmd'].every((ext) => editorSource.includes("case '" + ext + "':")) &&
    editorSource.includes('CM.StreamLanguage.define(CM.shell)') &&
    editorSource.includes('CM.StreamLanguage.define(CM.powerShell)') &&
    editorSource.includes('CM.StreamLanguage.define(CM.batch)'),
)
// ...and the generated bundle must actually CARRY those four names, which is the
// half a source-only assertion cannot see: a stale cm6.min.js whose entry.js was
// updated but never rebuilt fails here. `window`/`document` are passed as
// UNDEFINED on purpose - the bundle probes for them (`typeof document`) and falls
// back to inert stubs, while handing it a half-built object makes that probe
// succeed and the load throw on a missing `.documentElement.style`.
const cmVendor = new Function(
  'window',
  'document',
  'console',
  readFileSync(path.join(repo, 'packages/dsh-editor/lib/vendor/cm6.min.js'), 'utf8') + '\nreturn DSHEditorCM',
)(undefined, undefined, console)
check(
  'editor engine carries the shell languages',
  cmVendor &&
    typeof cmVendor.StreamLanguage === 'function' &&
    typeof cmVendor.StreamLanguage.define === 'function' &&
    // The exact call the client makes for each of the three extensions: a mode
    // the bundle names but StreamLanguage cannot wrap is still a broken file.
    ['shell', 'powerShell', 'batch'].every(
      (name) => cmVendor[name] && typeof cmVendor[name].token === 'function' && Boolean(cmVendor.StreamLanguage.define(cmVendor[name])),
    ),
)
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
let themeSnapshot = {
  preference: 'dark',
  active: { id: 'dark', colorScheme: 'dark' },
  themes: [
    { id: 'light', colorScheme: 'light', tokens: {} },
    { id: 'dark', colorScheme: 'dark', tokens: {} },
  ],
  revision: 3,
}
const themeWrites = []
// alpha.12: the registry's own write entry. The package registers its palettes
// through it (`ctx.theme.register` - ui-theme's documented third-party surface)
// and the control's menu reads the registry back through `snapshot.themes`.
const themeRegistrations = []
const themeService = {
  getTheme: () => themeSnapshot,
  register(definition) {
    themeRegistrations.push(definition)
    themeSnapshot = { ...themeSnapshot, themes: [...themeSnapshot.themes, definition], revision: themeSnapshot.revision + 1 }
    return () => {}
  },
  setTheme(id) {
    themeWrites.push(id)
    themeSnapshot = {
      ...themeSnapshot,
      preference: id,
      active: { id: 'system', colorScheme: 'light' },
      revision: themeSnapshot.revision + 1,
    }
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
  'theme.nord': 'Nord',
  'theme.monokai': 'Monokai',
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

// ------------------------------------- the theme extensions (Nord, Monokai)
// alpha.12: this package REGISTERS its own palettes into the shipped registry
// and the control's menu is built FROM that registry, so a theme this pack adds
// becomes selectable by being registered - there is no second list to keep in
// step. Nord rides the dark base palette and recolors the alias layer only;
// Monokai (alpha.13) sits after it in THEME_EXTENSIONS, which is the order the
// registration loop walks and therefore the order the menu draws.
const nord = themeRegistrations.find((theme) => theme.id === 'nord')
const monokai = themeRegistrations.find((theme) => theme.id === 'monokai')
check(
  'the registered themes are nord then monokai',
  themeRegistrations.map((theme) => theme.id).join(','),
  'nord,monokai',
)
check('nord rides the dark base palette', nord && nord.colorScheme, 'dark')
check(
  'nord overrides token variables only',
  nord &&
    Object.keys(nord.tokens).every(
      (name) => name.startsWith('--dsw-alias-') || name.startsWith('--dsw-specific-') || name.startsWith('--shiki-token-'),
    ),
  true,
)
check('nord paints the Polar Night page', nord && nord.tokens['--dsw-alias-bg-base'], '#2e3440')
check('nord paints the Snow Storm text', nord && nord.tokens['--dsw-alias-label-primary'], '#eceff4')
check('nord paints the Frost accent', nord && nord.tokens['--dsw-alias-brand-primary'], '#88c0d0')
check('nord keeps the sidebar on the page colour', nord && nord.tokens['--dsw-specific-sidebar-fill'], '#2e3440')
check('nord brings its own copy', themeLocales.themes.en['theme.nord'], 'Nord')
check('nord copy is in both dictionaries', themeLocales.themes.zh['theme.nord'], 'Nord')
check('monokai rides the dark base palette', monokai && monokai.colorScheme, 'dark')
check(
  'monokai overrides token variables only',
  monokai &&
    Object.keys(monokai.tokens).every(
      (name) => name.startsWith('--dsw-alias-') || name.startsWith('--dsw-specific-') || name.startsWith('--shiki-token-'),
    ),
  true,
)
check('monokai paints the classic near-black page', monokai && monokai.tokens['--dsw-alias-bg-base'], '#272822')
check('monokai paints the off-white body', monokai && monokai.tokens['--dsw-alias-label-primary'], '#f8f8f2')
check('monokai paints the keyword pink accent', monokai && monokai.tokens['--dsw-alias-brand-primary'], '#f92672')
check(
  'monokai keeps the sidebar on the page colour',
  monokai && monokai.tokens['--dsw-specific-sidebar-fill'],
  '#272822',
)
check('monokai paints the classic comment grey', monokai && monokai.tokens['--shiki-token-comment'], '#75715e')
check('monokai brings its own copy', themeLocales.themes.en['theme.monokai'], 'Monokai')
check('monokai copy is in both dictionaries', themeLocales.themes.zh['theme.monokai'], 'Monokai')
check(
  'the registered themes cover the same token names',
  JSON.stringify(Object.keys(monokai.tokens).sort()) === JSON.stringify(Object.keys(nord.tokens).sort()),
  true,
)
// The button wears ONE static appearance mark: it used to paint the active
// preference's own sun/moon, which left a registered theme with nothing to draw.
// A static render answers from `getServerSnapshot` (the service is browser-side),
// so the mark - preference-independent by design - is what the markup can prove;
// the control's STATE is where the registered theme and its words are asserted.
for (const listener of themeEvents) listener({ preference: 'nord', active: nord, themes: themeSnapshot.themes, revision: 11 })
const nordMarkup = renderToStaticMarkup(h(ThemesAction, { t: themesT, themeState: themesFacade.themeState }))
check('the control reads the registered theme', themesFacade.themeState.getSnapshot().themes.some((theme) => theme.id === 'nord'))
check(
  'the control reads the second registered theme',
  themesFacade.themeState.getSnapshot().themes.some((theme) => theme.id === 'monokai'),
)
check('themes button wears the static mark', nordMarkup.includes('M8 2.4A5.6 5.6 0 0 1 8 13.6Z'))
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
// alpha.11: the captured frame is the interface as it stands, so the pack's own
// controls STAY in it (alpha.10 hid them, which left a hole in the record). The
// ONE thing left out of the frame is the open tooltip bubble, and that rule is
// keyed on the shipped Tooltip's own semantic `role="tooltip"` marker - never a
// hashed class, and never one of the pack's own class names.
check(
  'capture rule keeps the pack controls in the shot',
  themesCss.includes('html[data-dsh-screenshot] [role=tooltip]{visibility:hidden}') &&
    themesCss.includes('html[data-dsh-screenshot] .dst-button') === false &&
    themesCss.includes('html[data-dsh-screenshot] .dst-slot') === false,
)
// And the button that starts the capture closes its OWN tooltip for the frame,
// through the shipped Tooltip's `disabled` prop (its close-and-stay-closed
// switch), so the bubble is gone rather than merely invisible.
const themesSource = readFileSync(path.join(repo, 'packages/dsh-themes/lib/client.js'), 'utf8')
// The MENU is the registry's own list, not a copy of it: the control iterates
// `snapshot.themes` and appends the `system` preference last, so the shipped
// trio keeps its places and a registered theme lands between Dark and System.
check(
  'the menu is built from the registry',
  themesSource.includes('Array.isArray(snapshot.themes)') && themesSource.includes('ids.map(themeMeta)'),
)
check('the menu keeps system last', themesSource.includes("concat([themeMeta('system')])"))
check('the button names the active theme', themesSource.includes('const active = themeMeta(preference)'))
check(
  'the button no longer picks a per-preference glyph',
  themesSource.includes('const Glyph = entry.Icon') === false && themesSource.includes("h(IconThemeOutline16, { size: 16 })"),
)
check(
  'the clicked button closes its own tooltip while it captures',
  themesSource.includes("{ label: label, side: 'bottom', delayMs: 500, disabled: busy }"),
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
// The tools bar is the History tab's own top bar (alpha.4), the same 38px
// border-box pane header the Files tab, the document preview and the editor use,
// so all four hairlines sit on the y=76 line the other columns draw.
check(
  'gittree top bar is the 38px pane header',
  gitCss.includes('.dsg-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;padding:0 10px 0 12px;') &&
    gitCss.includes('.dsg-btn{flex:none;display:inline-flex;align-items:center;height:24px;'),
)
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
    gitMarkup.includes('dsh-gittree 0.1.0-alpha.4'),
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

// -------------------------------------------------------------- dsh-rightbar
// The right bar is a GENERATED fork, so these are source-level checks (like the
// terminal's): what the fork must - and must not - contain once
// `sync-vendored.ps1` has rebuilt it from the core bundle plus its patch list.
// The dock's ceiling belongs to the kit (`MAX_DOCK_PANES = 4`, and the kit's own
// `canSplit` means "fewer than four"); the core bundle caps it at TWO in five
// places, which is what these assert the fork no longer does. A hand edit that
// skipped the patch list would show up here on the next re-sync.
const barSource = readFileSync(path.join(repo, 'packages/dsh-rightbar/lib/client.js'), 'utf8')
const syncSource = readFileSync(path.join(repo, 'scripts/sync-vendored.ps1'), 'utf8')
check('right bar has no two-pane cap', /dockPaneIds\)\((?:state|layout|surface\.layout)\)\.length [<>]=? 2/.test(barSource), false)
check('right bar offers every drop band', barSource.includes('dropZones: "edges",') && barSource.includes('dropZones: "horizontal"') === false)
check('right bar hands the limit to the kit', barSource.includes('canSplit: (0, _deepseek_ai_dsh_client_ui_dockkit.canSplit)(surface.layout),'))
check(
  'right bar names the four-pane ceiling',
  barSource.includes('"dock.splitPaneDisabled": "Four panes is the limit",') &&
    barSource.includes('"dock.splitPaneDisabled": "\u5df2\u8fbe\u56db\u683c\u4e0a\u9650",'),
)
check(
  'right bar cap lift is a recorded patch',
  syncSource.includes('lift the two-pane cap') && syncSource.includes('offer every drop band a pane has'),
)

// ------------------------------------------------------------- dsh-diagrams
// The diagrams bundle registers TWO tab types (one per diagram, plus the
// conversation index whose guide entry opens it), their keyed bodies and
// titles, and one conversation card per diagram tool. These checks drive the
// real factory with a stub ctx and render the seats the shell would render.
const diagrams = loadBundle('packages/dsh-diagrams/lib/client.js', {})
check('diagrams bundle id', diagrams.id, 'dsh-diagrams')
check(
  'diagrams inject',
  JSON.stringify(diagrams.exports.inject),
  '["slots","sidebarRightTabs"]',
)
const diagTypes = []
const diagSeats = {}
const openedTabs = []
const diagTabTypes = { register: (definition) => (diagTypes.push(definition), () => {}), entries: () => [] }
diagrams.exports.apply({
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      diagSeats[spec.name + (spec.key ? '#' + spec.key : '')] = { spec, component }
      return () => {}
    },
  },
  sidebarRightTabs: diagTabTypes,
  get: (name) => (name === 'sidebarRight' ? { openResource: (address) => openedTabs.push(address) } : undefined),
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('diagrams registers two tab types', diagTypes.length, 2)
// The stylesheet is injected when the row activates (apply), so it is read
// here rather than at load time.
const diagCssTag = diagrams.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-diagrams/diagrams.css').pop()
const diagCss = diagCssTag ? diagCssTag.textContent : ''
check(
  'diagrams stylesheet injected',
  diagCss.includes('.dsd-root{') &&
    diagCss.includes('.dsd-card{') &&
    diagCss.includes('.dsd-pill[data-status="ok"]') &&
    diagCss.includes('.dsd-svg svg{') &&
    diagCss.includes('.dsd-zoomBox{') &&
    diagCss.includes('.dsd-zoomBar{'),
)
// The panel's toolbar is the same 38px border-box top bar the Files tab, the
// document preview, the editor and the History tab use, so every right-column
// pane draws its first hairline on the y=76 line.
check(
  'diagrams top bar is the 38px pane header',
  diagCss.includes('.dsd-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;padding:0 10px 0 12px;'),
)
const viewerType = diagTypes.find((entry) => entry.kind === 'diagram')
const indexType = diagTypes.find((entry) => entry.kind === 'diagrams')
check('viewer type identity', viewerType.id, 'dsh-diagrams-viewer')
check('index type identity', indexType.id, 'dsh-diagrams-index')
// One tab per DIAGRAM: a resource kind whose glob owns the address the host's
// tool results carry, in the extension band so it beats any shipped viewer.
check(
  'viewer owns the diagram address grammar',
  viewerType.patterns.join(',') + '/' + viewerType.priority,
  'dsh-resource://diagram/session/**,dsh-resource://diagram/library/**/extension',
)
check('viewer claims a host address', viewerType.patterns[0].includes('dsh-resource://diagram/session/'))
// A LIBRARY address names no conversation: that is what makes one tab - and one
// citation - work from every chat.
check('viewer claims the library address too', viewerType.patterns[1] === 'dsh-resource://diagram/library/**')
check('viewer has no guide entry', viewerType.guide === undefined)
// The index is a PAGE type: no patterns, so it never competes for a file
// address, and its one guide entry sits after Files (10), Editor (20) and
// History (30) on the "+" / Start page.
check('index is a page type', indexType.patterns === undefined)
check('index guide entry', indexType.guide.map((entry) => entry.order + ':' + entry.title()).join(','), '40:Diagrams')
check('index chip title', indexType.title(), 'Diagrams')
check(
  'diagrams seats',
  Object.keys(diagSeats).sort().join(','),
  [
    'sidebar.right.pane.tab#dsh-diagrams-index',
    'sidebar.right.pane.tab#dsh-diagrams-viewer',
    'sidebar.right.pane.tab.title#dsh-diagrams-index',
    'sidebar.right.pane.tab.title#dsh-diagrams-viewer',
    'tool.call.toolview#diagram_delete',
    'tool.call.toolview#diagram_patch',
    'tool.call.toolview#diagram_publish',
    'tool.call.toolview#diagram_read',
    'tool.call.toolview#diagram_verify',
    'tool.call.toolview#diagram_write',
  ].join(','),
)
// The chip of a diagram tab is the diagram's own name; with nothing loaded yet
// it falls back to the id the address carries rather than an empty chip.
const viewerAddress = 'dsh-resource://diagram/session/sess-1/auth-flow'
check('viewer chip falls back to the address id', viewerType.title(viewerAddress), 'auth-flow')

const ViewerBody = diagSeats['sidebar.right.pane.tab#dsh-diagrams-viewer'].component
const viewerTab = { id: 'tabD', contentId: viewerAddress, title: 'auth-flow', navigation: { revision: 0 } }
const viewerMarkup = renderToStaticMarkup(h(ViewerBody, { useTabInfo: () => ({ tab: viewerTab }), sessionId: 'sess-1' }))
check('viewer body waits for the store', viewerMarkup.includes('Loading the diagram...'))
const badTab = { id: 'tabE', contentId: 'sidebar://diagrams', title: 'Diagrams', navigation: { revision: 0 } }
check(
  'viewer body rejects a non-diagram address',
  renderToStaticMarkup(h(ViewerBody, { useTabInfo: () => ({ tab: badTab }), sessionId: 'sess-1' })).includes('carries no diagram address'),
)

const IndexBody = diagSeats['sidebar.right.pane.tab#dsh-diagrams-index'].component
const indexMarkup = renderToStaticMarkup(h(IndexBody, { sessionId: 'sess-1' }))
check('index body renders its empty state', indexMarkup.includes('Nothing yet: this conversation has no diagrams and the library is empty.'))
check(
  'index body offers both engines',
  indexMarkup.includes('>New Mermaid<') && indexMarkup.includes('>New TikZ<') && indexMarkup.includes('dsh-diagrams 0.1.0-alpha.6'),
)
// The index is where the LIBRARY becomes visible: the file bar always counts
// both halves, and the two labelled lists are asserted from the source below
// (with an empty store the page draws its empty state instead).
check('index counts the shared library', indexMarkup.includes('in the library') && indexMarkup.includes(' here'))
check('index title seat', renderToStaticMarkup(h(diagSeats['sidebar.right.pane.tab.title#dsh-diagrams-index'].component, {})), 'Diagrams')

// The conversation card draws from the tool call itself, so it is right on
// replay. The block shapes are the SHELL's: a call still running is a call
// block with no `kind` (`ui-tool` reads `done = "kind" in block`), and a
// settled call is a `tool-result` block carrying `call.argsRaw` plus the
// presentation `meta` the host declared - which is where a `diagram_write`
// gets its id, because the write itself never names one.
const WriteCard = diagSeats['tool.call.toolview#diagram_write'].component
const writeArgs = JSON.stringify({ kind: 'tikz', title: 'Layers', source: '\\node {A};' })
const runningMarkup = renderToStaticMarkup(
  h(WriteCard, {
    toolName: 'diagram_write',
    sessionId: 'sess-1',
    block: { callId: 'c1', name: 'diagram_write', argsRaw: writeArgs, subCalls: [] },
  }),
)
check('write card shows the pending state', runningMarkup.includes('Writing a diagram...'))
check('write card offers no link while it runs', runningMarkup.includes('Open tab') === false)
const settledMarkup = renderToStaticMarkup(
  h(WriteCard, {
    toolName: 'diagram_write',
    sessionId: 'sess-1',
    block: {
      kind: 'tool-result',
      callId: 'c1',
      call: { name: 'diagram_write', argsRaw: writeArgs },
      content: [{ type: 'text', text: 'Wrote diagram "layers" (tikz) - status: ok.' }],
      isError: false,
      meta: {
        id: 'layers',
        kind: 'tikz',
        title: 'Layers',
        status: 'ok',
        address: 'dsh-resource://diagram/session/sess-1/layers',
      },
      subCalls: [],
    },
  }),
)
check('a settled write is not still writing', settledMarkup.includes('Writing a diagram...') === false)
check(
  'write card names the diagram the host created',
  settledMarkup.includes('TikZ') && settledMarkup.includes('Layers') && settledMarkup.includes('layers'),
)
check('write card links its tab', settledMarkup.includes('>Open tab<'))
check('write card keeps the picture behind the toggle', settledMarkup.includes('>Show<') && settledMarkup.includes('dsd-cardBody') === false)
// A call that never settled (an interrupted turn) still has to render honestly
// instead of claiming a diagram it never wrote.
const callOnlyMarkup = renderToStaticMarkup(
  h(WriteCard, {
    toolName: 'diagram_write',
    sessionId: 'sess-1',
    block: { callId: 'c2', name: 'diagram_write', argsRaw: JSON.stringify({ kind: 'mermaid', source: 'flowchart TD\n A-->B' }), subCalls: [] },
  }),
)
check('write card survives a call with no title yet', callOnlyMarkup.includes('dsd-card'))
// A replayed log can settle a call whose call block is gone (`call: null`): the
// view in `meta` still names the diagram, and nothing may dereference the args.
const calllessMarkup = renderToStaticMarkup(
  h(WriteCard, {
    toolName: 'diagram_write',
    sessionId: 'sess-1',
    block: {
      kind: 'tool-result',
      callId: 'c6',
      call: null,
      content: [{ type: 'text', text: 'Wrote diagram "layers" (tikz) - status: ok.' }],
      isError: false,
      meta: { id: 'layers', kind: 'tikz', title: 'Layers', status: 'ok' },
      subCalls: [],
    },
  }),
)
check('write card survives a missing call block', calllessMarkup.includes('Layers') && calllessMarkup.includes('>Open tab<'))

const ReadCard = diagSeats['tool.call.toolview#diagram_read'].component
check(
  'read card names the index',
  renderToStaticMarkup(h(ReadCard, { toolName: 'diagram_read', sessionId: 'sess-1', block: { callId: 'c3', name: 'diagram_read', argsRaw: '{}', subCalls: [] } })).includes(
    'Diagram index',
  ),
)
const readNamedMarkup = renderToStaticMarkup(
  h(ReadCard, {
    toolName: 'diagram_read',
    sessionId: 'sess-1',
    block: {
      kind: 'tool-result',
      callId: 'c4',
      call: { name: 'diagram_read', argsRaw: JSON.stringify({ id: 'auth-flow' }) },
      content: [{ type: 'text', text: 'auth-flow' }],
      isError: false,
      meta: { id: 'auth-flow', kind: 'mermaid', title: 'Auth flow', status: 'ok', address: 'dsh-resource://diagram/session/sess-1/auth-flow' },
      subCalls: [],
    },
  }),
)
check('read card links the diagram it read', readNamedMarkup.includes('auth-flow') && readNamedMarkup.includes('>Open tab<'))
const DeleteCard = diagSeats['tool.call.toolview#diagram_delete'].component
check(
  'delete card is a one-liner',
  renderToStaticMarkup(
    h(DeleteCard, { toolName: 'diagram_delete', sessionId: 'sess-1', block: { callId: 'c5', name: 'diagram_delete', argsRaw: JSON.stringify({ id: 'old-one' }), subCalls: [] } }),
  ).includes('Deleted diagram') &&
    renderToStaticMarkup(
      h(DeleteCard, { toolName: 'diagram_delete', sessionId: 'sess-1', block: { callId: 'c5', name: 'diagram_delete', argsRaw: JSON.stringify({ id: 'old-one' }), subCalls: [] } }),
    ).includes('old-one'),
)
// A mounted index tab re-reads the host when it becomes visible again: that is
// what keeps an open "Diagrams" page in step with writes made in the chat.
check(
  'the index re-reads on visibility',
  readFileSync(path.join(repo, 'packages/dsh-diagrams/lib/client.js'), 'utf8').includes('tabInfoNow(props)'),
)
// The client never invents the host's routes: the vendored engine, the state
// and the artifact routes are the ones lib/index.js registers.
const diagSource = readFileSync(path.join(repo, 'packages/dsh-diagrams/lib/client.js'), 'utf8')
check(
  'client routes match the host half',
  [
    '/api/dsh-diagrams/state',
    '/api/dsh-diagrams/diagram',
    '/api/dsh-diagrams/artifact',
    '/api/dsh-diagrams/export',
    '/api/dsh-diagrams/render-report',
    '/api/dsh-diagrams/vendor/mermaid.js',
  ].every((route) => diagSource.includes(route)),
)
check('client loads the engine as a classic script', diagSource.includes('new Blob([source]') && diagSource.includes('window.mermaid'))

// THE RENDER TRAP. `mermaid.render(id, source)` with no container builds a
// `#d<id>` div on document.body and only removes it on the success path; when
// the engine drew its own error diagram into it first, what stays in the page
// is a full-size "Syntax error in text / mermaid version <v>" picture - one per
// failed render. Three things keep that out of the interface, and all three are
// load-bearing, so each is asserted here rather than left to review.
check('the engine is told never to draw its own errors', diagSource.includes('suppressErrorRendering: true'))
check('a source is parsed before it is rendered', diagSource.indexOf('await mermaid.parse(text)') < diagSource.indexOf('await mermaid.render('))
check(
  'every render goes into a container the plugin owns',
  /mermaid\.render\(id,\s*text,\s*mermaidHost\(\)\)/.test(diagSource),
)
check('the render host is offscreen and out of the flow', /renderHost\.style\.cssText[^\n]*left:-100000px/.test(diagSource))
check('engine fixtures are swept even when the render throws', /finally \{[\s\S]{0,120}sweepMermaidFixtures\(\)/.test(diagSource))
// The one entry point the pictures use hands back a verdict instead of
// throwing, so no surface has to remember the parse/render order.
check('the pictures go through the safe renderer', diagSource.includes('renderMermaidSafe(source, dark)'))
check('exports refuse a diagram that does not render', /async function mermaidSvgNow[\s\S]{0,400}if \(!result\.ok\)/.test(diagSource))
// A Mermaid source the host already refused is never handed to the engine: it
// has no picture to make, and asking anyway is exactly what used to produce an
// engine error diagram.
check(
  'a refused Mermaid source is never rendered',
  /entry\.kind === 'mermaid' && entry\.status === 'error'/.test(diagSource) && diagSource.includes('does not parse, so there is nothing to draw'),
)

// ZOOM. A diagram is read whole first and zoomed in on second, so the picture is
// laid out at 80% of the pane and the ladder moves the BOX rather than applying a
// CSS transform: a transform scales into a clipped box with no scrollable area,
// and the reader could never reach the edge of a zoomed diagram.
check('the reader gets a zoom ladder', /const ZOOM_STEPS = \[0\.25, 0\.5, 0\.75, 1, 1\.25, 1\.5, 2, 3, 4\]/.test(diagSource))
check('100% is 80% of the pane', diagSource.includes('const ZOOM_FIT_WIDTH = 80'))
check('the picture is laid out as a share of the pane', diagSource.includes("style: { width: ZOOM_FIT_WIDTH * zoom + '%' }"))
check('zooming in lets the picture outgrow its natural width', diagSource.includes("'data-zoomed': zoom > ZOOM_DEFAULT"))
check('zoom is remembered per diagram', diagSource.includes('zoomMemory.set(zoomKey, next)'))
check('the canvas can scroll a zoomed diagram to its left edge', diagCss.includes('justify-content:flex-start'))
check('the zoom box never shrinks to fit', /\.dsd-zoomBox\{flex:none;/.test(diagCss))
check(
  'a zoomed mermaid svg overrides the max-width the engine writes',
  diagCss.includes('.dsd-zoomBox[data-zoomed="true"] .dsd-svg svg{width:100%;max-width:none!important;height:auto}'),
)
// The two ways this zoom could silently zoom nothing, both of them real defects
// found by using it: a column flex container sizes its children to their CONTENT
// on the cross axis, so the `.dsd-svg` wrapper stayed at the svg's natural width
// however wide the box became; and without an explicit `width:100%` on that
// wrapper the svg's own `width:100%` resolved against the wrapper, not the box.
check(
  'every child of a zoomed box is stretched to it',
  diagCss.includes('.dsd-zoomBox[data-zoomed="true"] > *{align-self:stretch}'),
)
check(
  'the picture wrapper fills the box',
  diagCss.includes('.dsd-svg{width:100%;max-width:100%;display:flex;justify-content:center}'),
)
check(
  'readable blocks do not stretch with the zoom',
  diagCss.includes('max-width:720px') && diagCss.includes('.dsd-diags{margin:0 auto;'),
)
// PAN. The picture is laid out at real size in a scrollable box, so a drag moves
// the SCROLL POSITION: no transform, nothing repositioned, and the wheel keeps
// working. A picture that fits must not offer a grab cursor, and a wide diagram
// at 100% must, because it overflows with no zoom at all.
check(
  'a drag pans the scroll position, not a transform',
  /canvas\.scrollLeft = start\.left - \(event\.clientX - start\.x\)/.test(diagSource) &&
    diagSource.includes('canvas.scrollTop = start.top - (event.clientY - start.y)'),
)
check('the drag captures the pointer', diagSource.includes('canvas.setPointerCapture(event.pointerId)'))
check(
  'the canvas is the pan surface',
  diagCss.includes('.dsd-canvas[data-pannable="true"]{cursor:grab}') && diagCss.includes('.dsd-canvas[data-panning="true"]{cursor:grabbing'),
)
check(
  'a picture that fits never offers a grab cursor',
  diagSource.includes("'data-pannable': pannable ? 'true' : undefined") &&
    diagSource.includes('canvas.scrollWidth > canvas.clientWidth + 1'),
)
check(
  'the native drag of a picture cannot steal the pan',
  diagSource.includes('draggable: false') && diagCss.includes('-webkit-user-drag:none'),
)
check(
  'a zoom keeps the point the reader was looking at',
  diagSource.includes('element.scrollLeft = anchor.x * element.scrollWidth - element.clientWidth / 2') &&
    diagSource.includes('window.requestAnimationFrame(restore)'),
)

// EXPORT. Every format is saved to the Desktop of the machine running the
// harness by the host route - the same deal the screenshot control makes, with
// the client naming a format and never a path. The browser download survives
// only as the fallback for a profile without that route.
check('the export menu saves to the Desktop', diagSource.includes('Save to the Desktop') && diagSource.includes("'Save .' + format"))
check(
  'the export reports the absolute path the host wrote',
  diagSource.includes("setStatus('saved to ' + (answer && answer.path ? answer.path : 'the Desktop'))"),
)
check('the browser download survives as a fallback', diagSource.includes("'Download .' + format + ' in the browser'"))

// VERDICT LABELS. Four objective states, and an absent report is never read as a
// picture: the pill draws what the host computed and falls back to the same four
// answers rather than inventing an optimistic one.
check('the pill draws the host verdict', diagSource.includes('entry.verification ? entry.verification : renderVerdictOf(entry)'))
check('the client keeps a fallback verdict for an older host', /function renderVerdictOf\(entry\)/.test(diagSource))
const fallbackVerdict = diagSource.slice(diagSource.indexOf('function renderVerdictOf'), diagSource.indexOf('function verdictTitle'))
check('a missing report is never read as a picture', fallbackVerdict.includes("if (!report) return { state: 'pending'"))
check(
  'the fallback carries the same four answers',
  fallbackVerdict.includes("state: 'stale'") && fallbackVerdict.includes("state: report.ok ? 'drawn' : 'failed'"),
)
check(
  'a failed render is red, an absent verdict is neutral',
  diagCss.includes('.dsd-pill[data-status="error"],.dsd-pill[data-status="failed"]') &&
    diagCss.includes('.dsd-pill[data-status="unchecked"],.dsd-pill[data-status="pending"],.dsd-pill[data-status="stale"]'),
)

// LIBRARY. A diagram published to the shared store is the same diagram in every
// conversation, and its address names no conversation - which is what makes one
// citation work from anywhere. The client has to know all of that: a second list
// in the store, a second address shape, and a scope on every request that names
// a diagram.
check(
  'the library address opens without a session',
  diagSource.includes('function addressFor(sessionId, diagramId, scope)') &&
    diagSource.includes('if (scope === LIBRARY_SCOPE) return LIBRARY_PREFIX + encodeURIComponent(diagramId)'),
)
check(
  'the address parser knows both shapes',
  /if \(text\.startsWith\(LIBRARY_PREFIX\)\)/.test(diagSource) && diagSource.includes("scope: 'conversation', sessionId: decodeURIComponent"),
)
check(
  'the store keeps the two halves apart',
  diagSource.includes('libraryById') && diagSource.includes('store.library = Array.isArray(payload && payload.library)'),
)
check(
  'an id with no scope resolves library-first, like the host',
  /function entryNow\(sessionId, diagramId, scope\)[\s\S]{0,400}return store\.libraryById\.get\(diagramId\) \?\? store\.byId\.get\(diagramId\)/.test(diagSource),
)
check(
  'the index shows both halves, library first',
  diagSource.includes("'Library - every conversation sees these") &&
    diagSource.includes("'This conversation'") &&
    diagCss.includes('.dsd-listHead{'),
)
check(
  'the scope travels with every request that names a diagram',
  diagSource.includes('revision, scope, ...report') &&
    diagSource.includes("'&scope=' +") &&
    diagSource.includes('{ session: sessionId, id: diagramId, format, data, scope }') &&
    diagSource.includes('scope,\n              recompile:') &&
    diagSource.includes('scope: entry.scope'),
)

// ------------------------------------------------------------------ dsh-pdf
const pdf = loadBundle('packages/dsh-pdf/lib/client.js', {})
const pdfCssTag = pdf.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-pdf/pdf.css').pop()
const pdfCss = pdfCssTag ? pdfCssTag.textContent : ''
const pdfSource = readFileSync(path.join(repo, 'packages/dsh-pdf/lib/client.js'), 'utf8')
check('pdf bundle id', pdf.id, 'dsh-pdf')
check('pdf inject', JSON.stringify(pdf.exports.inject), '["slots","sidebarRightTabs"]')
check('pdf stylesheet injected', pdfCss.includes('.dpf-root{') && pdfCss.includes('.dpf-tools{'))
// The toolbar is this tab's top bar: the same 38px border-box pane header the
// Files tab, the document preview, the editor and History use, so every
// column's first hairline lands on the same y=76 line.
check(
  'pdf top bar is the 38px pane header',
  pdfCss.includes('.dpf-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;'),
)
// The reader is a real reader, and these are the parts that make it one: a text
// layer pdf.js can position, the scale variable pdf.js reads (v6 uses
// --total-scale-factor, not v3's --scale-factor), and hit highlighting.
check(
  'the text layer keeps pdf.js contracts',
  pdfCss.includes('.dpf-textLayer span,.dpf-textLayer br{position:absolute;white-space:pre;') &&
    pdfCss.includes('--total-scale-factor:1;--scale-round-x:1px;--scale-round-y:1px') &&
    pdfCss.includes('.dpf-textLayer mark{'),
)
// The engine is never inlined: the harness reads every client bundle at boot,
// so pdf.js (1.8 MB) is fetched from this plugin's own routes on first use.
check('the engine is not inlined', pdfSource.length < 220000 && pdfSource.includes('pdfjsVersion') === false)
check('the engine comes from a route', pdfSource.includes("API_ROOT + '/vendor/pdf.min.mjs'") && pdfSource.includes("API_ROOT + '/vendor/pdf.worker.min.mjs'"))
check('the worker is handed over as a blob URL', pdfSource.includes('pdfjs.GlobalWorkerOptions.workerSrc = workerUrl'))
check('the engine is imported as a module blob', pdfSource.includes('await import(/* webpackIgnore: true */ engineUrl)'))
// The route registry matches EXACT paths only, so the cMap and standard-font
// trees cannot be fetched file by file: one map per kind is decoded on demand.
check(
  'assets arrive as one map per kind',
  pdfSource.includes("API_ROOT + '/vendor/cmaps.json'") &&
    pdfSource.includes("API_ROOT + '/vendor/standard-fonts.json'") &&
    pdfSource.includes('BinaryDataFactory: MapBinaryDataFactory'),
)
check('the reader uses pdf.js own TextLayer', pdfSource.includes('new engine.TextLayer({'))
check('the reader is page-navigable by keyboard', pdfSource.includes("event.key === 'PageDown'") && pdfSource.includes('dpf-pageInput') && pdfSource.includes('goToPage'))
check('a PDF is claimed as an extension type', pdfSource.includes("patterns: ['*.pdf']") && pdfSource.includes("priority: 'extension'"))
// alpha.3: the side panel (thumbnails + the document's own outline), the wasm
// decoders, and the workspace index page.
check(
  'the reader has a thumbnail rail, drawn lazily',
  pdfSource.includes('data-pdf-thumb') &&
    pdfSource.includes('THUMB_MAX = 300') &&
    pdfSource.includes('root: element.closest(\'.dpf-side\') ?? null') &&
    pdfSource.includes('Thumbnails stop at '),
)
check(
  'the reader reads the document outline itself',
  pdfSource.includes('await doc.getOutline()') &&
    pdfSource.includes('await doc.getDestination(') &&
    pdfSource.includes('await doc.getPageIndex(') &&
    pdfSource.includes('This document has no bookmarks'),
)
check(
  'the wasm decoders are wired',
  pdfSource.includes("API_ROOT + '/vendor/wasm.json'") &&
    pdfSource.includes("kind === 'wasmUrl' ? VENDOR_WASM") &&
    pdfSource.includes('wasmUrl: VENDOR_WASM'),
)
check(
  'the index page reads the workspace route',
  pdfSource.includes("API_ROOT + '/list'") &&
    pdfSource.includes("data-pdf-index-row") &&
    pdfSource.includes('Every PDF in this workspace'),
)
check('the index is a page type with its own guide entry', pdfSource.includes("priority: 'builtin',") && pdfSource.includes('order: 50'))
check('the client is at alpha.3', pdfSource.includes("PLUGIN_VERSION = '0.1.0-alpha.3'"))

const pdfTypes = []
const pdfSeats = {}
const pdfTabTypes = { register: (definition) => (pdfTypes.push(definition), () => {}), entries: () => [] }
pdf.exports.apply({
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      pdfSeats[spec.name + (spec.key ? '#' + spec.key : '')] = { spec, component }
      return () => {}
    },
  },
  sidebarRightTabs: pdfTabTypes,
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('pdf type registered', pdfTypes.length === 2 && pdfTypes[0].id + '/' + pdfTypes[0].kind, 'dsh-pdf/pdf')
check('the index registers as a page type', pdfTypes[1].id + '/' + pdfTypes[1].kind + '/' + pdfTypes[1].priority, 'dsh-pdf-index/pdfs/builtin')
check('the index claims no file address', pdfTypes[1].patterns === undefined, true)
check('the index guide entry follows Diagrams', pdfTypes[1].guide.map((entry) => entry.order + ':' + entry.title()).join(','), '50:PDFs')
check('pdf claims only *.pdf', JSON.stringify(pdfTypes[0].patterns), '["*.pdf"]')
check('pdf outranks the shipped preview band', pdfTypes[0].priority, 'extension')
check(
  'pdf canOpen accepts both address shapes',
  pdfTypes[0].canOpen('dsh-resource://file/session/s1/docs/report.pdf') === true &&
    pdfTypes[0].canOpen('dsh-resource://pdf/absolute/' + encodeURIComponent('C:\\tmp\\scan.PDF')) === true &&
    pdfTypes[0].canOpen('dsh-resource://file/session/s1/notes.txt') === false,
)
check('pdf chip title is the file name', pdfTypes[0].title('dsh-resource://file/session/s1/docs/report.pdf'), 'report.pdf')
check(
  'pdf seats',
  Object.keys(pdfSeats).sort().join(','),
  'sidebar.right.pane.tab#dsh-pdf,sidebar.right.pane.tab#dsh-pdf-index,sidebar.right.pane.tab.title#dsh-pdf,sidebar.right.pane.tab.title#dsh-pdf-index,tool.call.toolview#pdf_find,tool.call.toolview#pdf_info,tool.call.toolview#pdf_read,tool.call.toolview#pdf_render,tool.call.toolview#pdf_scan',
)
// alpha.2, the scanner: a page with no text layer must SAY so and offer the one
// action that can change it, through the same route the pdf_scan tool drives.
check(
  'a scanned page says so and offers a scan',
  pdfSource.includes('data-pdf-scanned') &&
    pdfSource.includes('.dpf-scanRow{') &&
    pdfSource.includes('This page is a scanned image') &&
    pdfSource.includes("'Scan this page'"),
)
check(
  'the reader scans through the plugin route',
  pdfSource.includes("API_ROOT + '/scan'") &&
    pdfSource.includes("method: 'POST'") &&
    pdfSource.includes('body: JSON.stringify({ ...payload, page: pageNumber, dpi: SCAN_DPI })'),
)
check(
  'recognized text is labelled as recognized',
  pdfSource.includes('data-pdf-ocr') &&
    pdfSource.includes('OCR misreads digits, names, accents and punctuation') &&
    pdfSource.includes('Recognized, not extracted'),
)
check('the client is at alpha.3', pdfSource.includes("PLUGIN_VERSION = '0.1.0-alpha.3'"))
const PdfBody = pdfSeats['sidebar.right.pane.tab#dsh-pdf'].component
const pdfTab = { id: 'tab7', contentId: 'dsh-resource://file/session/s1/report.pdf', title: 'report.pdf' }
const pdfMarkup = renderToStaticMarkup(h(PdfBody, { useTabInfo: () => ({ tab: pdfTab }), sessionId: 's1' }))
check('pdf body renders its opening state', pdfMarkup.includes('data-pdf-state="loading"') && pdfMarkup.includes('Opening the PDF'))
check(
  'pdf title seat draws the chip',
  renderToStaticMarkup(h(pdfSeats['sidebar.right.pane.tab.title#dsh-pdf'].component, { useTabInfo: () => ({ tab: pdfTab }) })),
  '<span class="dpf-title">report.pdf</span>',
)
// The index page: a page tab whose body reads the workspace. The effect cannot
// run under static rendering, so what is checked here is that it renders its
// own opening state and carries the address its guide entry opens.
const PdfIndexBody = pdfSeats['sidebar.right.pane.tab#dsh-pdf-index'].component
const pdfIndexMarkup = renderToStaticMarkup(h(PdfIndexBody, { sessionId: 's1' }))
check('the index body renders its opening state', pdfIndexMarkup.includes('data-pdf-index="sidebar://pdfs"') && pdfIndexMarkup.includes('data-pdf-index-state="loading"'))
check('the index offers a refresh and a page count', pdfIndexMarkup.includes('data-pdf-action="index-reload"') && pdfIndexMarkup.includes('data-pdf-action="index-count"'))
check(
  'the index title seat draws the chip',
  renderToStaticMarkup(h(pdfSeats['sidebar.right.pane.tab.title#dsh-pdf-index'].component, {})),
  '<span class="dpf-title">PDFs</span>',
)
const ToolCard = pdfSeats['tool.call.toolview#pdf_read'].component
const settledBlock = {
  kind: 'tool-result',
  call: { name: 'pdf_read', argsRaw: '{"path":"report.pdf","pages":"1-5","mode":"layout"}' },
  meta: {
    file: 'C:/work/report.pdf',
    name: 'report.pdf',
    address: 'dsh-resource://file/session/s1/report.pdf',
    pages: 12,
    mode: 'layout',
    scanned: [7, 8],
    cached: true,
  },
  content: [{ type: 'text', text: 'report.pdf — pages 1-5 of 12 (layout mode)' }],
}
const cardMarkup = renderToStaticMarkup(h(ToolCard, { toolName: 'pdf_read', block: settledBlock, sessionId: 's1' }))
check('the card names the document', cardMarkup.includes('data-pdf-card="pdf_read"') && cardMarkup.includes('report.pdf'))
check('the card shows what the host reported', cardMarkup.includes('12 pages') && cardMarkup.includes('layout text') && cardMarkup.includes('from cache'))
check('the card flags pages with no text layer', cardMarkup.includes('2 page(s) without text') && cardMarkup.includes('data-warn="true"'))
check('the card previews the answer', cardMarkup.includes('pages 1-5 of 12 (layout mode)'))
check('the card offers the tab', cardMarkup.includes('data-pdf-open="dsh-resource://file/session/s1/report.pdf"') && cardMarkup.includes('Open tab'))
const pdfRunningMarkup = renderToStaticMarkup(h(ToolCard, { toolName: 'pdf_read', block: { argsRaw: '{"path":"report.pdf"}' }, sessionId: 's1' }))
check('a running call says so', pdfRunningMarkup.includes('working…'))
// The pdf_scan card: what was recognized, with the engine and the resolution,
// and the warning that this is a transcription rather than extracted text.
const ScanCard = pdfSeats['tool.call.toolview#pdf_scan'].component
const scanCardMarkup = renderToStaticMarkup(
  h(ScanCard, {
    toolName: 'pdf_scan',
    block: {
      kind: 'tool-result',
      call: { name: 'pdf_scan', argsRaw: '{"path":"scan.pdf"}' },
      meta: {
        file: 'C:/work/scan.pdf',
        name: 'scan.pdf',
        address: 'dsh-resource://file/session/s1/scan.pdf',
        pages: 4,
        mode: 'ocr',
        dpi: 200,
        ocr: { engine: 'tesseract', lang: 'eng', dpi: 200, pages: [1, 2] },
      },
      content: [{ type: 'text', text: 'Recognized 2 pages of scan.pdf with tesseract (eng, 200 dpi, psm 3)' }],
    },
    sessionId: 's1',
  }),
)
check('the scan card names the engine and pages', scanCardMarkup.includes('recognized 1, 2 with tesseract (eng, 200 dpi)'))
check('the scan card warns it is a transcription', scanCardMarkup.includes('transcription, not extracted text'))
check('the scan card opens the tab', scanCardMarkup.includes('data-pdf-open="dsh-resource://file/session/s1/scan.pdf"'))

// ---------------------------------------------------------------- dsh-image
const image = loadBundle('packages/dsh-image/lib/client.js', {})
const imageCssTag = image.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-image/image.css').pop()
const imageCss = imageCssTag ? imageCssTag.textContent : ''
const imageSource = readFileSync(path.join(repo, 'packages/dsh-image/lib/client.js'), 'utf8')
check('image bundle id', image.id, 'dsh-image')
check('image inject', JSON.stringify(image.exports.inject), '["slots","sidebarRightTabs","remote.workspaceFiles"]')
check('image stylesheet injected', imageCss.includes('.dsi-root{') && imageCss.includes('.dsi-tools{'))
// The toolbar is this tab's top bar: the same 38px border-box pane header the
// Files tab, the document preview, the editor, History, Diagrams and the PDF
// reader use, so every column's first hairline lands on the same y=76 line.
check(
  'image top bar is the 38px pane header',
  imageCss.includes('.dsi-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;'),
)
// The zoom is a LAYOUT size on a box inside a scrollable pane, never a CSS
// transform: a transform would scale into a clipped box with no scrollable
// area, which is the bug the pack's diagram viewer shipped first.
check(
  'the zoom moves the layout, never a transform',
  imageSource.includes("style: natural ? { width: width + 'px', height: height + 'px' } : undefined") &&
    imageCss.includes('.dsi-box{flex:none;margin:auto;') &&
    imageCss.includes("transform:") === false,
)
check('the picture box is the pane-centred one', imageCss.includes('margin:auto;position:relative;box-sizing:border-box'))
// Transparency is shown as transparency, and past 300% the picture is drawn
// with nearest-neighbour sampling so pixel-peeping is honest.
check(
  'a checkerboard sits behind the picture',
  imageCss.includes('.dsi-box{') && imageCss.includes('background-image:linear-gradient(45deg,rgba(127,127,127,.22) 25%'),
)
check(
  'past 300% the picture is pixelated',
  imageSource.includes('const PIXELATED_AT = 3') &&
    imageSource.includes("'data-pixelated': pixelated ? 'true' : undefined") &&
    imageCss.includes('image-rendering:pixelated'),
)
// Panning is the pane's own scroll, offered only when it was MEASURED, and the
// grab cursor follows that measurement rather than an assumption.
check(
  'panning is real overflow measured, then scroll',
  imageSource.includes('canvas.scrollWidth > canvas.clientWidth + 1') &&
    imageCss.includes('.dsi-canvas[data-pannable="true"]{cursor:grab}') &&
    imageCss.includes('.dsi-canvas[data-panning="true"]{cursor:grabbing') &&
    imageSource.includes('canvas.scrollLeft = origin.left - (event.clientX - origin.x)'),
)
// Ctrl/Cmd + wheel zooms ANCHORED AT THE POINTER. The listener must be native
// and non-passive: React's own wheel listener is passive, so a preventDefault
// inside it does nothing and the browser's Ctrl+wheel page zoom fires too.
check(
  'wheel zoom is a non-passive listener at the pointer',
  imageSource.includes("canvas.addEventListener('wheel', listener, { passive: false })") &&
    imageSource.includes('if (!event.ctrlKey && !event.metaKey) return') &&
    imageSource.includes('moveTo(scaleRef.current * factor, { x: event.clientX, y: event.clientY })'),
)
// A trackpad pinch is a STREAM of wheel events that all land before the next
// render, so the handler must read a ref written synchronously by every move;
// reading the `scale` state would compute each step from the same base and the
// gesture would under-zoom badly.
check(
  'a pinch compounds on a synchronous zoom ref',
  imageSource.includes('const scaleRef = useRef(1)') &&
    imageSource.includes('scaleRef.current = clamped') &&
    imageSource.includes("const current = scaleRef.current"),
)
check(
  'a zoom keeps the point the reader was looking at',
  imageSource.includes('fx: (canvas.scrollLeft + px) / Math.max(1, canvas.scrollWidth)') &&
    imageSource.includes('element.scrollLeft = mark.fx * element.scrollWidth - mark.px') &&
    imageSource.includes('window.requestAnimationFrame(restore)'),
)
check(
  'the zoom ladder runs 5% to 800% with fit and 1:1',
  imageSource.includes('const ZOOM_STEPS = [0.05, 0.1, 0.17, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8]') &&
    imageSource.includes('const FIT_PADDING = 24') &&
    imageSource.includes("'data-image-action': 'fit'") &&
    imageSource.includes("'data-image-action': 'actual'"),
)
// The pointer readout samples a ONE-PIXEL canvas, so inspecting a large
// photograph never copies the picture into a second buffer.
check(
  'the pixel readout samples through a 1x1 canvas',
  imageSource.includes('const PIXEL_SAMPLE_PX = 1') &&
    imageSource.includes('context.drawImage(image, x, y, 1, 1, 0, 0, 1, 1)') &&
    imageSource.includes("'data-image-pixel': pixel.x + ',' + pixel.y"),
)
// Bytes come from the harness's own workspaceFiles remote - the call already
// enforces the path policy and the byte cap on the HOST side - so this package
// has no route, no fetch, and no policy of its own to get wrong.
check(
  'bytes come from the shipped remote, not a route of its own',
  imageSource.includes("const REMOTE_NAMESPACE = 'remote.workspaceFiles'") &&
    imageSource.includes('workspaceFiles\n          .readAll(sessionId, parsed.path, controller.signal)') &&
    imageSource.includes('fetch(') === false &&
    imageSource.includes("'/api/") === false,
)
check(
  'the read is aborted and its blob URL revoked',
  imageSource.includes('const controller = new AbortController()') &&
    imageSource.includes('controller.abort()') &&
    imageSource.includes('URL.revokeObjectURL(objectUrl)'),
)
check('the base64 decode is one indexed loop', imageSource.includes('bytes[index] = binary.charCodeAt(index)'))

const imageTypes = []
const imageSeats = {}
image.exports.apply({
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      imageSeats[spec.name + (spec.key ? '#' + spec.key : '')] = { spec, component }
      return () => {}
    },
  },
  sidebarRightTabs: { register: (definition) => (imageTypes.push(definition), () => {}), entries: () => [] },
  remote: { workspaceFiles: { readAll: () => Promise.resolve({ ok: false, error: { code: 'workspace-file/not-file' } }) } },
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('image type registered', imageTypes.length === 1 && imageTypes[0].id + '/' + imageTypes[0].kind, 'dsh-image/image')
check('image outranks the shipped preview band', imageTypes[0].priority, 'extension')
check(
  'image claims exactly the image suffixes',
  JSON.stringify(imageTypes[0].patterns),
  '["*.png","*.apng","*.jpg","*.jpeg","*.jpe","*.jfif","*.gif","*.webp","*.avif","*.bmp","*.ico","*.svg","*.tif","*.tiff"]',
)
check(
  'image canOpen takes images and refuses everything else',
  imageTypes[0].canOpen('dsh-resource://file/session/s1/docs/shot.PNG') === true &&
    imageTypes[0].canOpen('dsh-resource://file/session/s1/docs/photo.jpeg') === true &&
    imageTypes[0].canOpen('dsh-resource://file/session/s1/drawings/plan.svg') === true &&
    imageTypes[0].canOpen('dsh-resource://file/session/s1/notes.txt') === false &&
    imageTypes[0].canOpen('dsh-resource://file/absolute/C:/tmp/shot.png') === false &&
    imageTypes[0].canOpen('dsh-resource://pdf/absolute/x.png') === false,
)
check('the image chip title is the file name', imageTypes[0].title('dsh-resource://file/session/s1/docs/shot.png'), 'shot.png')
// A blank image is not a document anyone opens from the "+" control, so this
// type adds no guide capsule - it only ever claims a real file address.
check('the image type adds no guide entry', imageTypes[0].guide === undefined)
check(
  'image seats',
  Object.keys(imageSeats).sort().join(','),
  'sidebar.right.pane.tab#dsh-image,sidebar.right.pane.tab.title#dsh-image',
)
const ImageBody = imageSeats['sidebar.right.pane.tab#dsh-image'].component
const imageTab = { id: 'tab9', contentId: 'dsh-resource://file/session/s1/shots/hero%20image.png', title: 'hero image.png' }
const imageMarkup = renderToStaticMarkup(h(ImageBody, { useTabInfo: () => ({ tab: imageTab }), sessionId: 's1' }))
check('image body renders its opening state', imageMarkup.includes('data-image-state="loading"') && imageMarkup.includes('Opening the image'))
check('the opening state names the file it is opening', imageMarkup.includes('s1/shots/hero image.png'))
check(
  'image title seat draws the chip',
  renderToStaticMarkup(h(imageSeats['sidebar.right.pane.tab.title#dsh-image'].component, { useTabInfo: () => ({ tab: imageTab }) })),
  '<span class="dsi-title">hero image.png</span>',
)
const imageNoTabMarkup = renderToStaticMarkup(h(ImageBody, { useTabInfo: () => ({ tab: { id: 'tab10', contentId: '' } }), sessionId: 's1' }))
check('an address-less image tab still renders', imageNoTabMarkup.includes('data-image-state="loading"'))

// ---------------------------------------------------------------- dsh-audio
//
// The audio bundle is the pack's one surface whose real work is ARITHMETIC: a
// WAV/AIFF decoder and a peak pyramid. Neither can be exercised through a
// static render (the decode runs in an effect the server renderer never runs),
// so the bundle exposes its pure half as `__internals` and this section builds
// the FILES - a RIFF/WAVE, an IFF FORM, a FLAC - by hand and asserts the
// numbers that come back out of them. Nothing here needs ffmpeg, sox, a
// browser or a fixture on disk.

/** One RIFF/WAVE file, built by hand. `sample` writes its own sample bytes. */
function buildWav(options) {
  const channels = options.channels === undefined ? 1 : options.channels
  const bits = options.bits === undefined ? 16 : options.bits
  const rate = options.rate === undefined ? 44100 : options.rate
  const frames = options.frames === undefined ? 1000 : options.frames
  const kind = options.kind === undefined ? 'pcm' : options.kind
  const extensible = options.extensible === true
  const bytesPerSample = Math.ceil(bits / 8)
  const blockAlign = channels * bytesPerSample
  const dataBytes = frames * blockAlign
  const tag = kind === 'float' ? 3 : kind === 'alaw' ? 6 : kind === 'ulaw' ? 7 : kind === 'adpcm' ? 0x11 : 1
  const fmtSize = extensible ? 40 : 16
  const bytes = new Uint8Array(28 + fmtSize + dataBytes)
  const view = new DataView(bytes.buffer)
  const text = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
  }
  text(0, 'RIFF')
  view.setUint32(4, bytes.length - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, fmtSize, true)
  view.setUint16(20, extensible ? 0xfffe : tag, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bits, true)
  if (extensible) {
    view.setUint16(36, 22, true)
    view.setUint16(38, bits, true)
    view.setUint32(40, 3, true)
    view.setUint16(44, tag, true)
  }
  const dataHeader = 20 + fmtSize
  text(dataHeader, 'data')
  view.setUint32(dataHeader + 4, options.declaredDataBytes === undefined ? dataBytes : options.declaredDataBytes, true)
  const dataStart = dataHeader + 8
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const at = dataStart + frame * blockAlign + channel * bytesPerSample
      if (options.sample !== undefined) {
        options.sample(bytes, view, at, frame, channel)
        continue
      }
      const sine = Math.round(Math.sin((2 * Math.PI * 1000 * frame) / rate) * 16384)
      if (bits === 8) view.setUint8(at, 128 + (sine >> 8))
      else if (bits === 16) view.setInt16(at, sine, true)
      else if (bits === 24) {
        view.setUint8(at, sine & 0xff)
        view.setUint8(at + 1, (sine >> 8) & 0xff)
        view.setUint8(at + 2, (sine >> 16) & 0xff)
      } else if (bits === 32) view.setInt32(at, sine * 65536, true)
    }
  }
  return bytes
}

/** The 80-bit IEEE extended float AIFF states a sample rate with. */
function writeExtended80(view, offset, value) {
  const TWO63 = 9223372036854775808
  let exponent = 16383 + 63
  let mantissa = value < 0 ? -value : value
  while (mantissa < TWO63 && exponent > 0) {
    mantissa *= 2
    exponent -= 1
  }
  const high = Math.floor(mantissa / 4294967296)
  view.setUint16(offset, (value < 0 ? 0x8000 : 0) | exponent, false)
  view.setUint32(offset + 2, high, false)
  view.setUint32(offset + 6, mantissa - high * 4294967296, false)
}

/** One IFF FORM (AIFF, or AIFC with a compression type), built by hand. */
function buildAiff(options) {
  const channels = options.channels === undefined ? 1 : options.channels
  const bits = options.bits === undefined ? 16 : options.bits
  const rate = options.rate === undefined ? 44100 : options.rate
  const frames = options.frames === undefined ? 100 : options.frames
  const compression = options.compression === undefined ? '' : options.compression
  const bytesPerSample = Math.ceil(bits / 8)
  const blockAlign = channels * bytesPerSample
  const dataBytes = frames * blockAlign
  const commSize = compression === '' ? 18 : 23 // AIFC adds the type + a name
  const commPadded = commSize + (commSize & 1)
  const ssndSize = 8 + dataBytes
  const bytes = new Uint8Array(12 + 8 + commPadded + 8 + ssndSize)
  const view = new DataView(bytes.buffer)
  const text = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
  }
  text(0, 'FORM')
  view.setUint32(4, bytes.length - 8, false)
  text(8, compression === '' ? 'AIFF' : 'AIFC')
  text(12, 'COMM')
  view.setUint32(16, commSize, false)
  const comm = 20
  view.setInt16(comm, channels, false)
  view.setUint32(comm + 2, frames, false)
  view.setInt16(comm + 6, bits, false)
  writeExtended80(view, comm + 8, rate)
  if (compression !== '') {
    text(comm + 18, compression)
    bytes[comm + 22] = 0 // an empty compression name
  }
  const ssnd = 20 + commPadded
  text(ssnd, 'SSND')
  view.setUint32(ssnd + 4, ssndSize, false)
  const dataStart = ssnd + 16
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const at = dataStart + frame * blockAlign + channel * bytesPerSample
      const value = Math.round(Math.sin((2 * Math.PI * 1000 * frame) / rate) * 12000)
      if (options.sample !== undefined) options.sample(bytes, view, at, frame, channel)
      else if (bits === 8) view.setInt8(at, value >> 8)
      else if (bits === 16) view.setInt16(at, value, compression === 'sowt')
      else if (bits === 24) {
        view.setUint8(at, (value >> 16) & 0xff)
        view.setUint8(at + 1, (value >> 8) & 0xff)
        view.setUint8(at + 2, value & 0xff)
      }
    }
  }
  return bytes
}

/** One FLAC stream: a STREAMINFO block and a Vorbis comment, built by hand. */
function buildFlac(options) {
  const vendor = 'vn-harness-check'
  const entry = 'TITLE=' + (options.title === undefined ? 'Test' : options.title)
  const comments = new Uint8Array(12 + vendor.length + entry.length)
  const commentView = new DataView(comments.buffer)
  commentView.setUint32(0, vendor.length, true)
  for (let index = 0; index < vendor.length; index += 1) comments[4 + index] = vendor.charCodeAt(index)
  commentView.setUint32(4 + vendor.length, 1, true)
  commentView.setUint32(8 + vendor.length, entry.length, true)
  for (let index = 0; index < entry.length; index += 1) comments[12 + vendor.length + index] = entry.charCodeAt(index)
  const bytes = new Uint8Array(4 + 4 + 34 + 4 + comments.length)
  const view = new DataView(bytes.buffer)
  const text = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index)
  }
  text(0, 'fLaC')
  bytes[4] = 0 // STREAMINFO, not the last block
  bytes[7] = 34
  view.setUint16(8, 4096, false)
  view.setUint16(10, 4096, false)
  const high =
    (((options.rate & 0xfffff) << 12) | (((options.channels - 1) & 7) << 9) | (((options.bits - 1) & 31) << 4) | Math.floor(options.total / 4294967296)) >>> 0
  view.setUint32(18, high, false)
  view.setUint32(22, options.total % 4294967296, false)
  bytes[42] = 0x80 | 4 // VORBIS_COMMENT, the last block
  const size = comments.length
  bytes[43] = (size >> 16) & 0xff
  bytes[44] = (size >> 8) & 0xff
  bytes[45] = size & 0xff
  bytes.set(comments, 46)
  return bytes
}

const audio = loadBundle('packages/dsh-audio/lib/client.js', {})
const audioCssTag = audio.document.head.children.filter((tag) => tag.dataset && tag.dataset.pluginCss === 'dsh-audio/audio.css').pop()
const audioCss = audioCssTag ? audioCssTag.textContent : ''
const audioSource = readFileSync(path.join(repo, 'packages/dsh-audio/lib/client.js'), 'utf8')
const A = audio.exports.__internals
check('audio bundle id', audio.id, 'dsh-audio')
check('audio inject', JSON.stringify(audio.exports.inject), '["slots","sidebarRightTabs","remote.workspaceFiles"]')
check('audio stylesheet injected', audioCss.includes('.dsa-root{') && audioCss.includes('.dsa-tools{'))
check(
  'audio top bar is the 38px pane header',
  audioCss.includes('.dsa-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;'),
)
// The zoom is a LAYOUT width - the scrollable spacer is the file's duration
// times the pixels per second - never a CSS transform, and the canvas that
// paints the waveform is VIEWPORT-ANCHORED over it, because a canvas cannot be
// hundreds of thousands of pixels wide.
check(
  'the zoom moves the layout, never a transform',
  audioSource.includes("style: { width: contentWidth + 'px', height: contentHeight + 'px' }") &&
    audioCss.includes('.dsa-spacerBox{position:relative}') &&
    audioSource.includes('const totalPx = Math.max(1, Math.round(duration * pxPerSecond))') &&
    audioCss.includes('transform:') === false,
)
check('the canvas is viewport-anchored over the file-wide spacer', audioCss.includes('.dsa-canvas{position:sticky;left:0;'))
check(
  'a zoom keeps the time under the anchor',
  audioSource.includes('const timeAtAnchor = (scroller.scrollLeft + anchorX - GUTTER) / current') &&
    audioSource.includes('element.scrollLeft = Math.max(0, GUTTER + timeAtAnchor * clamped - anchorX)') &&
    audioSource.includes('window.requestAnimationFrame(restore)'),
)
// Ctrl/Cmd + wheel zooms at the POINTER, and the listener must be native and
// non-passive: React's own wheel listener is passive, so a preventDefault
// inside it does nothing and the browser's Ctrl+wheel page zoom fires too.
check(
  'wheel zoom is a non-passive listener at the pointer',
  audioSource.includes("scroller.addEventListener('wheel', listener, { passive: false })") &&
    audioSource.includes('zoomTo(ppsRef.current * factor, { x: event.clientX, y: event.clientY })') &&
    audioSource.includes('if (event.shiftKey) {'),
)
// A trackpad pinch is a STREAM of wheel events that all land before the next
// render, so the handler must read a ref written synchronously by every move;
// reading the `pxPerSecond` state would compute every step from the same base
// and the gesture would under-zoom badly (the bug dsh-image shipped once).
check(
  'a pinch compounds on a synchronous zoom ref',
  audioSource.includes('const ppsRef = useRef(MIN_PPS)') &&
    audioSource.includes('ppsRef.current = clamped') &&
    audioSource.includes('const current = ppsRef.current'),
)
// The cursor says what a press would do where it is: the ruler pans, a lane
// selects. A static grab cursor over a waveform that selects is a promise the
// surface does not keep.
check(
  'the cursor follows what a press would do there',
  audioSource.includes("canvas.style.cursor = 'grabbing'") &&
    audioSource.includes("canvas.style.cursor = 'ew-resize'") &&
    audioSource.includes("? 'grab' : 'crosshair'"),
)
// A re-read is a new viewer: a stale playback buffer is the bug this key stops.
check('a re-read resets the viewer', audioSource.includes("key: 'dsh-audio-load-' + reload"))
// The playhead is the AUDIO CLOCK's own position, not a CSS animation, so the
// line cannot drift away from the sound.
check(
  'the playhead follows the AudioContext clock',
  audioSource.includes('const elapsed = current.context.currentTime - current.startedAt') &&
    audioSource.includes('source.start(0, start)'),
)
check('the two amplitude scales are both real', audioSource.includes('const DB_RANGE = 72') && audioSource.includes("dbMode ? 'dBFS' : 'linear'"))
check(
  'individual samples are drawn as stems once they are big enough on screen',
  audioSource.includes('const STEM_PX_PER_SAMPLE = 3') && audioSource.includes('if (stems) {'),
)
// Bytes come from the harness's own workspaceFiles remote, read in WINDOWS so a
// file far past the single-read cap still draws - and the package ships no
// route of its own to re-implement the path policy with.
check(
  'audio streams the file through the shipped remote, not a route of its own',
  audioSource.includes("const REMOTE_NAMESPACE = 'remote.workspaceFiles'") &&
    audioSource.includes('workspaceFiles.readBytes(sessionId, path, { offset: offset, length: size }, signal)') &&
    audioSource.includes('workspaceFiles.readAll(sessionId, path, signal)') &&
    audioSource.includes('fetch(') === false &&
    audioSource.includes("'/api/") === false,
)
check(
  'a refused window teaches the host cap instead of truncating the read',
  audioSource.includes("code !== 'workspace-file/too-large' && code !== 'gateway/bad-request'") &&
    audioSource.includes("typeof error.details.limit === 'number'") &&
    audioSource.includes('size = Math.max(WINDOW_FLOOR, smaller)'),
)
check(
  'the read is aborted when the tab goes away',
  audioSource.includes('const controller = new AbortController()') &&
    audioSource.includes('controller.abort()') &&
    audioSource.includes('const binary = atob(String(base64))') &&
    audioSource.includes('bytes[index] = binary.charCodeAt(index)'),
)
check(
  'a FLAC past the single-read cap keeps its facts and says so',
  audioSource.includes('drawing its waveform means handing the whole file to the browser in one read') &&
    audioSource.includes('parseFlacInfo(bytes)'),
)
check('the peak pyramid starts at 256 samples and quadruples', A.BASE_BUCKET === 256 && A.LEVEL_FACTOR === 4)
// The header probe has to read PAST one window: a WAV with a large LIST/ID3
// chunk (embedded cover art) before its `data` is a chunk walk the first window
// cuts in half, and a walk that never finishes must say so rather than report a
// format it never reached.
check(
  'the header probe reads past one window, up to a ceiling',
  audioSource.includes('const PROBE_CEILING = 8 * 1024 * 1024') &&
    audioSource.includes('length = Math.min(ceiling, length * PROBE_GROWTH)') &&
    audioSource.includes('async function readPrefix(') &&
    audioSource.includes('so its format was never reached'),
)

// --- the WAV container, and the decoder behind it
const wavBytes = buildWav({ rate: 44100, channels: 1, bits: 16, frames: 2000 })
const wav = A.parseWav(wavBytes, wavBytes.length)
check(
  'a RIFF/WAVE header parses into facts',
  wav.ok === true && wav.sampleRate === 44100 && wav.channels === 1 && wav.bits === 16 && wav.format.kind === 's16' && wav.dataOffset === 44,
)
check('the frame count is the data chunk over the block align', wav.frames === 2000 && Math.abs(wav.duration - 2000 / 44100) < 1e-12)
const wavDecoded = A.decodePcm(wav.format, wavBytes.subarray(wav.dataOffset))
check('the decoder returns one Float32Array per channel', wavDecoded.channels.length === 1 && wavDecoded.frames === 2000 && wavDecoded.channels[0] instanceof Float32Array)
let wavPeak = 0
for (let index = 0; index < wavDecoded.channels[0].length; index += 1) {
  const magnitude = Math.abs(wavDecoded.channels[0][index])
  if (magnitude > wavPeak) wavPeak = magnitude
}
// 16384 of a signed 16-bit full scale is a half-scale sine, and 44.1 samples
// per cycle at 1 kHz means the nearest sample sits just under the crest.
check('a half-scale 16-bit sine decodes to a half-scale envelope', wavPeak > 0.495 && wavPeak <= 0.5)

// A known silence is silence: the second half of this file is exactly zero.
const gapsBytes = buildWav({
  rate: 8000,
  channels: 1,
  bits: 16,
  frames: 1600,
  sample(bytes, view, at, frame) {
    view.setInt16(at, frame < 800 ? 8000 : 0, true)
  },
})
const gapsFacts = A.parseWav(gapsBytes, gapsBytes.length)
const gaps = A.decodePcm(gapsFacts.format, gapsBytes.subarray(gapsFacts.dataOffset)).channels[0]
let silentTail = true
for (let index = 800; index < 1600; index += 1) if (gaps[index] !== 0) silentTail = false
let headSquares = 0
for (let index = 0; index < 800; index += 1) headSquares += gaps[index] * gaps[index]
check('a DC half then real silence decodes exactly', silentTail && gaps[0] === 8000 / 32768 && Math.abs(Math.sqrt(headSquares / 800) - 8000 / 32768) < 1e-9)

// 24-bit stereo: the two's-complement edges are the values a viewer can get
// wrong by one LSB.
const rampBytes = buildWav({
  channels: 2,
  bits: 24,
  frames: 3,
  sample(bytes, view, at, frame, channel) {
    const value = frame === 0 ? (channel === 0 ? 0x7fffff : -0x800000) : frame === 1 ? 0 : 0x400000
    bytes[at] = value & 0xff
    bytes[at + 1] = (value >> 8) & 0xff
    bytes[at + 2] = (value >> 16) & 0xff
  },
})
const rampFacts = A.parseWav(rampBytes, rampBytes.length)
const ramp = A.decodePcm(rampFacts.format, rampBytes.subarray(rampFacts.dataOffset))
check('24-bit stereo is read as 24-bit with a 6-byte frame', rampFacts.format.kind === 's24' && rampFacts.channels === 2 && rampFacts.blockAlign === 6)
check(
  '24-bit two\u2019s-complement edges decode to their exact ratios',
  ramp.channels[0][0] === 8388607 / 8388608 && ramp.channels[1][0] === -1 && ramp.channels[0][1] === 0 && ramp.channels[0][2] === 0.5,
)

// IEEE float is NOT clamped by the decoder: the value in the file is the value
// reported, and it is the DRAWING that clamps.
const floatBytes = buildWav({
  bits: 32,
  kind: 'float',
  frames: 2,
  sample(bytes, view, at, frame) {
    view.setFloat32(at, frame === 0 ? 0.25 : -1.5, true)
  },
})
const floatFacts = A.parseWav(floatBytes, floatBytes.length)
const floats = A.decodePcm(floatFacts.format, floatBytes.subarray(floatFacts.dataOffset))
check('IEEE float WAVE decodes unclamped', floatFacts.format.kind === 'f32' && floats.channels[0][0] === 0.25 && floats.channels[0][1] === -1.5)

// WAVE_FORMAT_EXTENSIBLE states its real format in the sub-format GUID.
const extensibleBytes = buildWav({ bits: 24, extensible: true, frames: 4 })
const extensibleFacts = A.parseWav(extensibleBytes, extensibleBytes.length)
check(
  'a WAVE_FORMAT_EXTENSIBLE header is read through its sub-format',
  extensibleFacts.ok === true && extensibleFacts.format.kind === 's24' && extensibleFacts.format.extensible === true && extensibleFacts.format.validBits === 24,
)

// The companded laws, against their canonical identities.
check(
  'the G.711 laws decode their own zero and full-scale codes',
  A.ulawToLinear(0xff) === 0 && A.ulawToLinear(0) === -32124 && A.alawToLinear(0x55) === -8 && A.alawToLinear(0xd5) === 8 && A.alawToLinear(0x2a) === -32256,
)
const alawBytes = buildWav({
  bits: 8,
  kind: 'alaw',
  frames: 2,
  sample(bytes, view, at, frame) {
    bytes[at] = frame === 0 ? 0x55 : 0x2a
  },
})
const alawFacts = A.parseWav(alawBytes, alawBytes.length)
const alaw = A.decodePcm(alawFacts.format, alawBytes.subarray(alawFacts.dataOffset))
check('A-law WAVE audio is decoded through the table', alawFacts.format.kind === 'alaw' && alaw.channels[0][0] === -8 / 32768 && alaw.channels[0][1] === -32256 / 32768)

// A truncated file draws what exists and says the rest is UNKNOWN, not silent.
const cutBytes = buildWav({ frames: 2000 }).slice(0, 44 + 1000)
const cut = A.parseWav(cutBytes, cutBytes.length)
check('a truncated WAVE reports the tail as unknown', cut.ok === true && cut.truncated === true && cut.frames === 500 && cut.declaredDataBytes === 4000)

// A codec this package does not decode is NAMED rather than drawn as noise.
const adpcmBytes = buildWav({ kind: 'adpcm', bits: 4, frames: 8 })
const adpcm = A.parseWav(adpcmBytes, adpcmBytes.length)
check('an unsupported WAVE codec is refused by name', adpcm.ok === false && adpcm.reason.includes('IMA ADPCM'))
const other = A.parseContainer(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), 12)
check('something that is not audio at all is refused in a sentence', other.ok === false && other.reason.includes('not a RIFF/WAVE'))

// --- the AIFF container (the format a browser will not decode for us)
const aiffBytes = buildAiff({ rate: 44100, channels: 1, bits: 16, frames: 500 })
const aiff = A.parseAiff(aiffBytes, aiffBytes.length)
check(
  'an AIFF header parses, sample rate and all',
  aiff.ok === true && aiff.sampleRate === 44100 && aiff.channels === 1 && aiff.bits === 16 && aiff.format.kind === 's16' && aiff.format.endian === 'be' && aiff.frames === 500,
)
const aiffDecoded = A.decodePcm(aiff.format, aiffBytes.subarray(aiff.dataOffset))
let aiffPeak = 0
for (let index = 0; index < aiffDecoded.channels[0].length; index += 1) {
  const magnitude = Math.abs(aiffDecoded.channels[0][index])
  if (magnitude > aiffPeak) aiffPeak = magnitude
}
// Big-endian: reading these bytes little-endian would give a large, wrong
// number rather than a plausible one, which is exactly what this pins.
check('big-endian AIFF samples decode to their signed value', aiffPeak > 0.36 && aiffPeak <= 12000 / 32768)
const sowtBytes = buildAiff({ compression: 'sowt', bits: 16, frames: 200 })
const sowt = A.parseAiff(sowtBytes, sowtBytes.length)
check(
  'an AIFC sowt keeps its little-endian samples straight',
  sowt.ok === true && sowt.container === 'AIFC (IFF FORM)' && sowt.format.kind === 's16' && sowt.format.endian === 'le' && sowt.sampleRate === 44100,
)
const aiff8 = A.parseAiff(buildAiff({ bits: 8, frames: 100 }), 12 + 8 + 18 + 8 + 8 + 100)
check('8-bit AIFF is SIGNED, unlike 8-bit WAVE', aiff8.ok === true && aiff8.format.kind === 's8')
const imaBytes = buildAiff({ compression: 'ima4', bits: 16, frames: 100 })
const ima = A.parseAiff(imaBytes, imaBytes.length)
check('an AIFC codec this viewer cannot decode is refused by name', ima.ok === false && ima.reason.includes('IMA 4:1 ADPCM'))

// --- the FLAC container's own facts
const flacBytes = buildFlac({ rate: 48000, channels: 2, bits: 16, total: 96000, title: 'Tone' })
const flac = A.parseFlacInfo(flacBytes)
check(
  'a FLAC STREAMINFO block parses into facts',
  flac.ok === true && flac.sampleRate === 48000 && flac.channels === 2 && flac.bits === 16 && flac.frames === 96000 && flac.duration === 2,
)
check('a FLAC says which decoder will draw it', flac.format.compressed === true && flac.codec.includes('browser-decoded'))
check('a FLAC\u2019s Vorbis comment is read for its tags', flac.metadata.title === 'Tone')
check('the container is recognized from its magic, not its name', A.parseContainer(flacBytes, flacBytes.length).container === 'FLAC')

// --- the peak pyramid
const wave = new Float32Array(1024)
for (let index = 0; index < 256; index += 1) wave[index] = 0.5
for (let index = 256; index < 512; index += 1) wave[index] = -0.25
const whole = new A.PeakSet(1, 1024)
whole.push([wave])
whole.finish()
const split = new A.PeakSet(1, 1024)
split.push([wave.subarray(0, 300)])
split.push([wave.subarray(300, 700)])
split.push([wave.subarray(700)])
split.finish()
check('level 0 is one bucket per 256 samples', whole.levels[0].bucket === 256 && whole.levels[0].count === 4)
check(
  'a bucket is the (min, max, rms) of the samples in it',
  whole.levels[0].maxs[0][0] === 0.5 && whole.levels[0].mins[0][0] === 0.5 && whole.levels[0].rmss[0][0] === 0.5 && whole.levels[0].mins[0][1] === -0.25 && whole.levels[0].rmss[0][1] === 0.25 && whole.levels[0].rmss[0][2] === 0,
)
// The pyramid's buckets are Float32Arrays, so a decimated RMS is compared
// against its exact value with the storage's own tolerance (float32 rounding is
// ~4e-9 here), not a double's.
check(
  'a decimated level groups four buckets, RMS and all',
  whole.levels[1].bucket === 1024 &&
    whole.levels[1].count === 1 &&
    whole.levels[1].maxs[0][0] === 0.5 &&
    whole.levels[1].mins[0][0] === -0.25 &&
    Math.abs(whole.levels[1].rmss[0][0] - Math.sqrt((0.25 + 0.0625) / 4)) < 1e-6,
)
// This is the claim the windowed decode rests on: feeding the samples in
// windows builds the SAME pyramid as feeding them in one block. A window
// boundary that split a bucket would break it.
check(
  'a windowed decode builds the same pyramid as a whole one',
  split.levels[0].count === whole.levels[0].count &&
    split.levels[0].rmss[0][1] === whole.levels[0].rmss[0][1] &&
    split.levels[0].maxs[0][0] === whole.levels[0].maxs[0][0] &&
    split.levels[1].rmss[0][0] === whole.levels[1].rmss[0][0],
)
check('the level read is the largest one that fits a pixel', A.pickLevel(whole, 100).bucket === 256 && A.pickLevel(whole, 1024).bucket === 1024 && A.pickLevel(whole, 9e6).bucket === 1024)
const column = A.columnEnvelope(whole.levels[0], 0, 0, 256)
check('a pixel column aggregates the buckets under it', column !== null && column.max === 0.5 && column.rms === 0.5)

// --- the ruler, the readouts and the addresses
check('the ruler picks a 1-2-5 step that fits its labels', A.tickStepFor(100, 64) === 1 && A.tickStepFor(10, 64) === 10 && A.tickStepFor(1000, 64) === 0.1 && A.tickStepFor(500000, 64) === 0.0002)
check('times read as m:ss.mmm, with the hours only when there are any', A.formatTime(0) === '0:00.000' && A.formatTime(221.512) === '3:41.512' && A.formatTime(3725.5) === '1:02:05.500')
check(
  'dBFS is 20 log10, and real silence says so',
  A.formatDb(1) === '0.0 dBFS' && A.formatDb(0.5) === '-6.0 dBFS' && A.formatDb(0) === 'silent' && Math.abs(A.amplitudeToDb(0.25) + 12.0412) < 0.001,
)
check(
  'channels are named L/R for a stereo pair, M for mono, numbers past that',
  A.channelLabel(0, 2) === 'L' && A.channelLabel(1, 2) === 'R' && A.channelLabel(0, 1) === 'M' && A.channelLabel(3, 6) === '4',
)
check(
  'audio canOpen takes the three families and refuses everything else',
  A.isAudioAddress('dsh-resource://file/session/s1/takes/take%2001.WAV') === true &&
    A.isAudioAddress('dsh-resource://file/session/s1/takes/take.flac') === true &&
    A.isAudioAddress('dsh-resource://file/session/s1/takes/take.aifc') === true &&
    A.isAudioAddress('dsh-resource://file/session/s1/song.mp3') === false &&
    A.isAudioAddress('dsh-resource://file/session/s1/notes.txt') === false &&
    A.isAudioAddress('dsh-resource://file/absolute/C:/tmp/take.wav') === false &&
    A.isAudioAddress('dsh-resource://pdf/absolute/x.wav') === false,
)
check('the address parser keeps a Windows drive segment whole', A.parseAudioAddress('dsh-resource://file/session/s1/C:/audio/take.wav').path, 'C:/audio/take.wav')

// --- activation, the tab type and the seats
const audioTypes = []
const audioSeats = {}
audio.exports.apply({
  slots: {
    inject: (name, fn) => fn(),
    register(spec, component) {
      audioSeats[spec.name + (spec.key ? '#' + spec.key : '')] = { spec, component }
      return () => {}
    },
  },
  sidebarRightTabs: { register: (definition) => (audioTypes.push(definition), () => {}), entries: () => [] },
  get: () => ({ readBytes: () => Promise.resolve({ ok: false, error: { code: 'workspace-file/not-found' } }) }),
  effect: (fn) => fn(),
  logger: { debug() {}, warn() {} },
})
check('audio type registered', audioTypes.length === 1 && audioTypes[0].id + '/' + audioTypes[0].kind, 'dsh-audio/audio')
check('audio outranks the shipped preview band', audioTypes[0].priority, 'extension')
check('audio claims exactly the three families', JSON.stringify(audioTypes[0].patterns), '["*.wav","*.wave","*.aif","*.aiff","*.aifc","*.flac"]')
// A blank audio file is not a document anyone opens from the "+" control, so
// this type adds no guide capsule - it only ever claims a real file address.
check('the audio type adds no guide entry', audioTypes[0].guide === undefined)
check('the audio chip title is the file name', audioTypes[0].title('dsh-resource://file/session/s1/takes/take%2001.wav'), 'take 01.wav')
check('audio seats', Object.keys(audioSeats).sort().join(','), 'sidebar.right.pane.tab#dsh-audio,sidebar.right.pane.tab.title#dsh-audio')
const AudioBody = audioSeats['sidebar.right.pane.tab#dsh-audio'].component
const audioTab = { id: 'tab11', contentId: 'dsh-resource://file/session/s1/takes/take%2001.wav', title: 'take 01.wav' }
const audioMarkup = renderToStaticMarkup(h(AudioBody, { useTabInfo: () => ({ tab: audioTab }), sessionId: 's1' }))
check('the audio body renders its opening state', audioMarkup.includes('data-audio-state="loading"') && audioMarkup.includes('Opening take 01.wav'))
check('the opening state names the file it is opening', audioMarkup.includes('s1/takes/take 01.wav'))
check(
  'audio title seat draws the chip',
  renderToStaticMarkup(h(audioSeats['sidebar.right.pane.tab.title#dsh-audio'].component, { useTabInfo: () => ({ tab: audioTab }) })),
  '<span class="dsa-title">take 01.wav</span>',
)
const audioNoTabMarkup = renderToStaticMarkup(h(AudioBody, { useTabInfo: () => ({ tab: { id: 'tab12', contentId: '' } }) }))
check('an address-less audio tab still renders', audioNoTabMarkup.includes('data-audio-state="loading"'))

// --- the surface itself, rendered
//
// The loading state above is all a server render of the BODY reaches (the
// decode runs in an effect). The viewer and the details panel are rendered
// directly instead, on facts and a pyramid built here, so the toolbar, the
// spacer, the canvas and the status line are all exercised as markup - which is
// what catches a reference or a prop that only the loaded surface touches.
const audioViewerFacts = {
  container: 'WAVE (RIFF)',
  codec: 'PCM signed 16-bit little-endian',
  sampleRate: 8000,
  channels: 2,
  bits: 16,
  frames: 1024,
  duration: 0.128,
  truncated: false,
  metadata: { title: 'Take 1', artist: 'Test' },
  format: { kind: 's16', endian: 'le', channels: 2, sampleRate: 8000, bits: 16, blockAlign: 4 },
}
const audioViewerPeaks = new A.PeakSet(2, 1024)
audioViewerPeaks.push([new Float32Array(1024).fill(0.25), new Float32Array(1024).fill(-0.25)])
audioViewerPeaks.finish()
const audioViewerMarkup = renderToStaticMarkup(
  h(A.AudioViewer, {
    facts: audioViewerFacts,
    peaks: audioViewerPeaks,
    samples: [new Float32Array(1024).fill(0.25), new Float32Array(1024).fill(-0.25)],
    buffer: null,
    size: 4124,
    source: 'this package (WAV/AIFF decoded in the page, window by window)',
    name: 'take 01.wav',
    path: 'takes/take 01.wav',
    onReload: () => {},
  }),
)
check(
  'the viewer renders its transport, canvas, spacer and status line',
  audioViewerMarkup.includes('data-audio-viewer="take 01.wav"') &&
    audioViewerMarkup.includes('data-audio-action="play"') &&
    audioViewerMarkup.includes('data-audio-canvas="true"') &&
    audioViewerMarkup.includes('data-audio-spacer="true"') &&
    audioViewerMarkup.includes('data-audio-status="true"'),
)
check(
  'the viewer states the facts it was given',
  audioViewerMarkup.includes('data-audio-rate="8000"') &&
    audioViewerMarkup.includes('8000 Hz') &&
    audioViewerMarkup.includes('2 ch') &&
    audioViewerMarkup.includes('16-bit') &&
    audioViewerMarkup.includes('0:00.128') &&
    audioViewerMarkup.includes('WAV'),
)
check(
  'the spacer carries the file\'s own width at this zoom, and the canvas does not',
  audioViewerMarkup.includes('data-audio-spacer="true"') && audioViewerMarkup.includes('width:') && audioViewerMarkup.includes('data-audio-canvas="true"'),
)
check('the scale toggle shows which scale is on', audioViewerMarkup.includes('>linear<') && audioViewerMarkup.includes('data-audio-action="scale"'))
const audioViewerInfoMarkup = renderToStaticMarkup(
  h(A.InfoPanel, { facts: audioViewerFacts, size: 4124, source: 'this package', levels: '256 samples/bucket \u2192 1024 samples/bucket' }),
)
check(
  'the details panel carries the facts, the pyramid and the file\'s metadata',
  audioViewerInfoMarkup.includes('PCM signed 16-bit little-endian') &&
    audioViewerInfoMarkup.includes('8000 Hz') &&
    audioViewerInfoMarkup.includes('Take 1') &&
    audioViewerInfoMarkup.includes('Test') &&
    audioViewerInfoMarkup.includes('256 samples/bucket'),
)

console.log('')
console.log(failures === 0 ? 'all client-bundle checks passed' : failures + ' check(s) FAILED')
process.exitCode = failures === 0 ? 0 : 1
