/**
 * dsh-image — browser half.
 *
 * An image TAB TYPE for the pack's right bar (dsh-rightbar): PNG, JPEG, GIF,
 * WebP, AVIF, BMP, ICO, SVG and TIFF open in a viewer that actually behaves
 * like one, instead of the shipped preview's bare image at its intrinsic size.
 *
 * The type registers at the `extension` band with the image patterns, which is
 * what wins the address: the shipped document preview claims
 * `dsh-resource://file/**` at the `fallback` band, and an `extension`-band type
 * outranks a `fallback` one, so an image opens here while every other file type
 * keeps exactly the surface it had. The editor is unaffected: it vetoes image
 * extensions outright. Nothing is disabled and no core row is touched.
 *
 * What the viewer adds, and why each part is here:
 *
 *   - FIT on open, so a 4000px screenshot is visible whole in a 400px pane,
 *     with `Fit` and `100%` one click away and a zoom ladder from 5% to 800%;
 *   - ZOOM THAT MOVES THE LAYOUT, never a CSS transform: the picture lives in
 *     a box of `naturalPixels * zoom` inside a scrollable pane, so a zoomed
 *     picture stays scrollable to its edge and the wheel keeps working;
 *   - DRAG TO PAN with the grab cursor measured from real overflow, plus
 *     Ctrl/Cmd+wheel zoom ANCHORED AT THE POINTER (a trackpad pinch is the
 *     same gesture) and double-click to toggle fit / 100%;
 *   - a CHECKERBOARD behind the picture, so a PNG's transparency reads as
 *     transparency rather than as whatever the pane's background happens to be;
 *   - pixelated rendering past 300%, which is what makes pixel-peeping honest;
 *   - a status line that names the picture's true dimensions, its size on
 *     disk, its format, and the source pixel under the pointer with its colour.
 *
 * Bytes come from the harness's own `workspaceFiles` remote
 * (`ctx.remote.workspaceFiles.readAll`), the same call the shipped preview
 * makes for a "bytes-complete" document. That call already enforces the
 * workspace path policy and the single-file byte cap on the HOST side, so this
 * package needs no route of its own, no policy of its own to get wrong, and a
 * Node half that does nothing but ship the browser bundle.
 *
 * Module-table format of every client bundle here; no build step.
 */
