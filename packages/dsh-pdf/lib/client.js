/**
 * dsh-pdf — browser half.
 *
 * A tab TYPE for the pack's right bar (dsh-rightbar) that is a real PDF reader,
 * plus one conversation card per pdf_* tool.
 *
 * The type is registered at the `extension` band for `*.pdf`, which is what
 * makes it win the address: the shipped document preview claims
 * `dsh-resource://file/**` at the `fallback` band and renders PDFs with a bare
 * width-fitted page sequence, and an `extension`-band type outranks a
 * `fallback` one, so a PDF now opens here while every other file keeps exactly
 * the surface it had. The editor is unaffected: it vetoes `pdf` outright.
 *
 * Two address shapes are claimed, because a PDF can live in two places:
 *
 *   - `dsh-resource://file/session/<sessionId>/<path>` - the ordinary file
 *     grammar, so a click in the Files tab lands here;
 *   - `dsh-resource://pdf/absolute/<whole-path-encoded>` - this package's own
 *     shape for a document outside any conversation workspace (a chat
 *     attachment under <DSH_HOME>/attachments/..., or a file in Downloads). The
 *     ordinary grammar cannot carry a POSIX absolute path, because it drops the
 *     leading slash and would silently point somewhere else.
 *
 * What the reader adds over the shipped preview, and why each part is here:
 * a ZOOM LADDER plus fit-width/fit-page, page navigation with a jump field and
 * keyboard control, ROTATION, a selectable TEXT LAYER (pdf.js's own TextLayer),
 * in-document SEARCH with hit highlighting and next/previous, a per-tab
 * remembered scroll position, and honest failures - a damaged file, a locked
 * document (password prompt) and an engine that will not start each get a
 * sentence and a Retry, never a blank pane.
 *
 * The engine is NOT in this bundle. pdf.js is 1.8 MB and the harness reads
 * every client bundle at boot, so the vendored engine and its worker are
 * fetched from this plugin's own authenticated routes on the first PDF and
 * turned into blob URLs (a module import and a worker URL), the same lazy shape
 * the editor uses for CodeMirror and the terminal for xterm. Bytes are read
 * through `/api/dsh-pdf/file`, which validates the address again on the host
 * side; the browser never decides what it may read.
 *
 * Module-table format of every client bundle here; no build step.
 */
