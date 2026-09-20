/**
 * dsh-diagrams — browser half.
 *
 * One bundle, five registrations, no build step:
 *
 *   1. the **`diagram` tab type** (a resource address,
 *      `dsh-resource://diagram/session/<session>/<id>`) - one tab per diagram,
 *      showing the rendered picture at 80% of the pane width with a zoom ladder
 *      (25%-400%), a source drawer, and an export menu whose every format is
 *      saved to the **Desktop of the machine running the harness** by the host
 *      (the browser download stays as the fallback for a profile without it);
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
    /**
     * Address grammar of one diagram. Two shapes, because a diagram lives in one
     * of two places: `dsh-resource://diagram/session/<session>/<id>` for this
     * conversation, and `dsh-resource://diagram/library/<id>` for the shared
     * library. The library address names NO conversation on purpose - that is
     * what makes it citable from any chat and durable after this one ends.
     */
    const ADDRESS_PREFIX = 'dsh-resource://diagram/session/'
    const LIBRARY_PREFIX = 'dsh-resource://diagram/library/'
    const LIBRARY_SCOPE = 'library'
    /** Keep in sync with lib/index.js. */
    const STATE_ROUTE = '/api/dsh-diagrams/state'
    const DIAGRAM_ROUTE = '/api/dsh-diagrams/diagram'
    const ARTIFACT_ROUTE = '/api/dsh-diagrams/artifact'
    const EXPORT_ROUTE = '/api/dsh-diagrams/export'
    const REPORT_ROUTE = '/api/dsh-diagrams/render-report'
    const VENDOR_ROUTE = '/api/dsh-diagrams/vendor/mermaid.js'
    /** Version marker shown in the panel footer, so a fresh bundle is easy to verify. */
    const PLUGIN_VERSION = '0.1.0-alpha.6'
    /**
     * The zoom ladder the diagram tab steps through, the share of the pane a
     * picture occupies at 100%, and the last zoom each tab was left at.
     *
     * 80% IS the 100% rung: a diagram is meant to be read whole first - laid out
     * to fit the tab with a margin - and the reader zooms IN from there. The
     * memory is keyed by `session/id` and is deliberately view state only: it is
     * never sent to the host and never survives a reload.
     */
    const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
    const ZOOM_DEFAULT = 1
    const ZOOM_FIT_WIDTH = 80
    const zoomMemory = new Map()
    /** The tools this package registers conversation cards for. */
    const TOOL_NAMES = ['diagram_write', 'diagram_patch', 'diagram_read', 'diagram_verify', 'diagram_publish', 'diagram_delete']
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
.dsd-pill[data-status="error"],.dsd-pill[data-status="failed"]{background:rgba(214,64,64,.14);color:#c93b3b}
.dsd-pill[data-status="unavailable"]{background:rgba(190,140,20,.16);color:#a9770f}
/* Neutral by design: "nothing has reported yet" and "the report is about an
   older revision" are both ABSENCES of a verdict, and neither is red. */
.dsd-pill[data-status="unchecked"],.dsd-pill[data-status="pending"],.dsd-pill[data-status="stale"]{background:var(--dsw-alias-fill-l2,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,#666)}
.dsd-pill[data-status="drawn"]{background:rgba(38,120,200,.14);color:#2f6fb5}
.dsd-body{flex:1;min-height:0;position:relative;display:flex;overflow:hidden}
/* The picture is laid out at a SHARE of the pane's width, not at its own
   natural size: a diagram is read whole first (80% of the tab, centred) and
   only then zoomed in on. The box owns the width, so zooming past the pane
   widens the SCROLLABLE area instead of scaling content into a clipped box.
   flex-start plus margin:0 auto is deliberate: with justify-content:center the
   left edge of an overflowing flex item is unreachable, and a zoomed diagram
   could never be scrolled back to.
   The canvas is also the PAN surface: a drag moves scrollLeft/scrollTop, which
   is why the picture needs no transform and nothing has to be repositioned. */
.dsd-canvas{flex:1;min-width:0;overflow:auto;display:flex;align-items:flex-start;justify-content:flex-start;padding:16px 16px 56px}
.dsd-canvas[data-drawer="true"]{align-items:stretch;justify-content:stretch;padding:0}
.dsd-canvas[data-pannable="true"]{cursor:grab}
.dsd-canvas[data-panning="true"]{cursor:grabbing;user-select:none}
.dsd-zoomBox{flex:none;margin:0 auto;min-width:0;display:flex;flex-direction:column;align-items:center;gap:10px;box-sizing:border-box}
/* EVERY child of a zoomed box fills it. This is the difference between zooming
   the picture and zooming an empty div: a column flex container sizes its
   children to their CONTENT on the cross axis, so the .dsd-svg wrapper stayed at
   the SVG's natural width however wide the box became - and width:100% on the
   svg then resolved against that content width. Stretching the children plus an
   explicit width:100% on the wrapper is what makes the picture follow the box. */
.dsd-zoomBox[data-zoomed="true"] > *{align-self:stretch}
.dsd-picture{max-width:100%;height:auto;-webkit-user-drag:none;user-select:none}
.dsd-pictureWrap{display:inline-flex;max-width:100%;flex-direction:column;align-items:center;gap:10px}
/* The wrapper fills the box and centres the svg inside it; mermaid writes its
   own max-width into the <svg>, so "fit the width, never upscale" is what
   happens at 100% with no extra rule. */
.dsd-svg{width:100%;max-width:100%;display:flex;justify-content:center}
.dsd-svg svg{max-width:100%;height:auto}
/* Past the fit width the picture follows the BOX rather than its own natural
   size: mermaid's inline max-width is overridden (!important, because an
   inline style beats a stylesheet), so a small diagram grows when the reader
   zooms in instead of refusing to. */
.dsd-zoomBox[data-zoomed="true"] .dsd-svg svg{width:100%;max-width:none!important;height:auto}
.dsd-zoomBox[data-zoomed="true"] .dsd-picture{width:100%;max-width:none}
.dsd-zoomBar{position:absolute;right:12px;bottom:12px;z-index:6;display:flex;align-items:center;gap:2px;padding:3px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22));background:var(--dsw-alias-surface-l1,#fff);box-shadow:0 4px 14px rgba(0,0,0,.14)}
.dsd-zoomLabel{min-width:44px;text-align:center;font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#666)}
/* Absolute caps, not percentages: these blocks are read, not zoomed, so a 400%
   box must not stretch them into one long line. */
.dsd-notice{max-width:520px;margin:0 auto;padding:10px 12px;border-radius:8px;font-size:12px;line-height:1.55;background:var(--dsw-alias-fill-l2,rgba(127,127,127,.10));color:var(--dsw-alias-label-secondary,#666)}
.dsd-notice[data-tone="error"]{background:rgba(214,64,64,.10);color:#c05a5a}
/* A diagram that did not render: the parser's own words as text. This is what
   stands where mermaid would otherwise have left its "Syntax error in text"
   error picture in the page. */
.dsd-renderError{max-width:720px;margin:0 auto;display:flex;flex-direction:column;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:8px;border:1px solid rgba(214,64,64,.25);background:rgba(214,64,64,.06)}
.dsd-renderErrorTop{font-size:12px;line-height:1.55;color:#c05a5a}
.dsd-renderErrorActions{display:flex;align-items:center;gap:6px}
.dsd-diags{margin:0 auto;padding:8px 10px;border-radius:8px;background:rgba(214,64,64,.08);border:1px solid rgba(214,64,64,.25);color:#c05a5a;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;white-space:pre-wrap;max-width:720px;overflow:auto}
/* Advisory findings: never a refusal, so never red. */
.dsd-warnings{max-width:720px;margin:0 auto;display:flex;flex-direction:column;gap:3px;padding:8px 10px;border-radius:8px;border:1px solid rgba(190,140,20,.28);background:rgba(190,140,20,.07);color:#8a6412;font-size:11.5px;line-height:1.5}
.dsd-warningsHead{font-weight:500}
.dsd-drawer{flex:none;width:44%;min-width:240px;max-width:70%;display:flex;flex-direction:column;border-left:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));box-sizing:border-box}
.dsd-drawerHead{flex:none;display:flex;align-items:center;gap:6px;height:32px;padding:0 8px 0 12px;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}
.dsd-source{flex:1;min-height:0;width:100%;box-sizing:border-box;resize:none;border:0;outline:none;padding:10px 12px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:1.6;tab-size:2}
.dsd-row{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:8px;cursor:pointer;box-sizing:border-box}
.dsd-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.10))}
.dsd-rowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dsd-rowTitle{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsd-rowMeta{font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8a8a);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsd-list{flex:1;min-height:0;overflow:auto;padding:10px;display:flex;flex-direction:column;gap:4px}
/* The two halves of the index: the shared library, then this conversation. */
.dsd-listHead{flex:none;padding:8px 10px 2px;font-size:11px;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
.dsd-empty{padding:28px 20px;text-align:center;color:var(--dsw-alias-label-secondary,#666);font-size:12.5px;line-height:1.7}
.dsd-menu{position:absolute;z-index:20;min-width:190px;padding:5px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22));background:var(--dsw-alias-surface-l1,#fff);box-shadow:0 8px 26px rgba(0,0,0,.18)}
.dsd-menuItem{display:block;width:100%;text-align:left;appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:12.5px;padding:7px 9px;border-radius:7px;cursor:pointer}
.dsd-menuItem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsd-menuHead{padding:5px 9px 3px;font-size:11px;letter-spacing:.02em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary,#8a8a8a)}
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
    /**
     * The address of one diagram. A library diagram's address names NO
     * conversation, which is what makes it openable - and citable - from any
     * chat.
     */
    function addressFor(sessionId, diagramId, scope) {
      if (scope === LIBRARY_SCOPE) return LIBRARY_PREFIX + encodeURIComponent(diagramId)
      return ADDRESS_PREFIX + encodeURIComponent(sessionId) + '/' + encodeURIComponent(diagramId)
    }

    /** The session id + diagram id an address carries, or nulls. */
    function parseDiagramAddress(address) {
      const text = String(address ?? '')
      try {
        if (text.startsWith(LIBRARY_PREFIX)) {
          return { scope: LIBRARY_SCOPE, sessionId: null, diagramId: decodeURIComponent(text.slice(LIBRARY_PREFIX.length)) }
        }
        if (!text.startsWith(ADDRESS_PREFIX)) return { scope: null, sessionId: null, diagramId: null }
        const rest = text.slice(ADDRESS_PREFIX.length)
        const slash = rest.indexOf('/')
        if (slash === -1) return { scope: null, sessionId: null, diagramId: null }
        return { scope: 'conversation', sessionId: decodeURIComponent(rest.slice(0, slash)), diagramId: decodeURIComponent(rest.slice(slash + 1)) }
      } catch (err) {
        return { scope: null, sessionId: null, diagramId: null }
      }
    }

    // ---------------------------------------------------------------------
    // The store: one entry per conversation
    // ---------------------------------------------------------------------
    /**
     * `stores` is the whole client-side model: `{ diagrams, byId, library,
     * libraryById, capabilities, loaded, error, inflight, listeners }` per
     * session. Both the conversation card and every tab read it, which is what
     * keeps an open tab in step with a write that happened in the chat. The
     * LIBRARY rides along in every session's copy - the state route returns it -
     * so a diagram published anywhere is visible everywhere without a second
     * request.
     */
    const stores = new Map()

    /** The (created-on-demand) store of one session. */
    function storeFor(sessionId) {
      const key = String(sessionId ?? '')
      let store = stores.get(key)
      if (!store) {
        store = {
          sessionId: key,
          diagrams: [],
          byId: new Map(),
          library: [],
          libraryById: new Map(),
          libraryPath: null,
          capabilities: null,
          loaded: false,
          error: null,
          inflight: null,
          listeners: new Set(),
        }
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
      store.library = Array.isArray(payload && payload.library) ? payload.library : []
      store.libraryById = new Map(store.library.map((entry) => [entry.id, entry]))
      store.libraryPath = (payload && payload.libraryPath) || null
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

    /**
     * Merge one diagram the caller already has into the store (no round trip).
     *
     * The diagram says which half it belongs to (`scope`), so a write into the
     * library lands in the library list and a write into the conversation lands
     * in the conversation list - and both are visible in this session either way.
     */
    function upsertDiagram(sessionId, diagram) {
      if (!sessionId || !diagram || !diagram.id) return
      const store = storeFor(sessionId)
      const inLibrary = diagram.scope === LIBRARY_SCOPE
      const map = inLibrary ? store.libraryById : store.byId
      const existing = map.get(diagram.id)
      if (existing) Object.assign(existing, diagram)
      else {
        // The new entry IS the payload: the route and the tool result both carry
        // the full diagram (source, revision, verification), and a placeholder
        // summary here would leave the tab without a source to render until the
        // next state refresh.
        map.set(diagram.id, diagram)
        if (inLibrary) store.library = store.library.concat([diagram])
        else store.diagrams = store.diagrams.concat([diagram])
      }
      // The maps are the source of truth; keep the arrays pointing at the same objects.
      store.byId = new Map(store.diagrams.map((entry) => [entry.id, store.byId.get(entry.id) ?? entry]))
      store.libraryById = new Map(store.library.map((entry) => [entry.id, store.libraryById.get(entry.id) ?? entry]))
      store.diagrams = store.diagrams.map((entry) => store.byId.get(entry.id) ?? entry)
      store.library = store.library.map((entry) => store.libraryById.get(entry.id) ?? entry)
      notify(sessionId)
    }

    /** Forget one diagram after a delete, from whichever half held it. */
    function dropDiagram(sessionId, diagramId, scope) {
      const store = storeFor(sessionId)
      if (scope !== 'conversation') {
        store.libraryById.delete(diagramId)
        store.library = store.library.filter((entry) => entry.id !== diagramId)
      }
      if (scope !== LIBRARY_SCOPE) {
        store.byId.delete(diagramId)
        store.diagrams = store.diagrams.filter((entry) => entry.id !== diagramId)
      }
      notify(sessionId)
    }

    /**
     * One stored diagram, by scope: `library` reads the shared list, anything
     * else this conversation. A caller with no scope (a card that only has an id
     * from a tool result) gets the LIBRARY first, which is the same rule the host
     * applies - so the card and the model never disagree about which diagram an
     * id names.
     */
    function entryNow(sessionId, diagramId, scope) {
      if (!diagramId) return null
      const store = storeFor(sessionId)
      if (scope === LIBRARY_SCOPE) return store.libraryById.get(diagramId) ?? null
      if (scope === 'conversation') return store.byId.get(diagramId) ?? null
      return store.libraryById.get(diagramId) ?? store.byId.get(diagramId) ?? null
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
     * The ONE element every Mermaid render happens inside.
     *
     * This is not a detail. `mermaid.render(id, source)` with no container
     * element builds `#d<id>` on `document.body`, renders the picture there and
     * removes it again - but ONLY on the success path. Any failure that throws
     * (a parse error; a render error with `suppressErrorRendering` on) leaves
     * that div behind, and when the engine's own error diagram was drawn into it
     * first, what stays in the page is a full 2412x512 picture reading
     * "Syntax error in text / mermaid version 11.17.2" - one per failed render,
     * sitting in the interface until the tab is reloaded. Passing a container we
     * own keeps every one of those divs out of the document, so there is nothing
     * left to leak.
     */
    let renderHost = null
    /** Ids handed to the engine, so the sweep below can recognise its divs. */
    const RENDER_ID_PREFIX = 'dshd-'
    /** A monotonic counter: the engine wants an id it has not seen, and a
     *  deterministic one keeps a bug report reproducible. */
    let renderSeq = 0

    /**
     * The offscreen element Mermaid renders into: attached (the engine measures
     * what it draws, so a detached node has no geometry), laid out at zero size
     * and out of the way, so nothing it does can paint over the interface.
     */
    function mermaidHost() {
      if (renderHost && document.body && document.body.contains(renderHost)) return renderHost
      renderHost = document.createElement('div')
      renderHost.setAttribute('data-dsh-diagrams', 'render-host')
      renderHost.style.cssText = 'position:absolute;left:-100000px;top:0;width:1px;height:1px;overflow:hidden;pointer-events:none;opacity:0'
      document.body.appendChild(renderHost)
      return renderHost
    }

    /**
     * Remove anything the engine left in the document that is not ours.
     *
     * Belt and braces behind {@link mermaidHost}: a future engine change that
     * ignores the container argument must not be able to put a picture in the
     * page. Only the plugin's own `d<id>`/`i<id>` fixtures are touched - never
     * another plugin's element - and the caller's container is never removed.
     */
    function sweepMermaidFixtures() {
      if (typeof document === 'undefined' || !document.body) return
      for (const child of Array.from(document.body.children)) {
        if (child === renderHost) continue
        const id = String(child.id || '')
        if (id.startsWith('d' + RENDER_ID_PREFIX) || id.startsWith('i' + RENDER_ID_PREFIX)) {
          try {
            child.remove()
          } catch (err) {
            /* a node that is already gone is the outcome we wanted */
          }
        }
      }
    }

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

    /** One Mermaid failure with the parser's own words, and whether it parsed. */
    class MermaidError extends Error {
      constructor(error, phase) {
        super(error && error.message ? String(error.message) : String(error))
        this.name = 'MermaidError'
        /** `parse` (the source is not valid Mermaid) or `render` (it parsed but would not draw). */
        this.phase = phase === 'parse' ? 'parse' : 'render'
      }
    }

    /** One normalized Mermaid failure, as the engine reports it. */
    function mermaidFailure(err, phase) {
      if (err instanceof MermaidError) return err
      return new MermaidError(err, phase)
    }

    /**
     * Render one Mermaid source to SVG, in the app's current theme.
     *
     * The order here is the whole point:
     *
     *   1. **`parse()` first.** It is the engine's own syntax check and it
     *      throws with the offending line. `render()` is only ever reached by a
     *      source the parser accepted, which is what keeps a broken diagram from
     *      producing a picture at all - clean or broken.
     *   2. **`suppressErrorRendering: true`.** If `render()` fails anyway (a
     *      renderer bug on a source the parser accepted), the engine throws
     *      instead of drawing its 2412x512 "Syntax error in text" diagram.
     *   3. **A container we own**, so nothing the engine builds lands in the
     *      page, plus a sweep in `finally` for anything that ignored it.
     *
     * A source that fails either step comes back as a {@link MermaidError}
     * whose `phase` says which one, and the caller draws that as TEXT. There is
     * no path here that puts an engine error picture in the interface.
     *
     * @param source - the diagram source.
     * @param dark - whether the app is dark right now.
     * @returns the SVG markup.
     * @throws {MermaidError} when the source does not parse or does not draw.
     */
    async function renderMermaid(source, dark) {
      const theme = dark ? 'dark' : 'default'
      const text = String(source ?? '')
      if (text.trim().length === 0) throw new MermaidError('the diagram has no source yet', 'parse')
      const cacheKey = theme + '\u0000' + text
      if (svgCache.has(cacheKey)) {
        const hit = svgCache.get(cacheKey)
        svgCache.delete(cacheKey)
        svgCache.set(cacheKey, hit)
        return hit
      }
      const mermaid = await loadEngine()
      if (engineTheme !== theme) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme,
          // Never let the engine draw its own error diagram: it is an enormous
          // SVG whose only content is "Syntax error in text / mermaid version
          // <v>", and it is exactly the picture this plugin must never show.
          suppressErrorRendering: true,
        })
        engineTheme = theme
      }
      // Step 1: the parser decides. A refusal here never reaches the renderer.
      try {
        await mermaid.parse(text)
      } catch (err) {
        throw mermaidFailure(err, 'parse')
      }
      renderSeq += 1
      const id = RENDER_ID_PREFIX + renderSeq.toString(36).padStart(6, '0')
      try {
        const rendered = await mermaid.render(id, text, mermaidHost())
        const svg = rendered && rendered.svg ? String(rendered.svg) : ''
        if (svg.trim().length === 0) throw new Error('the engine produced an empty picture')
        svgCache.set(cacheKey, svg)
        while (svgCache.size > SVG_CACHE_MAX) {
          const oldest = svgCache.keys().next()
          if (oldest.done) break
          svgCache.delete(oldest.value)
        }
        return svg
      } catch (err) {
        throw mermaidFailure(err, 'render')
      } finally {
        // Nothing the engine built may survive the call, success or failure.
        sweepMermaidFixtures()
      }
    }

    /**
     * Render a Mermaid source and hand back the verdict instead of throwing.
     * The one entry point the pictures use, so no surface has to know the order
     * of parse/render or remember to sweep.
     *
     * @returns `{ ok, svg, error, phase, ms }`.
     */
    async function renderMermaidSafe(source, dark) {
      const started = Date.now()
      try {
        const svg = await renderMermaid(source, dark)
        return { ok: true, svg, error: null, phase: null, ms: Date.now() - started }
      } catch (err) {
        const failure = err instanceof MermaidError ? err : new MermaidError(err, 'render')
        return { ok: false, svg: '', error: failure.message, phase: failure.phase, ms: Date.now() - started }
      }
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

    /**
     * What the BROWSER reported about THIS revision - a different question from
     * whether the host could validate the source, and the one the agent reads
     * back through `diagram_read`.
     *
     * The state itself is computed by the HOST (`lib/store.js`, one
     * implementation for the tool result, the index and this pill) and this only
     * draws it: `drawn` (a renderer reported success for this very revision),
     * `failed` (it reported failure, with its own error), `stale` (the newest
     * report names an older revision, so this one has never been drawn), or
     * `pending` (no report at all). Nothing is guessed and nothing is
     * optimistic: with no report the pill says so instead of implying a picture.
     */
    function RenderPill(props) {
      const entry = props.entry
      const verdict = entry && entry.verification ? entry.verification : renderVerdictOf(entry)
      const revision = verdict && Number.isFinite(verdict.revision) ? verdict.revision : 0
      if (!verdict || verdict.state === 'pending') {
        return h(
          'span',
          { className: 'dsd-pill', 'data-status': 'pending', title: 'No browser has reported on revision ' + revision + ' yet. Nothing here says a picture exists.' },
          'not drawn',
        )
      }
      if (verdict.state === 'stale') {
        return h(
          'span',
          { className: 'dsd-pill', 'data-status': 'stale', title: 'The newest render report is about revision ' + verdict.reported + '; the current revision is ' + revision + '.' },
          'stale',
        )
      }
      if (verdict.state === 'drawn') {
        return h(
          'span',
          { className: 'dsd-pill', 'data-status': 'drawn', title: 'A browser reported it DREW revision ' + revision + (verdict.at ? ' at ' + verdict.at : '') + '.' },
          'drawn',
        )
      }
      const error = verdict.error || (entry && entry.render && entry.render.error) || 'the renderer did not report a reason'
      return h(
        'span',
        { className: 'dsd-pill', 'data-status': 'failed', title: 'A browser reported it could NOT draw revision ' + revision + ': ' + error },
        'not drawn',
      )
    }

    /**
     * The same four answers the host computes, for a payload written by an older
     * host. The two halves ship together, but a browser can still be holding a
     * cached bundle from before a restart, and a verdict that is MISSING must
     * never be read as "drawn".
     */
    function renderVerdictOf(entry) {
      const current = entry && Number.isFinite(entry.revision) ? entry.revision : 0
      const report = entry && entry.render ? entry.render : null
      if (!report) return { state: 'pending', revision: current, reported: null }
      const reported = Number.isFinite(report.revision) ? report.revision : null
      if (reported === null || reported !== current) return { state: 'stale', revision: current, reported }
      return {
        state: report.ok ? 'drawn' : 'failed',
        revision: current,
        reported,
        error: report.ok ? null : report.error,
        at: report.at,
      }
    }

    /** The tooltip of a status pill: the verdict AND the advisory warnings. */
    function verdictTitle(entry) {
      if (!entry) return undefined
      const parts = []
      for (const diagnostic of entry.diagnostics ?? []) parts.push(diagnostic.text)
      for (const warning of entry.warnings ?? []) parts.push('warning: ' + warning.text)
      if (entry.render && entry.render.ok === false) parts.push('the browser could not draw it: ' + (entry.render.error || 'unknown render failure'))
      return parts.length > 0 ? parts.join('\n') : undefined
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

    /**
     * The host's ADVISORY findings, drawn apart from the errors.
     *
     * Warnings never block a write: they are the things a parser cannot refuse
     * but a reader will feel - an unbalanced-looking label, a picture with more
     * nodes than a person will read, a likely wrong diagram type. Kept visually
     * distinct so nobody mistakes advice for a refusal.
     */
    function Warnings(props) {
      const list = props.warnings ?? []
      if (list.length === 0) return null
      return h(
        'div',
        { className: 'dsd-warnings' },
        h('div', { className: 'dsd-warningsHead' }, 'Worth checking'),
        list.map((warning, index) => h('div', { key: index, className: 'dsd-warningRow' }, warning.text)),
      )
    }

    // ---------------------------------------------------------------------
    // Pictures
    // ---------------------------------------------------------------------
    /**
     * Tell the host what the browser did with one diagram.
     *
     * This is the verification the model cannot get on its own: parsing proves
     * the source is valid Mermaid, and only a real renderer proves the picture
     * exists. The report is best-effort and never surfaces to the user - a
     * failed POST costs nothing but the missing line in `diagram_read`.
     */
    function postRenderReport(sessionId, diagramId, revision, report, scope) {
      if (!sessionId || !diagramId) return
      try {
        fetch(REPORT_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          // The scope travels with the report: a LIBRARY diagram is reported from
          // whichever conversation happens to have its tab open.
          body: JSON.stringify({ session: sessionId, id: diagramId, revision, scope, ...report }),
        }).catch(() => {})
      } catch (err) {
        /* a report is a courtesy; it must never break a picture */
      }    }

    /**
     * The failing source drawn as TEXT, with the parser's own words.
     *
     * This is the replacement for the engine's error picture: the diagnostics
     * (which carry the line, the caret and the "Expecting" list) in a scrollable
     * block, plus the three things a person actually wants next.
     */
    function RenderError(props) {
      const lines = props.diagnostics ?? []
      const headline =
        props.phase === 'parse'
          ? 'Mermaid refused this diagram, so nothing was drawn:'
          : 'The Mermaid parser accepted this diagram but the renderer could not draw it:'
      return h(
        'div',
        { className: 'dsd-renderError' },
        h('div', { className: 'dsd-renderErrorTop' }, headline),
        lines.length > 0 ? h(Diagnostics, { diagnostics: lines }) : h('div', { className: 'dsd-renderErrorTop' }, props.error || 'no diagnostics were reported'),
        h(
          'div',
          { className: 'dsd-renderErrorActions' },
          props.onRetry ? h(Button, { title: 'Render this source again', onClick: props.onRetry }, 'Retry') : null,
          props.onOpenSource ? h(Button, { title: 'Open the source drawer', onClick: props.onOpenSource }, 'Edit source') : null,
          props.diagramId && props.sessionId
            ? h(Button, { title: 'Open this diagram in its own tab', onClick: props.onOpenTab }, 'Open tab')
            : null,
        ),
      )
    }

    /**
     * A Mermaid picture.
     *
     * The engine never draws its own errors here: `renderMermaidSafe` parses
     * first and asks the engine to throw rather than illustrate a failure, so a
     * bad diagram produces a text panel and NOT the "Syntax error in text"
     * picture mermaid would otherwise leave in the page.
     */
    function MermaidPicture(props) {
      const dark = useDark()
      const [state, setState] = useState({ svg: '', error: null, phase: null, diagnostics: [], busy: true, ms: 0, nonce: 0 })
      const source = props.source ?? ''
      const revision = props.revision ?? 0
      /** The last (revision, theme, attempt) actually reported, so a re-render of
       *  the same thing does not report twice. */
      const reported = useRef(null)

      useEffect(() => {
        let cancelled = false
        setState((previous) => ({ ...previous, busy: true }))
        renderMermaidSafe(source, dark)
          .then((result) => {
            if (cancelled) return
            setState({
              svg: result.svg,
              error: result.error,
              phase: result.phase,
              diagnostics: result.ok ? [] : splitDiagnostics(result.error),
              busy: false,
              ms: result.ms,
              nonce: 0,
            })
          })
          .catch((err) => {
            if (cancelled) return
            const text = err && err.message ? err.message : String(err)
            setState({ svg: '', error: text, phase: 'render', diagnostics: splitDiagnostics(text), busy: false, ms: 0, nonce: 0 })
          })
        return () => {
          cancelled = true
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [source, dark, state.nonce])

      // Report what happened, once per revision per outcome.
      useEffect(() => {
        if (state.busy) return
        const theme = dark ? 'dark' : 'default'
        const key = [revision, theme, state.error ? state.phase : 'ok', state.nonce].join('|')
        if (reported.current === key) return
        reported.current = key
        postRenderReport(
          props.sessionId,
          props.diagramId,
          revision,
          {
            kind: 'mermaid',
            ok: !state.error,
            phase: state.phase,
            error: state.error,
            diagnostics: state.diagnostics,
            theme,
            ms: state.ms,
          },
          props.scope,
        )
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [state.busy, state.error, state.phase, revision, dark, state.nonce])

      if (state.error) {
        return h(RenderError, {
          error: state.error,
          phase: state.phase,
          diagnostics: state.diagnostics,
          sessionId: props.sessionId,
          diagramId: props.diagramId,
          onRetry: () => setState((previous) => ({ ...previous, nonce: previous.nonce + 1 })),
          onOpenSource: props.onEdit,
          onOpenTab: props.onOpen,
        })
      }
      if (!state.svg) {
        return h('div', { className: 'dsd-notice' }, state.busy ? 'Rendering the Mermaid diagram...' : 'Nothing to render yet.')
      }
      return h('div', { className: 'dsd-svg', dangerouslySetInnerHTML: { __html: state.svg } })
    }

    /**
     * A Mermaid failure split into the diagnostics the shared block renders: one
     * entry per non-empty line, so the parser's caret and "Expecting" list keep
     * their own lines instead of collapsing into one paragraph.
     */
    function splitDiagnostics(text) {
      return String(text ?? '')
        .split('\n')
        .map((line) => ({ kind: 'render', text: line.replace(/\s+$/, '') }))
        .filter((entry) => entry.text.length > 0)
        .slice(0, 8)
    }

    /** A TikZ picture: the host compiled it, so fetch the artifact and show it. */
    function TikzPicture(props) {
      const sessionId = props.sessionId
      const diagramId = props.diagramId
      const revision = props.revision ?? 0
      const scope = props.scope
      const [state, setState] = useState({ url: null, error: null, bytes: 0 })
      const reported = useRef(null)
      useEffect(() => {
        let cancelled = false
        let objectUrl = null
        setState({ url: null, error: null, bytes: 0 })
        if (!sessionId || !diagramId) {
          setState({ url: null, error: 'This tab does not know which conversation the diagram belongs to.', bytes: 0 })
          return () => {}
        }
        const url =
          ARTIFACT_ROUTE +
          '?session=' +
          encodeURIComponent(sessionId) +
          '&id=' +
          encodeURIComponent(diagramId) +
          '&format=' +
          (props.format || 'svg') +
          '&scope=' +
          encodeURIComponent(scope ?? '') +
          '&v=' +
          revision
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
            setState({ url: objectUrl, error: null, bytes: blob.size })
          })
          .catch((err) => {
            if (!cancelled) setState({ url: null, error: err && err.message ? err.message : String(err), bytes: 0 })
          })
        return () => {
          cancelled = true
          if (objectUrl) URL.revokeObjectURL(objectUrl)
        }
      }, [sessionId, diagramId, revision, props.format, scope])

      // The host compiled it; the browser confirms the artifact actually loads.
      useEffect(() => {
        if (!sessionId || !diagramId) return
        if (state.url === null && state.error === null) return
        const key = [revision, state.error ? 'error' : 'ok'].join('|')
        if (reported.current === key) return
        reported.current = key
        postRenderReport(
          sessionId,
          diagramId,
          revision,
          {
            kind: 'tikz',
            ok: !state.error,
            phase: state.error ? 'artifact' : null,
            error: state.error,
            bytes: state.bytes,
          },
          scope,
        )
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [state.url, state.error, revision, sessionId, diagramId, scope])

      if (state.error) return h('div', { className: 'dsd-notice' }, state.error)
      if (!state.url) return h('div', { className: 'dsd-notice' }, 'Loading the compiled picture...')
      // `draggable: false` matters: the canvas pans by dragging, and a native
      // image drag would take the gesture away from it.
      return h('img', { className: 'dsd-picture', src: state.url, alt: props.alt || 'TikZ diagram', draggable: false })
    }

    /** One picture, dispatched by kind. */
    function Picture(props) {
      if (props.kind === 'tikz') {
        return h(TikzPicture, {
          sessionId: props.sessionId,
          diagramId: props.diagramId,
          revision: props.revision,
          scope: props.scope,
          format: 'svg',
          alt: props.title,
        })
      }
      return h(MermaidPicture, {
        source: props.source,
        sessionId: props.sessionId,
        diagramId: props.diagramId,
        revision: props.revision,
        scope: props.scope,
        onEdit: props.onEdit,
        onOpen: props.onOpen,
      })
    }

    /**
     * The picture of one STORED diagram, with the one case the engines cannot
     * handle on their own taken out of their hands.
     *
     * A Mermaid source the host already refused is not rendered at all. It has
     * no picture to make, and asking the engine anyway is what a broken diagram
     * costs: a wasted render, and - before alpha.3 - the engine's own "Syntax
     * error in text" diagram ending up in the page. The `diagnostics` the card
     * draws right below this say what is wrong.
     *
     * TikZ is deliberately NOT short-circuited: a compile that failed but still
     * produced a PDF is cached and worth showing, flagged as errored, because it
     * tells the reader what LaTeX did understand.
     */
    function StoredPicture(props) {
      const entry = props.entry
      if (!entry) return null
      if (entry.kind === 'mermaid' && entry.status === 'error') {
        return h(
          'div',
          { className: 'dsd-notice', 'data-tone': 'error' },
          'This diagram does not parse, so there is nothing to draw. The parser\u2019s own words are below - fix them and apply, or ask for it again.',
        )
      }
      return h(Picture, {
        kind: entry.kind,
        source: entry.source,
        sessionId: props.sessionId,
        diagramId: entry.id,
        revision: entry.revision,
        scope: props.scope,
        title: entry.title,
        onEdit: props.onEdit,
        onOpen: props.onOpen,
      })
    }

    // ---------------------------------------------------------------------
    // Data helpers shared by the panel and the cards
    // ---------------------------------------------------------------------
    /** The stored diagram of a conversation, or null. Library-first, like the host. */
    function diagramNow(sessionId, diagramId, scope) {
      return entryNow(sessionId, diagramId, scope)
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

    /**
     * The SVG markup of a rendered Mermaid picture, for export.
     *
     * Goes through the same parse-first path as the pictures: an export of a
     * diagram that does not parse fails with the parser's own message instead of
     * writing an engine error picture into the conversation folder.
     */
    async function mermaidSvgNow(source, dark) {
      const result = await renderMermaidSafe(source, dark)
      if (!result.ok) {
        const err = new Error(result.error || 'the diagram could not be rendered')
        err.phase = result.phase
        throw err
      }
      return result.svg
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
      /** The scope the ADDRESS names: a library tab is one tab for every chat. */
      const scope = parsed.scope
      const sessionId = parsed.sessionId || props.sessionId
      const diagramId = parsed.diagramId
      const { store, version } = useDiagramStore(sessionId)
      const entry = entryNow(sessionId, diagramId, scope)
      const [drawer, setDrawer] = useState(false)
      const [draft, setDraft] = useState('')
      const [status, setStatus] = useState('')
      const [busy, setBusy] = useState(false)
      const [menu, setMenu] = useState(false)
      const revision = entry ? entry.revision : 0
      const dark = useDark()
      const source = entry ? entry.source : ''
      /** The zoom this tab is at, remembered per diagram across tab switches. */
      const zoomKey = sessionId + '/' + diagramId
      const [zoom, setZoomState] = useState(() => zoomMemory.get(zoomKey) ?? ZOOM_DEFAULT)
      /** The scroll viewport is also the pan surface; nothing is transformed. */
      const canvasRef = useRef(null)
      /** One in-flight drag: the pointer origin and the scroll origin. */
      const pan = useRef(null)
      const [panning, setPanning] = useState(false)
      const [pannable, setPannable] = useState(false)
      // A tab body is reused across navigations, so the zoom is re-read for the
      // diagram now in the tab instead of leaking the previous one's.
      useEffect(() => {
        setZoomState(zoomMemory.get(zoomKey) ?? ZOOM_DEFAULT)
      }, [zoomKey])

      /**
       * Move to one zoom rung.
       *
       * The reader's point is remembered BEFORE the layout changes, and restored
       * on the next animation frame: by then React has committed the new box and
       * the browser has laid it out, but the frame has not been painted yet, so
       * the picture never jumps to a different place. (A `useLayoutEffect` would
       * do the same job and warns under any server renderer, which the tracked
       * check is.)
       */
      const zoomTo = useCallback(
        (next) => {
          const canvas = canvasRef.current
          let anchor = null
          if (canvas && canvas.scrollWidth > canvas.clientWidth) {
            anchor = {
              x: (canvas.scrollLeft + canvas.clientWidth / 2) / canvas.scrollWidth,
              y: (canvas.scrollTop + canvas.clientHeight / 2) / canvas.scrollHeight,
            }
          }
          zoomMemory.set(zoomKey, next)
          setZoomState(next)
          if (!anchor) return
          const restore = () => {
            const element = canvasRef.current
            if (!element) return
            element.scrollLeft = anchor.x * element.scrollWidth - element.clientWidth / 2
            element.scrollTop = anchor.y * element.scrollHeight - element.clientHeight / 2
          }
          if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(restore)
          else restore()
        },
        [zoomKey],
      )
      /** One rung on the ladder; the ends clamp rather than wrap around. */
      const stepZoom = useCallback(
        (direction) => {
          const found = ZOOM_STEPS.findIndex((step) => step >= zoom - 1e-6)
          const from = found === -1 ? ZOOM_STEPS.length - 1 : found
          const next = ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, from + direction))]
          if (next !== zoom) zoomTo(next)
        },
        [zoom, zoomTo],
      )
      /** Back to the fit width (80% of the pane), which is what 100% means here. */
      const resetZoom = useCallback(() => {
        if (zoom !== ZOOM_DEFAULT) zoomTo(ZOOM_DEFAULT)
      }, [zoom, zoomTo])
      /**
       * Whether there is anything to pan. Measured rather than assumed: a
       * picture that fits must not offer a grab cursor, and a wide diagram at
       * 100% must, because it overflows without any zoom at all.
       */
      const measurePannable = useCallback(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        setPannable(canvas.scrollWidth > canvas.clientWidth + 1 || canvas.scrollHeight > canvas.clientHeight + 1)
      }, [])
      useEffect(() => {
        measurePannable()
        const canvas = canvasRef.current
        if (!canvas || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(measurePannable)
        observer.observe(canvas)
        return () => observer.disconnect()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [measurePannable, zoom, source, drawer, dark])

      /**
       * Drag to pan. The picture is laid out at its real size in a scrollable
       * box, so panning is `scrollLeft`/`scrollTop` - no transform, no
       * repositioning, and the wheel keeps working normally.
       *
       * Mouse only: a touch drag is the browser's own scroll, and hijacking it
       * would take the gesture away from the platform.
       */
      const onPointerDown = (event) => {
        if (event.pointerType !== 'mouse' || event.button !== 0) return
        const canvas = canvasRef.current
        if (!canvas) return
        const target = event.target
        if (target && typeof target.closest === 'function' && target.closest('button, a, input, textarea, select')) return
        pan.current = { x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop }
        setPanning(true)
        try {
          canvas.setPointerCapture(event.pointerId)
        } catch (err) {
          /* an old browser: the move events still arrive while the pointer is over it */
        }
        // Stops text selection and the browser's own image drag from stealing the gesture.
        event.preventDefault()
      }
      const onPointerMove = (event) => {
        const start = pan.current
        const canvas = canvasRef.current
        if (!start || !canvas) return
        canvas.scrollLeft = start.left - (event.clientX - start.x)
        canvas.scrollTop = start.top - (event.clientY - start.y)
      }
      const endPan = (event) => {
        const canvas = canvasRef.current
        if (canvas && event && typeof canvas.releasePointerCapture === 'function') {
          try {
            canvas.releasePointerCapture(event.pointerId)
          } catch (err) {
            /* already released */
          }
        }
        pan.current = null
        setPanning(false)
      }

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
            body: JSON.stringify({
              session: sessionId,
              id: diagramId,
              source: draft,
              scope,
              recompile: entry && entry.kind === 'tikz',
            }),
          })
          if (answer && answer.diagram) upsertDiagram(sessionId, answer.diagram)
          setStatus(answer && answer.status ? 'status: ' + answer.status : 'saved')
        } catch (err) {
          setStatus(err && err.message ? err.message : 'save failed')
        } finally {
          setBusy(false)
        }
      }, [sessionId, diagramId, draft, entry])

      /**
       * Save one export to the Desktop of the machine running the harness.
       *
       * The client names a FORMAT and never a path: the host resolves the
       * Desktop (which can be OneDrive-redirected or XDG-configured), writes
       * create-exclusively and answers with the absolute path, which is what the
       * status line reports. A Mermaid SVG/PNG is produced here, because the
       * browser is what rendered it, and travels in the body as base64.
       */
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
              body: JSON.stringify({ session: sessionId, id: diagramId, format, data, scope }),
            })
            setStatus('saved to ' + (answer && answer.path ? answer.path : 'the Desktop'))
          } catch (err) {
            setStatus(err && err.message ? err.message : 'export failed')
          } finally {
            setBusy(false)
          }
        },
        [sessionId, diagramId, entry, dark],
      )

      /**
       * Download one export through the BROWSER instead of the Desktop - the
       * fallback for a profile whose host half is not mounted (then nothing can
       * resolve a Desktop), kept for the same reason the screenshot control
       * keeps it.
       */
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
          h(StatusPill, { status: entry.status, title: verdictTitle(entry) }),
          h(RenderPill, { entry }),
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
            h(Button, { key: 'export', title: 'Save this diagram to the Desktop of this machine', onClick: () => setMenu((value) => !value) }, 'Export ▾'),
            menu
              ? h(
                  'div',
                  { key: 'menu', className: 'dsd-menu', style: { right: 0, top: 28 } },
                  h('div', { key: 'saveHead', className: 'dsd-menuHead' }, 'Save to the Desktop'),
                  formats.map((format) =>
                    h('button', { key: 'save-' + format, type: 'button', className: 'dsd-menuItem', disabled: busy, onClick: () => exportAs(format) }, 'Save .' + format),
                  ),
                  h('div', { key: 'sep', className: 'dsd-menuSep' }),
                  formats.map((format) =>
                    h('button', { key: 'dl-' + format, type: 'button', className: 'dsd-menuItem', disabled: busy, onClick: () => downloadAs(format) }, 'Download .' + format + ' in the browser'),
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
            {
              className: 'dsd-canvas',
              'data-drawer': drawer ? 'true' : undefined,
              'data-pannable': pannable ? 'true' : undefined,
              'data-panning': panning ? 'true' : undefined,
              ref: canvasRef,
              onPointerDown,
              onPointerMove,
              onPointerUp: endPan,
              onPointerCancel: endPan,
              onLostPointerCapture: endPan,
            },
            h(
              'div',
              {
                className: 'dsd-zoomBox',
                // Past 100% the picture follows the BOX instead of its own
                // natural width (see the stylesheet): without it a diagram
                // narrower than the pane would refuse to grow.
                'data-zoomed': zoom > ZOOM_DEFAULT ? 'true' : undefined,
                style: { width: ZOOM_FIT_WIDTH * zoom + '%' },
              },
              h(StoredPicture, { entry, sessionId, scope, onEdit: () => setDrawer(true) }),
              entry.status === 'unavailable'
                ? h('div', { className: 'dsd-notice' }, 'This diagram was stored but could not be validated on this host.')
                : null,
              (entry.diagnostics ?? []).length > 0 ? h(Diagnostics, { diagnostics: entry.diagnostics }) : null,
              (entry.warnings ?? []).length > 0
                ? h(
                    'div',
                    { className: 'dsd-notice' },
                    h('b', null, 'Warnings from the host'),
                    h('br', null),
                    (entry.warnings ?? []).map((warning) => warning.text).join('\n'),
                  )
                : null,
            ),
          ),
          // The zoom ladder floats over the canvas rather than living in the
          // toolbar: it belongs to the PICTURE, and the toolbar is already
          // carrying the verdicts, the source and the export.
          h(
            'div',
            { className: 'dsd-zoomBar' },
            h(Button, {
              icon: '\u2212',
              title: 'Zoom out',
              disabled: busy || zoom <= ZOOM_STEPS[0],
              onClick: () => stepZoom(-1),
            }),
            h('span', { className: 'dsd-zoomLabel' }, Math.round(zoom * 100) + '%'),
            h(Button, {
              icon: '+',
              title: 'Zoom in',
              disabled: busy || zoom >= ZOOM_STEPS[ZOOM_STEPS.length - 1],
              onClick: () => stepZoom(1),
            }),
            h(
              Button,
              {
                title: 'Fit the tab width again (100% is ' + ZOOM_FIT_WIDTH + '% of the pane)',
                disabled: busy || zoom === ZOOM_DEFAULT,
                onClick: resetZoom,
              },
              'Fit',
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
          body: JSON.stringify({ session: sessionId, id: diagramId, kind: entry.kind, source: entry.source, scope: entry.scope, recompile: true }),
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
      const entry = parsed.diagramId ? entryNow(sessionId, parsed.diagramId, parsed.scope) : null
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
      /** One list row; the scope decides which tab address it opens. */
      const row = (entry, scope) =>
        h(
          'div',
          { key: scope + '/' + entry.id, className: 'dsd-row', onClick: () => openDiagramFrom(sessionId, entry.id, setStatus, scope) },
          h('span', { className: 'dsd-badge' }, entry.kind === 'tikz' ? 'TikZ' : 'Mermaid'),
          h(
            'div',
            { className: 'dsd-rowMain' },
            h('div', { className: 'dsd-rowTitle' }, entry.title || entry.id),
            h('div', { className: 'dsd-rowMeta' }, metaLine(entry)),
          ),
          h(StatusPill, { status: entry.status, title: verdictTitle(entry) }),
          h(RenderPill, { entry }),
        )
      const nothing = store.diagrams.length === 0 && store.library.length === 0
      return h(
        'div',
        { className: 'dsd-root' },
        h(
          'div',
          { className: 'dsd-tools' },
          h('span', { className: 'dsd-cardTitle' }, 'Diagrams'),
          h('span', { className: 'dsd-status' }, status),
          h('span', { className: 'dsd-toolsSpacer' }),
          h(Button, { disabled: busy, title: 'Create a Mermaid diagram in this conversation', onClick: () => create('mermaid') }, 'New Mermaid'),
          h(Button, { disabled: busy || texNote, title: texNote ? 'No TeX engine on this host' : 'Create a TikZ diagram in this conversation', onClick: () => create('tikz') }, 'New TikZ'),
        ),
        h(
          'div',
          { className: 'dsd-filebar' },
          h('b', null, store.diagrams.length + ' here'),
          h('span', null, store.library.length + ' in the library'),
          texNote ? h('span', null, 'no TeX engine on this host: TikZ diagrams are stored and exported as .tex only') : null,
        ),
        nothing
          ? h(
              'div',
              { className: 'dsd-empty' },
              'Nothing yet: this conversation has no diagrams and the library is empty.',
              h('br', null),
              'Ask for one in the chat, or start a blank one above - the model can edit whatever you create here.',
            )
          : h(
              'div',
              { className: 'dsd-list' },
              // The LIBRARY first: it is the half that is the same in every
              // conversation, and the half whose ids are worth citing.
              h('div', { className: 'dsd-listHead' }, 'Library - every conversation sees these, and their ids are citable from any chat'),
              store.library.length === 0 ? h('div', { className: 'dsd-empty' }, 'Nothing published yet. Ask the model to publish a diagram, and it becomes citable from any chat.') : null,
              store.library.map((entry) => row(entry, LIBRARY_SCOPE)),
              h('div', { className: 'dsd-listHead' }, 'This conversation'),
              store.diagrams.length === 0 ? h('div', { className: 'dsd-empty' }, 'No diagrams in this conversation yet.') : null,
              store.diagrams.map((entry) => row(entry, 'conversation')),
            ),
        h('div', { className: 'dsd-filebar', style: { paddingTop: '4px' } }, 'dsh-diagrams ' + PLUGIN_VERSION),
      )
    }

    /** Open one diagram's tab through the right bar's controller. */
    function openDiagram(sessionId, diagramId, scope) {
      const controller = sidebarRightNow()
      if (!controller) throw new Error('The right bar is not mounted.')
      controller.openResource(addressFor(sessionId, diagramId, scope))
    }

    /** Open a diagram from a surface that shows a message instead of throwing. */
    function openDiagramFrom(sessionId, diagramId, setStatus, scope) {
      try {
        openDiagram(sessionId, diagramId, scope)
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
      /** `meta.scope` is where the host says the diagram ended up. */
      const scope = (meta && meta.scope) || null
      const known = id ? entryNow(sessionId, id, scope) : null
      const kind = (args && args.kind) || (meta && meta.kind) || (known && known.kind) || null
      const title = (args && args.title) || (meta && meta.title) || (known && known.title) || null
      const address = id && sessionId ? addressFor(sessionId, id, (known && known.scope) || scope) : null

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

      if (toolName === 'diagram_read' || toolName === 'diagram_verify') {
        const read = toolName === 'diagram_read'
        // A read hands the SOURCE back (that is what the model asked for and
        // what it may patch); a verify is about the picture, so it draws it.
        let body = null
        if (read && known) {
          const text = known.source
          body = h(
            'div',
            { className: 'dsd-cardBody' },
            h('pre', { className: 'dsd-cardPre' }, text.length > 2000 ? text.slice(0, 2000) + '\n...' : text),
          )
        } else if (!read && id && known) {
          body = h(
            'div',
            { className: 'dsd-cardBody' },
            h(StoredPicture, { entry: known, sessionId, scope: known.scope }),
            (known.diagnostics ?? []).length > 0 ? h(Diagnostics, { diagnostics: known.diagnostics }) : null,
            (known.warnings ?? []).length > 0 ? h(Warnings, { warnings: known.warnings }) : null,
          )
        }
        return h(
          'div',
          { className: 'dsd-card' },
          h(
            'div',
            { className: 'dsd-cardTop' },
            h('span', { className: 'dsd-badge' }, read ? 'read' : 'verify'),
            h(
              'span',
              { className: 'dsd-cardTitle' },
              id ? (read ? 'Diagram "' + id + '"' : 'Checked "' + id + '"') : read ? 'Diagram index' : 'Diagram check',
            ),
            known ? h(StatusPill, { status: known.status, title: verdictTitle(known) }) : null,
            known && !read ? h(RenderPill, { entry: known }) : null,
            h('span', { className: 'dsd-toolsSpacer' }),
            id && address ? h('button', { type: 'button', className: 'dsd-inlineLink', onClick: openTab }, 'Open tab') : null,
          ),
          body,
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
                : known
                  ? h(StoredPicture, { entry: known, sessionId, scope: known.scope })
                  : h(Picture, {
                      kind,
                      source: stripFence((args && args.source) || ''),
                      sessionId,
                      diagramId: id,
                      revision: 0,
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
    /** The `diagram` type: one resource address per diagram, in either scope. */
    function viewerDefinition() {
      return {
        id: VIEWER_ID,
        kind: VIEWER_KIND,
        // Two address shapes: one tab per conversation diagram, and one tab per
        // LIBRARY diagram - the same tab, opened from any chat.
        patterns: [ADDRESS_PREFIX + '**', LIBRARY_PREFIX + '**'],
        priority: 'extension',
        title: (address) => {
          const parsed = parseDiagramAddress(address)
          const entry = parsed.diagramId ? entryNow(parsed.sessionId, parsed.diagramId, parsed.scope) : null
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