/* global window, document, URL, Blob, atob */
window.__ModuleLoader__.load({
  id: 'dsh-image',
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
    const TYPE_ID = 'dsh-image'
    /** The tab kind this package owns. */
    const KIND = 'image'
    /** Version marker shown in the toolbar, so a loaded bundle is easy to verify. */
    const PLUGIN_VERSION = '0.1.0-alpha.1'
    /** Address grammar owned by @deepseek-ai/dsh-util-workspace-path. */
    const FILE_PREFIX = 'dsh-resource://file/'
    const SESSION_SEGMENT = 'session/'
    /** The keyed seats every tab type occupies in the right bar. */
    const TAB_SLOT = 'sidebar.right.pane.tab'
    const TITLE_SLOT = 'sidebar.right.pane.tab.title'
    /** The Remote namespace this package reads bytes through. */
    const REMOTE_NAMESPACE = 'remote.workspaceFiles'
    /** The one-pixel canvas the pointer readout samples through. */
    const PIXEL_SAMPLE_PX = 1

    /**
     * The zoom ladder. The bottom is 5% (a 20000px panorama still fits a pane)
     * and the top is 800% (a 16px icon becomes a legible 128px square); the
     * ladder is what the + / - buttons walk, and a wheel zoom multiplies
     * instead of stepping so a pinch feels continuous.
     */
    const ZOOM_STEPS = [0.05, 0.1, 0.17, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8]
    const MIN_ZOOM = ZOOM_STEPS[0]
    const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]
    /** Free space Fit leaves around the picture, in CSS pixels. */
    const FIT_PADDING = 24
    /** Past this zoom a raster image is drawn with nearest-neighbour sampling. */
    const PIXELATED_AT = 3
    /** The wheel's zoom factor per notch. */
    const WHEEL_FACTOR = 1.25

    /**
     * File suffix to the media type the Blob is built with. This list is also
     * what the type CLAIMS, and it is deliberately wider than the shipped
     * preview's: `avif` is decodable in this browser generation, and `tif` /
     * `tiff` are claimed so that a browser which cannot decode them says so in
     * one clear sentence instead of falling into a generic binary message.
     */
    const MEDIA_TYPES = {
      png: 'image/png',
      apng: 'image/apng',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      jpe: 'image/jpeg',
      jfif: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      avif: 'image/avif',
      bmp: 'image/bmp',
      ico: 'image/x-icon',
      svg: 'image/svg+xml',
      tif: 'image/tiff',
      tiff: 'image/tiff',
    }
    /** The name the toolbar's format chip shows. */
    const FORMAT_NAMES = {
      png: 'PNG',
      apng: 'APNG',
      jpg: 'JPEG',
      jpeg: 'JPEG',
      jpe: 'JPEG',
      jfif: 'JPEG',
      gif: 'GIF',
      webp: 'WebP',
      avif: 'AVIF',
      bmp: 'BMP',
      ico: 'ICO',
      svg: 'SVG',
      tif: 'TIFF',
      tiff: 'TIFF',
    }
    /** SVG is a vector: never pixelated, and its size may be a bare viewBox. */
    const VECTOR_EXTENSIONS = new Set(['svg'])

    // ---------------------------------------------------------------------
    // Styles (the pack's tab dress, under this package's own prefix)
    // ---------------------------------------------------------------------
    const css = `
.dsi-root{height:100%;min-height:0;flex:auto;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1f1f1f);font-size:13px;line-height:1.5}
/* The toolbar IS this tab's top bar, and every column's top band ends in the
   same hairline at y=76: the docking strip above a pane is 38px and the
   conversation header is min-height:76px, which is why the Files tab, the
   editor, History, Diagrams and the PDF reader all use a 38px border-box
   header. */
.dsi-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;padding:0 10px 0 12px;min-width:0;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}
.dsi-btn{flex:none;display:inline-flex;align-items:center;justify-content:center;height:24px;min-width:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:12px;padding:0 8px;cursor:pointer;white-space:nowrap}
.dsi-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsi-btn:disabled{opacity:.45;cursor:default}
.dsi-btn[data-active="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}
.dsi-zoom{flex:none;min-width:50px;height:24px;display:inline-flex;align-items:center;justify-content:center;font-size:11.5px;color:var(--dsw-alias-label-secondary,#666);font-variant-numeric:tabular-nums}
.dsi-spacer{flex:1;min-width:0}
.dsi-meta{flex:0 1 auto;display:flex;align-items:center;gap:8px;min-width:0;font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
.dsi-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary,#666);font-family:ui-monospace,'Cascadia Code',Consolas,monospace}
.dsi-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsi-chip{flex:none;display:inline-flex;align-items:center;padding:0 6px;height:18px;border-radius:5px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsi-pixel{flex:none;display:inline-flex;align-items:center;gap:5px;min-width:0}
.dsi-swatch{flex:none;width:12px;height:12px;border-radius:3px;box-shadow:inset 0 0 0 .5px rgba(0,0,0,.35)}
.dsi-ver{flex:none;white-space:nowrap;opacity:.75}
/* The pane: the scroll viewport and the pan surface. Nothing here is ever
   transformed - the box below carries the zoom as a real layout size. */
.dsi-canvas{flex:1;min-height:0;overflow:auto;position:relative;display:flex;align-items:flex-start;justify-content:flex-start;box-sizing:border-box;padding:16px;background:var(--dsw-alias-bg-l1,rgba(127,127,127,.07));overscroll-behavior:contain}
.dsi-canvas[data-pannable="true"]{cursor:grab}
.dsi-canvas[data-panning="true"]{cursor:grabbing;user-select:none}
.dsi-canvas:focus{outline:none}
.dsi-canvas:focus-visible{box-shadow:inset 0 0 0 2px var(--dsw-alias-state-accent,#4f8cff)}
/* The picture's box, at the picture's real size times the zoom. The auto margin
   is the centring that survives overflow: a flex item centred with
   justify-content cannot be scrolled back to its own top-left corner.
   The checkerboard belongs to the BOX, so it moves and scales with the picture
   rather than sitting still under a moving pane. */
.dsi-box{flex:none;margin:auto;position:relative;box-sizing:border-box;background-color:var(--dsw-alias-bg-layer-1,#fff);background-image:linear-gradient(45deg,rgba(127,127,127,.22) 25%,transparent 25%,transparent 75%,rgba(127,127,127,.22) 75%),linear-gradient(45deg,rgba(127,127,127,.22) 25%,transparent 25%,transparent 75%,rgba(127,127,127,.22) 75%);background-size:16px 16px;background-position:0 0,8px 8px;box-shadow:0 0 0 .5px rgba(0,0,0,.18),0 1px 3px rgba(0,0,0,.14)}
.dsi-img{display:block;width:100%;height:100%}
/* Before the browser has decoded the picture there is no size to fit, so the
   image would paint at its intrinsic size for a frame and then jump to the fit
   zoom. Hidden-until-measured is what keeps the open clean; the state it hides
   in is the one where the picture is not on screen yet anyway. */
.dsi-img[data-free="true"]{width:auto;height:auto;max-width:none;visibility:hidden}
.dsi-box[data-pixelated="true"] .dsi-img{image-rendering:pixelated;image-rendering:crisp-edges}
/* The zoom ladder floats over the picture: it belongs to the picture, while the
   top bar carries the file's own facts. */
.dsi-zoomBar{position:absolute;right:12px;bottom:12px;z-index:6;display:flex;align-items:center;gap:2px;padding:3px;border-radius:10px;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.22));background:var(--dsw-alias-surface-l1,#fff);box-shadow:0 4px 14px rgba(0,0,0,.14)}
.dsi-zoomLabel{min-width:50px;text-align:center;font-size:11.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary,#666)}
.dsi-state{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;color:var(--dsw-alias-label-tertiary,#999);font-size:12.5px;line-height:18px;text-align:center}
.dsi-stateTitle{font-size:13px;color:var(--dsw-alias-label-secondary,#666);font-weight:500}
.dsi-stateErr{color:var(--dsw-alias-state-error-primary,#d3382c);max-width:560px;word-break:break-word}
.dsi-stateNote{max-width:560px;font-size:11.5px;opacity:.85;word-break:break-word}
.dsi-row{display:flex;align-items:center;gap:6px}
`
    const CSS_TAG = 'dsh-image/image.css'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-image'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------------
    // The Remote face, captured at activation
    //
    // `inject` waits for `remote.workspaceFiles`, so this is the generated
    // Remote's own namespace: `readAll(scopeId, path, signal)` resolves to
    // `{ ok: true, value }` or `{ ok: false, error }`, and rejects only for an
    // assembly fault.
    // ---------------------------------------------------------------------
    let workspaceFiles = null

    // ---------------------------------------------------------------------
    // Addresses
    // ---------------------------------------------------------------------
    /** Component-decode one path segment of the file grammar, tolerating a bad one. */
    function decodeSegment(segment) {
      try {
        return decodeURIComponent(segment)
      } catch (err) {
        return segment
      }
    }

    /**
     * Read the one address shape this type claims.
     *
     * @param address - a tab's content id.
     * @returns `{ sessionId, path }`, or null when the address is not a
     *   session-scoped file address.
     */
    function parseImageAddress(address) {
      const value = typeof address === 'string' ? address : ''
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
      return { sessionId: decodeSegment(tail.slice(0, cut)), path: path }
    }

    /** The lower-cased extension of a path (`''` for none and for dotfiles). */
    function extensionOf(path) {
      const normalized = String(path).replace(/\\/g, '/')
      const name = normalized.slice(normalized.lastIndexOf('/') + 1)
      const dot = name.lastIndexOf('.')
      return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
    }

    /** The media type an address's suffix maps to, or `''` for an unclaimed one. */
    function mediaTypeFor(path) {
      const extension = extensionOf(path)
      return MEDIA_TYPES[extension] === undefined ? '' : MEDIA_TYPES[extension]
    }

    /** Whether an address names an image this type claims. */
    function isImageAddress(address) {
      const parsed = parseImageAddress(address)
      return parsed !== null && mediaTypeFor(parsed.path) !== ''
    }

    /** The decoded last path segment of an address, for the chip title. */
    function baseNameOf(address) {
      const parsed = parseImageAddress(address)
      if (!parsed) return 'Image'
      const name = parsed.path.replace(/\\/g, '/').split('/').pop()
      return name === '' || name === undefined ? 'Image' : name
    }

    // ---------------------------------------------------------------------
    // Small helpers
    // ---------------------------------------------------------------------
    /** Clamp a zoom to the ladder's own ends and round away float drift. */
    function clampScale(value) {
      const number = Number(value)
      if (!Number.isFinite(number) || number <= 0) return 1
      return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(number.toFixed(4))))
    }

    /** A byte count a person reads at a glance. */
    function humanBytes(value) {
      const bytes = Number(value)
      if (!Number.isFinite(bytes) || bytes <= 0) return ''
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(bytes < 10240 ? 1 : 0) + ' KiB'
      return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1) + ' MiB'
    }

    /** `#rrggbb` for one sampled pixel. */
    function pixelHex(pixel) {
      const part = (value) => ('0' + Math.max(0, Math.min(255, value)).toString(16)).slice(-2)
      return '#' + part(pixel.r) + part(pixel.g) + part(pixel.b)
    }

    /**
     * Decode one base64 payload to native bytes.
     *
     * A plain indexed loop rather than `Uint8Array.from(atob(x), fn)`: calling
     * a mapper once per byte, for up to 32 million bytes, is the difference
     * between an instant open and a visible stall on a large photograph.
     *
     * @param base64 - the Host's `data` field.
     * @returns the bytes.
     */
    function decodeBase64(base64) {
      const binary = atob(String(base64))
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
      return bytes
    }

    /** The sentence a failed read gets, from the Remote's own failure code. */
    function readFailureText(error) {
      const code = error && typeof error.code === 'string' ? error.code : ''
      if (code === 'workspace-file/too-large') {
        return 'This image is larger than the harness lets one file read be (32 MiB by default), so it cannot be handed to the viewer.'
      }
      if (code === 'workspace-file/not-file') return 'This path is not a regular file.'
      if (code === 'workspace-file/undecodable') return 'These bytes are not decodable text, and they are not readable as an image either.'
      if (code === 'workspace-file/unknown-workspace') return 'This tab names a conversation that is not open in this harness.'
      if (code === 'workspace-file/unsupported-address') return 'This tab does not name a readable workspace file.'
      if (error && typeof error.message === 'string' && error.message !== '') return error.message
      return 'The file could not be read.'
    }

    /** What went wrong, as one sentence, whatever the thrown value is. */
    function thrownText(error) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    // ---------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------
    /** One 16px stroked glyph. */
    function Glyph(props) {
      const size = props.size === undefined ? 14 : props.size
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
        },
        ...props.paths.map((path) => h('path', { key: path, d: path })),
      )
    }

    const ICONS = {
      zoomIn: ['M7 2.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8Z', 'M10.3 10.3 14 14', 'M5 7h4', 'M7 5v4'],
      zoomOut: ['M7 2.6a4.4 4.4 0 1 0 0 8.8 4.4 4.4 0 0 0 0-8.8Z', 'M10.3 10.3 14 14', 'M5 7h4'],
      fit: ['M2.6 6V2.6H6', 'M10 2.6h3.4V6', 'M13.4 10v3.4H10', 'M6 13.4H2.6V10'],
      reload: ['M13.3 8a5.3 5.3 0 1 1-1.6-3.8', 'M13.3 2.4v3h-3'],
    }

    // ---------------------------------------------------------------------
    // States
    // ---------------------------------------------------------------------
    /** One centred state: loading, a failure, or a refused address. */
    function StateBox(props) {
      return h(
        'div',
        { className: 'dsi-state', 'data-image-state': props.state },
        h('div', { className: 'dsi-stateTitle' }, props.title),
        props.error ? h('div', { className: 'dsi-stateErr' }, props.error) : null,
        props.note ? h('div', { className: 'dsi-stateNote' }, props.note) : null,
        props.children ? h('div', { className: 'dsi-row' }, props.children) : null,
      )
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

    // ---------------------------------------------------------------------
    // Reading the bytes
    // ---------------------------------------------------------------------
    /**
     * Read one image's bytes and turn them into a Blob URL.
     *
     * The URL is revoked when the effect re-runs (a reload) or the tab closes,
     * so a reader flipping through a folder of photographs does not keep every
     * one of them pinned in memory. A reload is a new generation: the aborted
     * effect's settlement is dropped rather than racing the new one.
     *
     * @param address - the tab's content id.
     * @param fallbackSession - `props.sessionId`, used only if the address
     *   somehow carries no session.
     * @param reload - a counter; changing it re-reads.
     * @returns `{ phase, url, bytes, error }`.
     */
    function useImageSource(address, fallbackSession, reload) {
      const [state, setState] = useState({ phase: 'loading', url: '', bytes: 0, error: '' })
      useEffect(() => {
        const parsed = parseImageAddress(address)
        if (!parsed) {
          setState({ phase: 'failed', url: '', bytes: 0, error: 'This tab does not name a workspace file.' })
          return undefined
        }
        const mediaType = mediaTypeFor(parsed.path)
        if (mediaType === '') {
          setState({ phase: 'failed', url: '', bytes: 0, error: 'This image format is not one the viewer claims.' })
          return undefined
        }
        if (workspaceFiles === null || typeof workspaceFiles.readAll !== 'function') {
          setState({ phase: 'failed', url: '', bytes: 0, error: 'This harness exposes no workspaceFiles remote, so the file cannot be read.' })
          return undefined
        }
        const sessionId = parsed.sessionId === '' ? fallbackSession : parsed.sessionId
        const controller = new AbortController()
        let objectUrl = ''
        setState({ phase: 'loading', url: '', bytes: 0, error: '' })
        const settle = (next) => {
          if (!controller.signal.aborted) setState(next)
        }
        workspaceFiles
          .readAll(sessionId, parsed.path, controller.signal)
          .then((result) => {
            if (controller.signal.aborted) return
            if (!result || result.ok !== true) {
              settle({ phase: 'failed', url: '', bytes: 0, error: readFailureText(result ? result.error : null) })
              return
            }
            const value = result.value
            try {
              const bytes = decodeBase64(value.data)
              objectUrl = URL.createObjectURL(new Blob([bytes], { type: mediaType }))
              settle({ phase: 'ready', url: objectUrl, bytes: bytes.length, error: '' })
            } catch (err) {
              settle({ phase: 'failed', url: '', bytes: 0, error: 'The file bytes could not be turned into an image: ' + thrownText(err) })
            }
          })
          .catch((err) => {
            settle({ phase: 'failed', url: '', bytes: 0, error: thrownText(err) })
          })
        return () => {
          controller.abort()
          if (objectUrl !== '') URL.revokeObjectURL(objectUrl)
        }
      }, [address, fallbackSession, reload])
      return state
    }

    // ---------------------------------------------------------------------
    // The viewer
    // ---------------------------------------------------------------------
    /**
     * The picture, its zoom, its pan and its pointer readout.
     *
     * The whole component is built on one rule: the zoom is a real layout size
     * (`natural * scale`) on a box inside a scrollable pane, so panning is the
     * pane's own `scrollLeft`/`scrollTop` and everything the browser already
     * does - wheel scrolling, scrollbars, keyboard scrolling, overscroll -
     * keeps working untouched. A CSS transform would draw into a clipped box
     * with no scrollable area, which is the bug this shape exists to avoid.
     */
    function ImageViewer(props) {
      const { url, name, bytes, path, onReload } = props
      const canvasRef = useRef(null)
      const boxRef = useRef(null)
      const imgRef = useRef(null)
      const panState = useRef(null)
      const wheelHandler = useRef(null)
      const sampler = useRef(null)
      /**
       * The zoom the LAYOUT is actually at, written synchronously by every
       * move. A trackpad pinch arrives as a stream of wheel events that can all
       * land before React re-renders, so a handler reading the `scale` state
       * would compute every step from the same base and the gesture would
       * under-zoom badly. The wheel and ladder handlers read this instead.
       */
      const scaleRef = useRef(1)
      /** The natural size, once the browser has decoded the picture. */
      const [natural, setNatural] = useState(null)
      /** The zoom in force; while `fit` is true it is derived, not chosen. */
      const [scale, setScale] = useState(1)
      /** Whether the zoom follows the pane (Fit) or was chosen by the reader. */
      const [fit, setFit] = useState(true)
      const [panning, setPanning] = useState(false)
      const [pannable, setPannable] = useState(false)
      const [decodeError, setDecodeError] = useState('')
      const [pixel, setPixel] = useState(null)
      const extension = extensionOf(path)
      const isVector = VECTOR_EXTENSIONS.has(extension)
      const format = FORMAT_NAMES[extension] === undefined ? extension.toUpperCase() : FORMAT_NAMES[extension]

      /** The zoom at which the whole picture fits the pane's visible box. */
      const fitScale = useCallback(() => {
        const canvas = canvasRef.current
        if (!canvas || !natural) return 1
        const availableWidth = Math.max(40, canvas.clientWidth - FIT_PADDING * 2)
        const availableHeight = Math.max(40, canvas.clientHeight - FIT_PADDING * 2)
        // Fit shrinks but never enlarges: blowing a 16px icon up to fill the
        // pane is not what a reader means by "fit".
        return clampScale(Math.min(availableWidth / natural.w, availableHeight / natural.h, 1))
      }, [natural])

      /**
       * Move the layout to one zoom, keeping the point under `anchor` - or the
       * pane's centre - exactly where it is.
       *
       * The point is remembered as a FRACTION of the scrollable area before
       * the layout changes, and restored on the next animation frame: by then
       * React has committed the new box and the browser has laid it out, but
       * the frame has not been painted, so the picture never visibly jumps.
       * (Not a `useLayoutEffect`: that warns under the server renderer the
       * tracked check is.)
       */
      const moveTo = useCallback((next, anchor) => {
        const canvas = canvasRef.current
        const clamped = clampScale(next)
        let mark = null
        if (canvas) {
          const rect = canvas.getBoundingClientRect()
          const px = anchor && typeof anchor.x === 'number' ? anchor.x - rect.left : canvas.clientWidth / 2
          const py = anchor && typeof anchor.y === 'number' ? anchor.y - rect.top : canvas.clientHeight / 2
          mark = {
            px: px,
            py: py,
            fx: (canvas.scrollLeft + px) / Math.max(1, canvas.scrollWidth),
            fy: (canvas.scrollTop + py) / Math.max(1, canvas.scrollHeight),
          }
        }
        setFit(false)
        scaleRef.current = clamped
        setScale(clamped)
        if (!mark) return
        const restore = () => {
          const element = canvasRef.current
          if (!element) return
          element.scrollLeft = mark.fx * element.scrollWidth - mark.px
          element.scrollTop = mark.fy * element.scrollHeight - mark.py
        }
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(restore)
        else restore()
      }, [])

      /** Take the fit zoom now, wherever the pane currently is. */
      const applyFit = useCallback(
        (anchor) => {
          moveTo(fitScale(), anchor)
          setFit(true)
        },
        [fitScale, moveTo],
      )

      // The first layout fits, and a new picture in the same tab fits again.
      useEffect(() => {
        if (natural) {
          const next = fitScale()
          scaleRef.current = next
          setScale(next)
          setFit(true)
        }
      }, [natural, fitScale, url])

      /** Whether there is anything to pan: measured, never assumed. */
      const measure = useCallback(() => {
        const canvas = canvasRef.current
        if (!canvas) return
        setPannable(canvas.scrollWidth > canvas.clientWidth + 1 || canvas.scrollHeight > canvas.clientHeight + 1)
      }, [])
      useEffect(() => {
        measure()
      }, [measure, scale, natural, url])

      // A pane that changes size while Fit is on re-fits; it measures either way.
      useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(() => {
          measure()
          if (fit) {
            const next = fitScale()
            scaleRef.current = next
            setScale(next)
          }
        })
        observer.observe(canvas)
        return () => observer.disconnect()
      }, [fit, fitScale, measure])

      /** One rung on the ladder; the ends clamp rather than wrap around. */
      const stepZoom = useCallback(
        (direction, anchor) => {
          const current = scaleRef.current
          if (direction > 0) {
            const next = ZOOM_STEPS.find((step) => step > current + 1e-6)
            moveTo(next === undefined ? current * 2 : next, anchor)
          } else {
            const below = ZOOM_STEPS.filter((step) => step < current - 1e-6)
            moveTo(below.length > 0 ? below[below.length - 1] : current / 2, anchor)
          }
        },
        [moveTo],
      )

      /** Between Fit and 100% on a double-click. */
      const toggleFit = useCallback(
        (anchor) => {
          if (fit) moveTo(1, anchor)
          else applyFit(anchor)
        },
        [applyFit, fit, moveTo],
      )

      /** Keyboard control, so the viewer behaves like a picture, not a div. */
      const onKeyDown = useCallback(
        (event) => {
          const target = event.target
          if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
          const canvas = canvasRef.current
          if (event.key === '+' || event.key === '=') {
            event.preventDefault()
            stepZoom(1, null)
          } else if (event.key === '-' || event.key === '_') {
            event.preventDefault()
            stepZoom(-1, null)
          } else if (event.key === '0') {
            event.preventDefault()
            applyFit(null)
          } else if (event.key === '1') {
            event.preventDefault()
            moveTo(1, null)
          } else if (event.key === 'ArrowLeft' && canvas) {
            event.preventDefault()
            canvas.scrollLeft -= 40
          } else if (event.key === 'ArrowRight' && canvas) {
            event.preventDefault()
            canvas.scrollLeft += 40
          } else if (event.key === 'ArrowUp' && canvas) {
            event.preventDefault()
            canvas.scrollTop -= 40
          } else if (event.key === 'ArrowDown' && canvas) {
            event.preventDefault()
            canvas.scrollTop += 40
          }
        },
        [applyFit, moveTo, stepZoom],
      )

      /** Read the SOURCE pixel under one client point, for the toolbar readout. */
      const samplePixel = useCallback(
        (clientX, clientY) => {
          const canvas = canvasRef.current
          const box = boxRef.current
          const image = imgRef.current
          if (!canvas || !box || !image || !natural) return
          const rect = canvas.getBoundingClientRect()
          const boxX = canvas.scrollLeft + (clientX - rect.left) - box.offsetLeft
          const boxY = canvas.scrollTop + (clientY - rect.top) - box.offsetTop
          if (boxX < 0 || boxY < 0 || boxX >= box.offsetWidth || boxY >= box.offsetHeight) {
            setPixel(null)
            return
          }
          const x = Math.min(natural.w - 1, Math.max(0, Math.floor(boxX / scale)))
          const y = Math.min(natural.h - 1, Math.max(0, Math.floor(boxY / scale)))
          try {
            // The sample is drawn into a ONE-PIXEL canvas (`drawImage` of a 1x1
            // source rectangle), so inspecting an 8000px photograph costs a
            // canvas the size of a pixel rather than a copy of the picture. A
            // source that cannot be read back simply turns the readout off.
            if (sampler.current === null) {
              const scratch = document.createElement('canvas')
              scratch.width = PIXEL_SAMPLE_PX
              scratch.height = PIXEL_SAMPLE_PX
              sampler.current = scratch.getContext('2d', { willReadFrequently: true })
            }
            const context = sampler.current
            if (!context) {
              setPixel(null)
              return
            }
            context.clearRect(0, 0, 1, 1)
            context.drawImage(image, x, y, 1, 1, 0, 0, 1, 1)
            const data = context.getImageData(0, 0, 1, 1).data
            setPixel({ x: x, y: y, r: data[0], g: data[1], b: data[2], a: data[3] })
          } catch (err) {
            sampler.current = undefined
            setPixel(null)
          }
        },
        [natural, scale],
      )

      const onPointerDown = useCallback((event) => {
        if (event.pointerType !== 'mouse' || event.button !== 0) return
        const canvas = canvasRef.current
        if (!canvas) return
        const target = event.target
        if (target && typeof target.closest === 'function' && target.closest('button, a, input, textarea, select')) return
        panState.current = { x: event.clientX, y: event.clientY, left: canvas.scrollLeft, top: canvas.scrollTop }
        setPanning(true)
        try {
          canvas.setPointerCapture(event.pointerId)
        } catch (err) {
          /* an old browser: the move events still arrive while the pointer is over it */
        }
      }, [])

      const onPointerMove = useCallback(
        (event) => {
          const origin = panState.current
          const canvas = canvasRef.current
          if (origin && canvas) {
            canvas.scrollLeft = origin.left - (event.clientX - origin.x)
            canvas.scrollTop = origin.top - (event.clientY - origin.y)
          }
          samplePixel(event.clientX, event.clientY)
        },
        [samplePixel],
      )

      const endPan = useCallback(() => {
        panState.current = null
        setPanning(false)
      }, [])

      const onPointerLeave = useCallback(() => {
        endPan()
        setPixel(null)
      }, [endPan])

      /**
       * Ctrl/Cmd + wheel zooms at the pointer; a bare wheel is the browser's
       * own scroll and is left alone. The listener is attached NATIVELY with
       * `{ passive: false }`, because React's own wheel listener is passive
       * and a `preventDefault()` inside it does nothing - the browser's own
       * Ctrl+wheel page zoom would then fire on top of ours.
       */
      const onWheel = useCallback(
        (event) => {
          if (!event.ctrlKey && !event.metaKey) return
          if (event.deltaY === 0) return
          event.preventDefault()
          const factor = event.deltaY < 0 ? WHEEL_FACTOR : 1 / WHEEL_FACTOR
          // The ref, not the state: a pinch's events all land before the next
          // render, and every one of them must compound on the last.
          moveTo(scaleRef.current * factor, { x: event.clientX, y: event.clientY })
        },
        [moveTo],
      )
      wheelHandler.current = onWheel
      useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas) return undefined
        const listener = (event) => {
          const handle = wheelHandler.current
          if (typeof handle === 'function') handle(event)
        }
        canvas.addEventListener('wheel', listener, { passive: false })
        return () => canvas.removeEventListener('wheel', listener)
      }, [])

      /** Decoded: the browser now knows the picture's real size. */
      const onImageLoad = useCallback(
        (event) => {
          const image = event.target
          // A vector's natural box can be zero (a bare viewBox); its laid-out
          // size is then the honest answer, and 300x150 is the HTML default
          // the browser would use for a box-less image anyway.
          const width = image.naturalWidth || image.width || (isVector ? image.clientWidth : 0) || 300
          const height = image.naturalHeight || image.height || (isVector ? image.clientHeight : 0) || 150
          setDecodeError('')
          setNatural({ w: width, h: height })
        },
        [isVector],
      )

      const onImageError = useCallback(() => {
        setNatural(null)
        setDecodeError(
          'This browser could not decode ' +
            (format === '' ? 'this file' : 'a ' + format + ' file') +
            ' as an image. The bytes are here and intact - it is the codec that is missing.',
        )
      }, [format])

      if (decodeError !== '') {
        return h(
          StateBox,
          {
            state: 'decode-error',
            title: name + ' could not be shown',
            error: decodeError,
            note: humanBytes(bytes) === '' ? undefined : humanBytes(bytes) + ' on disk.',
          },
          h('button', { type: 'button', className: 'dsi-btn', 'data-image-action': 'reload', onClick: onReload }, 'Read it again'),
        )
      }

      const width = natural ? Math.max(1, Math.round(natural.w * scale)) : 0
      const height = natural ? Math.max(1, Math.round(natural.h * scale)) : 0
      const pixelated = natural !== null && !isVector && scale >= PIXELATED_AT
      const percent = Math.round(scale * 1000) / 10
      const atMin = scale <= MIN_ZOOM + 1e-6
      const atMax = scale >= MAX_ZOOM - 1e-6

      return h(
        'div',
        { className: 'dsi-root', 'data-image-viewer': name },
        h(
          'div',
          { className: 'dsi-tools' },
          h(
            'button',
            {
              type: 'button',
              className: 'dsi-btn',
              'data-image-action': 'zoom-out',
              title: 'Zoom out (-)',
              disabled: atMin,
              onClick: () => stepZoom(-1, null),
            },
            h(Glyph, { paths: ICONS.zoomOut }),
          ),
          h('span', { className: 'dsi-zoom', 'data-image-zoom': String(Math.round(scale * 100)) }, percent + '%'),
          h(
            'button',
            {
              type: 'button',
              className: 'dsi-btn',
              'data-image-action': 'zoom-in',
              title: 'Zoom in (+)',
              disabled: atMax,
              onClick: () => stepZoom(1, null),
            },
            h(Glyph, { paths: ICONS.zoomIn }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsi-btn',
              'data-image-action': 'fit',
              'data-active': fit ? 'true' : 'false',
              title: 'Fit the whole picture in the pane (0)',
              onClick: () => applyFit(null),
            },
            h(Glyph, { paths: ICONS.fit }),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsi-btn',
              'data-image-action': 'actual',
              'data-active': !fit && scale === 1 ? 'true' : 'false',
              title: 'Actual pixels, 1:1 (1)',
              disabled: natural === null,
              onClick: () => moveTo(1, null),
            },
            '100%',
          ),
          h('span', { className: 'dsi-spacer' }),
          h(
            'span',
            { className: 'dsi-meta' },
            pixel
              ? h(
                  'span',
                  { className: 'dsi-pixel', 'data-image-pixel': pixel.x + ',' + pixel.y },
                  h('span', {
                    className: 'dsi-swatch',
                    style: {
                      background:
                        pixel.a === 0
                          ? 'repeating-conic-gradient(rgba(127,127,127,.6) 0 25%,transparent 0 50%) 0 0/8px 8px'
                          : 'rgba(' + pixel.r + ',' + pixel.g + ',' + pixel.b + ',' + (pixel.a / 255).toFixed(3) + ')',
                    },
                  }),
                  h(
                    'span',
                    null,
                    pixel.x +
                      ',' +
                      pixel.y +
                      ' \u00b7 ' +
                      pixelHex(pixel) +
                      (pixel.a < 255 ? ' \u00b7 ' + Math.round((pixel.a / 255) * 100) + '%' : ''),
                  ),
                )
              : null,
            natural ? h('span', { 'data-image-size': natural.w + 'x' + natural.h }, natural.w + ' \u00d7 ' + natural.h) : null,
            format === '' ? null : h('span', { className: 'dsi-chip' }, format),
            humanBytes(bytes) === '' ? null : h('span', null, humanBytes(bytes)),
            h('span', { className: 'dsi-name', title: path }, name),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsi-btn',
              'data-image-action': 'reload-file',
              title: 'Read the file again',
              onClick: onReload,
            },
            h(Glyph, { paths: ICONS.reload }),
          ),
          h('span', { className: 'dsi-ver' }, PLUGIN_VERSION),
        ),
        h(
          'div',
          {
            className: 'dsi-canvas',
            ref: canvasRef,
            tabIndex: 0,
            role: 'img',
            'aria-label': 'Image preview: ' + name,
            'data-pannable': pannable ? 'true' : 'false',
            'data-panning': panning ? 'true' : 'false',
            onKeyDown,
            onPointerDown,
            onPointerMove,
            onPointerUp: endPan,
            onPointerCancel: endPan,
            onPointerLeave,
            onLostPointerCapture: endPan,
            onDoubleClick: (event) => toggleFit({ x: event.clientX, y: event.clientY }),
          },
          h(
            'div',
            {
              className: 'dsi-box',
              ref: boxRef,
              'data-image-box': 'true',
              'data-pixelated': pixelated ? 'true' : undefined,
              style: natural ? { width: width + 'px', height: height + 'px' } : undefined,
            },
            h('img', {
              className: 'dsi-img',
              ref: imgRef,
              src: url,
              alt: 'Image preview: ' + name,
              draggable: false,
              decoding: 'async',
              referrerPolicy: 'no-referrer',
              'data-free': natural ? undefined : 'true',
              onLoad: onImageLoad,
              onError: onImageError,
            }),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // The tab body
    // ---------------------------------------------------------------------
    /** The `image` tab: one picture, from this plugin's bytes to the picture. */
    function ImageBody(props) {
      const info = tabInfoNow(props)
      const tab = info && info.tab ? info.tab : null
      const address = tab && typeof tab.contentId === 'string' ? tab.contentId : ''
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const [reload, setReload] = useState(0)
      const parsed = useMemo(() => parseImageAddress(address), [address])
      const source = useImageSource(address, sessionId, reload)
      const name = baseNameOf(address)
      const scopeLabel = parsed ? (parsed.sessionId === '' ? parsed.path : parsed.sessionId + '/' + parsed.path) : address
      const again = useCallback(() => setReload((count) => count + 1), [])

      if (source.phase === 'loading') {
        return h(StateBox, { state: 'loading', title: 'Opening the image\u2026', note: scopeLabel })
      }
      if (source.phase === 'failed') {
        return h(
          StateBox,
          { state: 'error', title: name + ' could not be opened', error: source.error, note: scopeLabel },
          h('button', { type: 'button', className: 'dsi-btn', 'data-image-action': 'retry', onClick: again }, 'Try again'),
        )
      }
      return h(ImageViewer, {
        key: source.url,
        url: source.url,
        name: name,
        bytes: source.bytes,
        path: parsed ? parsed.path : name,
        onReload: again,
      })
    }

    /** The chip title: the file's own name. */
    function ImageTitle(props) {
      const info = tabInfoNow(props)
      const tab = info && info.tab ? info.tab : null
      return h('span', { className: 'dsi-title' }, baseNameOf(tab ? tab.contentId : ''))
    }

    // ---------------------------------------------------------------------
    // The tab type
    // ---------------------------------------------------------------------
    /**
     * The `image` type: an `extension`-band type for the image suffixes, which
     * outranks the shipped preview's `fallback` type for the same address and
     * leaves every other file type untouched. `canOpen` is what keeps a
     * non-image address out of this tab even if a pattern ever matched one.
     *
     * There is deliberately no `guide` entry: a blank image is not a document
     * anyone opens from the "+" control, so this type only ever claims a real
     * file address.
     */
    function imageDefinition() {
      return {
        id: TYPE_ID,
        kind: KIND,
        patterns: Object.keys(MEDIA_TYPES).map((extension) => '*.' + extension),
        priority: 'extension',
        canOpen: (address) => isImageAddress(address),
        title: (address) => baseNameOf(address),
      }
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------
    /** Services activation waits for: the seats, the tab registry, and the bytes. */
    const inject = ['slots', 'sidebarRightTabs', REMOTE_NAMESPACE]

    /**
     * Activate the browser half.
     * @param ctx - cordis context (inject: slots, sidebarRightTabs,
     *   remote.workspaceFiles).
     */
    function apply(ctx) {
      try {
        workspaceFiles = ctx && ctx.remote ? ctx.remote.workspaceFiles : null
      } catch (err) {
        workspaceFiles = null
      }
      try {
        ctx.effect(() => ctx.sidebarRightTabs.register(imageDefinition()), 'dsh-image: image tab type')
        ctx.effect(
          () => ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({ name: TAB_SLOT, key: TYPE_ID, inject: () => ({}) }, ImageBody)),
          'dsh-image: image tab body',
        )
        ctx.effect(
          () => ctx.slots.inject(TITLE_SLOT, () => ctx.slots.register({ name: TITLE_SLOT, key: TYPE_ID }, ImageTitle)),
          'dsh-image: image tab title',
        )
        ctx.logger?.debug?.('[dsh-image] client half active (' + PLUGIN_VERSION + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-image] activation failed', err)
        ctx.logger?.warn?.('[dsh-image] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.name = 'dsh-image'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
