/**
 * dsh-diagrams — browser half.
 *
 * One bundle, five registrations, no build step:
 *
 *   1. the **`diagram` tab type** (a resource address,
 *      `dsh-resource://diagram/session/<session>/<id>`) - one tab per diagram,
 *      showing the rendered picture with a source drawer and an export menu;
 *   2. the **`diagrams` tab type** (a page address, `sidebar://diagrams`) -
 *      the conversation's diagram index, and the type whose `guide` entry puts
 *      "Diagrams" on the tab strip's "+" / Start page (order 40, after Files,
 *      Editor and History);
 *   3. the **keyed tab bodies and titles** those two types need
 *      (`sidebar.right.pane.tab` / `.title`), the two-stage contract every tab
 *      type in this bar follows;
 *   4. a **`tool.call.toolview` entry per tool** (`diagram_write`,
 *      `diagram_patch`, `diagram_read`, `diagram_delete`) so every call draws
 *      its diagram inline in the conversation with a link that opens its tab.
 *
 * Everything the surfaces read comes from one module-level store keyed by
 * session, filled from the plugin's own authenticated routes. The store is the
 * seam that makes a write in the conversation appear in an open tab without any
 * extra transport: the card notifies it when a call settles, the panel
 * refetches on mount and navigation, and both subscribe to the same map.
 *
 * Rendering: Mermaid is drawn **in the browser** by the vendored engine (fetched
 * once from this plugin's own route as a classic script, exactly like the
 * editor's CodeMirror), themed off the app's light/dark scheme. TikZ is drawn
 * from the **host's cached artifact** - the compiled SVG, fetched with
 * credentials as a blob and shown through an `<img>`, so the picture is the
 * engine's own vector output and not a re-drawing.
 */
