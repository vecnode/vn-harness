/**
 * dsh-browser — browser half.
 *
 * A tab TYPE for the pack's right bar (dsh-rightbar), the page kind beside the
 * shipped "Start" page, the "Files" tab, the pack's "Editor" and its "History".
 * It is a BROWSER TAB: an address bar, back / forward / reload / stop, a
 * connection LED, Copy and Open, and the page itself underneath.
 *
 * The page is drawn by the browser that is already showing this GUI — one
 * `<iframe>`, nothing shipped with the harness to render anything. That choice
 * buys a real engine for free and costs one honest limitation, so the tab is
 * built around it instead of hiding it:
 *
 *   - a CROSS-ORIGIN frame is opaque. The page inside cannot be read, clicked
 *     through, or asked where it went, so in-frame navigation is invisible here:
 *     back / forward replay the addresses THIS tab loaded, and the address bar
 *     shows the address the tab settled on (the probe below resolves redirects
 *     for it). Nothing pretends otherwise;
 *   - an address can REFUSE to be embedded at all (`X-Frame-Options`, a CSP
 *     `frame-ancestors`). The frame would show the browser's own refusal page and
 *     fire a perfectly ordinary `load`, so this tab asks the host FIRST:
 *     `GET /api/dsh-browser/probe?url=` (lib/index.js) checks the headers from
 *     Node and answers `frameable`. Only a real refusal blocks the load — a
 *     401/DNS/timeout is a note, because the frame uses the browser's own
 *     session and may render what an anonymous check cannot see;
 *   - `led` is the surface's own health: grey idle, amber loading, green loaded,
 *     red when the address cannot be displayed here. It never claims more than
 *     the one signal a cross-origin frame gives (`load`), which is why a slow
 *     load becomes an explicit note rather than a lie.
 *
 * SURFACES (the seam). Everything above the render surface — the toolbar, the
 * history stack, the LED, the probe, the tab type and its Start entry — is
 * surface-neutral. A surface is one factory returning five methods
 * (`mount`/`goto`/`reload`/`stop`/`dispose`) plus an `onState` reporter; `iframe`
 * is the one this alpha ships. A harness-owned engine (a pinned Chromium driven
 * over CDP and streamed into a canvas) is a SECOND entry in `SURFACES` — same
 * `onState` shape, same five methods — and nothing else in this file changes.
 * That is the whole reason the seam exists.
 *
 * No services beyond the bar's registry and the slot system are required: `fetch`
 * is the browser's own, the session id arrives as a seat prop (and is handed to
 * the surface, which is where a future engine will need it), and the clipboard
 * degrades to `execCommand` when `navigator.clipboard` is unavailable.
 *
 * Module-table format of every client bundle here; no build step.
 */
