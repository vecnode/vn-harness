/**
 * dsh-terminal — browser half.
 *
 * A **bottom dock**, not a tab: one horizontal terminal panel at the foot of
 * the app. It starts at the right edge of the left bar, runs to the full width
 * of the page, and sits UNDERNEATH the middle and right columns — which make
 * room for it rather than being covered.
 *
 *   - It is opened by a **header button** registered into
 *     `conversation.session.header.utilities` at `order: 30`, i.e. immediately
 *     right of the shipped **Open In...** (-10) and left of the right bar's own
 *     toggle, which owns the single-occupant `...header.corner` seat beside it.
 *     The glyph is drawn here (primitives ships no terminal icon), and the only
 *     primitive this bundle uses is `Tooltip`.
 *   - The panel itself renders into `shell.overlay`, the root-scoped LIST slot
 *     the layout package renders inside the frame. Its element is `position:
 *     fixed`, which is what lets it escape the frame's `overflow:hidden` while
 *     still living in the app's React tree (no second root, no body-level
 *     append): a fixed box is not clipped by an ancestor's overflow, and the
 *     overlay layer's own `z-index:20` keeps the dock above the columns (10/11)
 *     and below a fullscreen right bar (40).
 *   - **Geometry** is the part the spike proved before any of this existed:
 *     the left edge is the frame's resolved `gridTemplateColumns` first track,
 *     so it follows the left bar opening, collapsing and being dragged with no
 *     hashed class name involved; the app makes room because the frame's inline
 *     height becomes `calc(100% - <dock>px)` while the dock is open (React never
 *     writes `style.height` on the frame — it writes `gridTemplateColumns` — so
 *     the override is stable) and is restored exactly on close.
 *   - **Intent and geometry are separate.** The first spike run failed exactly
 *     here: setting the dock's open state from the observer that tracks the left
 *     bar meant the close which restored the frame's height re-triggered the
 *     observer and reopened the dock. `data-open` is user intent; `data-suspended`
 *     is derived from the frame. Geometry never touches intent.
 *
 * The terminals themselves: one **xterm.js instance per slot**, attached over
 * one authenticated WebSocket each to a real PTY in the Node half. xterm is
 * vendored (see `vendor/`) and fetched lazily the first time a dock opens —
 * exactly how dsh-editor loads CodeMirror — so nothing is paid until it is used.
 *
 * Clipboard is deliberately `Ctrl+Shift+C` / `Ctrl+Shift+V` (Cmd on macOS): a
 * bare Ctrl+C must stay SIGINT for the shell.
 *
 * Module-table format of every client bundle here; no build step.
 */