/* global window, document, fetch, URL, Blob, atob, IntersectionObserver */
window.__ModuleLoader__.load({
  id: 'dsh-pdf',
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
    /** This implementation's identity in the tab system, and its slot key. */
    const TYPE_ID = 'dsh-pdf'
    /** The tab kind this package owns. */
    const KIND = 'pdf'
    /** The workspace PDF index: its own page type, address and seats. */
    const INDEX_ID = 'dsh-pdf-index'
    const INDEX_KIND = 'pdfs'
    const INDEX_ADDRESS = 'sidebar://' + INDEX_KIND
    /** The address shape a page-address tab is opened with. */
    const PAGE_PREFIX = 'sidebar://'
    /** Version marker shown in the toolbar, so a loaded bundle is easy to verify. */
    const PLUGIN_VERSION = '0.1.0-alpha.3'
    /** Keep in sync with lib/index.js. */
    const API_ROOT = '/api/dsh-pdf'
    const FILE_ROUTE = API_ROOT + '/file'
    const STATE_ROUTE = API_ROOT + '/state'
    const SCAN_ROUTE = API_ROOT + '/scan'
    const LIST_ROUTE = API_ROOT + '/list'
    const VENDOR_ENGINE = API_ROOT + '/vendor/pdf.min.mjs'
    const VENDOR_WORKER = API_ROOT + '/vendor/pdf.worker.min.mjs'
    const VENDOR_CMAPS = API_ROOT + '/vendor/cmaps.json'
    const VENDOR_FONTS = API_ROOT + '/vendor/standard-fonts.json'
    const VENDOR_WASM = API_ROOT + '/vendor/wasm.json'
    /** Address grammar owned by @deepseek-ai/dsh-util-workspace-path. */
    const FILE_PREFIX = 'dsh-resource://file/'
    const PDF_PREFIX = 'dsh-resource://pdf/'
    const SESSION_SEGMENT = 'session/'
    const ABSOLUTE_SEGMENT = 'absolute/'
    /** The keyed seats every tab type occupies. */
    const TAB_SLOT = 'sidebar.right.pane.tab'
    const TITLE_SLOT = 'sidebar.right.pane.tab.title'
    /** Services resolved lazily: the bar's controller, and the slot registry. */
    const SIDEBAR_SERVICE = 'sidebarRight'
    const THEME_SERVICE = 'theme'
    const DARK_ATTRIBUTE = 'data-ds-dark-theme'
    /** The zoom ladder, and the box it moves inside. */
    const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]
    const MIN_ZOOM = 0.25
    const MAX_ZOOM = 4
    /** How many page boxes are rendered ahead of the viewport. */
    const RENDER_MARGIN_PX = 1200
    /** The raster resolution the reader's own "scan this page" action asks for. */
    const SCAN_DPI = 200
    /** The wire tool names whose calls get a card in the conversation. */
    const TOOL_NAMES = ['pdf_info', 'pdf_read', 'pdf_find', 'pdf_render', 'pdf_scan']

    // ---------------------------------------------------------------------
    // Styles (the pack's tab dress, under this package's own prefix)
    // ---------------------------------------------------------------------
    const css = `
.dpf-root{height:100%;min-height:0;flex:auto;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1f1f1f);font-size:13px;line-height:1.5}
/* The toolbar IS this tab's top bar, and every column's top band ends in the
   same hairline at y=76: the docking strip above a pane is 38px and the
   conversation header is min-height:76px, which is why the Files tab, the
   editor, History and Diagrams all use a 38px border-box header. */
.dpf-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;padding:0 10px 0 12px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));min-width:0}
.dpf-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;height:24px;min-width:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:12px;padding:0 8px;cursor:pointer;white-space:nowrap}
.dpf-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dpf-btn:disabled{opacity:.45;cursor:default}
.dpf-btn[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.dpf-pageNum{flex:none;display:inline-flex;align-items:center;gap:4px;height:24px;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}
.dpf-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpf-pageInput{width:42px;height:22px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:12px;text-align:center;padding:0 2px}
.dpf-zoom{flex:none;min-width:46px;height:24px;display:inline-flex;align-items:center;justify-content:center;font-size:11.5px;color:var(--dsw-alias-label-secondary,#666);font-variant-numeric:tabular-nums}
.dpf-spacer{flex:1;min-width:0}
.dpf-scope{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary,#666)}
.dpf-find{flex:none;display:inline-flex;align-items:center;gap:4px}
.dpf-search{width:150px;height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;padding:0 8px}
.dpf-hits{flex:none;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);min-width:52px;text-align:right;font-variant-numeric:tabular-nums}
.dpf-ver{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#999);opacity:.75;white-space:nowrap}
.dpf-scroll{flex:1;min-height:0;overflow:auto;position:relative;background:var(--dsw-alias-bg-l1,rgba(127,127,127,.07));overscroll-behavior:contain}
/* The reader's own body: the side panel and the scrolling page column. */
.dpf-body{flex:1;min-height:0;display:flex;flex-direction:row;overflow:hidden}
.dpf-side{flex:none;width:190px;min-width:0;display:flex;flex-direction:column;border-right:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));background:var(--dsw-alias-bg-l1,rgba(127,127,127,.04))}
.dpf-sideHead{flex:none;display:flex;align-items:center;gap:6px;height:32px;box-sizing:border-box;padding:0 6px 0 10px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14))}
.dpf-sideTitle{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary,#666)}
.dpf-sideBody{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:8px}
.dpf-sideNote{padding:10px 12px;font-size:11.5px;line-height:1.5;color:var(--dsw-alias-label-tertiary,#999)}
.dpf-thumb{flex:none;display:flex;flex-direction:column;align-items:center;gap:3px;padding:4px;border:.5px solid transparent;border-radius:6px;background:transparent;cursor:pointer;font:inherit}
.dpf-thumb:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dpf-thumb[data-current="true"]{border-color:var(--dsw-alias-state-business-primary,#4f8cff);background:var(--dsw-alias-interactive-bg-hover,rgba(79,140,255,.1))}
.dpf-thumbCanvas{display:block;background:#fff;box-shadow:0 0 0 .5px rgba(0,0,0,.15)}
.dpf-thumbBox{display:block;background:rgba(127,127,127,.14);border-radius:2px}
.dpf-thumbLabel{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#999);font-variant-numeric:tabular-nums}
.dpf-outlineRow{width:100%;min-width:0;display:flex;align-items:baseline;gap:8px;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:12px;text-align:left;cursor:pointer}
.dpf-outlineRow:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dpf-outlineRow:disabled{opacity:.6;cursor:default}
.dpf-outlineTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpf-outlinePage{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#999);font-variant-numeric:tabular-nums}
/* The workspace PDF index (its own page tab type). */
.dpf-index{height:100%;min-height:0;flex:auto;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1f1f1f);font-size:13px}
.dpf-indexCount{font-size:12px;color:var(--dsw-alias-label-secondary,#666)}
.dpf-indexNote{flex:none;padding:6px 12px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14))}
.dpf-indexBody{flex:1;min-height:0;overflow:auto;padding:6px 6px 18px 6px}
.dpf-indexRow{width:100%;min-width:0;display:flex;align-items:center;gap:8px;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dpf-indexRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dpf-indexName{flex:1;min-width:0;display:flex;align-items:baseline;gap:6px;overflow:hidden}
.dpf-indexBase{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:12px}
.dpf-indexDir{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#999);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%}
.dpf-indexMeta{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap;font-variant-numeric:tabular-nums}
.dpf-indexPages{min-width:58px;text-align:right}
.dpf-scroll[data-panning="true"]{cursor:grabbing}
.dpf-pages{display:flex;flex-direction:column;align-items:center;gap:14px;padding:14px 14px 40px 14px;min-width:min-content}
/* The page box carries the pdf.js text-layer scale variables: pdf.js reads
   --total-scale-factor (and the two round() steps) from here rather than from
   the document, which is what keeps selection aligned at every zoom. */
.dpf-page{position:relative;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.18),0 0 0 .5px rgba(0,0,0,.10);--total-scale-factor:1;--scale-round-x:1px;--scale-round-y:1px}
.dpf-pageWrap{display:flex;flex-direction:column;gap:8px;align-items:center}
/* The scanned-page affordance, under the page it is about. */
.dpf-scanRow{display:flex;flex-wrap:wrap;align-items:center;gap:8px;max-width:min(680px,100%);padding:6px 10px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22));border-radius:8px;background:var(--dsw-alias-bg-l1,rgba(127,127,127,.06));font-size:11.5px;color:var(--dsw-alias-label-secondary,#666)}
.dpf-scanNote{flex:1 1 auto;min-width:0}
.dpf-scanErr{flex:1 1 100%;color:var(--dsw-alias-state-error-primary,#d3382c)}
.dpf-ocrPanel{align-self:center;width:min(900px,100%);box-sizing:border-box;display:flex;flex-direction:column;gap:6px;padding:8px 10px 10px 10px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.26));border-radius:8px;background:var(--dsw-alias-bg-l1,rgba(127,127,127,.06))}
.dpf-ocrHead{display:flex;align-items:center;gap:8px;min-width:0}
.dpf-ocrTitle{font-weight:500;font-size:12px}
.dpf-ocrMeta{font-size:10.5px}
.dpf-ocrText{margin:0;max-height:320px;overflow:auto;padding:8px 10px;border-radius:6px;background:var(--dsw-alias-bg-l2,#fff);border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;color:#111}
.dpf-canvas{display:block}
.dpf-placeholder{display:flex;align-items:center;justify-content:center;color:#9aa0a6;font-size:12px}
.dpf-textLayer{position:absolute;inset:0;overflow:hidden;line-height:1;text-align:initial;forced-color-adjust:none;transform-origin:0 0;caret-color:transparent;z-index:1}
.dpf-textLayer span,.dpf-textLayer br{position:absolute;white-space:pre;transform-origin:0 0;color:transparent;cursor:text}
.dpf-textLayer ::selection{background:rgba(79,140,255,.35)}
.dpf-textLayer mark{background:rgba(255,196,0,.5);color:transparent;border-radius:2px}
.dpf-textLayer mark[data-current="true"]{background:rgba(255,120,0,.65)}
.dpf-state{height:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;color:var(--dsw-alias-label-tertiary,#999);font-size:12.5px;line-height:18px;text-align:center}
.dpf-stateTitle{font-size:13px;color:var(--dsw-alias-label-secondary,#666);font-weight:500}
.dpf-stateErr{color:var(--dsw-alias-state-error-primary,#d3382c);max-width:560px;word-break:break-word}
.dpf-note{max-width:560px;font-size:11.5px;opacity:.85}
.dpf-row{display:flex;align-items:center;gap:6px}
.dpf-pw{height:26px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.35));border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:12px;padding:0 8px;width:200px}
.dpf-card{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22));border-radius:8px;background:var(--dsw-alias-bg-l1,rgba(127,127,127,.05))}
.dpf-cardHead{display:flex;align-items:center;gap:8px;min-width:0}
.dpf-cardName{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dpf-cardFacts{display:flex;flex-wrap:wrap;gap:6px 12px;font-size:11.5px;color:var(--dsw-alias-label-secondary,#666)}
.dpf-chip{display:inline-flex;align-items:center;gap:4px;padding:1px 6px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14));font-size:11px;color:var(--dsw-alias-label-secondary,#666)}
.dpf-chip[data-warn="true"]{background:var(--dsw-alias-state-warning-primary,#d29922);color:#fff}
.dpf-preview{max-height:230px;overflow:auto;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));border-radius:6px;padding:6px 8px;background:var(--dsw-alias-bg-l1,rgba(127,127,127,.04));font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:11.5px;line-height:1.45;white-space:pre-wrap;word-break:break-word;margin:0}
`
    const CSS_TAG = 'dsh-pdf/pdf.css'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-pdf'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------------
    // Addresses
    // ---------------------------------------------------------------------
    /** Component-encode one path segment the way the file grammar does. */
    function encodeSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ':')
    }

    /** Decode one encoded segment, tolerating a malformed one. */
    function decodeSegment(segment) {
      try {
        return decodeURIComponent(segment)
      } catch (err) {
        return segment
      }
    }

    /**
     * Read the two address shapes this type claims.
     *
     * @param address - a tab's content id.
     * @returns `{ sessionId, path }` or `{ absolute }`, or null when the address
     *          is not a PDF address at all.
     */
    function parsePdfAddress(address) {
      const value = typeof address === 'string' ? address : ''
      if (value.slice(0, PDF_PREFIX.length) === PDF_PREFIX) {
        const rest = value.slice(PDF_PREFIX.length)
        if (rest.slice(0, ABSOLUTE_SEGMENT.length) !== ABSOLUTE_SEGMENT) return null
        const absolute = decodeSegment(rest.slice(ABSOLUTE_SEGMENT.length))
        return absolute === '' ? null : { absolute }
      }
      if (value.slice(0, FILE_PREFIX.length) !== FILE_PREFIX) return null
      const rest = value.slice(FILE_PREFIX.length)
      if (rest.slice(0, SESSION_SEGMENT.length) !== SESSION_SEGMENT) return null
      const tail = rest.slice(SESSION_SEGMENT.length)
      const cut = tail.indexOf('/')
      if (cut < 0) return null
      const path = tail
        .slice(cut + 1)
        .split('/')
        .map(decodeSegment)
        .join('/')
      if (path === '') return null
      return { sessionId: decodeSegment(tail.slice(0, cut)), path }
    }

    /** The decoded last path segment of an address, for the chip title. */
    function baseNameOf(address) {
      const parsed = parsePdfAddress(address)
      if (!parsed) return 'PDF'
      const path = parsed.absolute ?? parsed.path
      const name = String(path).replace(/\\/g, '/').split('/').pop()
      return name === '' || name === undefined ? 'PDF' : name
    }

    /** Whether an address names a PDF (the only thing this type claims). */
    function isPdfAddress(address) {
      const parsed = parsePdfAddress(address)
      if (!parsed) return false
      const path = parsed.absolute ?? parsed.path
      return /\.pdf$/i.test(String(path))
    }

    // ---------------------------------------------------------------------
    // The engine, fetched once and kept
    // ---------------------------------------------------------------------
    /** The pending/complete engine import. */
    let enginePromise = null
    /** Decoded asset maps, per kind, fetched only when pdf.js asks for one. */
    const assetMaps = new Map()
    /** Documents already loaded, keyed by the address they were loaded from. */
    const documentCache = new Map()

    /**
     * The vendored pdf.js, as a module imported from a blob URL.
     *
     * This bundle carries no engine: the harness reads every client bundle at
     * boot, and pdf.js is 1.8 MB. The engine and its worker come from this
     * plugin's own routes, through the same authenticated fetch every other
     * request uses, and are then handed to the browser as blob URLs - the
     * worker especially, whose own fetches must not depend on how a route is
     * authorized.
     */
    function loadEngine() {
      if (enginePromise) return enginePromise
      enginePromise = (async () => {
        const [engineResponse, workerResponse] = await Promise.all([
          fetch(VENDOR_ENGINE, { credentials: 'same-origin' }),
          fetch(VENDOR_WORKER, { credentials: 'same-origin' }),
        ])
        if (!engineResponse.ok) throw new Error('The vendored pdf.js engine could not be loaded (HTTP ' + engineResponse.status + ').')
        if (!workerResponse.ok) throw new Error('The vendored pdf.js worker could not be loaded (HTTP ' + workerResponse.status + ').')
        const [engineSource, workerSource] = await Promise.all([engineResponse.text(), workerResponse.text()])
        const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' }))
        const engineUrl = URL.createObjectURL(new Blob([engineSource], { type: 'text/javascript' }))
        const pdfjs = await import(/* webpackIgnore: true */ engineUrl)
        if (!pdfjs || typeof pdfjs.getDocument !== 'function') throw new Error('The vendored pdf.js engine did not start.')
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
        return pdfjs
      })()
      // A failed load must not be remembered: the Retry button has to be able
      // to try again (the route may simply have been restarting).
      enginePromise.catch(() => {
        enginePromise = null
      })
      return enginePromise
    }

    /** One asset map, fetched from this plugin's route on first use. */
    async function assetMap(kind) {
      if (assetMaps.has(kind)) return assetMaps.get(kind)
      const route = kind === 'cMapUrl' ? VENDOR_CMAPS : kind === 'standardFontDataUrl' ? VENDOR_FONTS : kind === 'wasmUrl' ? VENDOR_WASM : null
      const promise = (async () => {
        if (route === null) return {}
        const response = await fetch(route, { credentials: 'same-origin' })
        if (!response.ok) return {}
        return await response.json()
      })()
      assetMaps.set(kind, promise)
      return promise
    }

    /**
     * The pdf.js v6 binary-data factory: the ONE seam through which a document
     * asks for a cMap, a standard font or a wasm decoder. pdf.js's own DOM
     * factory fetches `cMapUrl + filename`, which cannot work here because the
     * route registry matches EXACT paths only - 185 individual routes was the
     * alternative. This factory fetches ONE map per kind (base64 inside JSON)
     * and decodes the single requested entry on demand.
     */
    class MapBinaryDataFactory {
      constructor() {
        this.cMapUrl = null
        this.standardFontDataUrl = null
        this.wasmUrl = null
      }

      async fetch(request) {
        const kind = request && request.kind
        const filename = request && request.filename
        if (typeof filename !== 'string' || filename === '') throw new Error('pdf.js asked for an unnamed asset.')
        const map = await assetMap(kind)
        const encoded = map && typeof map === 'object' ? map[filename] : null
        if (typeof encoded !== 'string') {
          // A missing asset is not fatal: pdf.js substitutes metrics or skips
          // the image, and the page still renders. Say so rather than throwing.
          return new Uint8Array(0)
        }
        const binary = atob(encoded)
        const bytes = new Uint8Array(binary.length)
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
        return bytes
      }
    }

    /** The bytes of one PDF, fetched once per address and kept for the session. */
    function loadDocumentData(parsed) {
      const key = parsed.absolute ? 'abs:' + parsed.absolute : 'ws:' + parsed.sessionId + '/' + parsed.path
      const cached = documentCache.get(key)
      if (cached) return cached
      const promise = (async () => {
        const params = new URLSearchParams()
        if (parsed.absolute) params.set('path', parsed.absolute)
        else {
          params.set('session', parsed.sessionId)
          params.set('path', parsed.path)
        }
        const response = await fetch(FILE_ROUTE + '?' + params.toString(), { credentials: 'same-origin' })
        if (!response.ok) {
          let message = 'The PDF could not be read (HTTP ' + response.status + ').'
          try {
            const body = await response.json()
            if (body && body.error && body.error.message) message = String(body.error.message)
          } catch (err) {
            /* the status is the message then */
          }
          throw new Error(message)
        }
        const buffer = await response.arrayBuffer()
        return { bytes: new Uint8Array(buffer), sha: response.headers.get('x-dsh-pdf-sha256') ?? '' }
      })()
      promise.catch(() => documentCache.delete(key))
      documentCache.set(key, promise)
      return promise
    }

    // ---------------------------------------------------------------------
    // Services resolved lazily
    // ---------------------------------------------------------------------
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

    /** The tab information a pane body was handed, or null when it has none. */
    function tabInfoNow(props) {
      if (!props || typeof props.useTabInfo !== 'function') return null
      try {
        const info = props.useTabInfo()
        return info && info.tab ? info : null
      } catch (err) {
        return null
      }
    }

    /** Whether the app is in its dark theme right now. */
    function darkNow() {
      const theme = serviceNow(THEME_SERVICE)
      if (theme && typeof theme.getTheme === 'function') {
        try {
          const snapshot = theme.getTheme()
          if (snapshot && typeof snapshot === 'object' && typeof snapshot.colorScheme === 'string') return snapshot.colorScheme === 'dark'
        } catch (err) {
          /* fall through to the body marker */
        }
      }
      if (typeof document !== 'undefined' && document.body && typeof document.body.hasAttribute === 'function') {
        return document.body.hasAttribute(DARK_ATTRIBUTE)
      }
      return false
    }

    // ---------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------
    /** The guide/type glyph: a page with a folded corner. */
    function PdfGlyph(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          className: props ? props.className : undefined,
        },
        h('path', { d: 'M9 1.8H4.4c-.6 0-1.1.5-1.1 1.1v10.2c0 .6.5 1.1 1.1 1.1h7.2c.6 0 1.1-.5 1.1-1.1V5.6L9 1.8Z' }),
        h('path', { d: 'M9 1.8v3.8h3.7' }),
      )
    }

    /** One toolbar glyph from a small set of paths. */
    function Glyph(props) {
      const size = props.size ?? 14
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        ...(props.paths ?? []).map((d, index) => h('path', { key: index, d })),
      )
    }

    const ICON = {
      prev: ['M10 3 5 8l5 5'],
      next: ['M6 3l5 5-5 5'],
      zoomOut: ['M3.5 8h9'],
      zoomIn: ['M3.5 8h9', 'M8 3.5v9'],
      rotate: ['M13 8a5 5 0 1 1-1.6-3.7', 'M13 2.4V5h-2.6'],
      fitWidth: ['M2 3v10', 'M14 3v10', 'M4.5 8h7', 'M6.5 6 4.5 8l2 2', 'M9.5 6l2 2-2 2'],
      fitPage: ['M2 2h12v12H2z', 'M5 5h6v6H5z'],
      search: ['M7.2 12.2a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z', 'M11 11l2.6 2.6'],
      up: ['M8 12.5V3.5', 'M4.5 7 8 3.5 11.5 7'],
      down: ['M8 3.5v9', 'M4.5 9 8 12.5 11.5 9'],
      reload: ['M13 8a5 5 0 1 1-1.5-3.6', 'M13 2.4V5h-2.6'],
      pages: ['M2.5 2.5h4v11h-4z', 'M9.5 2.5h4v11h-4z'],
      list: ['M3 4h1.5', 'M6.5 4h7', 'M3 8h1.5', 'M6.5 8h7', 'M3 12h1.5', 'M6.5 12h7'],
    }

    /** One toolbar button. */
    function ToolButton(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'dpf-btn',
          title: props.title,
          disabled: props.disabled === true,
          'data-active': props.active === true ? 'true' : undefined,
          'data-pdf-action': props.action,
          onClick: props.onClick,
        },
        props.icon ? h(Glyph, { paths: ICON[props.icon] }) : props.children,
      )
    }

    /** The centered state box: waiting, failed, locked. */
    function StateBox(props) {
      return h(
        'div',
        { className: 'dpf-state', 'data-pdf-state': props.state },
        props.icon === false ? null : h(PdfGlyph, { size: 28 }),
        h('div', { className: 'dpf-stateTitle' }, props.title),
        props.error ? h('div', { className: 'dpf-stateErr' }, props.error) : null,
        props.note ? h('div', { className: 'dpf-note' }, props.note) : null,
        props.children ?? null,
      )
    }

    // ---------------------------------------------------------------------
    // One page: a canvas, and a text layer over it
    // ---------------------------------------------------------------------
    /**
     * One page box. The canvas is drawn when the page comes near the viewport
     * (and re-drawn when the scale changes), and pdf.js's own TextLayer draws
     * the selectable text over it. A page that has been rendered keeps its box
     * size when it scrolls away, so the scroll position never jumps.
     */
    function PageView(props) {
      const { doc, pageNumber, scale, rotation, registerBox } = props
      const boxRef = useRef(null)
      const canvasRef = useRef(null)
      const layerRef = useRef(null)
      const [size, setSize] = useState(null)
      const [visible, setVisible] = useState(false)
      const [status, setStatus] = useState('idle')
      const [failure, setFailure] = useState('')
      const [textContent, setTextContent] = useState(null)
      const renderToken = useRef(0)
      const textToken = useRef(0)
      const renderedScale = useRef(null)

      // Observe visibility: a long document must not build every canvas at once.
      useEffect(() => {
        const element = boxRef.current
        if (!element || typeof IntersectionObserver !== 'function') {
          setVisible(true)
          return undefined
        }
        const observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) if (entry.isIntersecting) setVisible(true)
          },
          { root: null, rootMargin: RENDER_MARGIN_PX + 'px 0px' },
        )
        observer.observe(element)
        return () => observer.disconnect()
      }, [])

      // Draw the page. The render task is cancelled when the page re-renders or
      // unmounts, which is what keeps a fast scroll from queueing drawings.
      useEffect(() => {
        if (!visible || !doc) return undefined
        const token = renderToken.current + 1
        renderToken.current = token
        let task = null
        let cancelled = false
        setStatus((current) => (current === 'ready' ? 'ready' : 'drawing'))
        ;(async () => {
          try {
            const page = await doc.getPage(pageNumber)
            if (cancelled || renderToken.current !== token) return
            const viewport = page.getViewport({ scale, rotation })
            const canvas = canvasRef.current
            if (!canvas) return
            const pixelRatio = Math.min(2.5, Math.max(1, window.devicePixelRatio || 1))
            canvas.width = Math.floor(viewport.width * pixelRatio)
            canvas.height = Math.floor(viewport.height * pixelRatio)
            canvas.style.width = Math.floor(viewport.width) + 'px'
            canvas.style.height = Math.floor(viewport.height) + 'px'
            setSize({ width: viewport.width, height: viewport.height })
            renderedScale.current = scale
            const context = canvas.getContext('2d', { alpha: false })
            task = page.render({ canvasContext: context, viewport, transform: pixelRatio === 1 ? null : [pixelRatio, 0, 0, pixelRatio, 0, 0] })
            await task.promise
            if (cancelled || renderToken.current !== token) return
            setStatus('ready')
            setFailure('')
          } catch (err) {
            if (cancelled || renderToken.current !== token) return
            const name = err && err.name ? String(err.name) : ''
            if (name === 'RenderingCancelledException') return
            setStatus('error')
            setFailure(err && err.message ? String(err.message) : 'this page could not be drawn')
          }
        })()
        return () => {
          cancelled = true
          if (task && typeof task.cancel === 'function') {
            try {
              task.cancel()
            } catch (err) {
              /* already finished */
            }
          }
        }
      }, [doc, pageNumber, scale, rotation, visible])

      // The selectable text layer, rebuilt when the scale changes.
      useEffect(() => {
        if (!doc) return undefined
        const token = textToken.current + 1
        textToken.current = token
        ;(async () => {
          try {
            const page = await doc.getPage(pageNumber)
            const content = await page.getTextContent()
            if (textToken.current !== token) return
            setTextContent({ page, content })
          } catch (err) {
            /* the text layer is a convenience; drawing already reported failure */
          }
        })()
        return undefined
      }, [doc, pageNumber])

      // Hand the text layer to pdf.js, which positions every run correctly.
      useEffect(() => {
        const container = layerRef.current
        const engine = props.pdfjs
        if (!container || !textContent || !engine || typeof engine.TextLayer !== 'function') return undefined
        container.textContent = ''
        let layer = null
        try {
          const viewport = textContent.page.getViewport({ scale, rotation })
          layer = new engine.TextLayer({ textContentSource: textContent.content, container, viewport })
          const done = layer.render()
          if (done && typeof done.catch === 'function') done.catch(() => {})
        } catch (err) {
          /* selection is best-effort; the page itself is drawn */
        }
        return () => {
          try {
            if (layer && typeof layer.cleanup === 'function') layer.cleanup()
          } catch (err) {
            /* nothing to release */
          }
        }
      }, [textContent, scale, rotation, props.pdfjs, props.searchRevision])

      // Register the box so the toolbar can jump to this page.
      useEffect(() => {
        if (typeof registerBox === 'function') return registerBox(pageNumber, boxRef)
        return undefined
      }, [pageNumber, registerBox])

      // Whether this page has a text layer at all. A page with none is a picture
      // of text: pdf.js reports zero runs because there are none, and the only
      // way to read its words is to draw it and recognize it. That is the one
      // thing this tab offers beyond rendering, so it is offered right here,
      // on the page that needs it.
      const noTextLayer =
        textContent !== null &&
        Array.isArray(textContent.content?.items) &&
        textContent.content.items.every((item) => typeof item.str !== 'string' || item.str.trim() === '')

      const [scan, setScan] = useState({ phase: 'idle', text: '', message: '', engine: '', lang: '', dpi: 0, cached: false })
      const scanNow = useCallback(async () => {
        if (typeof props.onScan !== 'function') return
        setScan((current) => ({ ...current, phase: 'busy', message: '' }))
        const answer = await props.onScan(pageNumber)
        if (answer && answer.ok) {
          setScan({
            phase: 'done',
            text: answer.text ?? '',
            message: '',
            engine: answer.engine ?? '',
            lang: answer.lang ?? '',
            dpi: answer.dpi ?? 0,
            cached: answer.cached === true,
          })
        } else {
          setScan((current) => ({ ...current, phase: 'error', message: (answer && answer.message) || 'The page could not be recognized.' }))
        }
      }, [pageNumber, props.onScan])

      const copyScanned = useCallback(() => {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(scan.text)
          }
        } catch (err) {
          /* the text is selectable anyway */
        }
      }, [scan.text])

      const width = size ? Math.floor(size.width) : null
      const height = size ? Math.floor(size.height) : null
      return h(
        'div',
        { className: 'dpf-pageWrap', ref: boxRef, 'data-pdf-page-wrap': String(pageNumber) },
        h(
          'div',
          {
            className: 'dpf-page',
            'data-pdf-page': String(pageNumber),
            'data-pdf-status': status,
            'data-pdf-text-layer': noTextLayer ? 'none' : 'present',
            style: {
              width: width ? width + 'px' : undefined,
              height: height ? height + 'px' : undefined,
              minHeight: width ? undefined : '60vh',
              minWidth: width ? undefined : '45vw',
              // pdf.js reads the scale from here, not from the document.
              '--total-scale-factor': String(scale),
            },
          },
          visible
            ? h('canvas', { className: 'dpf-canvas', ref: canvasRef, 'aria-label': 'Page ' + pageNumber })
            : h('div', { className: 'dpf-placeholder', style: { width: '100%', height: '100%' } }, String(pageNumber)),
          visible && textContent ? h('div', { className: 'dpf-textLayer', ref: layerRef, 'data-pdf-text-layer-content': String(pageNumber) }) : null,
          status === 'error' ? h('div', { className: 'dpf-placeholder', style: { position: 'absolute', inset: 0 } }, failure) : null,
        ),
        // The scanned-page affordance: this page carries a picture and no words,
        // so say exactly that and offer the one thing that can change it.
        noTextLayer && scan.phase !== 'done'
          ? h(
              'div',
              { className: 'dpf-scanRow', 'data-pdf-scanned': String(pageNumber) },
              h('span', { className: 'dpf-scanNote' }, 'This page is a scanned image: it has no text layer, so its words cannot be extracted.'),
              h(
                ToolButton,
                { action: 'scan-page', disabled: scan.phase === 'busy', onClick: scanNow, title: 'Draw this page and recognize its text (needs tesseract on the host)' },
                scan.phase === 'busy' ? 'Scanning…' : scan.phase === 'error' ? 'Retry scan' : 'Scan this page',
              ),
              scan.phase === 'error' ? h('span', { className: 'dpf-scanErr' }, scan.message) : null,
            )
          : null,
        scan.phase === 'done'
          ? h(
              'div',
              { className: 'dpf-ocrPanel', 'data-pdf-ocr': String(pageNumber) },
              h(
                'div',
                { className: 'dpf-ocrHead' },
                h('span', { className: 'dpf-ocrTitle' }, 'Recognized text (page ' + pageNumber + ')'),
                h('span', { className: 'dpf-chip dpf-ocrMeta' }, (scan.engine || 'OCR') + (scan.lang ? ' · ' + scan.lang : '') + (scan.dpi ? ' · ' + scan.dpi + ' dpi' : '') + (scan.cached ? ' · cached' : '')),
                h('span', { className: 'dpf-spacer' }),
                h(ToolButton, { action: 'scan-copy', onClick: copyScanned, title: 'Copy the recognized text' }, 'Copy'),
                h(ToolButton, { action: 'scan-hide', onClick: () => setScan((current) => ({ ...current, phase: 'idle' })), title: 'Hide the recognized text' }, 'Hide'),
              ),
              h('pre', { className: 'dpf-ocrText' }, scan.text === '' ? '(the engine found no text on this page)' : scan.text),
              h('div', { className: 'dpf-note' }, 'Recognized, not extracted: OCR misreads digits, names, accents and punctuation. Treat it as a transcription.'),
            )
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // The reader's side panel: thumbnails, and the document's own outline
    // ---------------------------------------------------------------------
    /** Thumbnails are drawn lazily; past this many pages the rail says so. */
    const THUMB_MAX = 300
    /** The thumbnail rail's canvas width, in CSS pixels. */
    const THUMB_WIDTH = 104
    /** How many outline entries are resolved and shown. */
    const OUTLINE_MAX = 200
    /** How deep the outline is walked. */
    const OUTLINE_MAX_DEPTH = 4

    /**
     * Resolve a document's bookmarks to 1-based page numbers.
     *
     * pdf.js hands back destinations as named strings or explicit arrays, and
     * only `getDestination` + `getPageIndex` turn one into a page. An entry whose
     * destination cannot be resolved keeps `page: null` rather than being
     * dropped: a bookmark a reader can see but not jump to is still information.
     * Bounded, because a generated outline can be enormous.
     */
    async function loadOutline(doc) {
      let raw
      try {
        raw = await doc.getOutline()
      } catch (err) {
        return { entries: [], error: 'The bookmarks of this document could not be read.' }
      }
      if (!raw || raw.length === 0) return { entries: [], error: '' }
      const entries = []
      const walk = async (list, depth) => {
        for (const entry of list) {
          if (entries.length >= OUTLINE_MAX) return
          let page = null
          try {
            const dest = typeof entry.dest === 'string' ? await doc.getDestination(entry.dest) : entry.dest
            if (Array.isArray(dest) && dest.length > 0) page = (await doc.getPageIndex(dest[0])) + 1
          } catch (err) {
            page = null
          }
          entries.push({ title: String(entry.title ?? ''), page, depth })
          if (Array.isArray(entry.items) && entry.items.length > 0 && depth < OUTLINE_MAX_DEPTH) await walk(entry.items, depth + 1)
        }
      }
      try {
        await walk(raw, 0)
      } catch (err) {
        return { entries, error: 'Some bookmarks could not be resolved.' }
      }
      return { entries, error: '' }
    }

    /**
     * One thumbnail: a canvas drawn when the rail scrolls it into view.
     *
     * Deliberately NOT the page component: a thumbnail is a picture, has no text
     * layer, keeps no scroll state and is never zoomed, so sharing the page's
     * machinery would only make both slower.
     */
    function Thumb(props) {
      const { doc, pageNumber, current, onPick } = props
      const boxRef = useRef(null)
      const canvasRef = useRef(null)
      const [size, setSize] = useState(null)
      const [visible, setVisible] = useState(false)
      const [failed, setFailed] = useState(false)
      const drawn = useRef(false)

      useEffect(() => {
        const element = boxRef.current
        if (!element || typeof IntersectionObserver !== 'function') {
          setVisible(true)
          return undefined
        }
        const observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) if (entry.isIntersecting) setVisible(true)
          },
          // The rail is the scroll container, so it is the observer's root: a
          // thumbnail two screens down must not draw until it is nearly shown.
          { root: element.closest('.dpf-side') ?? null, rootMargin: '300px 0px' },
        )
        observer.observe(element)
        return () => observer.disconnect()
      }, [])

      useEffect(() => {
        if (!visible || drawn.current || !doc) return undefined
        let cancelled = false
        let task = null
        ;(async () => {
          try {
            const page = await doc.getPage(pageNumber)
            if (cancelled) return
            const base = page.getViewport({ scale: 1 })
            const scale = THUMB_WIDTH / base.width
            const viewport = page.getViewport({ scale })
            const canvas = canvasRef.current
            if (!canvas) return
            const ratio = Math.min(2, Math.max(1, window.devicePixelRatio || 1))
            canvas.width = Math.floor(viewport.width * ratio)
            canvas.height = Math.floor(viewport.height * ratio)
            canvas.style.width = Math.floor(viewport.width) + 'px'
            canvas.style.height = Math.floor(viewport.height) + 'px'
            setSize({ width: viewport.width, height: viewport.height })
            task = page.render({
              canvasContext: canvas.getContext('2d', { alpha: false }),
              viewport,
              transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0],
            })
            await task.promise
            if (!cancelled) drawn.current = true
          } catch (err) {
            if (!cancelled && !(err && err.name === 'RenderingCancelledException')) setFailed(true)
          }
        })()
        return () => {
          cancelled = true
          if (task && typeof task.cancel === 'function') {
            try {
              task.cancel()
            } catch (err) {
              /* already finished */
            }
          }
        }
      }, [visible, doc, pageNumber])

      return h(
        'button',
        {
          type: 'button',
          className: 'dpf-thumb',
          ref: boxRef,
          'data-pdf-thumb': String(pageNumber),
          'data-current': current ? 'true' : undefined,
          title: 'Page ' + pageNumber,
          onClick: () => onPick(pageNumber),
        },
        visible
          ? h('canvas', { ref: canvasRef, className: 'dpf-thumbCanvas' })
          : h('span', { className: 'dpf-thumbBox', style: { width: THUMB_WIDTH + 'px', height: Math.round(THUMB_WIDTH * 1.294) + 'px' } }),
        h('span', { className: 'dpf-thumbLabel' }, failed ? String(pageNumber) + ' \u26a0' : String(pageNumber)),
      )
    }

    /** The thumbnail rail. */
    function ThumbRail(props) {
      const { doc, pageCount, current, onPick } = props
      const shown = Math.min(pageCount, THUMB_MAX)
      const thumbs = []
      for (let number = 1; number <= shown; number += 1) {
        thumbs.push(h(Thumb, { key: number, doc, pageNumber: number, current: number === current, onPick }))
      }
      return h(
        'div',
        { className: 'dpf-sideBody', 'data-pdf-rail': 'pages' },
        ...thumbs,
        pageCount > shown
          ? h('div', { className: 'dpf-sideNote' }, 'Thumbnails stop at ' + shown + ' pages (this document has ' + pageCount + '). Use the page field or Find to reach the rest.')
          : null,
      )
    }

    /** The document's own outline, or why there is none. */
    function OutlinePanel(props) {
      const { doc, onPick } = props
      const [state, setState] = useState({ phase: 'loading', entries: [], error: '' })
      useEffect(() => {
        let cancelled = false
        setState({ phase: 'loading', entries: [], error: '' })
        ;(async () => {
          const found = await loadOutline(doc)
          if (!cancelled) setState({ phase: 'ready', entries: found.entries, error: found.error })
        })()
        return () => {
          cancelled = true
        }
      }, [doc])
      if (state.phase === 'loading') return h('div', { className: 'dpf-sideNote' }, 'Reading the bookmarks\u2026')
      if (state.entries.length === 0) {
        return h(
          'div',
          { className: 'dpf-sideNote', 'data-pdf-outline': 'none' },
          state.error !== '' ? state.error : 'This document has no bookmarks. Its pages are the only way in \u2014 use the page field, Find, or the thumbnails.',
        )
      }
      return h(
        'div',
        { className: 'dpf-sideBody', 'data-pdf-outline': String(state.entries.length) },
        ...state.entries.map((entry, index) =>
          h(
            'button',
            {
              key: index,
              type: 'button',
              className: 'dpf-outlineRow',
              style: { paddingLeft: 8 + entry.depth * 12 + 'px' },
              title: entry.page ? entry.title + ' (page ' + entry.page + ')' : entry.title,
              disabled: entry.page === null,
              onClick: () => (entry.page ? onPick(entry.page) : undefined),
            },
            h('span', { className: 'dpf-outlineTitle' }, entry.title === '' ? '(untitled)' : entry.title),
            entry.page ? h('span', { className: 'dpf-outlinePage' }, String(entry.page)) : null,
          ),
        ),
        state.error !== '' ? h('div', { className: 'dpf-sideNote' }, state.error) : null,
      )
    }

    // ---------------------------------------------------------------------
    // The reader
    // ---------------------------------------------------------------------
    /**
     * The reader: toolbar over a continuous, lazy, zoomable page column.
     *
     * Zoom moves the LAYOUT (the page boxes are laid out at the new size), never
     * a CSS transform, so a page wider than the pane stays scrollable to its
     * edge - the same rule the diagrams tab learned. The scroll panes carry the
     * overflow, and a drag pans them while a zoom is above fit.
     */
    function Reader(props) {
      const { pdfjs, doc, name, scopeLabel, address, onScan } = props
      const scrollRef = useRef(null)
      const boxes = useRef(new Map())
      const [scale, setScale] = useState(1)
      const [fit, setFit] = useState('width')
      const [rotation, setRotation] = useState(0)
      const [page, setPage] = useState(1)
      const [pageInput, setPageInput] = useState('1')
      /** Which side panel is open: the thumbnail rail, the outline, or none. */
      const [side, setSide] = useState(null)
      const [query, setQuery] = useState('')
      const [search, setSearch] = useState(null)
      const [searchBusy, setSearchBusy] = useState(false)
      const [searchRevision, setSearchRevision] = useState(0)
      const [panning, setPanning] = useState(false)
      const panState = useRef(null)
      const pageCount = doc.numPages

      /** Register one page box for jump-to-page. */
      const registerBox = useCallback((pageNumber, ref) => {
        boxes.current.set(pageNumber, ref)
        return () => {
          boxes.current.delete(pageNumber)
        }
      }, [])

      /** Recompute the scale for the current fit mode against the pane width. */
      const applyFit = useCallback(
        async (mode) => {
          const pane = scrollRef.current
          if (!pane || !doc) return
          try {
            const first = await doc.getPage(1)
            const base = first.getViewport({ scale: 1, rotation })
            const availableWidth = Math.max(120, pane.clientWidth - 34)
            const availableHeight = Math.max(120, pane.clientHeight - 34)
            const next = mode === 'page' ? Math.min(availableWidth / base.width, availableHeight / base.height) : availableWidth / base.width
            setScale(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(next.toFixed(3)))))
          } catch (err) {
            /* keep the current scale */
          }
        },
        [doc, rotation],
      )

      // The first layout fits the width; a rotation re-fits, because the page
      // and the pane swapped proportions.
      useEffect(() => {
        if (fit !== null) applyFit(fit)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [doc, rotation])

      // Follow the pane when it is resized while a fit mode is active.
      useEffect(() => {
        const pane = scrollRef.current
        if (!pane || typeof ResizeObserver !== 'function' || fit === null) return undefined
        const observer = new ResizeObserver(() => applyFit(fit))
        observer.observe(pane)
        return () => observer.disconnect()
      }, [applyFit, fit])

      /** Step the zoom ladder, leaving the fit modes. */
      const zoomTo = useCallback((next) => {
        setFit(null)
        setScale(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(next.toFixed(3)))))
      }, [])

      const zoomStep = useCallback(
        (direction) => {
          const ladder = ZOOM_STEPS
          const current = scale
          if (direction > 0) {
            const next = ladder.find((step) => step > current + 0.001)
            zoomTo(next ?? Math.min(MAX_ZOOM, current * 1.25))
          } else {
            const below = ladder.filter((step) => step < current - 0.001)
            zoomTo(below.length > 0 ? below[below.length - 1] : Math.max(MIN_ZOOM, current / 1.25))
          }
        },
        [scale, zoomTo],
      )

      /** Scroll one page into view (aligning the top). */
      const goToPage = useCallback((target) => {
        const pane = scrollRef.current
        const ref = boxes.current.get(target)
        setPage(target)
        setPageInput(String(target))
        if (!pane || !ref || !ref.current) return
        pane.scrollTo({ top: Math.max(0, ref.current.offsetTop - 8), behavior: 'auto' })
      }, [])

      // Which page is on screen, from the scroll position. State is only written
      // when the page actually changes, and the two setters are called from the
      // event handler rather than from inside another updater (a side effect in
      // an updater runs twice under StrictMode and is not a render input).
      const onScroll = useCallback(() => {
        const pane = scrollRef.current
        if (!pane) return
        const middle = pane.scrollTop + pane.clientHeight * 0.35
        let current = 1
        for (const [number, ref] of boxes.current) {
          if (ref.current && ref.current.offsetTop <= middle) current = Math.max(current, number)
        }
        setPage((previous) => (previous === current ? previous : current))
        setPageInput((previous) => (previous === String(current) ? previous : String(current)))
      }, [])

      /** Keyboard control: the reader behaves like a document, not a div. */
      const onKeyDown = useCallback(
        (event) => {
          const target = event.target
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
          if (event.key === 'PageDown' || event.key === 'ArrowRight') {
            event.preventDefault()
            goToPage(Math.min(pageCount, page + 1))
          } else if (event.key === 'PageUp' || event.key === 'ArrowLeft') {
            event.preventDefault()
            goToPage(Math.max(1, page - 1))
          } else if (event.key === 'Home') {
            event.preventDefault()
            goToPage(1)
          } else if (event.key === 'End') {
            event.preventDefault()
            goToPage(pageCount)
          } else if (event.key === '+' || event.key === '=') {
            event.preventDefault()
            zoomStep(1)
          } else if (event.key === '-') {
            event.preventDefault()
            zoomStep(-1)
          } else if (event.key === '0') {
            event.preventDefault()
            setFit('width')
          }
        },
        [goToPage, page, pageCount, zoomStep],
      )

      // Drag to pan, only while something can actually be panned.
      const onPointerDown = useCallback((event) => {
        const pane = scrollRef.current
        if (!pane) return
        const canPan = pane.scrollWidth > pane.clientWidth + 1 || pane.scrollHeight > pane.clientHeight + 1
        if (!canPan || event.button !== 0) return
        // A click inside the text layer is a selection, not a pan.
        if (event.target && event.target.closest && event.target.closest('.dpf-textLayer')) return
        panState.current = { x: event.clientX, y: event.clientY, left: pane.scrollLeft, top: pane.scrollTop }
        setPanning(true)
      }, [])

      const onPointerMove = useCallback((event) => {
        const pane = scrollRef.current
        const origin = panState.current
        if (!pane || !origin) return
        pane.scrollLeft = origin.left - (event.clientX - origin.x)
        pane.scrollTop = origin.top - (event.clientY - origin.y)
      }, [])

      const endPan = useCallback(() => {
        panState.current = null
        setPanning(false)
      }, [])

      // ---- in-document search ----
      /**
       * Search walks every page's text, marks the hits it finds in the rendered
       * text layers, and remembers them so next/previous can move between them.
       * The pass is asynchronous and reports progress, because a 400-page
       * document is not instant.
       */
      const runSearch = useCallback(
        async (needle) => {
          const value = String(needle ?? '').trim()
          if (value === '' || !doc) {
            setSearch(null)
            setSearchRevision((revision) => revision + 1)
            return
          }
          setSearchBusy(true)
          try {
            const haystack = value.toLowerCase()
            const hits = []
            for (let number = 1; number <= pageCount; number += 1) {
              const page = await doc.getPage(number)
              const content = await page.getTextContent()
              const text = content.items.map((item) => (typeof item.str === 'string' ? item.str : '')).join(' ')
              const lower = text.toLowerCase()
              let index = lower.indexOf(haystack)
              while (index !== -1 && hits.length < 300) {
                hits.push({ page: number, index, snippet: text.slice(Math.max(0, index - 40), index + value.length + 40) })
                index = lower.indexOf(haystack, index + Math.max(1, value.length))
              }
              if (hits.length >= 300) break
            }
            setSearch({ query: value, hits, current: hits.length > 0 ? 0 : -1 })
            setSearchRevision((revision) => revision + 1)
            if (hits.length > 0) goToPage(hits[0].page)
          } catch (err) {
            setSearch({ query: value, hits: [], current: -1, error: err && err.message ? String(err.message) : 'the search failed' })
          } finally {
            setSearchBusy(false)
          }
        },
        [doc, goToPage, pageCount],
      )

      /** Move to the next/previous hit, if there is one. */
      const stepHit = useCallback(
        (direction) => {
          if (!search || search.hits.length === 0) return
          const total = search.hits.length
          const next = (search.current + direction + total) % total
          setSearch({ ...search, current: next })
          setSearchRevision((revision) => revision + 1)
          goToPage(search.hits[next].page)
        },
        [goToPage, search],
      )

      // Highlight the current hit inside the rendered text layers. pdf.js builds
      // the layer from the page's own runs, so the match is located by walking
      // the spans and wrapping the matched substring - the layout is untouched
      // because every span already has its absolute position and `white-space:
      // pre`, so wrapping text in a mark moves nothing.
      useEffect(() => {
        if (typeof document === 'undefined') return
        const root = scrollRef.current
        if (!root) return
        for (const mark of root.querySelectorAll('mark[data-pdf-hit]')) {
          const parent = mark.parentNode
          if (!parent) continue
          parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark)
          parent.normalize()
        }
        if (!search || search.hits.length === 0 || search.current < 0) return
        const hit = search.hits[search.current]
        const pageBox = root.querySelector('[data-pdf-page="' + hit.page + '"]')
        const layer = pageBox ? pageBox.querySelector('.dpf-textLayer') : null
        if (!layer) return
        const needle = search.query
        let remaining = 0
        // Count how many hits precede this one ON THIS PAGE, so the right
        // occurrence is marked when a page carries several.
        for (const other of search.hits) {
          if (other.page === hit.page && other.index < hit.index) remaining += 1
        }
        for (const span of layer.querySelectorAll('span')) {
          const text = span.textContent ?? ''
          const lower = text.toLowerCase()
          let index = lower.indexOf(needle.toLowerCase())
          while (index !== -1) {
            if (remaining === 0) {
              const before = text.slice(0, index)
              const match = text.slice(index, index + needle.length)
              const after = text.slice(index + needle.length)
              span.textContent = ''
              if (before !== '') span.appendChild(document.createTextNode(before))
              const mark = document.createElement('mark')
              mark.setAttribute('data-pdf-hit', 'true')
              mark.setAttribute('data-current', 'true')
              mark.textContent = match
              span.appendChild(mark)
              if (after !== '') span.appendChild(document.createTextNode(after))
              return
            }
            remaining -= 1
            index = lower.indexOf(needle.toLowerCase(), index + Math.max(1, needle.length))
          }
        }
      }, [search, searchRevision, scale])

      const pages = []
      for (let number = 1; number <= pageCount; number += 1) {
        pages.push(
          h(PageView, {
            key: number,
            pdfjs,
            doc,
            pageNumber: number,
            scale,
            rotation,
            registerBox,
            searchRevision,
            onScan,
          }),
        )
      }

      return h(
        'div',
        { className: 'dpf-root', 'data-pdf-reader': address },
        h(
          'div',
          { className: 'dpf-tools', onKeyDown },
          h(ToolButton, { icon: 'prev', title: 'Previous page', disabled: page <= 1, onClick: () => goToPage(Math.max(1, page - 1)), action: 'prev' }),
          h(
            'span',
            { className: 'dpf-pageNum' },
            h('input', {
              className: 'dpf-pageInput',
              value: pageInput,
              inputMode: 'numeric',
              'aria-label': 'Page number',
              onChange: (event) => setPageInput(event.target.value),
              onKeyDown: (event) => {
                if (event.key !== 'Enter') return
                const parsed = Number.parseInt(pageInput, 10)
                if (Number.isFinite(parsed)) goToPage(Math.min(pageCount, Math.max(1, parsed)))
                else setPageInput(String(page))
              },
            }),
            h('span', null, '/ ' + pageCount),
          ),
          h(ToolButton, { icon: 'next', title: 'Next page', disabled: page >= pageCount, onClick: () => goToPage(Math.min(pageCount, page + 1)), action: 'next' }),
          h(ToolButton, { icon: 'zoomOut', title: 'Zoom out (-)', onClick: () => zoomStep(-1), action: 'zoom-out' }),
          h('span', { className: 'dpf-zoom', 'data-pdf-zoom': String(Math.round(scale * 100)) }, Math.round(scale * 100) + '%'),
          h(ToolButton, { icon: 'zoomIn', title: 'Zoom in (+)', onClick: () => zoomStep(1), action: 'zoom-in' }),
          h(ToolButton, { icon: 'fitWidth', title: 'Fit width', active: fit === 'width', onClick: () => setFit('width'), action: 'fit-width' }),
          h(ToolButton, { icon: 'fitPage', title: 'Fit page', active: fit === 'page', onClick: () => setFit('page'), action: 'fit-page' }),
          h(ToolButton, { icon: 'rotate', title: 'Rotate 90 degrees', onClick: () => setRotation((current) => (current + 90) % 360), action: 'rotate' }),
          h(
            'span',
            { className: 'dpf-find' },
            h('input', {
              className: 'dpf-search',
              placeholder: 'Find in document',
              value: query,
              'aria-label': 'Find in document',
              'data-pdf-search': 'true',
              onChange: (event) => setQuery(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') runSearch(query)
              },
            }),
            h(ToolButton, { icon: 'search', title: 'Find (Enter)', onClick: () => runSearch(query), action: 'find' }),
            search
              ? h(ToolButton, { icon: 'up', title: 'Previous match', disabled: search.hits.length === 0, onClick: () => stepHit(-1), action: 'hit-prev' })
              : null,
            search
              ? h(ToolButton, { icon: 'down', title: 'Next match', disabled: search.hits.length === 0, onClick: () => stepHit(1), action: 'hit-next' })
              : null,
            h(
              'span',
              { className: 'dpf-hits', 'data-pdf-hits': search ? String(search.hits.length) : '' },
              searchBusy ? 'searching…' : search ? (search.hits.length === 0 ? 'no hits' : search.current + 1 + '/' + search.hits.length) : '',
            ),
          ),
          h('span', { className: 'dpf-spacer' }),
          h(ToolButton, { icon: 'pages', title: 'Show page thumbnails', active: side === 'pages', onClick: () => setSide((current) => (current === 'pages' ? null : 'pages')), action: 'side-pages' }),
          h(ToolButton, { icon: 'list', title: 'Show this document\u2019s bookmarks', active: side === 'outline', onClick: () => setSide((current) => (current === 'outline' ? null : 'outline')), action: 'side-outline' }),
          h('span', { className: 'dpf-scope', title: scopeLabel }, name),
          h('span', { className: 'dpf-ver' }, PLUGIN_VERSION),
        ),
        h(
          'div',
          { className: 'dpf-body', 'data-pdf-side': side ?? 'none' },
          side === null
            ? null
            : h(
                'div',
                { className: 'dpf-side', 'data-pdf-side-kind': side },
                h(
                  'div',
                  { className: 'dpf-sideHead' },
                  h('span', { className: 'dpf-sideTitle' }, side === 'pages' ? 'Pages' : 'Bookmarks'),
                  h('span', { className: 'dpf-spacer' }),
                  h(ToolButton, { action: 'side-close', title: 'Hide this panel', onClick: () => setSide(null) }, 'Hide'),
                ),
                side === 'pages' ? h(ThumbRail, { doc, pageCount, current: page, onPick: goToPage }) : h(OutlinePanel, { doc, onPick: goToPage }),
              ),
          h(
            'div',
            {
              className: 'dpf-scroll',
              ref: scrollRef,
              tabIndex: 0,
              onScroll,
              onKeyDown,
              onPointerDown,
              onPointerMove,
              onPointerUp: endPan,
              onPointerLeave: endPan,
              'data-panning': panning ? 'true' : 'false',
            },
            h('div', { className: 'dpf-pages' }, ...pages),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // The tab body
    // ---------------------------------------------------------------------
    /** What one address resolves to: the engine, the bytes and the document. */
    function usePdfDocument(address, sessionId) {
      const [state, setState] = useState({ phase: 'loading', doc: null, pdfjs: null, error: '', password: false })
      const [attempt, setAttempt] = useState(0)
      /** The password the reader typed; held in memory for this tab only. */
      const passwordRef = useRef('')
      /** The callback pdf.js hands us when it wants a password. */
      const updatePasswordRef = useRef(null)

      useEffect(() => {
        let cancelled = false
        const parsed = parsePdfAddress(address)
        if (!parsed) {
          setState({ phase: 'error', doc: null, pdfjs: null, error: 'This tab does not name a PDF.', password: false })
          return undefined
        }
        if (!parsed.absolute && (!parsed.sessionId || parsed.sessionId !== sessionId)) {
          // A workspace address always carries its session; the slot's own
          // sessionId is only a fallback for an address written oddly.
          parsed.sessionId = parsed.sessionId || sessionId
        }
        setState((current) => ({ ...current, phase: 'loading', error: '', password: false }))
        ;(async () => {
          try {
            const engine = await loadEngine()
            const data = await loadDocumentData(parsed)
            const task = engine.getDocument({
              data: data.bytes,
              isEvalSupported: false,
              useSystemFonts: false,
              disableFontFace: true,
              enableXfa: false,
              cMapPacked: true,
              BinaryDataFactory: MapBinaryDataFactory,
              cMapUrl: VENDOR_CMAPS,
              standardFontDataUrl: VENDOR_FONTS,
              // The WASM image decoders (JBIG2 / JPEG2000 / colour profiles). The
              // factory serves them from one map, exactly like the cMaps, and
              // pdf.js asks only when a page actually carries such an image.
              wasmUrl: VENDOR_WASM,
              ...(passwordRef.current !== '' ? { password: passwordRef.current } : {}),
            })
            task.onPassword = (updatePassword, reason) => {
              // pdf.js asks for a password exactly when the document needs one.
              if (cancelled) return
              const wrong = reason === 2
              setState((current) => ({ ...current, phase: 'password', error: wrong ? 'That password was not accepted.' : '' }))
              updatePasswordRef.current = updatePassword
            }
            const doc = await task.promise
            if (cancelled) return
            setState({ phase: 'ready', doc, pdfjs: engine, error: '', password: false })
          } catch (err) {
            if (cancelled) return
            const name = err && err.name ? String(err.name) : ''
            if (name === 'PasswordException') {
              setState({ phase: 'password', doc: null, pdfjs: null, error: '', password: true })
              return
            }
            const message =
              name === 'InvalidPDFException'
                ? 'This file is not a readable PDF. A truncated download is the usual cause.'
                : err && err.message
                  ? String(err.message)
                  : 'This PDF could not be opened.'
            setState({ phase: 'error', doc: null, pdfjs: null, error: message, password: false })
          }
        })()
        return () => {
          cancelled = true
        }
      }, [address, sessionId, attempt])

      return {
        ...state,
        retry: () => setAttempt((value) => value + 1),
        submitPassword: (value) => {
          passwordRef.current = String(value ?? '')
          const update = updatePasswordRef.current
          if (typeof update === 'function') {
            try {
              update(passwordRef.current)
              setState((current) => ({ ...current, phase: 'loading', error: '' }))
              return
            } catch (err) {
              /* fall through to a full reopen */
            }
          }
          setAttempt((attempt) => attempt + 1)
        },
      }
    }

    /** The `pdf` tab body: everything a PDF tab is. */
    function PdfBody(props) {
      const info = tabInfoNow(props)
      const tab = info && info.tab ? info.tab : null
      const address = tab && typeof tab.contentId === 'string' ? tab.contentId : ''
      const sessionId = props.sessionId ?? ''
      const parsed = useMemo(() => parsePdfAddress(address), [address])
      const { phase, doc, pdfjs, error, retry, submitPassword } = usePdfDocument(address, sessionId)
      const [password, setPassword] = useState('')
      const scopeLabel = parsed ? (parsed.absolute ? parsed.absolute : parsed.sessionId + '/' + parsed.path) : address

      /**
       * Recognize one page through this plugin's own route - the same pipeline
       * the `pdf_scan` tool drives, so what the model is told and what the
       * reader shows cannot drift. A missing engine comes back as a sentence
       * (the route answers 200 with `ok: false`), never as a thrown error.
       */
      const scanPage = useCallback(
        async (pageNumber) => {
          if (!parsed) return { ok: false, message: 'This tab does not name a readable document.' }
          const payload = parsed.absolute ? { path: parsed.absolute } : { session: parsed.sessionId, path: parsed.path }
          let response
          try {
            response = await fetch(SCAN_ROUTE, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ ...payload, page: pageNumber, dpi: SCAN_DPI }),
            })
          } catch (err) {
            return { ok: false, message: 'The scan request could not be sent: ' + (err && err.message ? err.message : String(err)) }
          }
          const answer = await response.json().catch(() => null)
          if (!answer) return { ok: false, message: 'The scan request failed (HTTP ' + response.status + ').' }
          if (answer.ok !== true) return { ok: false, message: answer.message || 'The scan could not run.', reason: answer.reason }
          const page = (answer.pages ?? []).find((entry) => entry.n === pageNumber) ?? (answer.pages ?? [])[0]
          if (!page) return { ok: false, message: 'No text came back for that page.' }
          if (page.error) return { ok: false, message: page.error }
          return { ok: true, text: page.text ?? '', engine: answer.engine, lang: answer.lang, dpi: answer.dpi, cached: page.cached === true }
        },
        [parsed],
      )

      if (phase === 'error') {
        return h(
          StateBox,
          { state: 'error', title: 'This PDF could not be opened', error, note: scopeLabel },
          h(
            'div',
            { className: 'dpf-row' },
            h(ToolButton, { icon: 'reload', title: 'Try again', onClick: retry, action: 'retry' }, 'Retry'),
          ),
        )
      }
      if (phase === 'password') {
        return h(
          StateBox,
          { state: 'password', title: 'This PDF is password protected', error, note: 'The password is used to open the document in this tab and is never stored.' },
          h(
            'div',
            { className: 'dpf-row' },
            h('input', {
              className: 'dpf-pw',
              type: 'password',
              value: password,
              placeholder: 'Document password',
              'aria-label': 'Document password',
              onChange: (event) => setPassword(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') submitPassword(password)
              },
            }),
            h('button', { type: 'button', className: 'dpf-btn', onClick: () => submitPassword(password) }, 'Open'),
          ),
        )
      }
      if (phase !== 'ready' || !doc) {
        return h(StateBox, { state: 'loading', title: 'Opening the PDF…', note: scopeLabel })
      }
      return h(Reader, {
        pdfjs,
        doc,
        name: baseNameOf(address),
        scopeLabel,
        address,
        onScan: scanPage,
      })
    }

    /** The chip title: the file's own name. */
    function PdfTitle(props) {
      const info = tabInfoNow(props)
      const tab = info && info.tab ? info.tab : null
      return h('span', { className: 'dpf-title' }, baseNameOf(tab ? tab.contentId : ''))
    }

    // ---------------------------------------------------------------------
    // The conversation cards
    // ---------------------------------------------------------------------
    /** Whether one conversation block is a settled call. */
    function isSettled(block) {
      return Boolean(block && block.kind === 'tool-result')
    }

    /** The host's own view of the document a settled call produced. */
    function viewOfBlock(block) {
      const meta = block && block.meta
      if (!meta || typeof meta !== 'object') return null
      return typeof meta.file === 'string' ? meta : null
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

    /** The model-facing text of a settled call, as a short preview. */
    function contentText(block) {
      const content = block && block.content
      if (!Array.isArray(content)) return ''
      const text = content
        .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n')
      return text
    }

    /** Open one PDF address in the right bar, reporting rather than throwing. */
    function openPdf(address, setNote) {
      try {
        const controller = sidebarRightNow()
        if (!controller) throw new Error('The right bar is not mounted.')
        controller.openResource(address)
      } catch (err) {
        if (typeof setNote === 'function') setNote(err && err.message ? err.message : 'could not open the tab')
      }
    }

    /**
     * The conversation card for the four pdf_* tools: the document it acted on,
     * what the host reported (pages, hits, rendered pictures), a preview of the
     * answer, and a link that opens the same document in the right bar.
     */
    function ToolCard(props) {
      const block = props.block
      const args = argsOf(block)
      const settled = isSettled(block)
      const running = Boolean(block) && !settled
      const view = settled ? viewOfBlock(block) : null
      const [note, setNote] = useState('')
      const file = (view && view.file) || (args && args.path) || ''
      const name = (view && view.name) || (file ? String(file).replace(/\\/g, '/').split('/').pop() : 'PDF')
      const text = settled ? contentText(block) : ''
      const address = view && view.address ? view.address : ''
      const facts = []
      if (view && Number.isFinite(view.pages)) facts.push({ label: view.pages + ' page' + (view.pages === 1 ? '' : 's') })
      if (view && view.mode) facts.push({ label: view.mode === 'layout' ? 'layout text' : 'text' })
      if (view && Number.isFinite(view.hits)) facts.push({ label: view.hits + ' hit' + (view.hits === 1 ? '' : 's'), warn: view.hits === 0 })
      if (view && Array.isArray(view.scanned) && view.scanned.length > 0) {
        facts.push({ label: view.scanned.length + ' page(s) without text', warn: true })
      }
      if (view && Array.isArray(view.images) && view.images.length > 0) facts.push({ label: view.images.length + ' picture(s) written' })
      if (view && Number.isFinite(view.dpi)) facts.push({ label: view.dpi + ' dpi' })
      if (view && view.cached === true) facts.push({ label: 'from cache' })
      if (view && view.ocr && typeof view.ocr.engine === 'string') {
        const recognized = Array.isArray(view.ocr.pages) ? view.ocr.pages : []
        facts.push({
          label:
            'recognized ' +
            (recognized.length > 0 ? recognized.slice(0, 6).join(', ') : 'no page') +
            ' with ' +
            view.ocr.engine +
            (view.ocr.lang ? ' (' + view.ocr.lang + (Number.isFinite(view.ocr.dpi) ? ', ' + view.ocr.dpi + ' dpi' : '') + ')' : ''),
        })
        facts.push({ label: 'transcription, not extracted text' })
      }
      if (view && Array.isArray(view.scanned) && Array.isArray(view.images) === false && view.scanned.length > 0) {
        facts.push({ label: 'scanned pages: ' + view.scanned.slice(0, 8).join(', ') })
      }

      return h(
        'div',
        { className: 'dpf-card', 'data-pdf-card': props.toolName },
        h(
          'div',
          { className: 'dpf-cardHead' },
          h(PdfGlyph, { size: 16 }),
          h('span', { className: 'dpf-cardName', title: file }, name),
          h('span', { className: 'dpf-spacer' }),
          running ? h('span', { className: 'dpf-chip' }, 'working…') : null,
          address
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dpf-btn',
                  title: 'Open this PDF in the right bar',
                  'data-pdf-open': address,
                  onClick: () => openPdf(address, setNote),
                },
                'Open tab',
              )
            : null,
        ),
        facts.length > 0
          ? h(
              'div',
              { className: 'dpf-cardFacts' },
              ...facts.map((fact, index) =>
                h('span', { key: index, className: 'dpf-chip', 'data-warn': fact.warn === true ? 'true' : undefined }, fact.label),
              ),
            )
          : null,
        text !== ''
          ? h('pre', { className: 'dpf-preview' }, text.length > 1600 ? text.slice(0, 1600) + '\n…' : text)
          : null,
        note !== '' ? h('div', { className: 'dpf-note' }, note) : null,
      )
    }

    // ---------------------------------------------------------------------
    // The workspace PDF index
    // ---------------------------------------------------------------------
    /** Human bytes, for the index rows. */
    function humanBytes(bytes) {
      if (!Number.isFinite(bytes)) return ''
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KiB'
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    }

    /** A short date, or nothing when the mtime is unusable. */
    function shortDate(ms) {
      if (!Number.isFinite(ms)) return ''
      try {
        return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      } catch (err) {
        return ''
      }
    }

    /**
     * The index page: every PDF in this conversation's workspace.
     *
     * It reads the list from this plugin's own route (bounded depth, file count
     * and page counting - see `listWorkspacePdfs`), and a row opens the document
     * through the ordinary `openResource` action, so whatever claims a PDF
     * address claims it: this package's reader.
     *
     * Requests are guarded by a `useRef` token rather than an effect cleanup, the
     * pack's rule for a panel that can be reloaded mid-flight: an answer is
     * applied only while it is still the newest one.
     */
    function PdfIndexBody(props) {
      const sessionId = props.sessionId ?? ''
      const [state, setState] = useState({ phase: 'loading', files: [], error: '', truncated: false, counted: 0 })
      const [note, setNote] = useState('')
      const token = useRef(0)

      const load = useCallback(
        async (withPages) => {
          const mine = token.current + 1
          token.current = mine
          setNote('')
          setState((current) => ({ ...current, phase: current.files.length > 0 ? 'ready' : 'loading', error: '' }))
          let response
          try {
            response = await fetch(LIST_ROUTE + '?session=' + encodeURIComponent(sessionId) + (withPages ? '&pages=1' : ''), { credentials: 'same-origin' })
          } catch (err) {
            if (token.current === mine) setState({ phase: 'error', files: [], error: 'The workspace could not be read: ' + (err && err.message ? err.message : String(err)), truncated: false, counted: 0 })
            return
          }
          const answer = await response.json().catch(() => null)
          if (token.current !== mine) return
          if (!answer || answer.ok !== true) {
            const message = answer && answer.error && answer.error.message ? answer.error.message : 'The list could not be read (HTTP ' + response.status + ').'
            setState({ phase: 'error', files: [], error: message, truncated: false, counted: 0 })
            return
          }
          setState({ phase: 'ready', files: answer.files ?? [], error: '', truncated: answer.truncated === true, counted: answer.counted ?? 0 })
          if (withPages) {
            const counted = (answer.files ?? []).filter((file) => Number.isFinite(file.pages)).length
            setNote(counted === 0 ? 'No page counts were available (a PDF may be locked or damaged).' : 'Page counts read for ' + counted + ' document(s).')
          }
        },
        [sessionId],
      )

      useEffect(() => {
        load(false)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [load])

      const open = useCallback(
        (address) => {
          const controller = sidebarRightNow()
          if (!controller) {
            setNote('The right bar is not mounted.')
            return
          }
          try {
            controller.openResource(address)
          } catch (err) {
            setNote(err && err.message ? err.message : 'could not open that PDF')
          }
        },
        [],
      )

      const files = state.files
      return h(
        'div',
        { className: 'dpf-index', 'data-pdf-index': INDEX_ADDRESS },
        h(
          'div',
          { className: 'dpf-tools' },
          h('span', { className: 'dpf-indexCount', 'data-pdf-index-count': String(files.length) }, files.length === 1 ? '1 PDF' : files.length + ' PDFs'),
          h('span', { className: 'dpf-spacer' }),
          h(ToolButton, { icon: 'reload', title: 'Read the workspace again', onClick: () => load(false), action: 'index-reload' }, 'Refresh'),
          h(
            ToolButton,
            {
              action: 'index-count',
              title: 'Open each PDF to report its page count (at most 12, and cached afterwards)',
              onClick: () => load(true),
              disabled: state.phase === 'loading',
            },
            'Count pages',
          ),
          h('span', { className: 'dpf-ver' }, PLUGIN_VERSION),
        ),
        note !== '' ? h('div', { className: 'dpf-indexNote' }, note) : null,
        state.phase === 'error'
          ? h(
              'div',
              { className: 'dpf-state', 'data-pdf-index-state': 'error' },
              h(PdfGlyph, { size: 26 }),
              h('div', { className: 'dpf-stateTitle' }, 'The workspace could not be read'),
              h('div', { className: 'dpf-stateErr' }, state.error),
            )
          : state.phase === 'loading'
            ? h('div', { className: 'dpf-state', 'data-pdf-index-state': 'loading' }, h('div', { className: 'dpf-stateTitle' }, 'Reading the workspace\u2026'))
            : files.length === 0
              ? h(
                  'div',
                  { className: 'dpf-state', 'data-pdf-index-state': 'empty' },
                  h(PdfGlyph, { size: 26 }),
                  h('div', { className: 'dpf-stateTitle' }, 'No PDFs in this workspace'),
                  h('div', { className: 'dpf-note' }, 'Drop one into the conversation folder (or attach it to the chat and open it by its absolute path) and it will appear here.'),
                )
              : h(
                  'div',
                  { className: 'dpf-indexBody' },
                  ...files.map((file) =>
                    h(
                      'button',
                      {
                        key: file.path,
                        type: 'button',
                        className: 'dpf-indexRow',
                        'data-pdf-index-row': file.path,
                        title: file.path,
                        onClick: () => open(file.address),
                      },
                      h(PdfGlyph, { size: 15 }),
                      h(
                        'span',
                        { className: 'dpf-indexName' },
                        h('span', { className: 'dpf-indexBase' }, file.name),
                        file.path.includes('/') ? h('span', { className: 'dpf-indexDir' }, file.path.slice(0, file.path.lastIndexOf('/')) + '/') : null,
                      ),
                      h('span', { className: 'dpf-indexMeta' }, humanBytes(file.bytes)),
                      h(
                        'span',
                        { className: 'dpf-indexMeta dpf-indexPages' },
                        file.tooLarge ? 'too large' : Number.isFinite(file.pages) ? String(file.pages) + ' pages' : '\u2014',
                      ),
                      h('span', { className: 'dpf-indexMeta' }, shortDate(file.mtimeMs)),
                    ),
                  ),
                  state.truncated
                    ? h('div', { className: 'dpf-indexNote' }, 'The list stops at ' + files.length + ' documents; this workspace has more. Open the Files tab to see everything.')
                    : null,
                ),
      )
    }

    /** The chip of the index tab. */
    function PdfIndexTitle() {
      return h('span', { className: 'dpf-title' }, 'PDFs')
    }

    // ---------------------------------------------------------------------
    // The tab type
    // ---------------------------------------------------------------------
    /**
     * The `pdf` type: an `extension`-band type for `*.pdf`, which outranks the
     * shipped preview's `fallback` type for the same address and leaves every
     * other file type untouched. `canOpen` is what keeps a non-PDF address out
     * of this tab even if a pattern ever matched one.
     */
    function pdfDefinition() {
      return {
        id: TYPE_ID,
        kind: KIND,
        patterns: ['*.pdf'],
        priority: 'extension',
        canOpen: (address) => isPdfAddress(address),
        title: (address) => baseNameOf(address),
      }
    }

    /**
     * The index type: a PAGE type (`sidebar://pdfs`, no `patterns`), exactly like
     * History and Diagrams, so it never competes for a file address.
     */
    function pdfIndexDefinition() {
      return {
        id: INDEX_ID,
        kind: INDEX_KIND,
        priority: 'builtin',
        title: () => 'PDFs',
        guide: [
          {
            order: 50,
            title: () => 'PDFs',
            description: () => 'Every PDF in this workspace',
            icon: PdfGlyph,
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
      try {
        ctx.effect(() => ctx.sidebarRightTabs.register(pdfDefinition()), 'dsh-pdf: pdf tab type')
        ctx.effect(() => ctx.sidebarRightTabs.register(pdfIndexDefinition()), 'dsh-pdf: pdf index tab type')
        ctx.effect(
          () =>
            ctx.slots.inject(TAB_SLOT, () =>
              ctx.slots.register({ name: TAB_SLOT, key: TYPE_ID, inject: () => ({}) }, PdfBody),
            ),
          'dsh-pdf: pdf tab body',
        )
        ctx.effect(
          () =>
            ctx.slots.inject(TITLE_SLOT, () => ctx.slots.register({ name: TITLE_SLOT, key: TYPE_ID }, PdfTitle)),
          'dsh-pdf: pdf tab title',
        )
        ctx.effect(
          () =>
            ctx.slots.inject(TAB_SLOT, () =>
              ctx.slots.register({ name: TAB_SLOT, key: INDEX_ID, inject: () => ({}) }, PdfIndexBody),
            ),
          'dsh-pdf: index tab body',
        )
        ctx.effect(
          () =>
            ctx.slots.inject(TITLE_SLOT, () => ctx.slots.register({ name: TITLE_SLOT, key: INDEX_ID }, PdfIndexTitle)),
          'dsh-pdf: index tab title',
        )
        for (const toolName of TOOL_NAMES) {
          ctx.effect(
            () => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key: toolName }, ToolCard)),
            'dsh-pdf: ' + toolName + ' card',
          )
        }
        ctx.logger?.debug?.('[dsh-pdf] client half active (' + PLUGIN_VERSION + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-pdf] activation failed', err)
        ctx.logger?.warn?.('[dsh-pdf] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.name = 'dsh-pdf'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