/* global window, document, fetch, URL, Blob */
window.__ModuleLoader__.load({
  id: 'dsh-diagrams',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------
    /** This implementation's identity in the tab system, and the slot key of its body. */
    const VIEWER_ID = 'dsh-diagrams-viewer'
    /** The tab kind of ONE diagram (a resource kind: the address names the id). */
    const VIEWER_KIND = 'diagram'
    /** The index page's implementation identity and kind (its address is `sidebar://diagrams`). */
    const INDEX_ID = 'dsh-diagrams-index'
    const INDEX_KIND = 'diagrams'
    /** Address grammar of one diagram: `dsh-resource://diagram/session/<session>/<id>`. */
    const ADDRESS_PREFIX = 'dsh-resource://diagram/session/'
    /** Keep in sync with lib/index.js. */
    const STATE_ROUTE = '/api/dsh-diagrams/state'
    const DIAGRAM_ROUTE = '/api/dsh-diagrams/diagram'
    const ARTIFACT_ROUTE = '/api/dsh-diagrams/artifact'
    const EXPORT_ROUTE = '/api/dsh-diagrams/export'
    const VENDOR_ROUTE = '/api/dsh-diagrams/vendor/mermaid.js'
    /** Version marker shown in the panel footer, so a fresh bundle is easy to verify. */
    const PLUGIN_VERSION = '0.1.0-alpha.2'
    /** The tools this package registers conversation cards for. */
    const TOOL_NAMES = ['diagram_write', 'diagram_patch', 'diagram_read', 'diagram_delete']
    /** Client services, all resolved lazily (none of them is required to draw). */
    const SIDEBAR_SERVICE = 'sidebarRight'
    const THEME_SERVICE = 'theme'
    /** The dark marker ui-layout writes on <body>; the fallback theme truth. */
    const DARK_ATTRIBUTE = 'data-ds-dark-theme'
    /** This bundle's stylesheet tag, so a second activation never double-injects it. */
    const CSS_TAG = 'dsh-diagrams/diagrams.css'

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------
    const css = `
.dsd-root{height:100%;min-height:0;flex:auto;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1f1f1f);font-size:13px}
/* The toolbar is this tab's top bar: 38px with box-sizing:border-box, the same
   box the Files tab, the editor and the History tab use, so the pane's first
   hairline lands on the y=76 line every column shares. */
.dsd-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;padding:0 10px 0 12px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}
.dsd-toolsSpacer{flex:1;min-width:0}
.dsd-filebar{flex:none;display:flex;align-items:center;gap:8px;box-sizing:border-box;min-height:28px;padding:0 12px 6px;font-size:12px;color:var(--dsw-alias-label-secondary,#666);overflow:hidden}
.dsd-filebar b{color:var(--dsw-alias-label-primary,#1f1f1f);font-weight:500}
.dsd-badge{flex:none;display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:5px;font-size:11px;letter-spacing:.02em;text-transform:uppercase;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,#666)}
.dsd-btn{appearance:none;display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}
.dsd-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsd-btn[disabled]{opacity:.45;cursor:default}
.dsd-btn[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.dsd-iconBtn{appearance:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:.5px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#666);cursor:pointer}
.dsd-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,#1f1f1f)}
.dsd-pill{flex:none;display:inline-flex;align-items:center;gap:5px;height:18px;padding:0 7px;border-radius:9px;font-size:11px}
.dsd-pill[data-status="ok"]{background:rgba(38,160,90,.14);color:#1f8a4c}
.dsd-pill[data-status="error"]{background:rgba(214,64,64,.14);color:#c93b3b}
.dsd-pill[data-status="unavailable"]{background:rgba(190,140,20,.16);color:#a9770f}
.dsd-pill[data-status="unchecked"]{background:var(--dsw-alias-fill-l2,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,#666)}
.dsd-body{flex:1;min-height:0;position:relative;display:flex;overflow:hidden}
.dsd-canvas{flex:1;min-width:0;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:16px}
.dsd-canvas[data-drawer="true"]{align-items:stretch;justify-content:stretch;padding:0}
.dsd-picture{max-width:100%;height:auto}
.dsd-pictureWrap{display:inline-flex;max-width:100%;flex-direction:column;align-items:center;gap:10px}
.dsd-svg svg{max-width:100%;height:auto}
.dsd-notice{max-width:520px;padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.55;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.10));color:var(--dsw-alias-label-secondary,#666)}
.dsd-notice[data-tone="error"]{background:rgba(214,64,64,.10);color:#c05a5a}
.dsd-diags{margin:0;padding:8px 10px;border-radius:8px;background:rgba(214,64,64,.08);border:1px solid rgba(214,64,64,.25);color:#c05a5a;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;white-space:pre-wrap;max-width:100%;overflow:auto}
.dsd-drawer{flex:none;width:44%;min-width:240px;max-width:70%;display:flex;flex-direction:column;border-left:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));box-sizing:border-box}
.dsd-drawerHead{flex:none;display:flex;align-items:center;gap:6px;height:32px;padding:0 8px 0 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}
.dsd-source{flex:1;min-height:0;width:100%;box-sizing:border-box;resize:none;border:0;outline:none;padding:10px 12px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;tab-size:2}
.dsd-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;cursor:pointer;box-sizing:border-box}
.dsd-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10))}
.dsd-rowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsd-rowTitle{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsd-rowMeta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsd-list{flex:1;min-height:0;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:4px}
.dsd-empty{padding:28px 20px;text-align:center;color:var(--dsw-alias-label-secondary,#666);font-size:12.5px;line-height:1.7}
.dsd-menu{position:absolute;z-index:20;min-width:190px;padding:5px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22));background:var(--dsw-alias-surface-l1,#fff);box-shadow:0 8px 26px rgba(0,0,0,.18)}
.dsd-menuItem{display:block;width:100%;text-align:left;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:12.5px;padding:7px 9px;border-radius:7px;cursor:pointer}
.dsd-menuItem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsd-menuSep{height:1px;margin:4px 6px;background:var(--dsw-alias-border-l3,rgba(127,127,127,.18))}
.dsd-status{flex:none;font-size:11.5px;color:var(--dsw-alias-label-secondary,#666);max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Conversation card */
.dsd-card{margin:2px 0 6px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));border-radius:10px;overflow:hidden;background:var(--dsw-alias-surface-l1,transparent);box-sizing:border-box}
.dsd-cardTop{display:flex;align-items:center;gap:8px;padding:7px 10px;font-size:12px}
.dsd-cardTitle{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsd-cardId{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.dsd-cardBody{padding:10px 12px 12px;border-top:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14));display:flex;flex-direction:column;gap:10px;max-height:460px;overflow:auto}
.dsd-cardPre{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#666)}
.dsd-inlineLink{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-link,#3b7ddd);font:inherit;font-size:12px;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:2px}
`
    /** Inject the stylesheet once per document. */
    function injectStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]')) return
      const style = document.createElement('style')
      style.dataset.plugin = 'dsh-diagrams'
      style.dataset.pluginCss = CSS_TAG
      style.textContent = css
      document.head.appendChild(style)
    }

    // ---------------------------------------------------------------------
    // The plugin context + the lazy services it reaches for
    // ---------------------------------------------------------------------
    /** The activation context; assigned in apply(). */
    let pluginCtx = null

    /** Resolve one client service, or null when it is not mounted. */
    function serviceNow(name) {
      try {
        const ctx = pluginCtx
        const found = ctx && typeof ctx.get === 'function' ? ctx.get(name) : null
        return found ?? null
      } catch (err) {
        return null
      }
    }

    /** The right bar's navigation controller, or null. */
    function sidebarRightNow() {
      const controller = serviceNow(SIDEBAR_SERVICE)
      return controller && typeof controller.openResource === 'function' ? controller : null
    }

    /**
     * The tab information a pane body was handed, or null when this seat has
     * none. `useTabInfo` throws while its tab is not committed, so a body that
     * only wants the visibility flag must not let that take it down.
     */
    function tabInfoNow(props) {
      if (!props || typeof props.useTabInfo !== 'function') return null
      try {
        const info = props.useTabInfo()
        return info && info.tab ? info : null
      } catch (err) {
        return null
      }
    }

    // ---------------------------------------------------------------------
    // Color scheme
    // ---------------------------------------------------------------------
    /** The theme service's own answer, else the body marker, else the media query. */
    function darkNow() {
      const theme = serviceNow(THEME_SERVICE)
      if (theme && typeof theme.getTheme === 'function') {
        try {
          const snapshot = theme.getTheme()
          if (snapshot && typeof snapshot === 'object' && snapshot.colorScheme) return snapshot.colorScheme === 'dark'
        } catch (err) {
          /* fall through to the marker */
        }
      }
      if (typeof document !== 'undefined' && document.body && typeof document.body.hasAttribute === 'function' && document.body.hasAttribute(DARK_ATTRIBUTE)) {
        return true
      }
      if (typeof window !== 'undefined' && window.matchMedia) return window.matchMedia('(prefers-color-scheme: dark)').matches
      return false
    }

    /** Follow the app's color scheme (the editor's truth order). */
    function useDark() {
      const [dark, setDark] = useState(() => darkNow())
      useEffect(() => {
        const update = () => setDark(darkNow())
        update()
        const theme = serviceNow(THEME_SERVICE)
        let off = null
        if (theme && typeof theme.on === 'function') off = theme.on('change', update)
        let observer = null
        if (typeof MutationObserver === 'function' && document.body) {
          observer = new MutationObserver(update)
          observer.observe(document.body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] })
        }
        return () => {
          if (typeof off === 'function') off()
          if (observer) observer.disconnect()
        }
      }, [])
      return dark
    }

    // ---------------------------------------------------------------------
    // Addresses
    // ---------------------------------------------------------------------
    /** The address of one diagram. */
    function addressFor(sessionId, diagramId) {
      return ADDRESS_PREFIX + encodeURIComponent(sessionId) + '/' + encodeURIComponent(diagramId)
    }

    /** The session id + diagram id an address carries, or nulls. */
    function parseDiagramAddress(address) {
      const text = String(address ?? '')
      if (!text.startsWith(ADDRESS_PREFIX)) return { sessionId: null, diagramId: null }
      const rest = text.slice(ADDRESS_PREFIX.length)
      const slash = rest.indexOf('/')
      if (slash === -1) return { sessionId: null, diagramId: null }
      try {
        return { sessionId: decodeURIComponent(rest.slice(0, slash)), diagramId: decodeURIComponent(rest.slice(slash + 1)) }
      } catch (err) {
        return { sessionId: null, diagramId: null }
      }
    }

    // ---------------------------------------------------------------------
    // The store: one entry per conversation
    // ---------------------------------------------------------------------
    /**
     * `stores` is the whole client-side model: `{ diagrams, byId, capabilities,
     * loaded, error, inflight, listeners }` per session. Both the conversation
     * card and every tab read it, which is what keeps an open tab in step with
     * a write that happened in the chat.
     */
    const stores = new Map()

    /** The (created-on-demand) store of one session. */
    function storeFor(sessionId) {
      const key = String(sessionId ?? '')
      let store = stores.get(key)
      if (!store) {
        store = { sessionId: key, diagrams: [], byId: new Map(), capabilities: null, loaded: false, error: null, inflight: null, listeners: new Set() }
        stores.set(key, store)
      }
      return store
    }

    /** Notify every subscriber of one session. */
    function notify(sessionId) {
      const store = storeFor(sessionId)
      for (const listener of [...store.listeners]) {
        try {
          listener(store)
        } catch (err) {
          /* a broken subscriber must not stop the others */
        }
      }
    }

    /** Read the plugin routes with the app's own credentials. */
    async function apiFetch(path, options) {
      const response = await fetch(path, { credentials: 'same-origin', ...(options ?? {}) })
      let body = null
      try {
        body = await response.json()
      } catch (err) {
        body = null
      }
      if (!response.ok) {
        const error = new Error((body && body.error && body.error.message) || 'The diagram service answered ' + response.status + '.')
        error.code = body && body.error ? body.error.code : 'HTTP_' + response.status
        throw error
      }
      return body
    }

    /** Apply one state answer to the store. */
    function applyState(sessionId, payload) {
      const store = storeFor(sessionId)
      store.diagrams = Array.isArray(payload && payload.diagrams) ? payload.diagrams : []
      store.byId = new Map(store.diagrams.map((entry) => [entry.id, entry]))
      if (payload && payload.capabilities) store.capabilities = payload.capabilities
      store.loaded = true
      store.error = null
      notify(sessionId)
    }

    /**
     * Refresh one conversation's diagrams from the host. Coalesced: concurrent
     * callers share one request, so an open panel and a settling card do not
     * double-fetch.
     */
    function refresh(sessionId, { force = false } = {}) {
      const store = storeFor(sessionId)
      if (!store.sessionId) return Promise.resolve(store)
      if (store.inflight && !force) return store.inflight
      const run = apiFetch(STATE_ROUTE + '?session=' + encodeURIComponent(store.sessionId))
        .then((payload) => {
          applyState(store.sessionId, payload)
          return store
        })
        .catch((err) => {
          store.error = err && err.message ? err.message : String(err)
          store.loaded = true
          notify(store.sessionId)
          return store
        })
        .finally(() => {
          if (store.inflight === run) store.inflight = null
        })
      store.inflight = run
      return run
    }

    /** Merge one diagram the caller already has into the store (no round trip). */
    function upsertDiagram(sessionId, diagram) {
      if (!sessionId || !diagram || !diagram.id) return
      const store = storeFor(sessionId)
      const existing = store.byId.get(diagram.id)
      if (existing) Object.assign(existing, diagram)
      else {
        store.byId.set(diagram.id, diagram)
        store.diagrams = store.diagrams.concat([{ id: diagram.id, kind: diagram.kind, title: diagram.title, status: diagram.status }])
      }
      // The map is the source of truth; keep the array pointing at the same objects.
      store.diagrams = store.diagrams.map((entry) => store.byId.get(entry.id) ?? entry)
      notify(sessionId)
    }

    /** Forget one diagram after a delete. */
    function dropDiagram(sessionId, diagramId) {
      const store = storeFor(sessionId)
      store.byId.delete(diagramId)
      store.diagrams = store.diagrams.filter((entry) => entry.id !== diagramId)
      notify(sessionId)
    }

    /** Subscribe to one session's store. */
    function subscribe(sessionId, listener) {
      const store = storeFor(sessionId)
      store.listeners.add(listener)
      return () => store.listeners.delete(listener)
    }

    /** The store snapshot hook shared by the card, the panel and the chip. */
    function useDiagramStore(sessionId, { load = true } = {}) {
      const store = storeFor(sessionId)
      const [version, setVersion] = useState(0)
      useEffect(() => {
        const off = subscribe(sessionId, () => setVersion((value) => value + 1))
        // Every mount re-reads: the conversation can gain diagrams while this
        // surface was unmounted, and the host's own file is the only truth.
        // Concurrent mounts share one request through the in-flight promise.
        if (load && sessionId) refresh(sessionId)
        return off
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId, load])
      return { store, version }
    }

    // ---------------------------------------------------------------------
    // Mermaid: the vendored engine, loaded once
    // ---------------------------------------------------------------------
    /** The in-flight engine load (the script is fetched and evaluated once). */
    let enginePromise = null
    /** The theme the engine is currently initialized for. */
    let engineTheme = null

    /**
     * Load the vendored Mermaid engine from this plugin's own route and hand
     * back the API. The bundle is a classic script (its last line assigns
     * `globalThis.mermaid`), so it is fetched and started as one - the same
     * blob-script trick the editor uses for CodeMirror, never through the module
     * loader and never as an inline script (CSP).
     */
    function loadEngine() {
      if (typeof window !== 'undefined' && window.mermaid && typeof window.mermaid.render === 'function') {
        return Promise.resolve(window.mermaid)
      }
      if (enginePromise) return enginePromise
      enginePromise = (async () => {
        const response = await fetch(VENDOR_ROUTE, { credentials: 'same-origin' })
        if (!response.ok) throw new Error('The vendored Mermaid engine could not be loaded (HTTP ' + response.status + ').')
        const source = await response.text()
        if (window.mermaid && typeof window.mermaid.render === 'function') return window.mermaid
        const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
        try {
          await new Promise((resolve, reject) => {
            const element = document.createElement('script')
            element.async = true
            element.src = url
            element.addEventListener(
              'load',
              () => {
                element.remove()
                resolve()
              },
              { once: true },
            )
            element.addEventListener(
              'error',
              () => {
                element.remove()
                reject(new Error('The vendored Mermaid engine failed to start.'))
              },
              { once: true },
            )
            document.head.appendChild(element)
          })
        } finally {
          URL.revokeObjectURL(url)
        }
        if (!window.mermaid || typeof window.mermaid.render !== 'function') {
          throw new Error('The vendored Mermaid engine loaded but exposed no renderer.')
        }
        return window.mermaid
      })().catch((err) => {
        enginePromise = null
        throw err
      })
      return enginePromise
    }

    /** Rendered SVGs, keyed by source+theme; a small LRU keeps memory flat while streaming. */
    const svgCache = new Map()
    const SVG_CACHE_MAX = 24

    /**
     * Render one Mermaid source to SVG, in the app's current theme.
     *
     * @param source - the diagram source.
     * @param dark - whether the app is dark right now.
     * @returns the SVG markup.
     */
    async function renderMermaid(source, dark) {
      const theme = dark ? 'dark' : 'default'
      const cacheKey = theme + '\u0000' + source
      if (svgCache.has(cacheKey)) {
        const hit = svgCache.get(cacheKey)
        svgCache.delete(cacheKey)
        svgCache.set(cacheKey, hit)
        return hit
      }
      const mermaid = await loadEngine()
      if (engineTheme !== theme) {
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme })
        engineTheme = theme
      }
      const id = 'dshd-' + Math.random().toString(36).slice(2, 10)
      const rendered = await mermaid.render(id, source)
      const svg = rendered && rendered.svg ? rendered.svg : ''
      if (typeof rendered.bindFunctions === 'function') {
        // No interactive handlers are needed for a static picture.
      }
      svgCache.set(cacheKey, svg)
      while (svgCache.size > SVG_CACHE_MAX) {
        const oldest = svgCache.keys().next()
        if (oldest.done) break
        svgCache.delete(oldest.value)
      }
      return svg
    }

    // ---------------------------------------------------------------------
    // Small shared pieces
    // ---------------------------------------------------------------------
    /** The tab-strip glyph (a node-and-edge shape), drawn in currentColor. */
    function DiagramGlyph(props) {
      const size = (props && props.size) || 16
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('rect', { x: 1, y: 1.5, width: 6, height: 4.5, rx: 1.2 }),
        h('rect', { x: 9, y: 10, width: 6, height: 4.5, rx: 1.2 }),
        h('path', { d: 'M7 3.7h3.2a1.3 1.3 0 0 1 1.3 1.3v5' }),
        h('path', { d: 'M11.5 8.4v1.2' }),
      )
    }

    /** A one-line status pill. */
    function StatusPill(props) {
      const status = props.status || 'unchecked'
      const label = { ok: 'ok', error: 'error', unavailable: 'not validated', unchecked: 'unchecked' }[status] || status
      return h('span', { className: 'dsd-pill', 'data-status': status, title: props.title || undefined }, label)
    }

    /** A dashed/outlined button. */
    function Button(props) {
      return h(
        'button',
        {
          type: 'button',
          className: props.icon ? 'dsd-iconBtn' : 'dsd-btn',
          title: props.title,
          disabled: props.disabled === true,
          'data-active': props.active === true ? 'true' : undefined,
          onClick: props.onClick,
        },
        props.icon ? props.icon : props.children,
      )
    }

    /** The diagnostics block shared by the card and the panel. */
    function Diagnostics(props) {
      const list = props.diagnostics ?? []
      if (list.length === 0) return null
      return h('pre', { className: 'dsd-diags' }, list.map((entry) => (entry && entry.text ? entry.text : String(entry))).join('\n'))
    }

    // ---------------------------------------------------------------------
    // Pictures
    // ---------------------------------------------------------------------
    /** A Mermaid picture: render in the browser, with the parser's error shown as text. */
    function MermaidPicture(props) {
      const dark = useDark()
      const [state, setState] = useState({ svg: '', error: null, busy: true })
      const source = props.source ?? ''
      useEffect(() => {
        let cancelled = false
        setState((previous) => ({ ...previous, busy: true }))
        renderMermaid(source, dark)
          .then((svg) => {
            if (!cancelled) setState({ svg, error: null, busy: false })
          })
          .catch((err) => {
            if (!cancelled) setState({ svg: '', error: err && err.message ? err.message : String(err), busy: false })
          })
        return () => {
          cancelled = true
        }
      }, [source, dark])
      if (state.error) {
        return h('div', { className: 'dsd-notice', 'data-tone': 'error' }, 'Mermaid could not draw this diagram: ' + state.error)
      }
      if (!state.svg) {
        return h('div', { className: 'dsd-notice' }, state.busy ? 'Rendering the Mermaid diagram...' : 'Nothing to render yet.')
      }
      return h('div', { className: 'dsd-svg', dangerouslySetInnerHTML: { __html: state.svg } })
    }

    /** A TikZ picture: the host compiled it, so fetch the artifact and show it. */
    function TikzPicture(props) {
      const sessionId = props.sessionId
      const diagramId = props.diagramId
      const revision = props.revision ?? 0
      const [state, setState] = useState({ url: null, error: null })
      useEffect(() => {
        let cancelled = false
        let objectUrl = null
        setState({ url: null, error: null })
        if (!sessionId || !diagramId) {
          setState({ url: null, error: 'This tab does not know which conversation the diagram belongs to.' })
          return () => {}
        }
        const url = ARTIFACT_ROUTE + '?session=' + encodeURIComponent(sessionId) + '&id=' + encodeURIComponent(diagramId) + '&format=' + (props.format || 'svg') + '&v=' + revision
        fetch(url, { credentials: 'same-origin' })
          .then(async (response) => {
            if (!response.ok) {
              let message = 'The compiled picture is not available (' + response.status + ').'
              try {
                const body = await response.json()
                if (body && body.error && body.error.message) message = body.error.message
              } catch (err) {
                /* keep the status message */
              }
              throw new Error(message)
            }
            return response.blob()
          })
          .then((blob) => {
            if (cancelled) return
            objectUrl = URL.createObjectURL(blob)
            setState({ url: objectUrl, error: null })
          })
          .catch((err) => {
            if (!cancelled) setState({ url: null, error: err && err.message ? err.message : String(err) })
          })
        return () => {
          cancelled = true
          if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
      }, [sessionId, diagramId, revision, props.format])
      if (state.error) return h('div', { className: 'dsd-notice' }, state.error)
      if (!state.url) return h('div', { className: 'dsd-notice' }, 'Loading the compiled picture...')
      return h('img', { className: 'dsd-picture', src: state.url, alt: props.alt || 'TikZ diagram' })
    }

    /** One picture, dispatched by kind. */
    function Picture(props) {
      if (props.kind === 'tikz') {
        return h(TikzPicture, { sessionId: props.sessionId, diagramId: props.diagramId, revision: props.revision, format: 'svg', alt: props.title })
      }
      return h(MermaidPicture, { source: props.source })
    }

    // ---------------------------------------------------------------------
    // Data helpers shared by the panel and the cards
    // ---------------------------------------------------------------------
    /** The stored diagram of a conversation, or null. */
    function diagramNow(sessionId, diagramId) {
      return storeFor(sessionId).byId.get(diagramId) ?? null
    }

    /** The source of one diagram: the panel prefers its own edited copy, then the store. */
    function sourceOf(entry, fallback) {
      if (entry && typeof entry.source === 'string') return entry.source
      return typeof fallback === 'string' ? fallback : ''
    }

    /** One line describing a diagram's size. */
    function metaLine(entry) {
      if (!entry) return ''
      const parts = []
      if (entry.kind) parts.push(entry.kind === 'tikz' ? 'TikZ' : 'Mermaid')
      if (entry.diagramType) parts.push(entry.diagramType)
      if (typeof entry.lines === 'number') parts.push(entry.lines + (entry.lines === 1 ? ' line' : ' lines'))
      if (entry.artifact && entry.artifact.pages) parts.push(entry.artifact.pages + (entry.artifact.pages === 1 ? ' page' : ' pages'))
      if (entry.updatedAt) parts.push('updated ' + new Date(entry.updatedAt).toLocaleTimeString())
      return parts.join(' · ')
    }

    /** Base64 of a UTF-8 string, without the deprecated `unescape` dance. */
    function base64Utf8(text) {
      const bytes = new TextEncoder().encode(text)
      let binary = ''
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000))
      }
      return btoa(binary)
    }

    /** Strip one surrounding ```-fence, as a chat payload habitually has one. */
    function stripFence(text) {
      const trimmed = String(text ?? '').trim()
      const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed)
      return fence ? fence[1] : text
    }

    /** Copy text to the clipboard, falling back to a hidden textarea. */
    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch (err) {
        /* fall through */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(area)
        return ok
      } catch (err) {
        return false
      }
    }

    /** Start a browser download of some bytes. */
    function downloadBytes(bytes, filename, type) {
      const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: type || 'application/octet-stream' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    }

    /** The SVG markup of a rendered Mermaid picture, for export. */
    async function mermaidSvgNow(source, dark) {
      return renderMermaid(source, dark)
    }

    /** Rasterize SVG markup to PNG bytes at `scale`, through a canvas. */
    async function svgToPng(svg, scale = 2) {
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      try {
        const image = await new Promise((resolve, reject) => {
          const element = new Image()
          element.onload = () => resolve(element)
          element.onerror = () => reject(new Error('The rendered SVG could not be rasterized.'))
          element.src = url
        })
        const width = Math.max(1, Math.round((image.naturalWidth || image.width || 600) * scale))
        const height = Math.max(1, Math.round((image.naturalHeight || image.height || 400) * scale))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const context = canvas.getContext('2d')
        context.fillStyle = darkNow() ? '#1b1b1b' : '#ffffff'
        context.fillRect(0, 0, width, height)
        context.drawImage(image, 0, 0, width, height)
        const dataUrl = canvas.toDataURL('image/png')
        return dataUrl.slice(dataUrl.indexOf(',') + 1)
      } finally {
        URL.revokeObjectURL(url)
      }
    }

    // ---------------------------------------------------------------------
    // The per-diagram tab
    // ---------------------------------------------------------------------
    /**
     * The body of one diagram tab: toolbar, picture, and the source drawer.
     * The drawer's text is the user's own edit; it starts from the stored
     * source and is applied back through the plugin route, which re-validates
     * (and recompiles a TikZ diagram) exactly like a model write does.
     */
    function ViewerBody(props) {
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
      const tab = info && info.tab ? info.tab : null
      const parsed = parseDiagramAddress(tab ? tab.contentId : '')
      const sessionId = parsed.sessionId || props.sessionId
      const diagramId = parsed.diagramId
      const { store, version } = useDiagramStore(sessionId)
      const entry = diagramId ? store.byId.get(diagramId) ?? null : null
      const [drawer, setDrawer] = useState(false)
      const [draft, setDraft] = useState('')
      const [status, setStatus] = useState('')
      const [busy, setBusy] = useState(false)
      const [menu, setMenu] = useState(false)
      const revision = entry ? entry.revision : 0
      const dark = useDark()
      const source = entry ? entry.source : ''

      // A tab that was in the background shows the diagram as it is NOW: a
      // write in the chat may have rewritten it since this body last rendered.
      const visible = info ? info.tab.visible !== false : true
      useEffect(() => {
        if (sessionId && visible) refresh(sessionId)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId, visible])

      // A re-navigation (or the first load) adopts the stored source; a local
      // edit in progress is never thrown away by a store refresh.
      const lastId = useRef(null)
      useEffect(() => {
        if (lastId.current !== diagramId) {
          lastId.current = diagramId
          setDrawer(false)
          setDraft(source)
          return
        }
        if (!drawer) setDraft(source)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [diagramId, source, drawer])

      /** Tell the plugin route what the user typed, then refresh from the host. */
      const apply = useCallback(async () => {
        if (!sessionId || !diagramId) return
        setBusy(true)
        setStatus('')
        try {
          const answer = await apiFetch(DIAGRAM_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: sessionId, id: diagramId, source: draft, recompile: entry && entry.kind === 'tikz' }),
          })
          if (answer && answer.diagram) upsertDiagram(sessionId, answer.diagram)
          setStatus(answer && answer.status ? 'status: ' + answer.status : 'saved')
        } catch (err) {
          setStatus(err && err.message ? err.message : 'save failed')
        } finally {
          setBusy(false)
        }
      }, [sessionId, diagramId, draft, entry])

      /** Save one export into the conversation folder. */
      const exportAs = useCallback(
        async (format) => {
          setMenu(false)
          if (!sessionId || !diagramId || !entry) return
          setBusy(true)
          setStatus('exporting ' + format + '...')
          try {
            let data
            if (entry.kind === 'mermaid' && (format === 'svg' || format === 'png')) {
              const svg = await mermaidSvgNow(entry.source, dark)
              data = format === 'png' ? await svgToPng(svg, 2) : base64Utf8(svg)
            }
            const answer = await apiFetch(EXPORT_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session: sessionId, id: diagramId, format, data }),
            })
            setStatus('saved to ' + (answer && answer.path ? answer.path : 'the conversation folder'))
          } catch (err) {
            setStatus(err && err.message ? err.message : 'export failed')
          } finally {
            setBusy(false)
          }
        },
        [sessionId, diagramId, entry, dark],
      )

      /** Download one export through the browser instead of the workspace. */
      const downloadAs = useCallback(
        async (format) => {
          setMenu(false)
          if (!entry) return
          setBusy(true)
          try {
            let blob
            if (format === 'mmd' || format === 'tex') blob = new Blob([entry.source + '\n'], { type: 'text/plain' })
            else if (format === 'md') {
              blob = new Blob(['# ' + (entry.title || entry.id) + '\n\n```' + (entry.kind === 'mermaid' ? 'mermaid' : 'latex') + '\n' + entry.source + '\n```\n'], {
                type: 'text/markdown',
              })
            } else if (entry.kind === 'mermaid') {
              const svg = await mermaidSvgNow(entry.source, dark)
              if (format === 'svg') blob = new Blob([svg], { type: 'image/svg+xml' })
              else {
                const base64 = await svgToPng(svg, 2)
                const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
                blob = new Blob([bytes], { type: 'image/png' })
              }
            } else {
              const url = ARTIFACT_ROUTE + '?session=' + encodeURIComponent(sessionId) + '&id=' + encodeURIComponent(diagramId) + '&format=' + format
              const response = await fetch(url, { credentials: 'same-origin' })
              if (!response.ok) throw new Error('That artifact is not available yet.')
              blob = await response.blob()
            }
            downloadBytes(blob, (entry.title || entry.id).replace(/[^A-Za-z0-9._-]+/g, '-') + '.' + format)
            setStatus('downloaded')
          } catch (err) {
            setStatus(err && err.message ? err.message : 'download failed')
          } finally {
            setBusy(false)
          }
        },
        [sessionId, diagramId, entry, dark],
      )

      if (!sessionId || !diagramId) {
        return h('div', { className: 'dsd-root' }, h('div', { className: 'dsd-empty' }, 'This diagram tab carries no diagram address.'))
      }
      if (!entry) {
        return h(
          'div',
          { className: 'dsd-root' },
          h(
            'div',
            { className: 'dsd-empty' },
            store.loaded ? 'Diagram "' + diagramId + '" is not in this conversation (it may have been deleted).' : 'Loading the diagram...',
          ),
        )
      }

      const formats = entry.kind === 'tikz' ? ['tex', 'pdf', 'svg', 'png'] : ['mmd', 'md', 'svg', 'png']
      return h(
        'div',
        { className: 'dsd-root' },
        h(
          'div',
          { className: 'dsd-tools' },
          h('span', { className: 'dsd-badge' }, entry.kind === 'tikz' ? 'TikZ' : 'Mermaid'),
          h('span', { className: 'dsd-cardId' }, entry.id),
          h(StatusPill, { status: entry.status, title: (entry.diagnostics ?? []).map((d) => d.text).join('\n') }),
          h('span', { className: 'dsd-toolsSpacer' }),
          h('span', { className: 'dsd-status' }, status),
          h(Button, { title: 'Copy the source', onClick: () => copyText(entry.source).then((ok) => setStatus(ok ? 'source copied' : 'copy failed')) }, 'Copy'),
          h(
            Button,
            { title: 'Edit the source in this panel', active: drawer, onClick: () => setDrawer((value) => !value) },
            drawer ? 'Close source' : 'Source',
          ),
          entry.kind === 'tikz'
            ? h(
                Button,
                {
                  title: 'Compile this document again (ignoring the artifact cache)',
                  disabled: busy,
                  onClick: () => recompileNow(entry, sessionId, diagramId, setStatus, setBusy),
                },
                'Recompile',
              )
            : null,
          h('div', { style: { position: 'relative' } }, [
            h(Button, { key: 'export', title: 'Export this diagram', onClick: () => setMenu((value) => !value) }, 'Export ▾'),
            menu
              ? h(
                  'div',
                  { key: 'menu', className: 'dsd-menu', style: { right: 0, top: 28 } },
                  formats.slice(0, 2).map((format) =>
                    h('button', { key: 'save-' + format, type: 'button', className: 'dsd-menuItem', onClick: () => exportAs(format) }, 'Save as .' + format + ' in the folder'),
                  ),
                  formats.slice(2).map((format) =>
                    h('button', { key: 'save-' + format, type: 'button', className: 'dsd-menuItem', onClick: () => exportAs(format) }, 'Save ' + format.toUpperCase() + ' in the folder'),
                  ),
                  h('div', { key: 'sep', className: 'dsd-menuSep' }),
                  formats.map((format) =>
                    h('button', { key: 'dl-' + format, type: 'button', className: 'dsd-menuItem', onClick: () => downloadAs(format) }, 'Download .' + format),
                  ),
                )
              : null,
          ]),
        ),
        h(
          'div',
          { className: 'dsd-filebar' },
          h('b', null, entry.title || entry.id),
          h('span', null, metaLine(entry)),
        ),
        h(
          'div',
          { className: 'dsd-body' },
          h(
            'div',
            { className: 'dsd-canvas' },
            h(
              'div',
              { className: 'dsd-pictureWrap' },
              h(Picture, { kind: entry.kind, source: entry.source, sessionId, diagramId, revision, title: entry.title }),
              entry.status === 'unavailable'
                ? h('div', { className: 'dsd-notice' }, 'This diagram was stored but could not be validated on this host.')
                : null,
              (entry.diagnostics ?? []).length > 0 ? h(Diagnostics, { diagnostics: entry.diagnostics }) : null,
            ),
          ),
          drawer
            ? h(
                'div',
                { className: 'dsd-drawer' },
                h(
                  'div',
                  { className: 'dsd-drawerHead' },
                  h('span', null, 'Source'),
                  h('span', { className: 'dsd-toolsSpacer' }),
                  h(Button, { title: 'Discard the edit', disabled: busy, onClick: () => setDraft(entry.source) }, 'Revert'),
                  h(Button, { title: 'Validate and save this source', disabled: busy || draft === entry.source, onClick: apply }, busy ? 'Saving...' : 'Apply'),
                ),
                h('textarea', {
                  className: 'dsd-source',
                  value: draft,
                  spellCheck: false,
                  onChange: (event) => setDraft(event.target.value),
                }),
              )
            : null,
        ),
      )
    }

    /**
     * Compile one TikZ diagram again through the plugin route, ignoring the
     * artifact cache. Mermaid needs no equivalent: it is rendered in the
     * browser from the source, so a change is already a re-render.
     */
    async function recompileNow(entry, sessionId, diagramId, setStatus, setBusy) {
      setBusy(true)
      setStatus('compiling...')
      try {
        const answer = await apiFetch(DIAGRAM_ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session: sessionId, id: diagramId, kind: entry.kind, source: entry.source, recompile: true }),
        })
        if (answer && answer.diagram) upsertDiagram(sessionId, answer.diagram)
        setStatus('status: ' + (answer && answer.status ? answer.status : 'ok'))
      } catch (err) {
        setStatus(err && err.message ? err.message : 'compile failed')
      } finally {
        setBusy(false)
      }
    }

    /** The chip of one diagram tab: the diagram's own title, live from the store. */
    function ViewerTitle(props) {
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
      const tab = info && info.tab ? info.tab : null
      const parsed = parseDiagramAddress(tab ? tab.contentId : '')
      const sessionId = props.sessionId ?? parsed.sessionId
      const { store } = useDiagramStore(sessionId, { load: false })
      const entry = parsed.diagramId ? store.byId.get(parsed.diagramId) : null
      if (entry && entry.title) return entry.title
      return parsed.diagramId || 'Diagram'
    }

    // ---------------------------------------------------------------------
    // The index page
    // ---------------------------------------------------------------------
    /** The body of the "Diagrams" page: every diagram of the conversation. */
    function IndexBody(props) {
      const sessionId = props.sessionId
      const { store } = useDiagramStore(sessionId)
      const [busy, setBusy] = useState(false)
      const [status, setStatus] = useState('')

      // Coming back to a tab that stayed mounted must show what happened while
      // it was in the background, so becoming visible re-reads the host.
      const info = tabInfoNow(props)
      const visible = info ? info.tab.visible !== false : true
      useEffect(() => {
        if (sessionId && visible) refresh(sessionId)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId, visible])

      /** Create a blank diagram of one kind and open its tab. */
      const create = useCallback(
        async (kind) => {
          if (!sessionId) return
          setBusy(true)
          setStatus('creating...')
          try {
            const source = kind === 'tikz' ? '\\node[draw, rounded corners] {Start};' : 'flowchart TD\n    A[Start] --> B[Next]'
            const answer = await apiFetch(DIAGRAM_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ session: sessionId, kind, title: kind === 'tikz' ? 'TikZ diagram' : 'Mermaid diagram', source, create: true }),
            })
            if (answer && answer.diagram) {
              upsertDiagram(sessionId, answer.diagram)
              openDiagram(sessionId, answer.diagram.id)
            }
            setStatus('')
          } catch (err) {
            setStatus(err && err.message ? err.message : 'could not create the diagram')
          } finally {
            setBusy(false)
          }
        },
        [sessionId],
      )

      if (!sessionId) return h('div', { className: 'dsd-root' }, h('div', { className: 'dsd-empty' }, 'Open a conversation to see its diagrams.'))

      const capabilities = store.capabilities
      const texNote = capabilities && capabilities.tex && capabilities.tex.available === false
      return h(
        'div',
        { className: 'dsd-root' },
        h(
          'div',
          { className: 'dsd-tools' },
          h('span', { className: 'dsd-cardTitle' }, 'Diagrams'),
          h('span', { className: 'dsd-status' }, status),
          h('span', { className: 'dsd-toolsSpacer' }),
          h(Button, { disabled: busy, title: 'Create a Mermaid diagram', onClick: () => create('mermaid') }, 'New Mermaid'),
          h(Button, { disabled: busy || texNote, title: texNote ? 'No TeX engine on this host' : 'Create a TikZ diagram', onClick: () => create('tikz') }, 'New TikZ'),
        ),
        h(
          'div',
          { className: 'dsd-filebar' },
          h('b', null, store.diagrams.length + (store.diagrams.length === 1 ? ' diagram' : ' diagrams')),
          texNote ? h('span', null, 'no TeX engine on this host: TikZ diagrams are stored and exported as .tex only') : null,
        ),
        store.diagrams.length === 0
          ? h(
              'div',
              { className: 'dsd-empty' },
              'No diagrams in this conversation yet.',
              h('br', null),
              'Ask for one in the chat, or start a blank one above - the model can edit whatever you create here.',
            )
          : h(
              'div',
              { className: 'dsd-list' },
              store.diagrams.map((entry) =>
                h(
                  'div',
                  { key: entry.id, className: 'dsd-row', onClick: () => openDiagramFrom(sessionId, entry.id, setStatus) },
                  h('span', { className: 'dsd-badge' }, entry.kind === 'tikz' ? 'TikZ' : 'Mermaid'),
                  h(
                    'div',
                    { className: 'dsd-rowMain' },
                    h('div', { className: 'dsd-rowTitle' }, entry.title || entry.id),
                    h('div', { className: 'dsd-rowMeta' }, metaLine(entry)),
                  ),
                  h(StatusPill, { status: entry.status }),
                ),
              ),
            ),
        h('div', { className: 'dsd-filebar', style: { paddingTop: '4px' } }, 'dsh-diagrams ' + PLUGIN_VERSION),
      )
    }

    /** Open one diagram's tab through the right bar's controller. */
    function openDiagram(sessionId, diagramId) {
      const controller = sidebarRightNow()
      if (!controller) throw new Error('The right bar is not mounted.')
      controller.openResource(addressFor(sessionId, diagramId))
    }

    /** Open a diagram from a surface that shows a message instead of throwing. */
    function openDiagramFrom(sessionId, diagramId, setStatus) {
      try {
        openDiagram(sessionId, diagramId)
      } catch (err) {
        if (typeof setStatus === 'function') setStatus(err && err.message ? err.message : 'could not open the tab')
      }
    }

    /** The chip of the index tab. */
    function IndexTitle() {
      return 'Diagrams'
    }

    // ---------------------------------------------------------------------
    // The conversation card
    // ---------------------------------------------------------------------
    /**
     * Whether one conversation block is a SETTLED call.
     *
     * The shell's own model is the law here: a finished call is a `tool-result`
     * block (`{ kind: 'tool-result', call: { name, argsRaw }, content, meta }`)
     * while a call still running is a call block with NO `kind` at all - which
     * is exactly how `ui-tool` reads it (`done = "kind" in block`). Reading
     * `kind` as "running" inverts every card.
     */
    function isSettled(block) {
      return Boolean(block && block.kind === 'tool-result')
    }

    /**
     * The host's own view of the diagram a settled call produced, or null.
     *
     * The tool declares it as `output.presentationMeta` (see `viewOf` in
     * lib/index.js), so it rides the result as `meta` and carries the id even
     * when the call itself never named one - which is every `diagram_write`,
     * because the host derives the id from the title.
     */
    function viewOfBlock(block) {
      const meta = block && block.meta
      if (!meta || typeof meta !== 'object') return null
      return typeof meta.id === 'string' && meta.id.length > 0 ? meta : null
    }

    /** Parse one tool call's arguments, running or settled. */
    function argsOf(block) {
      const raw = block && 'kind' in block ? block.call && block.call.argsRaw : block && block.argsRaw
      if (typeof raw !== 'string' || raw.length === 0) return null
      try {
        return JSON.parse(raw)
      } catch (err) {
        return null
      }
    }

    /**
     * The conversation card for the four diagram tools. It draws from the tool
     * call itself - so it is correct on replay - and merges what it sees into
     * the shared store, which is what keeps an open diagram tab in step.
     */
    function ToolCard(props) {
      const toolName = props.toolName
      const block = props.block
      const args = argsOf(block)
      const settled = isSettled(block)
      const running = Boolean(block) && !settled
      const sessionId = props.sessionId
      const { store } = useDiagramStore(sessionId, { load: false })
      const [open, setOpen] = useState(false)
      const [note, setNote] = useState('')

      // Which diagram this call is about. `patch`/`read`/`delete` name it; a
      // `write` cannot, because the host derives the id from the title - so the
      // settled result's own view is what names it there.
      const meta = settled ? viewOfBlock(block) : null
      const id = (args && args.id) || (meta && meta.id) || null
      const known = id ? store.byId.get(id) : null
      const kind = (args && args.kind) || (meta && meta.kind) || (known && known.kind) || null
      const title = (args && args.title) || (meta && meta.title) || (known && known.title) || null
      const address = id && sessionId ? addressFor(sessionId, id) : null

      // A settled call asks the host for this conversation once - that is what
      // turns the call into a picture, a status and a live "Open tab" link (and
      // what keeps an already-open index tab in step, through the store).
      useEffect(() => {
        if (running || !sessionId) return
        if (!known) refresh(sessionId)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [running, sessionId, id, known])

      const openTab = useCallback(() => {
        if (!address) return
        try {
          openDiagram(sessionId, id)
        } catch (err) {
          setNote(err && err.message ? err.message : 'could not open the tab')
        }
      }, [address, sessionId, id])

      if (toolName === 'diagram_read') {
        const text = known ? known.source : ''
        return h(
          'div',
          { className: 'dsd-card' },
          h(
            'div',
            { className: 'dsd-cardTop' },
            h('span', { className: 'dsd-badge' }, 'read'),
            h('span', { className: 'dsd-cardTitle' }, id ? 'Diagram "' + id + '"' : 'Diagram index'),
            h('span', { className: 'dsd-toolsSpacer' }),
            id && address ? h('button', { type: 'button', className: 'dsd-inlineLink', onClick: openTab }, 'Open tab') : null,
          ),
          text
            ? h('div', { className: 'dsd-cardBody' }, h('pre', { className: 'dsd-cardPre' }, text.length > 2000 ? text.slice(0, 2000) + '\n...' : text))
            : null,
        )
      }

      if (toolName === 'diagram_delete') {
        return h(
          'div',
          { className: 'dsd-card' },
          h(
            'div',
            { className: 'dsd-cardTop' },
            h('span', { className: 'dsd-badge' }, 'delete'),
            h('span', { className: 'dsd-cardTitle' }, id ? 'Deleted diagram "' + id + '"' : 'Deleted a diagram'),
          ),
        )
      }

      if (!id || !kind) {
        // A rejected call (bad arguments) still has to render something honest.
        return h(
          'div',
          { className: 'dsd-card' },
          h('div', { className: 'dsd-cardTop' }, h('span', { className: 'dsd-badge' }, 'diagram'), h('span', { className: 'dsd-cardTitle' }, running ? 'Writing a diagram...' : 'Diagram call')),
        )
      }

      return h(
        'div',
        { className: 'dsd-card' },
        h(
          'div',
          { className: 'dsd-cardTop' },
          h('span', { className: 'dsd-badge' }, kind === 'tikz' ? 'TikZ' : 'Mermaid'),
          h('span', { className: 'dsd-cardTitle' }, title || id),
          h('span', { className: 'dsd-cardId' }, id),
          known ? h(StatusPill, { status: known.status }) : running ? h('span', { className: 'dsd-status' }, 'writing...') : null,
          h('span', { className: 'dsd-toolsSpacer' }),
          note ? h('span', { className: 'dsd-status' }, note) : null,
          h('button', { type: 'button', className: 'dsd-inlineLink', onClick: openTab }, 'Open tab'),
          h('button', { type: 'button', className: 'dsd-inlineLink', onClick: () => setOpen((value) => !value) }, open ? 'Hide' : 'Show'),
        ),
        open || running
          ? h(
              'div',
              { className: 'dsd-cardBody' },
              running
                ? h('div', { className: 'dsd-notice' }, 'Writing the diagram...')
                : h(Picture, {
                    kind,
                    source: known ? known.source : stripFence((args && args.source) || ''),
                    sessionId,
                    diagramId: id,
                    revision: known ? known.revision : 0,
                    title,
                  }),
              known && (known.diagnostics ?? []).length > 0 ? h(Diagnostics, { diagnostics: known.diagnostics }) : null,
            )
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // Tab-type definitions
    // ---------------------------------------------------------------------
    /** The `diagram` type: one resource address per diagram. */
    function viewerDefinition() {
      return {
        id: VIEWER_ID,
        kind: VIEWER_KIND,
        patterns: [ADDRESS_PREFIX + '**'],
        priority: 'extension',
        title: (address) => {
          const parsed = parseDiagramAddress(address)
          const entry = parsed.sessionId && parsed.diagramId ? diagramNow(parsed.sessionId, parsed.diagramId) : null
          if (entry && entry.title) return entry.title
          return parsed.diagramId || 'Diagram'
        },
      }
    }

    /** The `diagrams` type: the conversation index, and the guide entry. */
    function indexDefinition() {
      return {
        id: INDEX_ID,
        kind: INDEX_KIND,
        priority: 'builtin',
        title: () => 'Diagrams',
        guide: [
          {
            order: 40,
            title: () => 'Diagrams',
            description: () => 'Mermaid and TikZ diagrams in this conversation',
            icon: DiagramGlyph,
          },
        ],
      }
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------
    /** Services activation waits for: the slot registry and the bar's tab registry. */
    const inject = ['slots', 'sidebarRightTabs']

    /**
     * Activate the browser half.
     * @param ctx - cordis context (inject: slots, sidebarRightTabs).
     */
    function apply(ctx) {
      pluginCtx = ctx
      injectStyles()
      try {
        ctx.effect(() => ctx.sidebarRightTabs.register(viewerDefinition()), 'dsh-diagrams: diagram tab type')
        ctx.effect(() => ctx.sidebarRightTabs.register(indexDefinition()), 'dsh-diagrams: diagrams page type')
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: VIEWER_ID, inject: () => ({}) }, ViewerBody),
            ),
          'dsh-diagrams: diagram tab body',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab.title', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: VIEWER_ID }, ViewerTitle),
            ),
          'dsh-diagrams: diagram tab title',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab', key: INDEX_ID, inject: () => ({}) }, IndexBody),
            ),
          'dsh-diagrams: index tab body',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab.title', () =>
              ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: INDEX_ID }, IndexTitle),
            ),
          'dsh-diagrams: index tab title',
        )
        // One conversation card per tool, keyed on the wire tool name.
        for (const toolName of TOOL_NAMES) {
          ctx.effect(
            () =>
              ctx.slots.inject('tool.call.toolview', () =>
                ctx.slots.register({ name: 'tool.call.toolview', key: toolName }, ToolCard),
              ),
            'dsh-diagrams: ' + toolName + ' card',
          )
        }
        ctx.logger?.debug?.('[dsh-diagrams] client half active (' + PLUGIN_VERSION + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-diagrams] activation failed', err)
        ctx.logger?.warn?.('[dsh-diagrams] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.name = 'dsh-diagrams'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