/* global window, document, fetch, WebSocket, location, navigator, Blob, URL, MutationObserver, ResizeObserver, localStorage */
window.__ModuleLoader__.load({
  id: 'dsh-terminal',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------
    /** Shown on the dock's bar so a freshly loaded bundle is easy to verify. */
    const PLUGIN_VERSION = '0.1.0-alpha.4'
    /** The header list this control joins (Open In... is -10). */
    const HEADER_SLOT = 'conversation.session.header.utilities'
    /** The root-scoped overlay list the layout package renders inside the frame. */
    const OVERLAY_SLOT = 'shell.overlay'
    /** Right of Open In (-10): the last utility, beside the right bar's toggle. */
    const HEADER_ORDER = 30
    /** After the layout's own overlay children. */
    const OVERLAY_ORDER = 50
    /** Keep in sync with lib/index.js. */
    const HEALTH_ROUTE = '/api/dsh-terminal/health'
    const VENDOR_JS_ROUTE = '/api/dsh-terminal/vendor/xterm.js'
    const VENDOR_CSS_ROUTE = '/api/dsh-terminal/vendor/xterm.css'
    const PTY_ROUTE = '/api/dsh-terminal/pty'
    /** The marker that separates control frames from the shell's own output. */
    const CONTROL = '\u0000'
    /** Terminal slots per conversation, and the geometry bounds of the dock. */
    const MAX_TERMINALS = 8
    const MIN_HEIGHT = 120
    const DEFAULT_HEIGHT = 280
    const MAX_HEIGHT_RATIO = 0.7
    const STORAGE_KEY = 'dsh-terminal.dockHeight'

    // ---------------------------------------------------------------------
    // Styles — the pack's tab dress, under this package's own `dst-` prefix.
    // ---------------------------------------------------------------------
    const css = `
.dst-dock{position:fixed;left:0;right:0;bottom:0;z-index:21;box-sizing:border-box;display:none;flex-direction:column;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#1f1f1f);border-top:.5px solid var(--dsw-alias-border-l4,rgba(127,127,127,.34));box-shadow:0 -6px 18px rgba(0,0,0,.06);font-size:12.5px;line-height:1.5}
.dst-dock[data-open]:not([data-suspended]){display:flex}
.dst-grip{flex:none;height:6px;cursor:row-resize;touch-action:none;background:transparent}
.dst-grip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dst-bar{flex:none;display:flex;align-items:center;gap:8px;min-width:0;padding:2px 8px 6px 10px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.16))}
.dst-brand{flex:none;display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,#666);font-weight:500}
.dst-glyph{flex:none;display:inline-flex;color:var(--dsw-alias-label-tertiary,#999)}
.dst-chips{flex:1;min-width:0;display:flex;align-items:center;gap:4px;overflow-x:auto;overflow-y:hidden;overscroll-behavior-x:contain;scrollbar-width:none;-ms-overflow-style:none}
.dst-chips::-webkit-scrollbar{height:0;width:0}
.dst-nav{flex:none;display:inline-flex;align-items:center;gap:2px}
.dst-chev{font-size:13px;line-height:1}
.dst-chip{flex:none;display:inline-flex;align-items:center;gap:6px;height:24px;box-sizing:border-box;padding:0 4px 0 9px;border:.5px solid transparent;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#666);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap;max-width:190px}
.dst-chip:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dst-chip[data-active]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));border-color:var(--dsw-alias-border-l3,rgba(127,127,127,.28));color:var(--dsw-alias-label-primary,#1f1f1f)}
.dst-chipName{overflow:hidden;text-overflow:ellipsis}
.dst-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#999)}
.dst-dot[data-state=live]{background:var(--dsw-alias-state-success-primary,#2f9e44)}
.dst-dot[data-state=connecting]{background:var(--dsw-alias-state-warning-primary,#d29922)}
.dst-dot[data-state=exited],.dst-dot[data-state=error]{background:var(--dsw-alias-state-error-primary,#d3382c)}
.dst-chipClose{flex:none;display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;border:0;border-radius:4px;background:transparent;color:inherit;cursor:pointer;padding:0;opacity:.6}
.dst-chipClose:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.2))}
.dst-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:12px;padding:0 8px;cursor:pointer;white-space:nowrap;gap:5px}
.dst-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dst-btn:disabled{opacity:.45;cursor:default}
.dst-btnIcon{width:24px;padding:0}
.dst-facts{flex:none;display:inline-flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-tertiary,#999);font-size:11.5px}
.dst-cwd{max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,'Cascadia Code',Consolas,monospace;direction:rtl;text-align:left}
.dst-ver{opacity:.7}
.dst-body{flex:auto;min-height:0;position:relative;background:var(--dsw-alias-bg-base,#fff)}
.dst-host{position:absolute;inset:0;padding:4px 2px 2px 8px;box-sizing:border-box;overflow:hidden}
.dst-host[hidden]{display:none}
.dst-host .xterm{height:100%}
.dst-notice{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:20px;text-align:center;color:var(--dsw-alias-label-tertiary,#999);font-size:12.5px}
.dst-noticeTitle{color:var(--dsw-alias-label-secondary,#666);font-size:13px}
.dst-noticeErr{color:var(--dsw-alias-state-error-primary,#d3382c)}
.dst-noticeCode{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:11px;opacity:.85;max-width:640px;white-space:pre-wrap}
`
    const CSS_TAG = 'dsh-terminal/terminal.css'
    if (typeof document !== 'undefined' && document.head && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-terminal'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------------
    // The dock store. A tiny module-level store rather than a published
    // service: nothing outside this package consumes it, and the pack provides
    // a service only when a consumer exists. The snapshot is a REVISION NUMBER
    // so `useSyncExternalStore` never sees a fresh object per call.
    // ---------------------------------------------------------------------
    const dock = {
      /** User intent: the panel is showing. */
      open: false,
      /** The conversation the panel belongs to (set by the button that opened it). */
      sessionId: null,
      /** Panel height in px. */
      height: readStoredHeight(),
      /** Bumped by every mutation; the only thing the store publishes. */
      rev: 0,
      /** sessionId -> [{ index, status, detail }] — survives closing the dock. */
      slots: new Map(),
      /** sessionId -> the slot index on screen. */
      active: new Map(),
    }
    const subscribers = new Set()

    function readStoredHeight() {
      try {
        const raw = window.localStorage ? window.localStorage.getItem(STORAGE_KEY) : null
        const value = Number.parseInt(raw === null ? '' : raw, 10)
        if (Number.isFinite(value)) return clampHeight(value)
      } catch (err) {
        /* a blocked localStorage simply means the default height */
      }
      return DEFAULT_HEIGHT
    }

    function maxHeight() {
      const viewport = typeof window !== 'undefined' && window.innerHeight ? window.innerHeight : 800
      return Math.max(MIN_HEIGHT, Math.round(viewport * MAX_HEIGHT_RATIO))
    }

    function clampHeight(value) {
      return Math.min(Math.max(Math.round(value), MIN_HEIGHT), maxHeight())
    }

    /**
     * The scroll a strip needs to bring ONE chip into view: the smallest amount
     * that leaves `margin` px of air, or 0 when it is already there. Both boxes
     * are `{ left, right }` in the same coordinate space (`getBoundingClientRect`),
     * and the result is a DELTA for `scrollLeft` - a negative one when the chip is
     * cut off on the left, a positive one on the right - which the browser clamps
     * to the scrollable range itself. Pure, so the tracked check can drive it
     * without a layout engine: a sign error here is the classic way a
     * scroll-into-view scrolls the wrong way, and no static render would see it.
     */
    function revealDelta(box, chip, margin) {
      const gap = margin === undefined ? 8 : margin
      if (chip.left < box.left) return chip.left - box.left - gap
      if (chip.right > box.right) return chip.right - box.right + gap
      return 0
    }

    function bump() {
      dock.rev += 1
      for (const listener of [...subscribers]) {
        try {
          listener()
        } catch (err) {
          /* one throwing subscriber must not break the others */
        }
      }
    }

    function subscribe(listener) {
      subscribers.add(listener)
      return () => {
        subscribers.delete(listener)
      }
    }

    /** The revision is the whole subscription: components then read `dock`. */
    function useRevision() {
      return useSyncExternalStore(subscribe, () => dock.rev, () => dock.rev)
    }

    /** The slots recorded for one conversation (never null). */
    function slotsFor(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return []
      let list = dock.slots.get(sessionId)
      if (list === undefined) {
        list = [{ index: 0, status: 'connecting', detail: '' }]
        dock.slots.set(sessionId, list)
      }
      return list
    }

    function setSlotStatus(sessionId, index, status, detail) {
      const list = dock.slots.get(sessionId)
      if (list === undefined) return
      const slot = list.find((entry) => entry.index === index)
      if (slot === undefined) return
      if (slot.status === status && slot.detail === detail) return
      slot.status = status
      slot.detail = detail === undefined ? slot.detail : detail
      bump()
    }

    /** Open the dock for a conversation, or close it when it is already there. */
    function toggleDock(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (dock.open && dock.sessionId === sessionId) {
        dock.open = false
        bump()
        return
      }
      if (dock.sessionId !== sessionId) dock.active.set(sessionId, 0)
      dock.sessionId = sessionId
      dock.open = true
      slotsFor(sessionId)
      bump()
    }

    function closeDock() {
      if (!dock.open) return
      dock.open = false
      bump()
    }

    /** A header button reports its conversation: the dock only belongs to one. */
    function adoptSession(sessionId) {
      if (!dock.open || typeof sessionId !== 'string' || sessionId === '') return
      if (dock.sessionId !== sessionId) closeDock()
    }

    function setHeight(value) {
      const next = clampHeight(value)
      if (next === dock.height) return
      dock.height = next
      try {
        if (window.localStorage) window.localStorage.setItem(STORAGE_KEY, String(next))
      } catch (err) {
        /* not persisting is not a failure */
      }
      bump()
    }

    // ---------------------------------------------------------------------
    // The vendored xterm engine (lazy, once) — the dsh-editor pattern: fetch
    // the classic bundle, inject it through a blob script, then it is a global.
    // ---------------------------------------------------------------------
    let enginePromise = null
    let engineCssDone = false

    function ensureCss() {
      if (engineCssDone || typeof document === 'undefined' || !document.head) return
      engineCssDone = true
      const tagId = 'dsh-terminal/xterm.css'
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']')) return
      const tag = document.createElement('link')
      tag.rel = 'stylesheet'
      tag.href = VENDOR_CSS_ROUTE
      tag.dataset.plugin = 'dsh-terminal'
      tag.dataset.pluginCss = tagId
      document.head.appendChild(tag)
    }

    function ensureEngine() {
      if (window.DSHTerminal) return Promise.resolve(window.DSHTerminal)
      if (!enginePromise) {
        enginePromise = (async () => {
          ensureCss()
          const res = await fetch(VENDOR_JS_ROUTE, { method: 'GET', credentials: 'same-origin' })
          if (!res.ok) throw new Error('terminal engine unavailable (HTTP ' + String(res.status) + ')')
          const source = await res.text()
          if (window.DSHTerminal) return window.DSHTerminal
          const blob = new Blob([source], { type: 'text/javascript' })
          const url = URL.createObjectURL(blob)
          await new Promise((resolve, reject) => {
            const el = document.createElement('script')
            el.async = true
            el.src = url
            el.addEventListener(
              'load',
              () => {
                el.remove()
                URL.revokeObjectURL(url)
                resolve()
              },
              { once: true },
            )
            el.addEventListener(
              'error',
              () => {
                el.remove()
                URL.revokeObjectURL(url)
                reject(new Error('terminal engine failed to start'))
              },
              { once: true },
            )
            document.head.appendChild(el)
          })
          if (!window.DSHTerminal) throw new Error('terminal engine did not export DSHTerminal')
          return window.DSHTerminal
        })().catch((err) => {
          enginePromise = null
          throw err
        })
      }
      return enginePromise
    }

    // ---------------------------------------------------------------------
    // Appearance. The pack's sanctioned signal is the attribute ui-layout
    // applies to the document (`body[data-ds-dark-theme]`), watched live; the
    // ANSI palette is the one thing xterm cannot take from CSS variables, so
    // the app's own tokens are read for the chrome colours and a small table
    // supplies the 16 colours per appearance.
    // ---------------------------------------------------------------------
    const ANSI = {
      dark: {
        black: '#2b3245', red: '#f07178', green: '#7ec699', yellow: '#ffcb6b',
        blue: '#82aaff', magenta: '#c792ea', cyan: '#89ddff', white: '#d6deeb',
        brightBlack: '#5c6773', brightRed: '#ff8b92', brightGreen: '#9fe0b4',
        brightYellow: '#ffd98c', brightBlue: '#a4c2ff', brightMagenta: '#dcb1f5',
        brightCyan: '#b3e9ff', brightWhite: '#ffffff',
      },
      light: {
        black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#7a5b00',
        blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#6e7781',
        brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37',
        brightYellow: '#9a6700', brightBlue: '#218bff', brightMagenta: '#a475f9',
        brightCyan: '#3192aa', brightWhite: '#1f1f1f',
      },
    }

    function appearance() {
      try {
        return document.body && document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
      } catch (err) {
        return 'light'
      }
    }

    function token(name, fallback) {
      try {
        const value = getComputedStyle(document.body).getPropertyValue(name)
        return value && value.trim() !== '' ? value.trim() : fallback
      } catch (err) {
        return fallback
      }
    }

    /** xterm's palette for one appearance: app chrome tokens plus the ANSI table. */
    function xtermTheme(mode) {
      const base = ANSI[mode] || ANSI.light
      return {
        ...base,
        background: token('--dsw-alias-bg-base', mode === 'dark' ? '#151517' : '#ffffff'),
        foreground: token('--dsw-alias-label-primary', mode === 'dark' ? '#e6e6e6' : '#1f1f1f'),
        cursor: token('--dsw-alias-label-secondary', mode === 'dark' ? '#c8c8c8' : '#444444'),
        cursorAccent: token('--dsw-alias-bg-base', mode === 'dark' ? '#151517' : '#ffffff'),
        selectionBackground: token('--dsw-alias-interactive-bg-hover', mode === 'dark' ? 'rgba(255,255,255,.22)' : 'rgba(0,0,0,.16)'),
      }
    }

    // ---------------------------------------------------------------------
    // Dock geometry (the spike, shipped). Intent and geometry stay separate:
    // `applyGeometry` never writes `data-open`.
    // ---------------------------------------------------------------------
    /** The frame element: found from OUR OWN node inside its overlay layer. */
    function frameFrom(node) {
      try {
        if (node && typeof node.closest === 'function') {
          const overlay = node.closest('[data-shell-overlay]')
          if (overlay && overlay.parentElement) return overlay.parentElement
        }
        const column = document.querySelector('[data-rightbar-col]')
        if (column && column.parentElement) return column.parentElement
      } catch (err) {
        /* the frame is not mounted yet */
      }
      return null
    }

    /**
     * The left bar's live width: the frame's columns are an inline
     * `gridTemplateColumns: <sidebar>px minmax(0,1fr) <rightbar>px`, so the
     * RESOLVED computed style carries the sidebar track in px.
     */
    function sidebarWidth(frame) {
      try {
        const tracks = getComputedStyle(frame).gridTemplateColumns.split(' ')
        const first = Number.parseFloat(tracks[0])
        return Number.isFinite(first) ? first : 0
      } catch (err) {
        return 0
      }
    }

    /** Place the dock; never touches intent. */
    function applyGeometry(node, frame) {
      if (node === null) return
      if (frame === null) {
        node.style.left = '0px'
        node.style.height = dock.height + 'px'
        node.dataset.suspended = '1'
        return
      }
      if (frame.hasAttribute('data-rightbar-fullscreen')) node.dataset.suspended = '1'
      else delete node.dataset.suspended
      node.style.left = sidebarWidth(frame) + 'px'
      node.style.height = dock.height + 'px'
    }

    /**
     * The two columns that make room for the dock: the MIDDLE and the RIGHT one.
     *
     * The left bar is deliberately not one of them. Shrinking the frame itself
     * (the first alpha's approach) makes room for the dock by shortening the
     * frame's only grid row, which shortens the LEFT column too - its content
     * visibly slid up the moment the dock opened. The dock starts at the left
     * bar's right edge, so the left bar must keep its full height and the room
     * has to come from the two columns the dock actually spans.
     *
     * Both are found without hashed class names: the layout marks the right
     * column itself (`data-rightbar-col`), the middle column is its immediately
     * preceding sibling in the frame, and the left column is the frame's first
     * element child (`DocumentTitle` renders no DOM, so it is not one), which is
     * the guard that keeps this from ever insetting the left bar.
     *
     * @param frame - the app frame element.
     * @returns the column elements to inset.
     */
    function columnsFor(frame) {
      const columns = []
      try {
        const right = frame.querySelector('[data-rightbar-col]')
        if (right === null) return columns
        const middle = right.previousElementSibling
        if (middle !== null && middle.nodeType === 1 && middle !== frame.children[0]) columns.push(middle)
        columns.push(right)
      } catch (err) {
        /* a frame without the layout's column marker keeps the dock unhoused */
      }
      return columns
    }

    /**
     * The room the dock takes, applied as those columns' own height.
     *
     * A height, not `padding-bottom`: the right column's panel is absolutely
     * positioned inside it (`top:0; bottom:0`), and an absolute child's
     * containing block is its ancestor's PADDING box - padding would leave the
     * panel exactly where it was and the dock would cover the bottom of it.
     * A height shortens the column itself, so the panel ends at the dock's top
     * edge like everything else.
     *
     * While the dock is closed - or suspended by a fullscreen right bar - each
     * column gets back the inline height it had before this plugin ever ran.
     *
     * @param frame - the app frame element (or null when it is not mounted).
     */
    const insets = new Map()

    function applyInsets(frame) {
      if (frame !== null) {
        for (const column of columnsFor(frame)) {
          if (!insets.has(column)) insets.set(column, column.style.height)
        }
      }
      const bare = frame === null || !dock.open || frame.hasAttribute('data-rightbar-fullscreen')
      const wanted = bare ? null : 'calc(100% - ' + String(dock.height) + 'px)'
      for (const [column, saved] of insets) {
        if (!document.contains(column)) {
          insets.delete(column)
          continue
        }
        column.style.height = wanted === null ? saved : wanted
      }
    }

    // ---------------------------------------------------------------------
    // The runtime: one xterm + one socket per slot. A plain object rather than
    // hook state, because its life is imperative (resize, reattach, backpressure).
    // ---------------------------------------------------------------------
    const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(String(navigator.platform || navigator.userAgent || ''))

    class DockRuntime {
      /**
       * @param options - `sessionId`, `hosts` (index -> element), `onStatus`.
       */
      constructor({ sessionId, hosts, onStatus }) {
        this.sessionId = sessionId
        this.hosts = hosts
        this.onStatus = onStatus
        this.entries = new Map()
        this.engine = null
        this.destroyed = false
      }

      /** Create/attach every recorded slot; the caller has already fetched it. */
      async start(engine, slots) {
        this.engine = engine
        for (const slot of slots) {
          if (this.destroyed) return
          this.ensureEntry(slot.index)
        }
        this.show(dock.active.get(this.sessionId) ?? 0)
      }

      /** Create the xterm + socket for one slot in this.runtime. */
      ensureEntry(index) {
        if (this.entries.has(index)) return this.entries.get(index)
        const host = this.hosts.get(index)
        if (host === undefined || host === null) return null
        const { Terminal, FitAddon } = this.engine
        const term = new Terminal({
          allowProposedApi: true,
          cursorBlink: true,
          fontFamily: "ui-monospace, 'Cascadia Code', Consolas, 'SF Mono', Menlo, monospace",
          fontSize: 12.5,
          lineHeight: 1.2,
          scrollback: 5000,
          theme: xtermTheme(appearance()),
        })
        const fit = new FitAddon()
        term.loadAddon(fit)
        term.open(host)
        const entry = { index, term, fit, ws: null, status: 'connecting', wroteReplay: false, host }
        this.entries.set(index, entry)

        term.onData((data) => {
          if (entry.ws !== null && entry.ws.readyState === 1) entry.ws.send(data)
        })
        term.attachCustomKeyEventHandler((event) => this.onKey(event, entry))
        this.connect(entry)
        return entry
      }

      /** Clipboard keys; every other key belongs to the shell. */
      onKey(event, entry) {
        if (event.type !== 'keydown') return true
        const key = String(event.key || '').toLowerCase()
        const shiftCombo = (event.ctrlKey || event.metaKey) && event.shiftKey
        const macCombo = MAC && event.metaKey && !event.shiftKey && !event.ctrlKey
        if ((shiftCombo || macCombo) && key === 'c') {
          const selection = entry.term.getSelection()
          if (selection !== '') void writeClipboard(selection)
          else entry.term.clearSelection()
          return false
        }
        if ((shiftCombo || macCombo) && key === 'v') {
          void readClipboard().then((text) => {
            if (text !== '') entry.term.paste(text)
          })
          return false
        }
        return true
      }

      /** One WebSocket per slot; the init frame names the conversation and slot. */
      connect(entry) {
        let url
        try {
          const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
          url = scheme + '//' + location.host + PTY_ROUTE
        } catch (err) {
          this.onStatus(entry.index, 'error', 'no location')
          return
        }
        let ws
        try {
          ws = new WebSocket(url)
        } catch (err) {
          this.onStatus(entry.index, 'error', String((err && err.message) || err))
          return
        }
        entry.ws = ws
        entry.wroteReplay = false
        ws.onopen = () => {
          try {
            ws.send(
              CONTROL +
                JSON.stringify({
                  t: 'init',
                  session: this.sessionId,
                  slot: entry.index,
                  cols: entry.term.cols,
                  rows: entry.term.rows,
                }),
            )
          } catch (err) {
            /* the error handler reports it */
          }
        }
        ws.onmessage = (event) => {
          const data = event.data
          if (typeof data !== 'string' || data === '') return
          if (data.charCodeAt(0) === 0) {
            let message = null
            try {
              message = JSON.parse(data.slice(1))
            } catch (err) {
              return
            }
            this.onControl(entry, message)
            return
          }
          entry.term.write(data)
        }
        ws.onerror = () => {
          if (entry.status === 'live') return
          this.onStatus(entry.index, 'error', 'socket')
        }
        ws.onclose = () => {
          if (this.destroyed) return
          if (entry.status === 'connecting') this.onStatus(entry.index, 'error', 'closed before ready')
          else if (entry.status === 'live') this.onStatus(entry.index, 'exited', '')
        }
      }

      /** Apply one control frame from the Node half. */
      onControl(entry, message) {
        if (message === null || typeof message !== 'object') return
        if (message.t === 'ready') {
          entry.facts = { shell: message.shell, cwd: message.cwd }
          if (typeof message.cols === 'number' && typeof message.rows === 'number' && (message.cols !== entry.term.cols || message.rows !== entry.term.rows)) {
            entry.term.resize(message.cols, message.rows)
          }
          if (typeof message.replay === 'string' && message.replay !== '') entry.term.write(message.replay)
          entry.wroteReplay = true
          this.onStatus(entry.index, 'live', message.cwd ? String(message.cwd) : '')
          this.fit()
          return
        }
        if (message.t === 'exit') {
          this.onStatus(entry.index, 'exited', 'exit code ' + String(message.code))
          entry.term.write('\r\n[process exited with code ' + String(message.code) + ']\r\n')
          return
        }
        if (message.t === 'closed') {
          this.onStatus(entry.index, 'exited', String(message.reason || 'closed'))
          return
        }
        if (message.t === 'error') {
          this.onStatus(entry.index, 'error', String(message.message || message.code || 'error'))
        }
      }

      /**
       * Fit every visible slot to its host box, tell the PTY the new size, and
       * leave the view on the END of the output.
       *
       * The scroll is not decoration: a shell prints at the end of its buffer, so
       * a resize that keeps the old scroll position shows lines that are no
       * longer the last ones - and after a grow the rows below the old viewport
       * would simply be off-screen. Re-fitting also recomputes the rows/cols from
       * the new box, which is what keeps the visible line count honest while the
       * panel is being dragged.
       */
      fit() {
        for (const entry of this.entries.values()) {
          if (entry.host === null || entry.host.hasAttribute('hidden')) continue
          try {
            entry.fit.fit()
          } catch (err) {
            /* a zero-sized host (mid-layout) is not an error */
          }
          if (entry.ws !== null && entry.ws.readyState === 1) {
            try {
              entry.ws.send(CONTROL + JSON.stringify({ t: 'resize', cols: entry.term.cols, rows: entry.term.rows }))
            } catch (err) {
              /* the next fit retries */
            }
          }
          try {
            entry.term.scrollToBottom()
          } catch (err) {
            /* an emulator without the method keeps its position */
          }
        }
      }

      /** The panel or the viewport changed size: re-fit and follow the end. */
      refit() {
        this.fit()
      }

      /** Show one slot and hide the others. */
      show(index) {
        for (const entry of this.entries.values()) {
          if (entry.host === null) continue
          if (entry.index === index) entry.host.removeAttribute('hidden')
          else entry.host.setAttribute('hidden', '')
        }
        dock.active.set(this.sessionId, index)
        const entry = this.entries.get(index)
        if (entry !== undefined) {
          // A hidden xterm cannot be measured: fit only once it is on screen.
          requestAnimationFrame(() => {
            if (this.destroyed) return
            this.fit()
            try {
              entry.term.focus()
            } catch (err) {
              /* focus is best-effort */
            }
          })
        }
      }

      /** Re-read the appearance for every live terminal. */
      retheme() {
        const mode = appearance()
        for (const entry of this.entries.values()) {
          try {
            entry.term.options.theme = xtermTheme(mode)
          } catch (err) {
            /* an older xterm simply keeps its palette */
          }
        }
      }

      /** End one slot's shell and forget it. */
      kill(index) {
        const entry = this.entries.get(index)
        if (entry === undefined) return
        if (entry.ws !== null && entry.ws.readyState === 1) {
          try {
            entry.ws.send(CONTROL + JSON.stringify({ t: 'kill' }))
          } catch (err) {
            /* the server's reaper owns anything left behind */
          }
        }
        this.drop(index)
      }

      /** Detach one slot: close the socket and dispose the emulator. */
      drop(index) {
        const entry = this.entries.get(index)
        if (entry === undefined) return
        this.entries.delete(index)
        try {
          if (entry.ws !== null) {
            entry.ws.onclose = null
            entry.ws.onerror = null
            entry.ws.onmessage = null
            entry.ws.close()
          }
        } catch (err) {
          /* already closed */
        }
        try {
          entry.term.dispose()
        } catch (err) {
          /* already disposed */
        }
      }

      /**
       * Detach everything WITHOUT killing the shells: the sockets close, the
       * server keeps each PTY for its grace period, and reopening replays what
       * the shell printed meanwhile. This is the same path a page reload takes,
       * which is why hiding and reloading cannot diverge.
       */
      destroy() {
        this.destroyed = true
        for (const index of [...this.entries.keys()]) this.drop(index)
      }
    }

    function writeClipboard(text) {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          return navigator.clipboard.writeText(text).catch(() => {})
        }
      } catch (err) {
        /* fall through to the legacy path */
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        area.remove()
      } catch (err) {
        /* nothing else to try */
      }
      return Promise.resolve()
    }

    function readClipboard() {
      try {
        if (navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
          return navigator.clipboard.readText().catch(() => '')
        }
      } catch (err) {
        /* the shell's own paste binding is the fallback */
      }
      return Promise.resolve('')
    }

    // ---------------------------------------------------------------------
    // Glyphs (primitives ships no terminal icon; the rightbar draws its own too)
    // ---------------------------------------------------------------------
    function svg(path, size) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        path.map((d, index) =>
          typeof d === 'string' ? h('path', { key: index, d, stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round', strokeLinejoin: 'round' }) : d,
        ),
      )
    }

    function TerminalGlyph({ size = 15 }) {
      return svg(['M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z', 'M4.6 7.2 6.4 9l-1.8 1.8', 'M8.2 10.8h3.2'], size)
    }

    function CloseGlyph({ size = 11 }) {
      return svg(['M3.6 3.6l8.8 8.8', 'M12.4 3.6l-8.8 8.8'], size)
    }

    function PlusGlyph({ size = 12 }) {
      return svg(['M8 3.4v9.2', 'M3.4 8h9.2'], size)
    }

    // ---------------------------------------------------------------------
    // The header control: toggles the dock for its own conversation.
    // ---------------------------------------------------------------------
    function TerminalButton({ sessionId }) {
      const rev = useRevision()
      const active = dock.open && dock.sessionId === sessionId
      // The conversation this button belongs to is the one on screen, so this is
      // where "switching conversation closes the dock" is enforced.
      useEffect(() => {
        adoptSession(sessionId)
        // `rev` keeps this honest when the dock is opened/closed elsewhere.
      }, [sessionId, rev])
      const label = active ? 'Hide terminal' : 'Terminal'
      const onClick = useCallback(() => {
        toggleDock(sessionId)
      }, [sessionId])
      return h(
        primitives.Tooltip,
        { label, side: 'bottom', delayMs: 500 },
        h(
          'button',
          {
            type: 'button',
            className: 'dst-btn dst-btnIcon',
            'aria-label': 'Terminal',
            'aria-pressed': active ? 'true' : 'false',
            'data-dsh-terminal-toggle': '',
            style: { width: '28px', height: '28px', borderRadius: '28px' },
            onClick,
          },
          h('span', { className: 'dst-glyph' }, h(TerminalGlyph, { size: 15 })),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // The dock
    // ---------------------------------------------------------------------
    function Dock() {
      const rev = useRevision()
      const open = dock.open
      const sessionId = dock.sessionId
      const height = dock.height
      const rootRef = useRef(null)
      const hostsRef = useRef(new Map())
      const runtimeRef = useRef(null)
      // The chip strip scrolls sideways once the terminals outgrow it. The
      // arrows are part of that: they exist only while it really overflows, and
      // they are the affordance the strip wears INSTEAD of a scrollbar - a
      // classic scrollbar on a 24px row costs more height than it explains.
      const chipsRef = useRef(null)
      const chipRefs = useRef(new Map())
      const [chipNav, setChipNav] = useState({ over: false, atStart: true, atEnd: true })
      const [health, setHealth] = useState(null)
      const [engineError, setEngineError] = useState(null)
      // Mirrored onto the dock element as `data-appearance`: the terminal's own
      // colours live in xterm's canvas/DOM renderer, not in a CSS rule, so this
      // is the only honest way to see (and to check) which palette is in force.
      const [mode, setMode] = useState(appearance())
      const slots = open || sessionId === null ? slotsFor(sessionId) : []

      // Geometry: place the dock, and take its room from the middle and right
      // columns ONLY - never from the frame, whose single grid row is shared
      // with the left bar (see `columnsFor`).
      //
      // Deliberately NOT keyed on the revision: every status bump would run the
      // cleanup and the effect again, churning the columns' heights. The
      // observers and the resize listener cover live moves.
      useEffect(() => {
        const node = rootRef.current
        if (node === null) return undefined
        const frame = frameFrom(node)
        applyGeometry(node, frame)
        applyInsets(frame)
        let observer = null
        let columnObserver = null
        if (open && frame !== null && typeof MutationObserver === 'function') {
          // The frame's inline `style` changes when a column is dragged or the
          // right bar opens/closes: one mutation, settled immediately.
          observer = new MutationObserver(() => {
            applyGeometry(node, frame)
            applyInsets(frame)
          })
          observer.observe(frame, { attributes: true, attributeFilter: ['style', 'data-rightbar-fullscreen'] })
        }
        if (open && frame !== null && typeof ResizeObserver === 'function') {
          // The LEFT BAR is ANIMATED, which is what the observer above cannot see:
          // collapsing or expanding it rewrites the grid tracks ONCE and then
          // transitions them, so the mutation fires before the width has actually
          // changed - and never again, leaving the dock at the old left edge. The
          // two columns the dock spans change SIZE on every frame of that
          // transition, which is exactly what a ResizeObserver reports.
          columnObserver = new ResizeObserver(() => applyGeometry(node, frame))
          for (const column of columnsFor(frame)) columnObserver.observe(column)
        }
        const onTransitionEnd = (event) => {
          if (event.target === frame) applyGeometry(node, frame)
        }
        if (open && frame !== null) frame.addEventListener('transitionend', onTransitionEnd)
        const onResize = () => {
          applyGeometry(node, frame)
          applyInsets(frame)
          const runtime = runtimeRef.current
          if (runtime !== null) runtime.refit()
        }
        window.addEventListener('resize', onResize)
        return () => {
          window.removeEventListener('resize', onResize)
          if (frame !== null) frame.removeEventListener('transitionend', onTransitionEnd)
          if (observer !== null) observer.disconnect()
          if (columnObserver !== null) columnObserver.disconnect()
        }
      }, [open, height])

      // The dock's own element must leave the columns as it found them when the
      // plugin goes away (a restart of the app is not the only way to unload it).
      useEffect(
        () => () => {
          for (const [column, saved] of insets) column.style.height = saved
          insets.clear()
        },
        [],
      )

      // A drag (or a viewport change) has to reach the emulator: after the styles
      // above are on the page, re-fit so the rows/cols match the new box and the
      // view lands on the end of the output - otherwise the panel keeps showing
      // the old number of lines with the last ones out of sight.
      useEffect(() => {
        if (!open) return undefined
        const id = requestAnimationFrame(() => {
          const runtime = runtimeRef.current
          if (runtime !== null) runtime.refit()
        })
        return () => cancelAnimationFrame(id)
      }, [height, open])

      // Appearance: ui-layout publishes it as an attribute on the body.
      useEffect(() => {
        const runtime = runtimeRef.current
        if (runtime !== null) runtime.retheme()
        setMode(appearance())
        if (typeof MutationObserver !== 'function' || !document.body) return undefined
        const observer = new MutationObserver(() => {
          setMode(appearance())
          const live = runtimeRef.current
          if (live !== null) live.retheme()
        })
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
        return () => observer.disconnect()
      }, [open])

      // Health: is a PTY available on this host at all?
      useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        fetch(HEALTH_ROUTE, { credentials: 'same-origin' })
          .then((res) => (res.ok ? res.json() : null))
          .then((body) => {
            if (!cancelled) setHealth(body)
          })
          .catch(() => {
            if (!cancelled) setHealth({ ok: false, available: false, reason: 'the terminal routes are not reachable' })
          })
        return () => {
          cancelled = true
        }
      }, [open])

      // The runtime: created while the dock is open, destroyed when it closes.
      useEffect(() => {
        if (!open || sessionId === null || health === null || health.available !== true) return undefined
        let runtime = null
        let cancelled = false
        ensureEngine()
          .then((engine) => {
            if (cancelled) return
            const hosts = hostsRef.current
            runtime = new DockRuntime({
              sessionId,
              hosts,
              onStatus: (index, status, detail) => setSlotStatus(sessionId, index, status, detail),
            })
            runtimeRef.current = runtime
            return runtime.start(engine, slotsFor(sessionId))
          })
          .catch((err) => {
            if (!cancelled) setEngineError(String((err && err.message) || err))
          })
        return () => {
          cancelled = true
          if (runtime !== null) runtime.destroy()
          runtimeRef.current = null
        }
        // NOT keyed on `slots.length`: adding or killing a chip must not tear
        // down the terminals that are already attached. The next effect picks
        // new slots up through `ensureEntry`.
      }, [open, sessionId, health, engineError])

      // A new slot needs its xterm; an existing one keeps its socket.
      useEffect(() => {
        const runtime = runtimeRef.current
        if (runtime === null) return
        for (const slot of slots) runtime.ensureEntry(slot.index)
        runtime.show(dock.active.get(sessionId) ?? 0)
      }, [slots.length, sessionId])

      const onGripDown = useCallback(
        (event) => {
          const startY = event.clientY
          const startHeight = dock.height
          const move = (moveEvent) => setHeight(startHeight + (startY - moveEvent.clientY))
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
          event.preventDefault()
        },
        [],
      )

      const addTerminal = useCallback(() => {
        const list = slotsFor(sessionId)
        if (list.length >= MAX_TERMINALS) return
        const used = new Set(list.map((slot) => slot.index))
        let index = 0
        while (used.has(index)) index += 1
        list.push({ index, status: 'connecting', detail: '' })
        dock.active.set(sessionId, index)
        bump()
      }, [sessionId])

      const killTerminal = useCallback(
        (index) => {
          const list = slotsFor(sessionId)
          const at = list.findIndex((slot) => slot.index === index)
          if (at !== -1) list.splice(at, 1)
          const runtime = runtimeRef.current
          if (runtime !== null) runtime.kill(index)
          // The list may legitimately become empty: killing the last chip ends
          // every shell and leaves the "+" as the way back in.
          const nextActive = list.length === 0 ? 0 : list[Math.min(at <= 0 ? 0 : at, list.length - 1)].index
          dock.active.set(sessionId, nextActive)
          bump()
          const live = runtimeRef.current
          if (live !== null) live.show(nextActive)
        },
        [sessionId],
      )

      const active = dock.active.get(sessionId) ?? 0

      // Picking a chip goes through the STORE, always. `runtime.show()` writes
      // `dock.active` straight into the map and re-fits the visible emulator, but
      // it does not publish: with the pick routed through it alone, React never
      // re-rendered, so `data-active` stayed on the chip the reader had just left
      // - the terminal being shown changed, the highlight did not (reported
      // against alpha.3). One revision bump is what makes the two agree, and it
      // is harmless on the path where no runtime exists yet.
      const selectSlot = useCallback(
        (index) => {
          dock.active.set(sessionId, index)
          const runtime = runtimeRef.current
          if (runtime !== null) runtime.show(index)
          bump()
        },
        [sessionId],
      )

      /** Re-read the strip's overflow. State is left untouched when unchanged. */
      const syncChips = useCallback(() => {
        const box = chipsRef.current
        if (box === null) return
        const max = Math.max(0, box.scrollWidth - box.clientWidth)
        const next = {
          over: max > 1,
          atStart: box.scrollLeft <= 1,
          atEnd: box.scrollLeft >= max - 1,
        }
        setChipNav((prev) =>
          prev.over === next.over && prev.atStart === next.atStart && prev.atEnd === next.atEnd ? prev : next,
        )
      }, [])

      /** One page of the strip, in either direction. */
      const scrollChips = useCallback((direction) => {
        const box = chipsRef.current
        if (box === null) return
        const step = Math.max(96, Math.round(box.clientWidth * 0.7))
        const max = Math.max(0, box.scrollWidth - box.clientWidth)
        const left = Math.max(0, Math.min(max, box.scrollLeft + direction * step))
        if (typeof box.scrollTo === 'function') box.scrollTo({ left, behavior: 'smooth' })
        else box.scrollLeft = left
      }, [])

      // What overflows is geometry, not state: it is re-read on a scroll, on a
      // resize of the strip (the dock opening, the window, the left bar moving)
      // and whenever the chip count changes.
      useEffect(() => {
        const box = chipsRef.current
        if (box === null) return undefined
        const onScroll = () => syncChips()
        box.addEventListener('scroll', onScroll, { passive: true })
        let observer = null
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(() => syncChips())
          observer.observe(box)
        }
        syncChips()
        return () => {
          box.removeEventListener('scroll', onScroll)
          if (observer !== null) observer.disconnect()
        }
      }, [open, slots.length, syncChips])

      // A bare wheel over the strip moves it SIDEWAYS, which is this pane's axis
      // (the pack's other scrollable surfaces do the same). The listener is
      // NATIVE and `{passive:false}`: React's own wheel listener is passive, so a
      // `preventDefault()` inside it would do nothing and the wheel would scroll
      // the terminal's own scrollback at the same time.
      useEffect(() => {
        const box = chipsRef.current
        if (box === null) return undefined
        const onWheel = (event) => {
          if (event.ctrlKey || event.metaKey) return
          const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX
          if (delta === 0) return
          const max = box.scrollWidth - box.clientWidth
          if (max <= 0) return
          const next = Math.max(0, Math.min(max, box.scrollLeft + delta))
          if (next === box.scrollLeft) return
          box.scrollLeft = next
          event.preventDefault()
        }
        box.addEventListener('wheel', onWheel, { passive: false })
        return () => box.removeEventListener('wheel', onWheel)
      }, [])

      // The chip on screen is always ON screen: a pick, or a terminal just added,
      // scrolls the strip by the smallest amount that reveals it. The strip's own
      // box is the reference (`getBoundingClientRect`), never a page scroll.
      useEffect(() => {
        const box = chipsRef.current
        const chip = chipRefs.current.get(active)
        if (box === null || chip === undefined || chip === null) return
        const boxRect = box.getBoundingClientRect()
        const chipRect = chip.getBoundingClientRect()
        if (chipRect.width === 0 && chipRect.height === 0) return
        const delta = revealDelta(boxRect, chipRect)
        if (delta !== 0) box.scrollLeft += delta
        syncChips()
      }, [active, open, slots.length, syncChips])

      const activeSlot = slots.find((slot) => slot.index === active) || slots[0] || null
      const facts = activeSlot && activeSlot.detail ? activeSlot.detail : ''
      const notice = health !== null && health.available !== true ? health : engineError === null ? null : { reason: engineError }

      return h(
        'div',
        {
          ref: rootRef,
          className: 'dst-dock',
          'data-dsh-terminal-dock': '',
          'data-open': open ? '' : undefined,
          'data-appearance': mode,
          role: 'region',
          'aria-label': 'Terminal',
        },
        h('div', { className: 'dst-grip', role: 'separator', 'aria-orientation': 'horizontal', onPointerDown: onGripDown, title: 'Resize' }),
        h(
          'div',
          { className: 'dst-bar' },
          h('span', { className: 'dst-brand' }, h('span', { className: 'dst-glyph' }, h(TerminalGlyph, { size: 14 })), 'Terminal'),
          h(
            'div',
            { className: 'dst-chips', ref: chipsRef },
            slots.map((slot) =>
              h(
                'div',
                {
                  key: slot.index,
                  ref: (el) => {
                    if (el === null) chipRefs.current.delete(slot.index)
                    else chipRefs.current.set(slot.index, el)
                  },
                  className: 'dst-chip',
                  'data-active': slot.index === active ? '' : undefined,
                  onClick: () => selectSlot(slot.index),
                },
                h('span', { className: 'dst-dot', 'data-state': slot.status }),
                h('span', { className: 'dst-chipName' }, 'Terminal ' + String(slot.index + 1)),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dst-chipClose',
                    title: 'Close this terminal',
                    'aria-label': 'Close Terminal ' + String(slot.index + 1),
                    onClick: (event) => {
                      event.stopPropagation()
                      killTerminal(slot.index)
                    },
                  },
                  h(CloseGlyph, { size: 9 }),
                ),
              ),
            ),
          ),
          // The way along the strip, shown only while there IS one. Both the
          // strip and the "+" live outside this group, so the control that opens
          // a terminal can never scroll out of reach.
          chipNav.over
            ? h(
                'div',
                { className: 'dst-nav' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dst-btn dst-btnIcon',
                    title: 'Scroll the terminals left',
                    'aria-label': 'Scroll the terminals left',
                    disabled: chipNav.atStart,
                    onClick: () => scrollChips(-1),
                  },
                  h('span', { className: 'dst-chev' }, '\u2039'),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dst-btn dst-btnIcon',
                    title: 'Scroll the terminals right',
                    'aria-label': 'Scroll the terminals right',
                    disabled: chipNav.atEnd,
                    onClick: () => scrollChips(1),
                  },
                  h('span', { className: 'dst-chev' }, '\u203a'),
                ),
              )
            : null,
          h(
            'button',
            {
              type: 'button',
              className: 'dst-btn dst-btnIcon',
              title: 'New terminal',
              'aria-label': 'New terminal',
              disabled: slots.length >= MAX_TERMINALS,
              onClick: addTerminal,
            },
            h(PlusGlyph, { size: 12 }),
          ),
          h(
            'span',
            { className: 'dst-facts' },
            health && health.shell ? h('span', null, health.shell.label) : null,
            facts !== '' ? h('span', { className: 'dst-cwd', title: facts }, facts) : null,
            h('span', { className: 'dst-ver' }, 'dsh-terminal ' + PLUGIN_VERSION),
          ),
          h(
            'button',
            { type: 'button', className: 'dst-btn dst-btnIcon', title: 'Hide terminal', 'aria-label': 'Hide terminal', onClick: closeDock },
            h(CloseGlyph, { size: 11 }),
          ),
        ),
        h(
          'div',
          { className: 'dst-body' },
          slots.map((slot) =>
            h('div', {
              key: slot.index,
              className: 'dst-host',
              'data-slot': String(slot.index),
              hidden: slot.index === active ? undefined : '',
              ref: (el) => {
                if (el === null) hostsRef.current.delete(slot.index)
                else hostsRef.current.set(slot.index, el)
              },
            }),
          ),
          notice !== null
            ? h(
                'div',
                { className: 'dst-notice' },
                h('div', { className: 'dst-noticeTitle' }, notice.available === false ? 'No terminal on this host' : 'The terminal engine did not load'),
                h('div', { className: 'dst-noticeErr' }, String(notice.reason || 'unknown reason')),
                h('div', { className: 'dst-noticeCode' }, 'dsh-terminal ' + PLUGIN_VERSION + ' · ' + String(health && health.platform ? health.platform : 'web')),
              )
            : slots.length === 0
              ? h(
                  'div',
                  { className: 'dst-notice' },
                  h('div', { className: 'dst-noticeTitle' }, 'No terminals'),
                  h('div', null, 'Use + in the bar above to open a shell in this conversation\u2019s folder.'),
                )
              : null,
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Activation
    // ---------------------------------------------------------------------
    const inject = ['slots']

    /**
     * Register the header control and the dock. Both ride `slots.inject`, so
     * neither is lost to a registration order: the seat exists whenever the
     * conversation header or the app frame exists.
     *
     * @param ctx - the client context (inject: slots).
     */
    function apply(ctx) {
      try {
        ctx.effect(
          () =>
            ctx.slots.inject(HEADER_SLOT, () =>
              ctx.slots.register(
                {
                  name: HEADER_SLOT,
                  id: 'dsh-terminal',
                  order: HEADER_ORDER,
                },
                TerminalButton,
              ),
            ),
          'dsh-terminal: header control',
        )
        ctx.effect(
          () =>
            ctx.slots.inject(OVERLAY_SLOT, () =>
              ctx.slots.register({ name: OVERLAY_SLOT, id: 'dsh-terminal', order: OVERLAY_ORDER }, Dock),
            ),
          'dsh-terminal: dock',
        )
        ctx.logger?.debug?.('[dsh-terminal] dock control registered (' + PLUGIN_VERSION + ', order ' + String(HEADER_ORDER) + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-terminal] activation failed', err)
        ctx.logger?.warn?.('[dsh-terminal] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.apply = apply
    exports.inject = inject
    // The bundle's PURE half, for the tracked check: the strip's scroll-into-view
    // arithmetic, which a static render cannot exercise (see `revealDelta`).
    exports.__internals = { revealDelta }
    return module.exports
  },
})
