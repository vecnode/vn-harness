/**
 * dsh-editor - browser half.
 *
 * A tab TYPE for the GUI's native right Sidebar - the column the conversation
 * header's expand button opens (`@deepseek-ai/dsh-client-ui-sidebar-right`),
 * beside the shipped "Start" (guide) and "Files" tabs:
 *
 *   - the type registers through `ctx.sidebarRightTabs.register(...)` with the
 *     id `dsh-editor` and the kind `editor`; its body and its chip title
 *     register under that same id in the keyed seats
 *     `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title`, exactly like
 *     the tab types the product ships;
 *   - it declares `dsh-resource://file/**` in the `extension` band - the band
 *     reserved for types from outside the product, which outranks every viewer
 *     shipped with it - and vetoes in `canOpen` what a text editor has nothing
 *     to add to (HTML, images, PDF, office/archive/media files and the binary
 *     formats) plus every path outside the session workspace. Opening a text or
 *     code file in the Sidebar (a click in the Files tree, a file link in the
 *     conversation) therefore lands HERE, as an editable tab; everything else
 *     keeps its own preview tab;
 *   - Markdown is one of those text files (alpha.6): it opens editable, and the
 *     toolbar's **Preview** button hands the same address to the shipped
 *     document preview - named by kind, because the registry's ranking would
 *     otherwise hand it straight back to this `extension`-band type - so the
 *     rendered document is always one click away and its tab takes the editor
 *     tab's place. Since alpha.7 that preview is a **toggle**: this package also
 *     registers the rendered Markdown DOCUMENT body (shadowing the shipped one
 *     through the keyed slot's priority rule), and that body carries an **Edit**
 *     button which hands the same file straight back to this editor. Since
 *     alpha.8 that shadow body also **undoes what the plain-text scrollport
 *     imposes** on its contents (`white-space:pre` and the mono font stack, see
 *     the `.dse-mdview*` rules): a source newline is a soft break again instead
 *     of a hard one, and the Edit pill uses the app's UI font like every other
 *     button around it;
 *   - it contributes a guide entry, so the tab strip's "+" control - which
 *     opens the "Start" page - offers "Editor". Picking it creates an editor
 *     tab that opens on a BLANK document: nothing is read from disk until the
 *     user saves, and there is no workspace browser inside the tab. Saving it
 *     (the Save button or Ctrl+S) asks for a file name - extension included -
 *     through the pack's shared dialog surface (`dsh-modal`'s `modals`
 *     service, resolved lazily so the editor still works without it), creates
 *     the file inside the conversation folder, and swaps the tab record for
 *     that file's own tab, so the chip title becomes the file name and later
 *     saves are ordinary in-place saves.
 *
 * Data path (alpha.4):
 *   - read:  GET /api/dsh-editor/file?session=<id>&path=<rel> returns strict
 *     UTF-8 text only - binary / invalid-UTF-8 files are refused server-side,
 *     so the editor can never open a non-text file;
 *   - save:  PUT /api/dsh-editor/file with the mtime/size the file had when it
 *     was opened; a file that changed on disk meanwhile answers 409 and the
 *     panel offers "Reload" / "Save anyway" instead of clobbering it;
 *   - create: the same PUT with `create: true` writes a NEW file at a
 *     workspace-relative path whose parent folder already exists inside the
 *     workspace; an existing target answers 409 instead of overwriting a file
 *     the user never opened;
 *   - the tab's address already carries the authorizing session
 *     (`dsh-resource://file/session/<sessionId>/<path>`), so the client echoes
 *     only the session id and the workspace-relative path and the Node half
 *     resolves the workspace root itself (see lib/index.js).
 *
 * CodeMirror 6 is vendored ONCE as a classic IIFE (`window.DSHEditorCM`, built
 * from vendor/entry.js into lib/vendor/cm6.min.js) and fetched lazily over the
 * plugin's own authenticated route on the first file open, so an idle GUI never
 * pays for the editor.
 *
 * Color scheme (alpha.5): the surface follows the app's light/dark theme -
 * oneDark while the app is dark, a transparent light theme while it is light -
 * and re-configures live when the theme changes (the `theme` service's
 * `theme/change` event, or the `body[data-ds-dark-theme]` marker ui-layout
 * writes). The text colour is the `--dsw-alias-label-primary` token in both
 * modes, so a file with no language of its own (a .txt, .gitignore or .log
 * file) stays readable instead of painting light-theme text on oneDark's dark
 * canvas.
 *
 * Dirty state: the tab body compares the live document to the last saved text;
 * the SAVE button and the chip's dirty dot follow it. Ctrl/Cmd+S is bound inside
 * the editor. Unsaved changes are NOT auto-persisted - closing the tab while
 * dirty loses them (documented alpha caveat).
 *
 * Module-table format of every core client package; no build step.
 */