/* global window, document, fetch, navigator, requestAnimationFrame */
window.__ModuleLoader__.load({
  id: 'dsh-browser',
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
    const TYPE_ID = 'dsh-browser'
    /** The tab kind this package owns. */
    const KIND = 'browser'
    /** The address a page tab of this kind is recorded under. */
    const PAGE_ADDRESS = 'sidebar://' + KIND
    /** The render surface in force (see SURFACES at the bottom of this file). */
    const SURFACE = 'iframe'
    /** Keep in sync with lib/index.js. */
    const PROBE_ROUTE = '/api/dsh-browser/probe'
    /** Version marker shown on the status line so a freshly loaded bundle is easy to verify. */
    const PLUGIN_VERSION = '0.1.0-alpha.1'
    /** The keyed seats every tab type occupies. */
    const TAB_SLOT = 'sidebar.right.pane.tab'
    const TITLE_SLOT = 'sidebar.right.pane.tab.title'
    /** The chip's label, the guide entry's title and the tab type's title. */
    const LABEL = 'Browser'
    /** How long a frame may load before the tab says so out loud. */
    const LOAD_WARN_MS = 12000

    // ---------------------------------------------------------------------
    // Styles (the pack's tab dress, under this package's own prefix)
    // ---------------------------------------------------------------------
    const css = `
.dsb-root{height:100%;min-height:0;flex:auto;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1f1f1f);font-size:13px;line-height:1.5}
.dsb-tools{flex:none;display:flex;align-items:center;gap:6px;padding:8px 10px 8px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}
.dsb-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;min-width:26px;height:26px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:12.5px;padding:0 8px;cursor:pointer;white-space:nowrap}
.dsb-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsb-btn:disabled{opacity:.4;cursor:default}
.dsb-btn[data-dsb-copied="true"]{color:var(--dsw-alias-state-success-primary,#2f9e44)}
.dsb-url{flex:1;min-width:0;height:26px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:var(--dsw-alias-bg-layer-1,transparent);color:inherit;font:inherit;font-size:12.5px;padding:0 8px}
.dsb-url:focus{outline:none;border-color:var(--dsw-alias-border-l2,rgba(127,127,127,.55))}
.dsb-led{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-tertiary,#999);box-shadow:0 0 0 2px rgba(127,127,127,.14)}
.dsb-led[data-dsb-led="loading"]{background:var(--dsw-alias-state-warning-primary,#d29922);box-shadow:0 0 0 2px rgba(210,153,34,.18)}
.dsb-led[data-dsb-led="live"]{background:var(--dsw-alias-state-success-primary,#2f9e44);box-shadow:0 0 0 2px rgba(47,158,68,.18)}
.dsb-led[data-dsb-led="down"]{background:var(--dsw-alias-state-error-primary,#d3382c);box-shadow:0 0 0 2px rgba(211,56,44,.18)}
.dsb-note{flex:none;padding:5px 12px;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14))}
.dsb-body{flex:1;min-height:0;position:relative;display:flex}
.dsb-frameHost{flex:1;min-width:0;min-height:0;display:flex;background:#fff}
.dsb-frame{flex:1;width:100%;height:100%;border:0;display:block;background:#fff}
.dsb-card{margin:auto;max-width:420px;box-sizing:border-box;padding:18px 20px;display:flex;flex-direction:column;gap:10px;align-items:center;text-align:center}
.dsb-cardTitle{font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary,#666);word-break:break-word}
.dsb-cardText{font-size:12px;color:var(--dsw-alias-label-tertiary,#999);margin:0}
.dsb-cardErr{color:var(--dsw-alias-state-error-primary,#d3382c)}
.dsb-cardRow{display:flex;gap:8px;flex-wrap:wrap;justify-content:center}
.dsb-detail{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:11px;opacity:.85;word-break:break-word;margin:0}
.dsb-status{flex:none;display:flex;align-items:center;gap:8px;padding:4px 10px 5px 12px;border-top:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14));font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);min-width:0}
.dsb-statusTitle{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsb-code{flex:none;font-family:ui-monospace,'Cascadia Code',Consolas,monospace;opacity:.85}
.dsb-ver{flex:none;white-space:nowrap;opacity:.7}
.dsb-chip{white-space:nowrap}
`
    const CSS_TAG = 'dsh-browser/browser.css'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-browser'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------------
    // Addresses
    // ---------------------------------------------------------------------
    /**
     * Turn what someone typed into an address this tab may load, or `null`.
     *
     * A scheme is respected when it is http or https and refused otherwise (no
     * `javascript:`, no `file:`, no `data:`). Without a scheme, a loopback host
     * gets http - that is where dev servers live - and anything else that looks
     * like a hostname gets https. A bare word is not an address and is refused
     * rather than sent to a search engine this pack has no business choosing.
     *
     * @param raw - the input text or a tab parameter.
     * @returns the absolute address, or `null`.
     */
    function normalizeAddress(raw) {
      const text = String(raw === undefined || raw === null ? '' : raw).trim()
      if (text === '') return null
      if (/^[a-z][a-z0-9+.-]*:/i.test(text)) {
        try {
          const url = new URL(text)
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
          return url.href
        } catch (err) {
          return null
        }
      }
      if (/\s/.test(text)) return null
      const authority = text.split(/[/?#]/)[0]
      const loopback = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(authority)
      const dotted = authority.indexOf('.') !== -1
      if (!loopback && !dotted) return null
      // Canonicalized through URL, so the address bar, the history stack and the
      // probe all speak about the same string (`example.com` -> `https://example.com/`).
      try {
        return new URL((loopback ? 'http://' : 'https://') + text).href
      } catch (err) {
        return null
      }
    }

    /** The address an opener asked for (`openTab('browser', { params: { url } })`), or ''. */
    function readOpenerUrl(info) {
      const navigation = info && info.tab ? info.tab.navigation : null
      if (navigation === null || typeof navigation !== 'object') return ''
      const params = navigation.params
      const wanted = params && typeof params.url === 'string' ? params.url : ''
      const address = normalizeAddress(wanted)
      return address === null ? '' : address
    }

    // ---------------------------------------------------------------------
    // Surfaces (the seam)
    // ---------------------------------------------------------------------
    /** `requestAnimationFrame` where there is one; a task otherwise. */
    function nextFrame(run) {
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run)
      else setTimeout(run, 0)
    }

    /**
     * The surface this alpha ships: a live `<iframe>` drawn by the browser that
     * is already showing this GUI.
     *
     * What it can report is exactly what a cross-origin frame reports: the `load`
     * event, and nothing else. No URL, no title, no errors - the host probe covers
     * those before the load, and the status line says so.
     *
     * @param spec - `{ sessionId, host, onState }`; `host` is the mount point.
     * @returns the surface contract: `{ kind, mount, goto, reload, stop, dispose }`.
     */
    function createIframeSurface(spec) {
      let frame = null
      let loadTimer = null
      let disposed = false
      let current = ''

      const report = (patch) => {
        if (!disposed && typeof spec.onState === 'function') spec.onState(patch)
      }
      const clearLoadTimer = () => {
        if (loadTimer !== null) {
          clearTimeout(loadTimer)
          loadTimer = null
        }
      }
      const onLoad = () => {
        clearLoadTimer()
        if (frame !== null && frame.getAttribute('src') === 'about:blank') return
        report({ phase: 'live' })
      }
      const armLoadTimer = () => {
        clearLoadTimer()
        loadTimer = setTimeout(() => {
          loadTimer = null
          report({ phase: 'slow', note: 'This page is still loading. Reload to start over.' })
        }, LOAD_WARN_MS)
      }
      const ensure = () => {
        if (frame !== null) return frame
        frame = document.createElement('iframe')
        frame.className = 'dsb-frame'
        frame.setAttribute('title', LABEL + ' page')
        frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin')
        frame.setAttribute('allow', 'clipboard-write; fullscreen; autoplay')
        frame.addEventListener('load', onLoad)
        spec.host.appendChild(frame)
        return frame
      }

      return {
        kind: 'iframe',
        /** Put the frame in the host. Called once, before any navigation. */
        mount() {
          ensure()
        },
        /** Load one absolute address. */
        goto(address) {
          current = address
          const element = ensure()
          armLoadTimer()
          element.setAttribute('src', address)
        },
        /** Re-fetch the current address. */
        reload() {
          if (current === '') return
          const element = ensure()
          armLoadTimer()
          // `contentWindow.location.reload()` is a cross-origin access and throws,
          // so the frame is unloaded for one frame and handed the same address
          // again - which is a fresh load, cache and all.
          element.setAttribute('src', 'about:blank')
          const target = current
          nextFrame(() => {
            if (!disposed && frame !== null) frame.setAttribute('src', target)
          })
        },
        /** Stop the load. The only lever a cross-origin frame leaves is unloading it. */
        stop() {
          clearLoadTimer()
          if (frame !== null) frame.setAttribute('src', 'about:blank')
          report({ phase: 'idle', note: 'Stopped.' })
        },
        /** Remove the frame and forget it. */
        dispose() {
          disposed = true
          clearLoadTimer()
          if (frame !== null) {
            frame.removeEventListener('load', onLoad)
            try {
              frame.setAttribute('src', 'about:blank')
            } catch (err) {
              /* a frame already gone */
            }
            if (frame.parentNode) frame.parentNode.removeChild(frame)
          }
          frame = null
          current = ''
        },
      }
    }

    /**
     * Every render surface this bundle knows, by name. `SURFACE` above picks the
     * one in force; a second entry here (a harness-owned engine streamed over CDP)
     * is the entire cost of adding one, because nothing outside this map knows
     * what a frame is.
     */
    const SURFACES = {
      iframe: createIframeSurface,
    }

    /** Build the surface in force; an unknown name falls back to the shipped one. */
    function createSurface(kind, spec) {
      const factory = SURFACES[kind] || SURFACES.iframe
      return factory(spec)
    }

    // ---------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------
    /** The guide capsule's glyph (drawn before "Browser" on the Start page). */
    function BrowserGlyph(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20
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
          className: props ? props.className : undefined,
        },
        h('circle', { cx: 8, cy: 8, r: 6.2 }),
        h('path', { d: 'M1.8 8h12.4' }),
        h('path', { d: 'M8 1.8c1.9 1.9 2.9 3.9 2.9 6.2S9.9 12.3 8 14.2C6.1 12.3 5.1 10.3 5.1 8S6.1 3.7 8 1.8z' }),
      )
    }

    // ---------------------------------------------------------------------
    // The tab body
    // ---------------------------------------------------------------------
    /**
     * The Browser surface: the toolbar, the page, and the truth about both.
     *
     * The history lives in a ref (`historyRef`) and is mirrored into state only to
     * render: that keeps `load` a stable callback, so the mount effect that opens
     * the tab at an opener's address never reads a stale stack.
     */
    function BrowserView(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
      const opener = readOpenerUrl(info)

      const hostRef = useRef(null)
      const surfaceRef = useRef(null)
      const inputRef = useRef(null)
      const probeCacheRef = useRef(new Map())
      const historyRef = useRef({ entries: [], index: -1 })
      const tokenRef = useRef(0)
      const copyTimerRef = useRef(null)

      const [draft, setDraft] = useState(opener)
      const [entries, setEntries] = useState([])
      const [index, setIndex] = useState(-1)
      const [copied, setCopied] = useState(false)
      const [nav, setNav] = useState({ phase: 'idle', address: '', title: '', status: 0, blockedBy: null, note: '' })

      const applyHistory = useCallback(() => {
        const history = historyRef.current
        setEntries(history.entries.slice())
        setIndex(history.index)
      }, [])

      /**
       * Ask the host whether an address may be framed here. One answer per address
       * per tab lifetime: a step back to a page the user already saw must not
       * re-block it on a renewed probe.
       */
      const probe = useCallback((address) => {
        const cache = probeCacheRef.current
        const held = cache.get(address)
        if (held !== undefined) return held
        const pending = fetch(PROBE_ROUTE + '?url=' + encodeURIComponent(address), {
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        })
          .then(async (response) => {
            const payload = await response.json().catch(() => null)
            if (payload === null || payload.ok !== true) {
              const error = payload && payload.error ? payload.error : { code: 'HTTP_' + String(response.status), message: 'The address could not be checked.' }
              return { ok: false, error }
            }
            return { ok: true, ...payload }
          })
          .catch((err) => ({ ok: false, error: { code: 'UNREACHABLE', message: String((err && err.message) || err) } }))
        cache.set(address, pending)
        return pending
      }, [])

      /**
       * Load one address: normalize, record it, ask the host, then hand it to the
       * surface - unless the host says the address refuses to be embedded, which
       * is the one answer that stops a load instead of annotating it.
       *
       * @param raw - what the address bar, a history step or an opener supplied.
       * @param options - `{ push }` adds a history entry, `{ bypassProbe }` loads
       *   without asking (the "Try anyway" escape from a refusal).
       */
      const load = useCallback(
        (raw, options = {}) => {
          const token = tokenRef.current + 1
          tokenRef.current = token
          const address = normalizeAddress(raw)
          if (address === null) {
            setNav({ phase: 'error', address: String(raw === undefined || raw === null ? '' : raw), title: '', status: 0, blockedBy: null, note: 'Only http and https addresses can open here.' })
            return
          }
          setDraft(address)
          if (options.push === true) {
            const history = historyRef.current
            const trimmed = history.entries.slice(0, history.index + 1)
            // Enter on the address already on top of the stack is a reload, not a
            // new entry: a browser does not grow its history for a second Enter.
            if (trimmed.length === 0 || trimmed[trimmed.length - 1] !== address) trimmed.push(address)
            history.entries = trimmed
            history.index = trimmed.length - 1
            applyHistory()
          }
          const surface = surfaceRef.current
          setNav({ phase: 'probing', address, title: '', status: 0, blockedBy: null, note: '' })
          if (surface === null) return
          if (options.bypassProbe === true) {
            surface.goto(address)
            return
          }
          probe(address).then((answer) => {
            if (tokenRef.current !== token) return
            if (answer.ok !== true) {
              // Not a refusal: the host could not check the address at all (offline,
              // DNS, a timeout, a wall). The frame uses the browser's own session, so
              // hand it over and keep the reason in the status line.
              setNav({ phase: 'loading', address, title: '', status: 0, blockedBy: null, note: answer.error.message })
              surface.goto(address)
              return
            }
            const target = answer.finalUrl ? answer.finalUrl : address
            if (answer.frameable === false) {
              setNav({ phase: 'blocked', address: target, title: answer.title || '', status: answer.status, blockedBy: answer.blockedBy || null, note: answer.note || '' })
              return
            }
            setDraft(target)
            setNav({ phase: 'loading', address: target, title: answer.title || '', status: answer.status, blockedBy: null, note: answer.note || '' })
            surface.goto(target)
          })
        },
        [applyHistory, probe],
      )

      // The surface is mounted once and disposed on unmount; the opener's address,
      // if any, is loaded right after it exists.
      useEffect(() => {
        const host = hostRef.current
        if (host === null) return undefined
        const surface = createSurface(SURFACE, {
          sessionId,
          host,
          onState: (patch) => setNav((state) => ({ ...state, ...patch })),
        })
        surfaceRef.current = surface
        surface.mount()
        if (opener !== '') load(opener, { push: true })
        return () => {
          surfaceRef.current = null
          surface.dispose()
        }
        // Mount/unmount only: `load` is stable and the opener never changes for one tab.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      useEffect(
        () => () => {
          if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
        },
        [],
      )

      /** Move along the tab's own stack; the address is already in the probe cache. */
      const step = useCallback(
        (delta) => {
          const history = historyRef.current
          const next = history.index + delta
          if (next < 0 || next >= history.entries.length) return
          history.index = next
          applyHistory()
          load(history.entries[next], {})
        },
        [applyHistory, load],
      )

      const reload = useCallback(() => {
        const history = historyRef.current
        if (history.index < 0) return
        const address = history.entries[history.index]
        if (nav.phase === 'blocked') {
          // A site can change its mind: Reload re-asks the host instead of doing
          // nothing, which is what a user pressing Reload on a refusal means.
          probeCacheRef.current.delete(address)
          load(address, {})
          return
        }
        const surface = surfaceRef.current
        if (surface === null) return
        setNav((state) => ({ ...state, phase: 'loading', note: '' }))
        surface.reload()
      }, [load, nav.phase])

      const stop = useCallback(() => {
        const surface = surfaceRef.current
        if (surface !== null) surface.stop()
      }, [])

      const openExternal = useCallback(() => {
        const address = draft !== '' ? draft : nav.address
        if (address === '' || typeof window.open !== 'function') return
        window.open(address, '_blank', 'noopener,noreferrer')
      }, [draft, nav.address])

      const copy = useCallback(() => {
        const text = draft !== '' ? draft : nav.address
        if (text === '') return
        const done = () => {
          setCopied(true)
          if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current)
          copyTimerRef.current = setTimeout(() => {
            copyTimerRef.current = null
            setCopied(false)
          }, 1400)
        }
        const fallback = () => {
          try {
            const holder = document.createElement('textarea')
            holder.value = text
            holder.setAttribute('readonly', '')
            holder.style.position = 'fixed'
            holder.style.opacity = '0'
            document.body.appendChild(holder)
            holder.select()
            document.execCommand('copy')
            document.body.removeChild(holder)
            done()
          } catch (err) {
            /* no clipboard on this page: the button simply does not confirm */
          }
        }
        if (navigator && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(text).then(done).catch(fallback)
          return
        }
        fallback()
      }, [draft, nav.address])

      const onAddressKeyDown = useCallback(
        (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            load(draft, { push: true })
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            setDraft(nav.address)
          }
        },
        [draft, load, nav.address],
      )

      const onRootKeyDown = useCallback((event) => {
        if ((event.ctrlKey || event.metaKey) && (event.key === 'l' || event.key === 'L')) {
          event.preventDefault()
          const input = inputRef.current
          if (input !== null) {
            input.focus()
            if (typeof input.select === 'function') input.select()
          }
        }
      }, [])

      // ---- derived state ----
      const phase = nav.phase
      const loading = phase === 'probing' || phase === 'loading' || phase === 'slow'
      const led = phase === 'idle' ? 'idle' : phase === 'live' ? 'live' : phase === 'blocked' || phase === 'error' ? 'down' : 'loading'
      const ledTitle =
        led === 'idle'
          ? 'No page loaded'
          : led === 'live'
            ? 'The page loaded'
            : led === 'down'
              ? phase === 'blocked'
                ? 'This address cannot be shown in a frame here'
                : 'That is not an address this tab can open'
              : 'Loading the page'
      const canBack = index > 0
      const canForward = index >= 0 && index < entries.length - 1
      const showCard = phase === 'idle' || phase === 'blocked' || phase === 'error'
      const host = useMemo(() => {
        try {
          return new URL(nav.address).host
        } catch (err) {
          return nav.address
        }
      }, [nav.address])

      // ---- the toolbar ----
      const tools = h(
        'div',
        { className: 'dsb-tools' },
        h(
          'button',
          { type: 'button', className: 'dsb-btn', 'data-dsb-back': true, title: 'Back', 'aria-label': 'Back', disabled: !canBack, onClick: () => step(-1) },
          '\u2039',
        ),
        h(
          'button',
          { type: 'button', className: 'dsb-btn', 'data-dsb-forward': true, title: 'Forward', 'aria-label': 'Forward', disabled: !canForward, onClick: () => step(1) },
          '\u203a',
        ),
        loading
          ? h(
              'button',
              { type: 'button', className: 'dsb-btn', 'data-dsb-stop': true, title: 'Stop loading', 'aria-label': 'Stop loading', onClick: stop },
              '\u00d7',
            )
          : h(
              'button',
              { type: 'button', className: 'dsb-btn', 'data-dsb-reload': true, title: 'Reload this page', 'aria-label': 'Reload this page', disabled: nav.address === '', onClick: reload },
              '\u21bb',
            ),
        h('span', { className: 'dsb-led', 'data-dsb-led': led, role: 'img', title: ledTitle, 'aria-label': ledTitle }),
        h('input', {
          ref: inputRef,
          className: 'dsb-url',
          type: 'text',
          inputMode: 'url',
          spellCheck: false,
          autoComplete: 'off',
          placeholder: 'localhost:3000 or example.com',
          'aria-label': 'Address',
          'data-dsb-url': true,
          value: draft,
          onChange: (event) => setDraft(event.target.value),
          onKeyDown: onAddressKeyDown,
        }),
        h(
          'button',
          {
            type: 'button',
            className: 'dsb-btn',
            'data-dsb-copy': true,
            'data-dsb-copied': copied ? 'true' : 'false',
            title: copied ? 'Copied' : 'Copy the address',
            'aria-label': copied ? 'Copied the address' : 'Copy the address',
            disabled: draft === '' && nav.address === '',
            onClick: copy,
          },
          copied ? 'Copied' : 'Copy',
        ),
        h(
          'button',
          { type: 'button', className: 'dsb-btn', 'data-dsb-open': true, title: 'Open in a new browser tab', 'aria-label': 'Open in a new browser tab', disabled: draft === '' && nav.address === '', onClick: openExternal },
          'Open',
        ),
      )

      // ---- the page, or the card that explains why there is none ----
      let card = null
      if (phase === 'idle') {
        card = h(
          'div',
          { className: 'dsb-card', 'data-dsb-card': 'idle' },
          h('div', { className: 'dsb-cardTitle' }, 'Type an address to load a page here'),
          h('p', { className: 'dsb-cardText' }, 'The page is drawn by the browser you are already in, so nothing is installed and your own dev servers and logins work.'),
          h('p', { className: 'dsb-cardText' }, 'A site that refuses to be embedded is reported before anything loads, with a way to open it in a real tab.'),
        )
      } else if (phase === 'blocked') {
        card = h(
          'div',
          { className: 'dsb-card', 'data-dsb-card': 'blocked' },
          h('div', { className: 'dsb-cardTitle' }, (host === '' ? 'This address' : host) + ' refuses to be embedded'),
          nav.blockedBy ? h('p', { className: 'dsb-detail' }, nav.blockedBy.value) : null,
          h('p', { className: 'dsb-cardText' }, 'The site allows only its own pages in a frame, so no browser can show it here.'),
          h(
            'div',
            { className: 'dsb-cardRow' },
            h('button', { type: 'button', className: 'dsb-btn', 'data-dsb-open-external': true, onClick: openExternal }, 'Open in a new tab'),
            h('button', { type: 'button', className: 'dsb-btn', 'data-dsb-anyway': true, title: 'Load it anyway and let the browser show its own refusal page', onClick: () => load(nav.address, { bypassProbe: true }) }, 'Try anyway'),
          ),
        )
      } else if (phase === 'error') {
        card = h(
          'div',
          { className: 'dsb-card', 'data-dsb-card': 'error' },
          h('div', { className: 'dsb-cardTitle dsb-cardErr' }, 'That address cannot open here'),
          h('p', { className: 'dsb-cardText' }, nav.note),
        )
      }

      // The frame host stays mounted while a card is shown: the surface owns real
      // DOM, and hiding it (never unmounting it) is what keeps a loaded page alive
      // behind a refusal card the user is deciding about.
      const body = h(
        'div',
        { className: 'dsb-body' },
        h('div', { className: 'dsb-frameHost', ref: hostRef, style: { display: showCard ? 'none' : 'flex' } }),
        card,
      )

      const statusText =
        nav.title !== ''
          ? nav.title
          : phase === 'idle'
            ? 'Nothing loaded'
            : phase === 'probing'
              ? 'Checking the address\u2026'
              : phase === 'loading' || phase === 'slow'
                ? 'Loading\u2026'
                : phase === 'live'
                  ? 'Loaded'
                  : nav.note !== ''
                    ? nav.note
                    : 'Nothing loaded'

      return h(
        'div',
        {
          className: 'dsb-root',
          onKeyDown: onRootKeyDown,
          'data-dsb-tab': info && info.tab && typeof info.tab.id === 'string' ? info.tab.id : '',
          'data-dsb-address': PAGE_ADDRESS,
          'data-dsb-surface': SURFACE,
          'data-dsb-phase': phase,
        },
        tools,
        nav.note !== '' && phase !== 'error' ? h('div', { className: 'dsb-note', 'data-dsb-note': true }, nav.note) : null,
        body,
        h(
          'div',
          { className: 'dsb-status' },
          h('span', { className: 'dsb-statusTitle', title: nav.address, 'data-dsb-status': phase }, statusText),
          nav.status > 0 ? h('span', { className: 'dsb-code' }, String(nav.status)) : null,
          h('span', { className: 'dsb-ver' }, 'dsh-browser ' + PLUGIN_VERSION + ' \u00b7 ' + SURFACE),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // The chip title
    // ---------------------------------------------------------------------
    /** The tab strip's label for this kind (the guide entry names the same word). */
    function BrowserTitle() {
      return h('span', { className: 'dsb-chip' }, LABEL)
    }

    // ---------------------------------------------------------------------
    // Registry definition
    // ---------------------------------------------------------------------
    function browserDefinition() {
      return {
        id: TYPE_ID,
        kind: KIND,
        // A PAGE type: no `patterns`, so it never claims a resource address - this
        // tab carries an address bar of its own instead of an address from the
        // resource grammar.
        priority: 'builtin',
        title: () => LABEL,
        guide: [
          {
            order: 40,
            title: () => LABEL,
            description: () => 'Load a page beside the conversation',
            icon: BrowserGlyph,
          },
        ],
      }
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------
    /** Services the activation waits for: the slot registry and the bar's tab registry. */
    const inject = ['slots', 'sidebarRightTabs']

    function apply(ctx) {
      try {
        ctx.effect(() => ctx.sidebarRightTabs.register(browserDefinition()), 'dsh-browser: browser tab type')
        ctx.effect(
          () =>
            ctx.slots.inject(TAB_SLOT, () =>
              ctx.slots.register(
                {
                  name: TAB_SLOT,
                  key: TYPE_ID,
                },
                BrowserView,
              ),
            ),
          'dsh-browser: browser tab body',
        )
        ctx.effect(
          () =>
            ctx.slots.inject(TITLE_SLOT, () =>
              ctx.slots.register(
                {
                  name: TITLE_SLOT,
                  key: TYPE_ID,
                },
                BrowserTitle,
              ),
            ),
          'dsh-browser: browser tab title',
        )
        ctx.logger?.debug?.('[dsh-browser] browser tab type registered (' + PLUGIN_VERSION + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-browser] activation failed', err)
        ctx.logger?.warn?.('[dsh-browser] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.name = 'dsh-browser'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