/* global window, document */
window.__ModuleLoader__.load({
  id: 'dsh-editor',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef } = React
    const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives')

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------
    /** This implementation's identity in the tab system, and its slot key. */
    const EDITOR_ID = 'dsh-editor'
    /** The tab kind this package owns. */
    const EDITOR_KIND = 'editor'
    /** The address a page tab of this kind is recorded under (the registry composes this). */
    const PAGE_ADDRESS = 'sidebar://' + EDITOR_KIND
    /** Keep in sync with lib/index.js. */
    const FILE_ROUTE = '/api/dsh-editor/file'
    const VENDOR_ROUTE = '/api/dsh-editor/vendor'
    /** Address grammar owned by @deepseek-ai/dsh-util-workspace-path. */
    const FILE_PREFIX = 'dsh-resource://file/'
    const SESSION_SEGMENT = 'session/'
    /** Version marker shown on the toolbar so a freshly loaded bundle is easy to verify. */
    const PLUGIN_VERSION = '0.1.0-alpha.9'
    /** The client service dsh-modal provides; resolved lazily, never required. */
    const MODAL_SERVICE = 'modals'
    /** The client service @deepseek-ai/dsh-client-ui-theme provides; resolved lazily too. */
    const THEME_SERVICE = 'theme'
    /** The theme presenter's dark-palette marker on <body> (ui-layout). */
    const DARK_ATTRIBUTE = 'data-ds-dark-theme'
    /** The right bar's navigation controller (dsh-rightbar), resolved lazily. */
    const SIDEBAR_SERVICE = 'sidebarRight'
    /** The tab-type registry (dsh-rightbar), whose entries name every registered kind. */
    const TAB_TYPES_SERVICE = 'sidebarRightTabs'
    /** The shipped document preview's registry id; its KIND is read from the registry. */
    const PREVIEW_TYPE_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
    /** The preview's kind on the pinned line, used only when the registry has no such type. */
    const PREVIEW_FALLBACK_KIND = 'text'
    /**
     * Documents this editor claims as TEXT and can also hand to the RENDERED
     * preview from its toolbar ("Preview"): the Markdown family the shipped
     * preview draws as a document. Everything else that preview owns (HTML,
     * images, PDF, archives, media, binaries) keeps its own tab, because a text
     * editor has nothing to add there.
     */
    const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown'])

    // ---------------------------------------------------------------------
    // Styles
    // ---------------------------------------------------------------------
    const css = `
.dse-root{height:100%;min-height:0;flex:auto;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1f1f1f);font-size:13px;line-height:1.5}
/* The toolbar IS this tab's top bar, and every column's top band ends in the
   same hairline at y=76: the docking strip above a pane is 38px (28px + 10px
   top padding) and the conversation header is min-height:76px, which is why
   the shipped Files tab's own 38px header lands exactly on that line. This bar
   was 26px of control in 8px/8px of padding (42.5px), so its rule sat ~4.5px
   BELOW the other two columns'. It is now the same 38px box, with a size-down
   24px control inside it, so the three hairlines are one line. */
.dse-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;padding:0 10px 0 12px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}
.dse-searchWrap{position:relative;flex:1;min-width:0;display:flex;align-items:center}
.dse-find{flex:1;min-width:0;height:24px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);padding:0 26px 0 8px;font:inherit;font-size:12px;outline:none}
.dse-find::placeholder{color:var(--dsw-alias-label-tertiary,#999)}
.dse-find:focus{border-color:var(--dsw-alias-state-accent,#4f8cff)}
.dse-find:disabled{opacity:.5}
.dse-clear{position:absolute;right:5px;top:50%;transform:translateY(-50%);display:none;align-items:center;justify-content:center;width:16px;height:16px;border:0;border-radius:4px;background:var(--dsw-alias-button-floating-fill,rgba(127,127,127,.16));color:var(--dsw-alias-label-tertiary,#999);cursor:pointer;padding:0;font-size:10px;line-height:1}
.dse-clear.on{display:inline-flex}
.dse-actions{flex:none;display:flex;align-items:center;gap:8px;min-width:0}
.dse-saveStatus{flex:none;font-size:11px;line-height:1;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}
.dse-saveStatus.err{color:var(--dsw-alias-state-error-primary,#d3382c)}
.dse-saveStatus.warn{color:var(--dsw-alias-state-warning-primary,#d29922)}
.dse-save{flex:none;display:inline-flex;align-items:center;gap:6px;height:24px;box-sizing:border-box;border:0;border-radius:6px;background:var(--dsw-alias-state-accent,#4f8cff);color:#fff;font:inherit;font-size:12px;font-weight:500;padding:0 10px;cursor:pointer;white-space:nowrap}
.dse-save:hover:not(:disabled){filter:brightness(1.08)}
.dse-save:disabled{opacity:.45;cursor:default}
.dse-preview{flex:none;display:inline-flex;align-items:center;height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:12px;padding:0 9px;cursor:pointer;white-space:nowrap}
.dse-preview:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dse-preview[hidden]{display:none}
.dse-fileBar{flex:none;display:flex;align-items:center;gap:8px;padding:4px 10px 5px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14));font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);min-width:0}
.dse-filePath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,'Cascadia Code',Consolas,monospace;color:var(--dsw-alias-label-secondary,#666)}
.dse-dirtyDot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warning-primary,#d29922);opacity:0}
.dse-dirty .dse-dirtyDot{opacity:1}
.dse-dirtyText{flex:none;white-space:nowrap}
.dse-ver{flex:none;white-space:nowrap;opacity:.7}
.dse-body{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}
.dse-cm{position:absolute;left:0;right:0;top:0;bottom:0;display:none;overflow:hidden}
.dse-cm.on{display:block}
.dse-cm .cm-editor{height:100%}
.dse-cm .cm-scroller{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:12.5px;line-height:1.6}
.dse-cm .cm-editor.cm-focused{outline:none}
.dse-state{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;color:var(--dsw-alias-label-tertiary,#999);font-size:12.5px;line-height:18px;text-align:center}
.dse-state.hidden{display:none}
.dse-stateTitle{font-size:13px;color:var(--dsw-alias-label-secondary,#666);font-weight:500}
.dse-stateErr{color:var(--dsw-alias-state-error-primary,#d3382c)}
.dse-banner{margin:6px 10px;flex:none;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.2));border-left:2px solid var(--dsw-alias-state-warning-primary,#d29922);border-radius:6px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08));padding:6px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary,#1f1f1f);display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dse-banner .dse-bannerText{flex:1;min-width:120px}
.dse-banner button{border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);border-radius:5px;font:inherit;font-size:11.5px;padding:2px 8px;cursor:pointer}
.dse-banner button:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
/* The chip's dirty marker (the title seat draws it before the tab's title). */
.dse-titleDot{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warning-primary,#d29922);margin-right:5px;vertical-align:middle}
/* The blank tab's placeholder path: a new document has no name until it is saved. */
.dse-filePath.dse-untitled{font-style:italic;color:var(--dsw-alias-label-tertiary,#999)}
/* The rendered Markdown view: the editor's own document body inside the shipped
   preview. The bar is a sticky overlay so the way back to editing stays in reach
   while the page scrolls; it ignores pointer events except on the button, so it
   never blocks selecting text underneath.
   Two resets are load-bearing here (alpha.8), because the preview's scrollport is
   built for the PLAIN-TEXT renderer: [data-textpreview-body] declares
   white-space:pre and the mono font stack, and the shipped Markdown body undid
   both in its own wrapper (._0RKuNG_document) - the wrapper this shadow body
   replaces. Without them the page inherits "pre": every newline in the source
   becomes a hard break and every blank line a full empty line ("huge spaces"),
   and the Edit pill renders in the mono face, unlike every button around it. */
.dse-mdview{display:flex;flex-direction:column;min-height:100%;box-sizing:border-box}
.dse-mdviewBar{position:sticky;top:0;z-index:3;display:flex;justify-content:flex-end;align-items:center;gap:8px;padding:6px 8px 0;pointer-events:none}
.dse-mdviewEdit{pointer-events:auto;display:inline-flex;align-items:center;height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:12px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#1f1f1f);font-family:var(--dsw-font-family,inherit);font-size:11.5px;padding:0 10px;cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.12)}
.dse-mdviewEdit:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dse-mdviewPaper{flex:1;min-height:0;white-space:normal}
`
    const CSS_TAG = 'dsh-editor/editor.css'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-editor'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------------
    // Address helpers (the same grammar @deepseek-ai/dsh-util-workspace-path
    // owns: `dsh-resource://file/session/<sessionId>/<path-segments>`, one
    // component-encoded segment per path segment, `:` kept literal).
    // ---------------------------------------------------------------------
    function decodeSegment(segment) {
      try {
        return decodeURIComponent(segment)
      } catch (e) {
        return segment
      }
    }

    function encodeSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ':')
    }

    /**
     * Split a `dsh-resource://file/...` address.
     * @param address - the address a tab was opened at.
     * @returns `{ scope: 'session', sessionId, path }` for a session-scoped
     *   address, `{ scope: 'absolute', path }` for the authorizing-less form,
     *   or `undefined` for anything that is not a file address.
     */
    function parseFileAddress(address) {
      if (typeof address !== 'string' || address.slice(0, FILE_PREFIX.length) !== FILE_PREFIX) return undefined
      const rest = address.slice(FILE_PREFIX.length)
      if (rest.slice(0, SESSION_SEGMENT.length) !== SESSION_SEGMENT) {
        return { scope: 'absolute', path: rest.split('/').map(decodeSegment).join('/') }
      }
      const tail = rest.slice(SESSION_SEGMENT.length)
      const cut = tail.indexOf('/')
      if (cut < 0) return { scope: 'session', sessionId: decodeSegment(tail), path: '' }
      return {
        scope: 'session',
        sessionId: decodeSegment(tail.slice(0, cut)),
        path: tail.slice(cut + 1).split('/').map(decodeSegment).join('/'),
      }
    }

    /** The decoded last path segment of a file address, or the address itself. */
    function basenameOf(address) {
      const file = parseFileAddress(address)
      const path = file ? file.path : String(address || '')
      const name = path.slice(path.lastIndexOf('/') + 1)
      return name === '' ? path || 'Editor' : name
    }

    /** Build a session-scoped file address for a workspace-relative path. */
    function sessionFileAddress(sessionId, path) {
      const normalized = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      return FILE_PREFIX + SESSION_SEGMENT + encodeSegment(sessionId) + '/' + normalized.split('/').map(encodeSegment).join('/')
    }

    /** Whether a path is absolute in either spelling the Host accepts. */
    function isAbsolutePath(value) {
      return value.startsWith('/') || value.startsWith('\\\\') || /^[A-Za-z]:[/\\]/.test(value)
    }

    /** The lower-cased extension of a path (`''` for none and for dotfiles). */
    function extensionOf(path) {
      const name = String(path).slice(String(path).lastIndexOf('/') + 1)
      const dot = name.lastIndexOf('.')
      return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
    }

    // Extensions the product's own preview types own (HTML renderers, the image
    // and PDF viewers) plus the binary formats a text editor cannot show at all.
    // A file with one of these keeps its shipped preview tab: our type registers
    // in the `extension` band, which outranks every builtin, so this veto is
    // what preserves them. Markdown is deliberately NOT here since alpha.6: it
    // is text, the editor can edit it, and the toolbar's "Preview" button hands
    // it back to the rendered view on demand.
    const PREVIEW_EXTENSIONS = new Set([
      // rendered documents
      'html', 'htm', 'xhtml',
      // images
      'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'tif', 'tiff',
      // documents / archives / media / binaries
      'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar',
      'mp3', 'wav', 'ogg', 'oga', 'flac', 'm4a', 'mp4', 'webm', 'mov', 'avi', 'mkv',
      'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'jar', 'wasm', 'node',
      'woff', 'woff2', 'ttf', 'otf', 'eot', 'db', 'sqlite', 'icns',
    ])

    /**
     * Whether this type opens a file address: a session-scoped address whose
     * path stays inside the session workspace and is not owned by a shipped
     * preview. The Node half confines reads and writes to that workspace, so
     * anything else is left to the preview it already has.
     */
    function canOpenFile(address) {
      const file = parseFileAddress(address)
      if (!file || file.scope !== 'session') return false
      if (!file.path || isAbsolutePath(file.path.replace(/\\/g, '/'))) return false
      return !PREVIEW_EXTENSIONS.has(extensionOf(file.path))
    }

    // ---------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------
    /** The guide capsule's glyph (drawn before "Editor" on the Start page). */
    function EditorGlyph(props) {
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
        h('path', { d: 'M5.5 3.5 2 8l3.5 4.5' }),
        h('path', { d: 'M10.5 3.5 14 8l-3.5 4.5' }),
      )
    }

    // ---------------------------------------------------------------------
    // Per-tab state the chip title reads: whether the open document is dirty,
    // and the label a surface wants drawn instead of the record's title. A body
    // writes it, the title subscribes to it - the tab record itself carries no
    // place for a body-owned flag.
    // ---------------------------------------------------------------------
    const IDLE_TAB_STATE = { dirty: false, label: '' }
    const tabStates = new Map()
    const titleListeners = new Set()

    function tabStateOf(tabId) {
      const held = tabStates.get(tabId)
      return held === undefined ? IDLE_TAB_STATE : held
    }

    function notifyTitles() {
      for (const listener of [...titleListeners]) {
        try {
          listener()
        } catch (e) {
          /* a throwing subscriber must not break the others */
        }
      }
    }

    function setTabDirty(tabId, dirty) {
      const previous = tabStateOf(tabId)
      if (previous.dirty === dirty) return
      tabStates.set(tabId, { dirty: dirty, label: previous.label })
      notifyTitles()
    }

    /**
     * Set the chip label this surface wants the title seat to draw, for a tab
     * whose RECORD title is no longer the whole truth: a document saved into an
     * address this type cannot claim (a preview-owned extension) keeps the tab
     * record - and therefore the record's "Editor" title - while the file it
     * now edits is what the chip should name. An empty label restores the
     * record's own title.
     */
    function setTabLabel(tabId, label) {
      const previous = tabStateOf(tabId)
      if (previous.label === label) return
      tabStates.set(tabId, { dirty: previous.dirty, label: label })
      notifyTitles()
    }

    function dropTabState(tabId) {
      if (tabStates.delete(tabId)) notifyTitles()
    }

    function subscribeTabState(listener) {
      titleListeners.add(listener)
      return () => {
        titleListeners.delete(listener)
      }
    }

    // ---------------------------------------------------------------------
    // Color scheme (light / dark), shared by every editor surface.
    //
    // The editor is the one surface that cannot just read the `--dsw-alias-*`
    // tokens: CodeMirror needs a light/dark theme of its own, and oneDark paints
    // an opaque dark canvas that no token can lighten. So the surface gets
    // oneDark only while the APP is dark, and a transparent light layer
    // otherwise. Without that split, a document CodeMirror assigns no language
    // (a .ps1, .gitignore or .txt file - its text colour comes from the token
    // below, not from a syntax style) painted light-theme text
    // (`--dsw-alias-label-primary` is near-black there) on oneDark's dark
    // canvas.
    //
    // Truth order for "is the app dark": the theme service's resolved snapshot
    // (`active.colorScheme`), else the presenter's own body marker
    // (`body[data-ds-dark-theme]`, written before the first paint), else the OS
    // preference. Live flips reach every open editor through the service's
    // `theme/change` event, with a body-marker observer as the fallback for a
    // profile where ui-theme never lands.
    // ---------------------------------------------------------------------
    /** The owning client context, remembered so the theme service can be re-resolved. */
    let pluginCtx = null
    /** The theme service once it answered; a miss is retried on the next probe. */
    let themeService = null
    /** The resolved scheme every editor surface is on. */
    let appDark = probeDark()
    const schemeListeners = new Set()

    /** The theme service (@deepseek-ai/dsh-client-ui-theme), or `null`. */
    function themeServiceNow() {
      if (themeService) return themeService
      try {
        themeService = pluginCtx && pluginCtx.get ? pluginCtx.get(THEME_SERVICE) : null
      } catch (e) {
        themeService = null
      }
      return themeService
    }

    /** Whether the app is currently dark, from the service, the body marker, or the OS. */
    function probeDark() {
      try {
        const service = themeServiceNow()
        const snapshot = service && typeof service.getTheme === 'function' ? service.getTheme() : null
        const scheme = snapshot && snapshot.active ? snapshot.active.colorScheme : null
        if (scheme === 'dark') return true
        if (scheme === 'light') return false
      } catch (e) {}
      try {
        const body = document.body
        if (body && typeof body.hasAttribute === 'function' && body.hasAttribute(DARK_ATTRIBUTE)) return true
      } catch (e) {}
      try {
        if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
          return window.matchMedia('(prefers-color-scheme: dark)').matches
        }
      } catch (e) {}
      // oneDark was the editor's own default before it followed the app.
      return true
    }

    /** Re-probe the scheme and tell every live surface when it moved. */
    function refreshScheme() {
      const next = probeDark()
      if (next === appDark) return
      appDark = next
      for (const listener of [...schemeListeners]) {
        try {
          listener(appDark)
        } catch (e) {
          /* a throwing subscriber must not break the others */
        }
      }
    }

    /** Follow the app's scheme: the listener is called with the new `dark` flag. */
    function subscribeScheme(listener) {
      schemeListeners.add(listener)
      return () => {
        schemeListeners.delete(listener)
      }
    }

    /**
     * The CodeMirror theme layer for one color scheme: oneDark while the app is
     * dark (the editor's long-standing look), else a light layer that keeps the
     * editor on the panel's own tokens - CodeMirror's base theme already brings
     * the light caret, cursor and selection styling.
     * @param CM - the vendored engine.
     * @param dark - whether the app is dark.
     * @returns the extension(s) a compartment holds.
     */
    function schemeExtensions(CM, dark) {
      if (dark) return CM.oneDark
      return [
        CM.EditorView.theme(
          {
            '&': { backgroundColor: 'transparent' },
            '.cm-content': { caretColor: 'var(--dsw-alias-state-accent,#4f8cff)' },
            '.cm-gutters': { color: 'var(--dsw-alias-label-tertiary,#8a8a8a)' },
            '.cm-activeLine': { backgroundColor: 'var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.08))' },
          },
          { dark: false },
        ),
      ]
    }

    // ---------------------------------------------------------------------
    // Vendored CodeMirror 6 engine (lazy, once).
    // ---------------------------------------------------------------------
    let cmEnginePromise = null
    function ensureCmEngine() {
      if (window.DSHEditorCM) return Promise.resolve(window.DSHEditorCM)
      if (!cmEnginePromise) {
        cmEnginePromise = (async () => {
          const res = await fetch(VENDOR_ROUTE, { method: 'GET', credentials: 'same-origin' })
          if (!res.ok) {
            throw new Error('editor engine unavailable (HTTP ' + res.status + ')')
          }
          const source = await res.text()
          if (window.DSHEditorCM) return window.DSHEditorCM
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
                reject(new Error('editor engine failed to start'))
              },
              { once: true },
            )
            document.head.appendChild(el)
          })
          if (!window.DSHEditorCM) throw new Error('editor engine did not initialize')
          return window.DSHEditorCM
        })()
      }
      return cmEnginePromise
    }

    // ---------------------------------------------------------------------
    // Language mapping (syntax highlighting by file extension) - the vendored
    // bundle carries javascript/typescript, json, markdown, python, html, css
    // and yaml, plus three CM5-style stream languages: `shell` (sh/bash/zsh/...)
    // and `powerShell` (ps1/psm1/psd1) from legacy-modes, and the batch mode
    // written in vendor/batch-mode.js. CodeMirror has no Lezer parser for any of
    // them, so all three ride on StreamLanguage; without a mapping a shell
    // script drew as one flat colour in the light theme - the whole point of
    // alpha.10.
    // ---------------------------------------------------------------------
    function languageExtensionFor(CM, fileName) {
      const ext = extensionOf(fileName)
      switch (ext) {
        case 'js':
        case 'mjs':
        case 'cjs':
          return CM.javascript()
        case 'jsx':
          return CM.javascript({ jsx: true })
        case 'ts':
          return CM.javascript({ typescript: true })
        case 'tsx':
          return CM.javascript({ typescript: true, jsx: true })
        case 'json':
        case 'jsonc':
          return CM.json()
        case 'md':
        case 'markdown':
        case 'mdown':
          return CM.markdown()
        case 'py':
        case 'pyw':
          return CM.python()
        case 'html':
        case 'htm':
        case 'xhtml':
          return CM.html()
        case 'css':
          return CM.css()
        case 'yaml':
        case 'yml':
          return CM.yaml()
        case 'sh':
        case 'bash':
        case 'zsh':
        case 'ksh':
        case 'dash':
          return CM.StreamLanguage.define(CM.shell)
        case 'ps1':
        case 'psm1':
        case 'psd1':
          return CM.StreamLanguage.define(CM.powerShell)
        case 'bat':
        case 'cmd':
          return CM.StreamLanguage.define(CM.batch)
        default:
          return null
      }
    }

    function isWrapFile(fileName) {
      const ext = extensionOf(fileName)
      return ['md', 'markdown', 'mdown', 'txt', 'text', 'log', 'csv', 'gitignore', 'editorconfig'].indexOf(ext) >= 0 || ext === ''
    }

    /** Debounced helper. */
    function debounce(fn, ms) {
      let timer = null
      return (...args) => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          fn(...args)
        }, ms)
      }
    }

    function fmtTime(date) {
      try {
        return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
      } catch (e) {
        return ''
      }
    }

    // ---------------------------------------------------------------------
    // One open file - or one blank document - the imperative CodeMirror surface
    // behind a tab record. Built by the body, disposed with the tab.
    // `hooks.saveAs(text)` is the body's answer to "this document has no file
    // yet": it names the file through the shared dialog, creates it, and swaps
    // the tab record for that file's own tab.
    // ---------------------------------------------------------------------
    function createEditorInstance(rootEl, tabId, hooks) {
      const bodyHooks = hooks || {}
      const toolRoot = document.createElement('div')
      toolRoot.className = 'dse-root'

      // ---- toolbar: find-in-file + PREVIEW (Markdown only) + SAVE ----
      const tools = document.createElement('div')
      tools.className = 'dse-tools'
      const searchWrap = document.createElement('div')
      searchWrap.className = 'dse-searchWrap'
      const findInput = document.createElement('input')
      findInput.type = 'text'
      findInput.className = 'dse-find'
      findInput.placeholder = 'Find in file\u2026'
      findInput.spellcheck = false
      const clearFind = document.createElement('button')
      clearFind.type = 'button'
      clearFind.className = 'dse-clear'
      clearFind.title = 'Clear search'
      clearFind.setAttribute('aria-label', 'Clear search')
      clearFind.textContent = '\u00d7'
      searchWrap.appendChild(findInput)
      searchWrap.appendChild(clearFind)
      const actions = document.createElement('div')
      actions.className = 'dse-actions'
      const saveStatus = document.createElement('span')
      saveStatus.className = 'dse-saveStatus'
      saveStatus.textContent = '\u00a0'
      const saveBtn = document.createElement('button')
      saveBtn.type = 'button'
      saveBtn.className = 'dse-save'
      saveBtn.disabled = true
      saveBtn.textContent = 'Save'
      saveBtn.title = 'Save this file to disk (Ctrl+S)'
      // Markdown is editable here (alpha.6); this is the way back to the
      // RENDERED document the shipped preview draws. Hidden for anything else,
      // because the preview has nothing to add to a plain text file.
      const previewBtn = document.createElement('button')
      previewBtn.type = 'button'
      previewBtn.className = 'dse-preview'
      previewBtn.hidden = true
      previewBtn.textContent = 'Preview'
      previewBtn.title = 'Open the rendered view of this Markdown file'
      actions.appendChild(saveStatus)
      actions.appendChild(previewBtn)
      actions.appendChild(saveBtn)
      tools.appendChild(searchWrap)
      tools.appendChild(actions)
      toolRoot.appendChild(tools)

      // ---- file bar: dirty dot + workspace-relative path ----
      const fileBar = document.createElement('div')
      fileBar.className = 'dse-fileBar'
      const dirtyDot = document.createElement('span')
      dirtyDot.className = 'dse-dirtyDot'
      const filePath = document.createElement('span')
      filePath.className = 'dse-filePath'
      const dirtyText = document.createElement('span')
      dirtyText.className = 'dse-dirtyText'
      const versionText = document.createElement('span')
      versionText.className = 'dse-ver'
      versionText.textContent = PLUGIN_VERSION
      versionText.title = 'dsh-editor ' + PLUGIN_VERSION
      fileBar.appendChild(dirtyDot)
      fileBar.appendChild(filePath)
      fileBar.appendChild(dirtyText)
      fileBar.appendChild(versionText)
      toolRoot.appendChild(fileBar)

      // ---- body: editor / loading / error states ----
      const body = document.createElement('div')
      body.className = 'dse-body'
      const cmWrap = document.createElement('div')
      cmWrap.className = 'dse-cm'
      const stateEl = document.createElement('div')
      stateEl.className = 'dse-state'
      const stateTitle = document.createElement('div')
      stateTitle.className = 'dse-stateTitle'
      const stateHint = document.createElement('div')
      stateEl.appendChild(stateTitle)
      stateEl.appendChild(stateHint)
      body.appendChild(cmWrap)
      body.appendChild(stateEl)
      toolRoot.appendChild(body)

      const bannerHost = document.createElement('div')
      toolRoot.insertBefore(bannerHost, body)
      rootEl.appendChild(toolRoot)

      // ---- state ----
      let CM = null
      let cm = null
      let langCompartment = null
      let wrapCompartment = null
      let themeCompartment = null
      let file = null // { sessionId, path, mtimeMs, size }; null = a blank, unnamed document
      let blank = false // the surface currently holds the tab's own new document
      let targetKey = null // sessionId + path of the loaded/loading file
      let lastSaved = ''
      let dirty = false
      let saving = false
      let disposed = false

      function markDirty(next) {
        if (dirty === next) return
        dirty = next
        setTabDirty(tabId, next)
      }

      function showState(kind, title, hint) {
        stateEl.classList.toggle('hidden', kind === 'none')
        stateEl.classList.toggle('dse-stateErr', kind === 'error')
        stateTitle.textContent = title || ''
        stateHint.textContent = hint || ''
        cmWrap.classList.toggle('on', kind === 'edit')
      }

      function setStatus(text, mode) {
        saveStatus.textContent = text || '\u00a0'
        saveStatus.className = 'dse-saveStatus' + (mode === 'err' ? ' err' : mode === 'warn' ? ' warn' : '')
      }

      let statusTimer = null
      function flashStatus(text, mode, ms) {
        setStatus(text, mode)
        if (statusTimer) clearTimeout(statusTimer)
        statusTimer = setTimeout(() => {
          statusTimer = null
          setStatus('', '')
        }, ms || 1800)
      }

      function showBanner(message, buttons) {
        bannerHost.textContent = ''
        const banner = document.createElement('div')
        banner.className = 'dse-banner'
        const text = document.createElement('span')
        text.className = 'dse-bannerText'
        text.textContent = message
        banner.appendChild(text)
        for (const button of buttons || []) {
          const el = document.createElement('button')
          el.type = 'button'
          el.textContent = button.label
          el.addEventListener('click', () => {
            try {
              button.onClick()
            } catch (e) {}
          })
          banner.appendChild(el)
        }
        bannerHost.appendChild(banner)
        return banner
      }

      function clearBanner() {
        bannerHost.textContent = ''
      }

      function updateDirtyUi() {
        const has = !!file
        const isDirty = has && dirty
        fileBar.classList.toggle('dse-dirty', isDirty)
        dirtyText.textContent = isDirty ? 'Modified' : ''
        fileBar.title = has ? file.path : 'Not saved yet'
        filePath.classList.toggle('dse-untitled', !has)
        filePath.textContent = has ? file.path : (blank || cm ? 'Untitled' : '')
        // An unnamed document is always saveable once it has a surface: Save is
        // what names it. A file that is already on disk is saveable only while
        // it differs from what is on disk.
        saveBtn.disabled = saving || (has ? !isDirty : !cm)
        findInput.disabled = !cm
        saveBtn.textContent = has ? 'Save' : 'Save\u2026'
        saveBtn.title = !has ? 'Name this file and write it into the conversation folder (Ctrl+S)' : isDirty ? 'Save this file to disk (Ctrl+S)' : 'Nothing to save'
        // "Preview" belongs to the Markdown family (the documents this editor
        // claims as text and the shipped preview can render as a document).
        previewBtn.hidden = !has || !MARKDOWN_EXTENSIONS.has(extensionOf(file.path))
      }

      /**
       * Hand this document to the RENDERED preview: the shipped document preview
       * type claims the address, and the preview tab takes this one's place, so
       * the pair Edit <-> Preview is one tab that cannot drift from the file it
       * names. The rendered page carries the way back (the **Edit** button this
       * package's own document body draws). Unsaved edits are NOT included (the
       * preview reads the file), so the button warns instead of silently showing
       * the older text.
       */
      function requestPreview() {
        if (!file) return
        if (dirty) {
          setStatus('Save first', 'warn')
          showBanner('Save your edits first: the rendered preview reads the file from disk.', [])
          return
        }
        if (typeof bodyHooks.openPreview !== 'function') {
          setStatus('Preview unavailable', 'err')
          showBanner('The rendered preview is unavailable in this window.', [])
          return
        }
        try {
          bodyHooks.openPreview(sessionFileAddress(file.sessionId, file.path), tabId)
        } catch (err) {
          setStatus('Preview unavailable', 'err')
          showBanner(err && err.message ? err.message : 'The rendered preview is unavailable.', [])
        }
      }

      function onDocChanged() {
        if (!cm) return
        // A blank document has no saved text to compare against; any content at
        // all is work the user would lose, so it counts as modified.
        markDirty(file ? cm.state.doc.toString() !== lastSaved : cm.state.doc.toString() !== '')
        updateDirtyUi()
      }

      // Debounced equality check keeps the dirty flag honest after undoing back
      // to the saved text without comparing every keystroke.
      const recheckDirty = debounce(() => {
        if (!cm || disposed) return
        const settled = file ? cm.state.doc.toString() === lastSaved : cm.state.doc.toString() === ''
        if (settled && dirty) {
          markDirty(false)
          updateDirtyUi()
        }
      }, 250)

      function saveNow(force) {
        if (!cm || saving) return
        if (!file) {
          requestSaveAs()
          return
        }
        if (!force && !dirty) return
        const target = file
        const text = cm.state.doc.toString()
        saving = true
        setStatus('Saving\u2026')
        updateDirtyUi()
        fetch(FILE_ROUTE, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            session: target.sessionId,
            path: target.path,
            text: text,
            expected: force ? undefined : { mtimeMs: target.mtimeMs, size: target.size },
          }),
        })
          .then(async (res) => {
            if (disposed) return
            let payload = null
            try {
              payload = await res.json()
            } catch (e) {}
            if (res.status === 409 && payload && payload.error && payload.error.code === 'CHANGED_ON_DISK') {
              saving = false
              setStatus('Changed on disk', 'warn')
              showBanner('This file changed on disk since you opened it. Saving would overwrite the newer version.', [
                {
                  label: 'Reload',
                  onClick: () => {
                    clearBanner()
                    openFile({ sessionId: target.sessionId, path: target.path }, true)
                  },
                },
                {
                  label: 'Save anyway',
                  onClick: () => {
                    clearBanner()
                    saveNow(true)
                  },
                },
              ])
              updateDirtyUi()
              return
            }
            if (res.status >= 200 && res.status < 300 && payload && payload.ok) {
              lastSaved = text
              const stillDirty = cm.state.doc.toString() !== lastSaved
              markDirty(stillDirty)
              target.mtimeMs = typeof payload.mtimeMs === 'number' ? payload.mtimeMs : target.mtimeMs
              target.size = typeof payload.size === 'number' ? payload.size : target.size
              flashStatus(stillDirty ? 'Saved (more edits)' : 'Saved ' + fmtTime(new Date()))
              clearBanner()
            } else {
              const message =
                payload && payload.error
                  ? payload.error.message
                  : res.status === 409
                    ? 'This file changed on disk since you opened it.'
                    : 'Save failed (HTTP ' + res.status + ')'
              setStatus('Save failed', 'err')
              showBanner(message, [])
            }
            saving = false
            updateDirtyUi()
          })
          .catch((err) => {
            if (disposed) return
            saving = false
            setStatus('Save failed', 'err')
            showBanner(err && err.message ? err.message : 'Could not reach the editor service.', [])
            updateDirtyUi()
          })
      }

      /**
       * Save the blank document: hand the text to the body, which names the file
       * through the shared dialog, creates it, and swaps this tab for the file's
       * own tab. A body without a `saveAs` hook (or a cancelled dialog) leaves
       * the document exactly as it was.
       */
      function requestSaveAs() {
        if (!cm || saving) return
        if (typeof bodyHooks.saveAs !== 'function') {
          setStatus('Save failed', 'err')
          showBanner('This editor tab cannot name a new file (the dialog service is unavailable).', [])
          return
        }
        const text = cm.state.doc.toString()
        saving = true
        setStatus('Naming\u2026')
        updateDirtyUi()
        Promise.resolve()
          .then(() => bodyHooks.saveAs(text))
          .then((created) => {
            if (disposed) return
            saving = false
            if (!created) {
              // Cancelled: keep the typed document and its dirty marker.
              setStatus('')
              updateDirtyUi()
              return
            }
            if (created.adopt === true && created.file) {
              // The body kept the file in this surface (its extension belongs to
              // a shipped preview, or the record has no tab actions), so later
              // saves are ordinary in-place saves and the chip names the file.
              file = created.file
              blank = false
              targetKey = file.sessionId + '\u0000' + file.path
              lastSaved = text
              markDirty(false)
              applyLanguage(file.path)
              setTabLabel(tabId, basenameOf(file.path))
              filePath.textContent = file.path
              filePath.title = file.path
              filePath.classList.remove('dse-untitled')
              flashStatus('Saved ' + fmtTime(new Date()))
              clearBanner()
            }
            // `created.replaced`: the body swapped the tab record, so this
            // surface is about to be disposed with nothing left to update.
            updateDirtyUi()
          })
          .catch((err) => {
            if (disposed) return
            saving = false
            setStatus('Save failed', 'err')
            showBanner(err && err.message ? err.message : 'Could not create the new file.', [])
            updateDirtyUi()
          })
      }

      function ensureEditor() {
        if (cm) return cm
        langCompartment = new CM.Compartment()
        wrapCompartment = new CM.Compartment()
        themeCompartment = new CM.Compartment()
        const extensions = [
          CM.lineNumbers(),
          CM.highlightActiveLineGutter(),
          CM.highlightSpecialChars(),
          CM.history(),
          CM.foldGutter(),
          CM.drawSelection(),
          CM.dropCursor(),
          CM.EditorState.allowMultipleSelections.of(true),
          CM.indentOnInput(),
          CM.syntaxHighlighting(CM.defaultHighlightStyle, { fallback: true }),
          CM.bracketMatching(),
          CM.closeBrackets(),
          CM.autocompletion(),
          CM.rectangularSelection(),
          CM.crosshairCursor(),
          CM.highlightActiveLine(),
          CM.highlightSelectionMatches(),
          CM.search({ top: true }),
          CM.keymap.of([
            ...CM.closeBracketsKeymap,
            ...CM.defaultKeymap,
            ...CM.searchKeymap,
            ...CM.historyKeymap,
            ...CM.completionKeymap,
            {
              key: 'Mod-s',
              run: () => {
                saveNow(false)
                return true
              },
            },
          ]),
          CM.EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onDocChanged()
              recheckDirty()
            }
          }),
          langCompartment.of([]),
          wrapCompartment.of([CM.EditorView.lineWrapping]),
        ]
        // The palette follows the APP's color scheme (see the color-scheme
        // section): oneDark paints its own opaque dark canvas, so it is only
        // configured while the app is dark. The transparent light layer leaves
        // the panel's tokens visible, and the `.cm-scroller` colour below is a
        // token in both modes, which is what keeps unhighlighted text readable
        // in either one.
        extensions.push(themeCompartment.of(schemeExtensions(CM, appDark)))
        extensions.push(
          CM.EditorView.theme({
            '&': { height: '100%', fontSize: '12.5px' },
            '&.cm-focused': { outline: 'none' },
            // Gutters are transparent so the line-number strip shares the exact
            // code background (oneDark paints .cm-editor behind them).
            '.cm-gutters': { backgroundColor: 'transparent' },
            '.cm-activeLineGutter': { backgroundColor: 'transparent' },
            '.cm-scroller': {
              fontFamily: "ui-monospace, 'Cascadia Code', Consolas, monospace",
              fontSize: '12.5px',
              lineHeight: '1.6',
              color: 'var(--dsw-alias-label-primary,#d4d4d4)',
            },
          }),
        )
        cm = new CM.EditorView({
          parent: cmWrap,
          state: CM.EditorState.create({ doc: '', extensions: extensions }),
        })
        return cm
      }

      function applyLanguage(fileName) {
        if (!cm || !CM) return
        const language = languageExtensionFor(CM, fileName)
        const wrapped = isWrapFile(fileName)
        cm.dispatch({
          effects: [
            langCompartment.reconfigure(language ? [language] : []),
            wrapCompartment.reconfigure(wrapped ? [CM.EditorView.lineWrapping] : []),
          ],
        })
      }

      function setDocument(text) {
        if (!cm) return
        cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: text } })
      }

      /**
       * Load one file into this editor. Re-opening the file already shown is a
       * no-op unless `force` is given (a re-navigation of the same tab record
       * must not throw away unsaved edits).
       */
      async function openFile(target, force) {
        if (disposed) return
        if (!target || typeof target.sessionId !== 'string' || typeof target.path !== 'string') return
        const key = target.sessionId + '\u0000' + target.path
        if (!force && key === targetKey) return
        if (dirty && cm && file && key !== targetKey && !force) {
          // eslint-disable-next-line no-alert
          if (!window.confirm('Discard unsaved changes to ' + file.path + '?')) return
        }
        targetKey = key
        clearBanner()
        showState('loading', 'Opening\u2026', target.path)
        try {
          await ensureCmEngine()
          CM = CM || window.DSHEditorCM
          if (disposed) return
          const res = await fetch(
            FILE_ROUTE + '?session=' + encodeURIComponent(target.sessionId) + '&path=' + encodeURIComponent(target.path),
            { method: 'GET', credentials: 'same-origin' },
          )
          const payload = await res.json().catch(() => null)
          if (disposed) return
          if (!res.ok || !payload || !payload.ok) {
            const code = payload && payload.error ? payload.error.code : 'HTTP ' + res.status
            const message = payload && payload.error ? payload.error.message : 'Could not open this file.'
            file = null
            lastSaved = ''
            markDirty(false)
            filePath.textContent = ''
            if (code === 'NOT_TEXT') {
              showState('error', 'Not a text file', 'This file is binary or not valid UTF-8, so it cannot open in the text editor.')
            } else {
              showState('error', 'Could not open the file', message)
            }
            updateDirtyUi()
            return
          }
          ensureEditor()
          blank = false
          file = {
            sessionId: target.sessionId,
            path: payload.path || target.path,
            mtimeMs: typeof payload.mtimeMs === 'number' ? payload.mtimeMs : null,
            size: typeof payload.size === 'number' ? payload.size : null,
          }
          lastSaved = payload.text || ''
          markDirty(false)
          setDocument(lastSaved)
          applyLanguage(file.path)
          setTabLabel(tabId, basenameOf(file.path))
          filePath.textContent = file.path
          filePath.title = file.path
          showState('edit')
          flashStatus('Opened')
          updateDirtyUi()
          try {
            cm.focus()
          } catch (e) {}
        } catch (err) {
          if (disposed) return
          file = null
          markDirty(false)
          showState('error', 'Editor unavailable', err && err.message ? err.message : String(err))
          updateDirtyUi()
        }
      }

      /**
       * Show the tab's own new document: an empty surface with no file behind
       * it. Nothing is read from disk, and re-entering the already-blank
       * surface changes nothing (a re-navigation must not throw away typing).
       */
      async function openBlank(force) {
        if (disposed) return
        if (blank && cm && !force) {
          try {
            cm.focus()
          } catch (e) {}
          return
        }
        clearBanner()
        try {
          await ensureCmEngine()
          CM = CM || window.DSHEditorCM
          if (disposed) return
          ensureEditor()
          blank = true
          targetKey = null
          file = null
          lastSaved = ''
          markDirty(false)
          setDocument('')
          applyLanguage('')
          setTabLabel(tabId, '')
          showState('edit')
          setStatus('')
          updateDirtyUi()
          try {
            cm.focus()
          } catch (e) {}
        } catch (err) {
          if (disposed) return
          showState('error', 'Editor unavailable', err && err.message ? err.message : String(err))
          updateDirtyUi()
        }
      }

      // ---- find-in-file wiring (the toolbar search drives CodeMirror's own) ----
      const runFind = debounce(() => {
        if (!cm || !CM) return
        const value = findInput.value
        if (!value) {
          try {
            CM.closeSearchPanel(cm)
          } catch (e) {}
          return
        }
        cm.dispatch({ effects: CM.setSearchQuery.of(new CM.SearchQuery({ search: value })) })
        try {
          CM.openSearchPanel(cm)
        } catch (e) {}
      }, 200)
      findInput.addEventListener('input', () => {
        clearFind.classList.toggle('on', !!findInput.value)
        runFind()
      })
      findInput.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape') {
          findInput.value = ''
          clearFind.classList.remove('on')
          runFind()
        }
      })
      clearFind.addEventListener('click', () => {
        findInput.value = ''
        clearFind.classList.remove('on')
        runFind()
        findInput.focus()
      })
      saveBtn.addEventListener('click', () => saveNow(false))
      previewBtn.addEventListener('click', () => requestPreview())

      filePath.textContent = ''
      showState('loading', 'Opening\u2026', '')
      updateDirtyUi()

      // Follow the app's color scheme while this surface is open. A flip that
      // lands before the engine loaded needs no dispatch: the compartment is
      // created from the then-current `appDark`.
      const stopScheme = subscribeScheme(() => {
        if (!cm || !themeCompartment) return
        cm.dispatch({ effects: themeCompartment.reconfigure(schemeExtensions(CM, appDark)) })
      })

      return {
        /** Show one file, or the tab's own blank document when `target` is null. */
        open(target) {
          return target ? openFile(target, false) : openBlank(false)
        },
        dispose() {
          disposed = true
          stopScheme()
          if (statusTimer) clearTimeout(statusTimer)
          if (cm) {
            try {
              cm.destroy()
            } catch (e) {}
            cm = null
          }
          dropTabState(tabId)
          if (toolRoot.parentNode) toolRoot.parentNode.removeChild(toolRoot)
        },
      }
    }

    // ---------------------------------------------------------------------
    // The tab bodies.
    // ---------------------------------------------------------------------

    /**
     * The file name the dialog asks for is a workspace-relative path whose last
     * segment states an extension: naming the extension is part of the gesture,
     * and a file called `notes` is almost never what was meant. A dotfile
     * (`.gitignore`) is the one accepted exception.
     * @returns the problem to show inline, or `''` when the name is usable.
     */
    function validateNewFilePath(value) {
      const text = String(value === undefined || value === null ? '' : value).trim()
      if (text === '') return 'Enter a file name.'
      if (text.length > 200) return 'That file name is too long.'
      const normalized = text.replace(/\\/g, '/')
      if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) return 'Use a path inside the conversation folder, not an absolute one.'
      const segments = normalized.split('/')
      for (const segment of segments) {
        if (segment === '' || segment === '.' || segment === '..') return 'The path cannot contain empty, "." or ".." segments.'
      }
      const name = segments[segments.length - 1]
      const dotfile = name.length > 1 && name.charAt(0) === '.' && name.indexOf('.', 1) < 0
      if (!dotfile && !/\.[^./\\]+$/.test(name)) return 'Add a file extension, for example .md or .txt.'
      return ''
    }

    /** A first guess at the new document's name, read from what has been typed. */
    function suggestedFileName(text) {
      const trimmed = String(text || '').trim()
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'untitled.json'
      if (/^#{1,6}\s/.test(trimmed)) return 'untitled.md'
      return 'untitled.txt'
    }

    /** One create failure, phrased for the dialog. */
    function createFailureText(status, payload, path) {
      const error = payload && payload.error ? payload.error : null
      const code = error && error.code ? error.code : ''
      if (code === 'EXISTS') return 'A file named "' + path + '" already exists in that folder.'
      if (code === 'NO_FOLDER') return 'The folder for "' + path + '" does not exist.'
      if (code === 'OUTSIDE_WORKSPACE') return 'That path is outside the conversation folder.'
      if (code === 'TOO_LARGE') return 'The file would be too large to save.'
      if (code === 'NO_WORKSPACE') return 'The conversation folder is not available right now.'
      if (error && error.message) return error.message
      return 'Could not create the file (HTTP ' + status + ').'
    }

    /**
     * Name and create the document a blank editor tab holds, then hand the tab
     * over to the created file: the tab record is replaced (`replaceTab`) so the
     * chip title becomes the file name and every later save is an in-place save.
     *
     * The dialog does the naming AND owns the failure: `submit` performs the
     * create while the dialog stays open, so a taken name is reported inside it
     * and the typed name survives. Without the shared dialog service (dsh-modal
     * not mounted) the browser's own prompt keeps the editor usable.
     *
     * @param options - `{ sessionId, tab, text, modals }`.
     * @returns `null` when cancelled; otherwise what the tab body should do next.
     */
    async function createNewFile(options) {
      const sessionId = options.sessionId
      const tab = options.tab
      const text = options.text
      const modals = options.modals

      const put = async (path) => {
        const trimmed = String(path).trim().replace(/\\/g, '/')
        const res = await fetch(FILE_ROUTE, {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ session: sessionId, path: trimmed, text: text, create: true }),
        })
        let payload = null
        try {
          payload = await res.json()
        } catch (e) {}
        if (!res.ok || !payload || !payload.ok) throw new Error(createFailureText(res.status, payload, trimmed))
        return typeof payload.path === 'string' && payload.path !== '' ? payload.path : trimmed
      }

      let name = null
      if (modals && typeof modals.open === 'function') {
        const values = await modals.open({
          title: 'Save new file',
          message: 'The file is created inside this conversation\u2019s workspace folder. Type its name - extension included - relative to that folder.',
          fields: [
            {
              name: 'path',
              label: 'File name (with extension)',
              value: suggestedFileName(text),
              placeholder: 'notes.md',
              hint: 'A subfolder works too, for example src/app.ts; the folder must already exist.',
              mono: true,
              required: true,
            },
          ],
          validate: (input) => validateNewFilePath(input.path),
          submit: async (input) => ({ path: await put(input.path) }),
          confirmLabel: 'Save',
          busyLabel: 'Saving\u2026',
        })
        if (values === null) return null
        name = values.path
      } else {
        // eslint-disable-next-line no-alert
        const typed = window.prompt('Save as (relative to the conversation folder, extension included)', suggestedFileName(text))
        if (typed === null) return null
        const problem = validateNewFilePath(typed)
        if (problem !== '') throw new Error(problem)
        name = await put(typed)
      }

      const address = sessionFileAddress(sessionId, name)
      // The file becomes its own tab only when THIS type would claim it - the
      // same ranking a click on the file in the Files tree uses, so the two
      // routes agree. An extension a shipped preview owns (Markdown, HTML, an
      // image, a PDF) is left in this editor surface on purpose: the user asked
      // for an editor, and handing the tab to a preview would take the file out
      // of the only place that can edit it.
      if (canOpenFile(address) && tab && tab.actions && typeof tab.actions.openResource === 'function') {
        try {
          tab.actions.openResource(address, { replaceTab: tab.id })
          return { replaced: true, path: name }
        } catch (err) {
          // No registered type claims the address after all: keep the file here
          // rather than losing the tab or the save.
        }
      }
      // The surface adopts the file: the document stays open, the chip takes the
      // file's name, and later saves go in place.
      return { adopt: true, path: name, file: { sessionId: sessionId, path: name, mtimeMs: null, size: null } }
    }

    /**
     * One tab's editor: the CodeMirror surface behind a file tab record, or
     * behind the tab's own blank document when `file` is null.
     *
     * The imperative surface is created once per tab id and lives until the tab
     * closes, so it is handed STABLE hooks that read the current tab record on
     * every call: saving the blank document names it and the tab record is then
     * swapped for the created file's own tab, and "Preview" hands the file at
     * the CURRENT record path to the rendered preview.
     */
    function EditorView(props) {
      const hostRef = useRef(null)
      const instanceRef = useRef(null)
      const tab = props.tab
      const sessionId = props.sessionId
      const file = props.file
      const getModals = props.getModals
      const openPreviewRef = useRef(null)
      openPreviewRef.current = props.openPreview
      const fileKey = file ? file.sessionId + '\u0000' + file.path : ''

      const saveAsRef = useRef(null)
      saveAsRef.current = (text) =>
        createNewFile({
          sessionId: sessionId,
          tab: tab,
          text: text,
          modals: typeof getModals === 'function' ? getModals() : undefined,
        })
      const hooksRef = useRef(null)
      if (hooksRef.current === null) {
        hooksRef.current = {
          saveAs: (text) => saveAsRef.current(text),
          openPreview: (address, tabId) => {
            const open = openPreviewRef.current
            if (typeof open !== 'function') throw new Error('The rendered preview is unavailable in this window.')
            return open(address, tabId)
          },
        }
      }

      useEffect(() => {
        const instance = createEditorInstance(hostRef.current, props.tabId, hooksRef.current)
        instanceRef.current = instance
        instance.open(file ? { sessionId: file.sessionId, path: file.path } : null)
        return () => {
          instanceRef.current = null
          instance.dispose()
        }
      }, [props.tabId])

      // A re-navigation of the same record (a second open of the address) may
      // point somewhere else; the instance ignores the file it already shows,
      // and re-entering the blank document never resets what was typed.
      useEffect(() => {
        const instance = instanceRef.current
        if (instance) instance.open(file ? { sessionId: file.sessionId, path: file.path } : null)
      }, [fileKey, props.revision])

      return h('div', { className: 'dse-root', ref: hostRef, 'data-editor-tab': props.tabId })
    }

    /**
     * The tab body dispatched by `sidebar.right.pane.tab`: a file address gets
     * that file's editor, and the tab's own page address gets a blank document.
     */
    function EditorBody(props) {
      const info = props.useTabInfo()
      const tab = info.tab
      const parsed = parseFileAddress(tab.contentId)
      const file = parsed && parsed.scope === 'session' && parsed.path !== '' ? parsed : null
      return h(EditorView, {
        key: tab.id,
        tabId: tab.id,
        tab: tab,
        file: file,
        sessionId: props.sessionId,
        getModals: props.getModals,
        openPreview: props.openPreview,
        revision: tab.navigation.revision,
      })
    }

    /** The chip title: the label this surface set, else the captured title, plus a dot while dirty. */
    function EditorTitle(props) {
      const info = props.useTabInfo()
      const tab = info.tab
      const state = React.useSyncExternalStore(subscribeTabState, () => tabStateOf(tab.id))
      const text = state.label === '' ? tab.title : state.label
      if (!state.dirty) return h('span', null, text)
      return h(
        React.Fragment,
        null,
        h('span', { className: 'dse-titleDot', 'aria-hidden': true }),
        h('span', null, text),
      )
    }

    // ---------------------------------------------------------------------
    // The rendered Markdown view, with the way back to editing.
    //
    // The shipped document preview draws a Markdown file in its own tab (kind
    // `text`) and dispatches the DOCUMENT body through the keyed slot
    // `sidebar.right.tab.document`, keyed by the implementation id its registry
    // selected. This bundle registers the SAME key at a LOWER priority, which is
    // the slot system's shadowing rule (`lowest renders`): the shipped body keeps
    // its metadata, loading/paging, wrap and reload chrome, and only the body
    // itself is ours - so the rendered page can carry the **Edit** toggle that
    // takes the reader back to the editor, which is what makes Preview a toggle
    // instead of a one-way door. Uninstalling this package brings the shipped
    // body back with no residue.
    //
    // The body contract is the shipped one: props `{ resourceAddress, content,
    // wrap, scrollportRef }` from the preview, `t` from the locale named on the
    // registration, and the session tab hooks the slot's declaration injects.
    // ---------------------------------------------------------------------
    /** The document-body slot inside the preview tab. */
    const DOCUMENT_SLOT = 'sidebar.right.tab.document'
    /** The shipped Markdown body's slot key (its implementation id, shadowed by ours). */
    const MARKDOWN_BODY_KEY = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown'
    /** Below the shipped body's default priority (0), which is what shadows it. */
    const DOCUMENT_PRIORITY = -10
    /** The copy namespace this body registers for its own labels. */
    const MARKDOWN_NS = 'dsh-editor.markdown'

    /** The rendered-view copy (MarkdownText's own chrome labels live here too). */
    const zhMarkdown = {
      'md.edit': '\u7f16\u8f91',
      'md.editTitle': '\u5728\u7f16\u8f91\u5668\u4e2d\u7f16\u8f91\u6b64\u6587\u4ef6',
      'md.copy': '\u590d\u5236',
      'md.copied': '\u5df2\u590d\u5236',
      'md.footnotes': '\u811a\u6ce8',
    }
    /** English dictionary, key-identical to the Chinese source of truth. */
    const enMarkdown = {
      'md.edit': 'Edit',
      'md.editTitle': 'Edit this file in the editor',
      'md.copy': 'Copy',
      'md.copied': 'Copied',
      'md.footnotes': 'Footnotes',
    }

    /**
     * The rendered Markdown body: the same page the shipped implementation draws
     * (`MarkdownText` inside the `[data-document-markdown]` root the light paper
     * is scoped to), plus the sticky **Edit** toggle.
     */
    function MarkdownPreviewBody(props) {
      const t = props.t
      const content = props.content
      // Hooks must be called unconditionally, and both are provided by the
      // preview's own child declaration.
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
      const labels = React.useMemo(
        () => ({
          code: { copyLabel: t('md.copy'), copiedLabel: t('md.copied') },
          footnotes: t('md.footnotes'),
        }),
        [t],
      )
      if (!content || content.kind !== 'text') return null
      const address = typeof props.resourceAddress === 'string' ? props.resourceAddress : ''
      const tabId = info && info.tab && typeof info.tab.id === 'string' ? info.tab.id : ''
      const edit = props.edit
      const backToEditor = () => {
        try {
          edit(address, tabId)
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[dsh-editor] could not return to the editor', err && err.message ? err.message : err)
        }
      }
      return h(
        'div',
        { className: 'dse-mdview' },
        h(
          'div',
          { className: 'dse-mdviewBar' },
          h(
            'button',
            {
              type: 'button',
              className: 'dse-mdviewEdit',
              title: t('md.editTitle'),
              'data-markdown-edit': true,
              onClick: backToEditor,
            },
            t('md.edit'),
          ),
        ),
        h(
          'div',
          { className: 'dse-mdviewPaper', 'data-document-markdown': true },
          h(MarkdownText, { text: content.text, streaming: !content.eof, labels: labels }),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // Registry definition
    // ---------------------------------------------------------------------
    function editorDefinition() {
      return {
        id: EDITOR_ID,
        kind: EDITOR_KIND,
        patterns: ['dsh-resource://file/**'],
        // Types from outside the product sit in the highest band, so text files
        // open editable instead of in the shipped read-only preview; `canOpen`
        // hands every file the previews own - and every path outside the
        // session workspace - back to them.
        priority: 'extension',
        canOpen: canOpenFile,
        title: (address) => (address === PAGE_ADDRESS ? 'Editor' : basenameOf(address)),
        guide: [
          {
            order: 20,
            title: () => 'Editor',
            description: () => 'Start a blank text or code file and save it',
            icon: EditorGlyph,
          },
        ],
      }
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------
    /** Services the activation waits for: the slot registry, the bar's tab registry, and copy. */
    const inject = ['locale', 'slots', 'sidebarRightTabs']

    function apply(ctx) {
      pluginCtx = ctx
      /**
       * The shared dialog service (dsh-modal), re-resolved on every use instead
       * of held: it is a service that mounts when its own row lands, and the
       * editor must not depend on it existing. Without it the save dialog falls
       * back to the browser's own prompt.
       */
      function modalsNow() {
        try {
          return ctx.get ? ctx.get(MODAL_SERVICE) : undefined
        } catch (e) {
          return undefined
        }
      }

      /**
       * The kind the shipped document preview registered under, read from the
       * tab-type registry instead of hardcoded: the preview names it itself, and
       * a harness line that renames it would otherwise turn "Preview" into a
       * dead button. Falls back to the pinned line's kind.
       */
      function previewKindNow() {
        try {
          const registry = ctx.get ? ctx.get(TAB_TYPES_SERVICE) : undefined
          const entries = registry && typeof registry.entries === 'function' ? registry.entries() : null
          for (const definition of Array.isArray(entries) ? entries : []) {
            if (definition && definition.id === PREVIEW_TYPE_ID && typeof definition.kind === 'string') {
              return definition.kind
            }
          }
        } catch (e) {}
        return PREVIEW_FALLBACK_KIND
      }

      /**
       * Open one file address in the RENDERED preview, replacing the editor tab
       * that asked for it. The right bar's controller is resolved lazily (the
       * editor is usable without the bar), and the preview type is NAMED, because
       * the registry's ranking would otherwise hand the address straight back to
       * this editor (the `extension` band outranks the preview's `fallback`).
       * @param address - the file address to render.
       * @param tabId - the editor tab to replace.
       */
      function openPreviewNow(address, tabId) {
        const controller = sidebarRightNow()
        if (!controller) {
          throw new Error('The rendered preview is unavailable (the right bar is not mounted).')
        }
        controller.openResource(address, { kind: previewKindNow(), replaceTab: tabId })
      }

      /**
       * The other half of the toggle: hand the rendered file back to THIS editor,
       * named by our own kind (the `extension` band would claim it anyway, but
       * naming it keeps the intent explicit), replacing the preview tab. The tab
       * id comes from the body's own tab record; a body that could not read one
       * falls back to the active tab, and failing that the editor opens beside
       * the preview instead of doing nothing.
       * @param address - the file address to edit.
       * @param tabId - the preview tab to replace, when the body knew it.
       */
      function editFileNow(address, tabId) {
        const controller = sidebarRightNow()
        if (!controller) {
          throw new Error('The editor is unavailable (the right bar is not mounted).')
        }
        let replace = typeof tabId === 'string' && tabId !== '' ? tabId : ''
        if (replace === '') {
          try {
            const active = typeof controller.active === 'function' ? controller.active() : null
            if (active && typeof active.id === 'string') replace = active.id
          } catch (e) {}
        }
        controller.openResource(address, replace === '' ? { kind: EDITOR_KIND } : { kind: EDITOR_KIND, replaceTab: replace })
      }

      /** The right bar's navigation controller, or `null` when it is not mounted. */
      function sidebarRightNow() {
        try {
          const controller = ctx.get ? ctx.get(SIDEBAR_SERVICE) : null
          return controller && typeof controller.openResource === 'function' ? controller : null
        } catch (e) {
          return null
        }
      }

      // Follow the app's color scheme. The theme service's own change event is
      // authoritative once ui-theme is mounted; the body marker (written by
      // ui-layout before the first paint) is both the boot-time answer and the
      // fallback when ui-theme never lands.
      try {
        themeService = ctx.get ? ctx.get(THEME_SERVICE) : null
      } catch (e) {
        themeService = null
      }
      refreshScheme()
      try {
        if (typeof ctx.on === 'function') ctx.on('theme/change', refreshScheme)
      } catch (e) {}
      try {
        const body = typeof document !== 'undefined' ? document.body : null
        if (body && typeof MutationObserver === 'function') {
          const observer = new MutationObserver(() => {
            refreshScheme()
          })
          observer.observe(body, { attributes: true, attributeFilter: [DARK_ATTRIBUTE] })
          ctx.effect(
            () => () => {
              observer.disconnect()
            },
            'dsh-editor: color scheme observer',
          )
        }
      } catch (e) {}
      // The service may land a tick after this row (both are boot plugins): the
      // microtask picks up the resolved scheme once every apply has run.
      Promise.resolve().then(() => {
        themeService = null
        refreshScheme()
      })

      try {
        ctx.effect(() => ctx.sidebarRightTabs.register(editorDefinition()), 'dsh-editor: editor tab type')
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab',
                  key: EDITOR_ID,
                  inject: () => ({ getModals: modalsNow, openPreview: openPreviewNow }),
                },
                EditorBody,
              ),
            ),
          'dsh-editor: editor tab body',
        )
        ctx.effect(
          () =>
            ctx.slots.inject('sidebar.right.pane.tab.title', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.right.pane.tab.title',
                  key: EDITOR_ID,
                },
                EditorTitle,
              ),
            ),
          'dsh-editor: editor tab title',
        )
        ctx.effect(
          () =>
            ctx.locale.register(MARKDOWN_NS, {
              zh: zhMarkdown,
              en: enMarkdown,
            }),
          'dsh-editor: rendered Markdown dictionaries',
        )
        // Shadow the shipped Markdown document body so the rendered page carries
        // the Edit toggle; see the rendered-view section above.
        ctx.effect(
          () =>
            ctx.slots.inject(DOCUMENT_SLOT, () =>
              ctx.slots.register(
                {
                  name: DOCUMENT_SLOT,
                  key: MARKDOWN_BODY_KEY,
                  priority: DOCUMENT_PRIORITY,
                  locale: MARKDOWN_NS,
                  inject: () => ({ edit: editFileNow }),
                },
                MarkdownPreviewBody,
              ),
            ),
          'dsh-editor: rendered Markdown body',
        )
        ctx.logger?.debug?.('[dsh-editor] editor tab type registered (' + PLUGIN_VERSION + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-editor] activation failed', err)
        ctx.logger?.warn?.('[dsh-editor] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.name = 'dsh-editor'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})

// # sourceMappingURL=client.js.map
