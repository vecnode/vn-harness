/**
 * dsh-themes - browser half: the pack's CONVERSATION HEADER package.
 *
 * It owns three controls on that header and the appearance overrides that go
 * with them.
 *
 * 1. THE THEMES CONTROL. One small button, the same size and dress as the
 *    header's other icon buttons, sitting immediately LEFT of the shipped
 *    "Open In..." control (both live in the Session header's
 *    `conversation.session.header.utilities` list; Open In registers at order -10,
 *    this one at -20). Pressing it opens a menu holding the appearances the
 *    product already offers - Light, Dark, System, exactly the choice Settings >
 *    General > Appearance presents - plus every theme REGISTERED into the shipped
 *    registry (this pack's own **Nord** and **Monokai**, alpha.12/alpha.13). The
 *    button wears ONE static "appearance" mark (alpha.12) rather than the active
 *    preference's sun/moon: a
 *    registered palette has no shipped glyph to wear, and the menu - and the
 *    tooltip, which names the active theme - is where the choice is.
 *
 *    The preference itself is NOT owned here. `@deepseek-ai/dsh-client-ui-theme`
 *    owns it (`theme` client service): it persists the choice in the `ui-theme`
 *    settings namespace, resolves `system` through `prefers-color-scheme`, and
 *    ui-layout applies each snapshot to the document (`body[data-ds-dark-theme]`,
 *    the `--dsw-*` tokens). This bundle only reads the published snapshot and
 *    calls `setTheme(id)`, so the header control and the Settings row are the same
 *    switch, and a change made in either place lands in the other.
 *
 *    It also REGISTERS themes through that same service (`ctx.theme.register`) -
 *    the shipped extension point for a third-party palette - and builds the menu
 *    from the registry's own list, so a theme added to this package becomes
 *    selectable by being registered, not by being listed in two places. See the
 *    theme-extensions section below.
 *
 *    The service is resolved lazily (`ctx.get('theme')`), never declared in the
 *    editor-style hard dependency list: a profile that never mounts ui-theme keeps
 *    its header intact, and this control simply reports that the theme service is
 *    unavailable instead of taking another plugin's activation down with it.
 *
 * 2. THE SESSION-LOG DOWNLOAD SEAT (alpha.9). The shipped
 *    `@deepseek-ai/dsh-session-log-export` browser half put a three-dot "more
 *    actions" button into that same utilities list whose menu held exactly ONE
 *    item, "Download session log" - one click to open a menu, a second to pick
 *    the only thing in it. This bundle registers the SHIPPED occupant's id at a
 *    LOWER slot priority, which is a list slot's own shadowing rule (`lowest
 *    renders`), so the seat draws one plain download icon button that starts the
 *    export on the first click. The export is NOT reimplemented: the shipped row
 *    stays mounted (it owns the host half - `/api/session.export` and the
 *    `/export` command) and this control calls the controller its browser half
 *    publishes, so the button and `/export` share one implementation and one busy
 *    state. The seat's preparing/success/error dialog is rendered here from that
 *    same store, so `/export` keeps its feedback. See the download seat section
 *    below.
 *
 * 3. THE SCREENSHOT CONTROL (alpha.10). One more button on the same row, left of
 *    the Themes control (order -30 against its -20), which captures the WHOLE
 *    window - the app is a fixed-viewport shell, so its 100% width and 100%
 *    height are exactly what fills the tab - and saves the PNG to the Desktop of
 *    the machine running the app. The capture itself can only happen in this
 *    page: `getDisplayMedia` asks the browser for the current tab's own surface,
 *    one frame is drawn into a canvas and encoded as a PNG. Real pixels, so what
 *    the app draws with canvas (the terminal dock's xterm surface), with
 *    compositor effects or inside an open dialog is in the picture - which is
 *    why this is used instead of a DOM-to-canvas library.
 *
 *    The FILE does not go through the browser's downloads: the PNG is POSTed to
 *    this package's own host route (`/api/dsh-themes/screenshot`), which writes
 *    it to the host's Desktop under `vn-harness-<timestamp>.png` and answers the
 *    path, so one click produces a real file on the host with no save dialog and
 *    no clutter in the download folder. A profile that runs this bundle without
 *    its Node half still gets the picture: the browser's own download is the
 *    fallback, and the toast says which of the two happened. See the screenshot
 *    section below.
 *
 * It also carries the pack's appearance OVERRIDES - rules that hold one surface
 * on a fixed palette regardless of the app theme, or give a core surface the
 * frame's own dress. The first (alpha.2) is the
 * Markdown paper: the RENDERED Markdown view the shipped document preview draws
 * keeps a white page in the dark theme, by re-declaring ui-theme's own light
 * declarations on its root (see the paper section below). The second (alpha.3) is
 * the Markdown **chrome** override: a rendered Markdown page has one viewer, so
 * the preview header's viewer menu - which the shipped implementation fills with
 * "Markdown" and the plain-text fallback - is hidden on Markdown tabs (the way
 * to the editable surface is the editor's own **Edit** button on the page). The
 * third (alpha.4) is the left column's **top bar**: the sidebar's branding row
 * becomes the same 76px band, ending in the same hairline, that the middle and
 * right columns already open with (see the top bar section below). The fourth
 * (alpha.9) is the **header ring**: the right bar's own collapse/expand toggle in
 * the header corner is the one icon button on that bar that could not be given
 * the group's round outline where it lives (it belongs to a GENERATED forked
 * bundle), so one rule keyed on the header's stable corner marker gives it the
 * same ring this package's two header buttons draw themselves. All four are plain
 * engine-neutral CSS, so they hold in every browser the Web GUI runs in.
 *
 * Module-table format of every core client package; no build step.
 */
/* global window, document */
window.__ModuleLoader__.load({
  id: 'dsh-themes',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const { Button, Menu, Modal, Toast, Tooltip } = primitives
    /** The shipped download glyph the removed Session-log menu item carried. */
    const DownloadGlyph = primitives.IconDownloadOutline16
    /** The status glyphs the screenshot toast wears (the shipped check / warning pair). */
    const CheckGlyph = primitives.IconCheckOutline16
    const WarningGlyph = primitives.IconWarningOutline16

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------
    /** The slot id of the Themes occupant in the header utilities list. */
    const THEMES_ID = 'dsh-themes'
    /** Version marker, logged at activation so a fresh bundle is easy to verify. */
    const PLUGIN_VERSION = '0.1.0-alpha.10'
    /** The client service (@deepseek-ai/dsh-client-ui-theme) that owns the preference. */
    const THEME_SERVICE = 'theme'
    /** The Session header's utilities slot (the group the Open In control sits in). */
    const HEADER_SLOT = 'conversation.session.header.utilities'
    /** Order of the shipped Open In control in that slot; this one sits to its left. */
    const OPEN_IN_APP_ORDER = -10
    /** This control's order: below Open In's, so the list renders it first. */
    const HEADER_ORDER = -20
    /** The locale namespace owning every control's copy in this package. */
    const LOCALE_NS = 'themes'
    /**
     * The Session-log download seat (alpha.9): the SHIPPED occupant's own id. A
     * list slot renders one occupant per id - the lowest priority registration -
     * so sharing the id with the shipped three-dot button is exactly what makes
     * this package's download button the rendered one.
     */
    const DOWNLOAD_SEAT_ID = 'session-log-download'
    /** The seat's order (the shipped occupant's own), so the button does not move. */
    const DOWNLOAD_SEAT_ORDER = 0
    /** One below the shipped occupant's default `0`: lower renders, so this one wins. */
    const DOWNLOAD_SEAT_PRIORITY = -10
    /**
     * The shipped client service that owns the export
     * (`@deepseek-ai/dsh-session-log-export`'s browser half:
     * `download(sessionId)` / `dismiss(sessionId)` / `.store`).
     */
    const DOWNLOAD_SERVICE = 'sessionLogDownload'
    /**
     * The screenshot control (alpha.10): its occupant id in the same utilities
     * list, and its order - one step LEFT of the Themes control, because a list
     * slot renders lowest order first.
     */
    const SCREENSHOT_ID = 'dsh-themes-screenshot'
    const SCREENSHOT_ORDER = HEADER_ORDER - 10
    /** The host route that writes the PNG to this machine's Desktop. */
    const SCREENSHOT_ROUTE = '/api/dsh-themes/screenshot'
    /** The saved file's name pattern, the same one the Node half falls back to. */
    const SCREENSHOT_PREFIX = 'vn-harness-'
    /**
     * The app mark, from `assets/vn-harness.svg` at the pack root: a black circle
     * centred on (12,12) in its own 24px box, with a 1px transparent margin.
     *
     * The margin is the point. The mark is drawn into boxes the app paints with
     * `overflow:hidden` - the sidebar's brand button is exactly 24px tall - and an
     * edge-to-edge circle loses a fraction of a pixel on each side there, which is
     * what alpha.7's disc looked like. The artwork carries the inset instead, so no
     * container can shave it.
     *
     * Inlined as a data URI rather than served: the mark is a few hundred bytes and
     * this way the branding needs no route, no request and no Node half (the
     * package's row is a deliberate no-op). The asset file stays the source of
     * truth, and the tracked check compares this URI's geometry against it so the
     * two cannot drift.
     */
    const MARK_ICON =
      'data:image/svg+xml,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="#000000"/></svg>')
    /** The empty-conversation hero's mark box, where its whale sits (34x25). */
    const HERO_MARK_SLOT_CLASS = '.pXSMma_fishHitbox'
    /** The icon's size in the hero: the headline is 26px on a 32px line. */
    const HERO_MARK_SIZE = 26

    // ---------------------------------------------------------------------
    // Styles - the header's own icon-button dress (28px square, 28px radius,
    // 6px padding, a 15px glyph), so the controls in this package are the size
    // of the ones beside them in both appearances. Both of them share the class.
    //
    // alpha.9 adds the hairline RING. The bar's icon buttons are meant to read
    // as one group, and the pack's terminal control (`.dst-btn`, which is also
    // the dress the shipped `session-log-download` more-button and the bar's own
    // toggle were cut from) wears a `.5px` outline; this package's buttons wore
    // none, so they sat bare among them. The ring is `--dsw-alias-border-l3` -
    // the token the terminal control already uses - and `box-sizing:border-box`
    // keeps the box exactly 28px with the outline inside it.
    //
    // alpha.10 added the CAPTURE rule; alpha.11 narrows it to the tooltip alone.
    // The screenshot control marks the document (`html[data-dsh-screenshot]`, set
    // for the one frame it grabs) and this rule takes the open TOOLTIP BUBBLE out
    // of that frame: a hover card is not part of the interface, and the pointer is
    // still parked on the button that started the capture. The controls
    // themselves stay in the picture - this header IS the interface being
    // photographed, and a shot that silently dropped the three buttons this
    // package owns was a hole in the record. The selector is the shipped Tooltip's
    // own semantic marker (`role="tooltip"` on its bubble span), never a hashed
    // class, so it holds for every Tooltip in the app and cannot drift with the
    // harness line.
    // ---------------------------------------------------------------------
    const css = `
.dst-slot{display:inline-flex;align-items:center}
.dst-button{width:28px;height:28px;box-sizing:border-box;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:28px;flex:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}
.dst-button svg{width:15px;height:15px}
.dst-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dst-button:disabled{cursor:default;opacity:.5}
.dst-button:focus-visible{outline:.5px solid var(--dsw-alias-state-accent,#4f8cff);outline-offset:1px}
html[data-dsh-screenshot] [role=tooltip]{visibility:hidden}
`
    const CSS_TAG = 'dsh-themes/themes.css'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-themes'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------------
    // Dictionaries (the control's own copy - the product's Appearance row
    // words the same three choices, but its namespace belongs to ui-theme).
    // ---------------------------------------------------------------------
    /** Simplified Chinese dictionary (the key-set source of truth). */
    const zh = {
      'theme.title': '主题',
      'theme.light': '浅色',
      'theme.dark': '深色',
      'theme.system': '跟随系统',
      'theme.nord': 'Nord',
      'theme.monokai': 'Monokai',
      'theme.current': '主题：{name}',
      'theme.menu': '选择应用主题',
      'theme.unavailable': '主题服务不可用',
      'download.title': '下载 Session 日志',
      'download.busy': '正在准备 Session 压缩包',
      'download.unavailable': 'Session 导出不可用',
      'download.preparingTitle': '正在导出 Session',
      'download.preparingDescription': '正在准备包含当前 Session、子 Session 和附件的 ZIP 文件。',
      'download.successTitle': 'Session 导出已开始下载',
      'download.successDescription': '浏览器正在下载 Session ZIP 文件。',
      'download.errorTitle': 'Session 导出失败',
      'download.close': '关闭',
      'download.commandFailed': '无法启动 Session 导出。',
      'screenshot.title': '截图并保存到桌面',
      'screenshot.busy': '正在截图',
      'screenshot.saved': '截图已保存到 {path}',
      'screenshot.downloaded': '截图已交给浏览器下载',
      'screenshot.failed': '截图失败',
      'screenshot.unsupported': '当前环境不支持网页截图（需要 HTTPS 或 localhost）',
      'screenshot.cancelled': '截图已取消',
    }
    /** English dictionary, key-identical to the Chinese source of truth. */
    const en = {
      'theme.title': 'Theme',
      'theme.light': 'Light',
      'theme.dark': 'Dark',
      'theme.system': 'System',
      'theme.nord': 'Nord',
      'theme.monokai': 'Monokai',
      'theme.current': 'Theme: {name}',
      'theme.menu': 'Choose the app theme',
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

    /** The three preferences ui-theme owns, in the Settings row's order. */
    const PREFERENCES = [
      { id: 'light', label: 'theme.light', Icon: primitives.IconLightOutline16 },
      { id: 'dark', label: 'theme.dark', Icon: primitives.IconDarkOutline16 },
      { id: 'system', label: 'theme.system', Icon: primitives.IconFollowsystemOutline16 },
    ]

    /**
     * What the control renders when the theme service has not answered: the
     * product's own default preference. `revision: -1` marks it as "unknown",
     * so the first real snapshot always replaces it.
     */
    const UNKNOWN_SNAPSHOT = Object.freeze({
      preference: 'system',
      active: Object.freeze({ id: 'system', colorScheme: 'light' }),
      revision: -1,
    })

    // ---------------------------------------------------------------------
    // THEME EXTENSIONS (alpha.12).
    //
    // The themes this pack ADDS to the shipped registry, and the single glyph
    // the header button wears.
    //
    // THE EXTENSION POINT IS THE SHIPPED ONE. `ctx.theme`
    // (`@deepseek-ai/dsh-client-ui-theme`) is a real registry:
    // `register({ id, colorScheme, tokens })` adds a theme whose alias-token
    // overrides ui-layout's presenter writes as INLINE CSS variables on `body`,
    // over whichever base palette `colorScheme` selects; `getTheme()` publishes
    // every registered theme in `snapshot.themes`; `setTheme(id)` selects one.
    // Nothing about the theme system is reimplemented here - this package
    // registers palettes, and the control's menu is built FROM THE REGISTRY, so
    // adding a theme is registering it and nothing else.
    //
    // WHY THE ALIAS LAYER, NOT THE `--dsw-static-*` RAMP. A static is shared by
    // roles that are not the same role (in the dark palette
    // `neutral-bluish-50` is both the primary label and the brand fill), so
    // recoloring the ramp drags unrelated surfaces along with it. The alias
    // layer is the semantic one, and it is the layer ui-theme documents as the
    // third-party surface.
    //
    // WHAT IS NOT PERSISTED. ui-theme's durable preference schema accepts
    // `light` / `dark` / `system` only, so an extension theme is an IN-PROCESS
    // choice: `setTheme('nord')` applies at once, and a reload (or a settings
    // re-adopt) returns to the durable built-in. That is the shipped boundary,
    // not something this registration can lift - which is also why nothing here
    // remembers the choice behind the service's back.
    // ---------------------------------------------------------------------
    /**
     * The Themes control's glyph: a half-filled disc.
     *
     * The button used to wear the ACTIVE preference's own icon - a sun for
     * Light, a moon for Dark, a display for System - which made one button mean
     * three things and had nothing to draw for a registered theme. It now draws
     * one "appearance" mark whatever is active; the menu, and the tooltip that
     * names the active theme, carry the choice. Drawn here in the weight of the
     * icons beside it (a 16px box, a 1.2px `currentColor` outline), because the
     * shipped primitive set has no palette/appearance glyph.
     */
    function IconThemeOutline16(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        // The filled half first, so the outline sits on top of it.
        h('path', { d: 'M8 2.4A5.6 5.6 0 0 1 8 13.6Z', fill: 'currentColor', stroke: 'none' }),
        h('circle', { cx: '8', cy: '8', r: '5.6' }),
      )
    }

    /**
     * Nord's own glyph in the menu: a six-spoke snowflake - the palette is named
     * for the north, and a registered theme is allowed to look like itself. Same
     * 16px box and the same 1.2px weight as every other glyph in that menu.
     */
    function IconSnowflakeOutline16(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M8 2.6v10.8' }),
        h('path', { d: 'M3.32 5.3 12.68 10.7' }),
        h('path', { d: 'M12.68 5.3 3.32 10.7' }),
      )
    }

    /**
     * Monokai's own glyph in the menu: a pair of braces - the palette is a
     * syntax-highlighting scheme, and braces are the mark it is usually drawn
     * with. Same 16px box and the same 1.2px weight as every other glyph in that
     * menu.
     */
    function IconBracesOutline16(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', {
          d: 'M6.5 2.5c-1.5 0-2 1-2 2.2 0 1.3-.2 1.9-1.5 2.3 1.3.4 1.5 1 1.5 2.3 0 1.2.5 2.2 2 2.2',
        }),
        h('path', {
          d: 'M9.5 2.5c1.5 0 2 1 2 2.2 0 1.3.2 1.9 1.5 2.3-1.3.4-1.5 1-1.5 2.3 0 1.2-.5 2.2-2 2.2',
        }),
      )
    }

    /**
     * NORD (nordtheme.com) on the DARK base palette: Polar Night surfaces
     * (`nord0`-`nord3`), Snow Storm text (`nord4`-`nord6`), Frost accents
     * (`nord7`-`nord10`) and Aurora states (`nord11`-`nord15`).
     *
     * Every name here is an alias the app already asks for, so the palette
     * reaches the surfaces the shipped dark palette reaches: the bars, the
     * panes, menus, buttons, code blocks, scrollbars, tooltips and the four
     * state colours. Aliases NOT named here keep their shipped dark value - the
     * scrims (`bg-mask-*`), the elevation strokes and the shadow scale are
     * scheme-neutral black/white alphas and read correctly on Polar Night
     * unchanged.
     */
    const NORD_TOKENS = Object.freeze({
      // Polar Night: the surface ladder, page -> raised -> elevated. `nord0` is
      // the page for the conversation AND the sidebar, the way vscode-nord
      // draws editor and sidebar alike; the columns are separated by the frame's
      // own hairline, not by a lighter rail.
      '--dsw-alias-bg-base': '#2e3440',
      '--dsw-specific-sidebar-fill': '#2e3440',
      '--dsw-alias-bg-layer-1': '#3b4252',
      '--dsw-alias-bg-layer-2': '#3b4252',
      '--dsw-alias-bg-layer-3': '#434c5e',
      '--dsw-alias-bg-overlay': '#434c5e',
      '--dsw-alias-bg-module-platform': '#3b4252',
      '--dsw-alias-bg-multi-select': '#434c5e',
      '--dsw-alias-bg-skeleton': '#d8dee914',
      '--dsw-specific-menu': '#434c5e',
      '--dsw-specific-selector': '#434c5e',
      '--dsw-specific-bubble': '#3b4252',
      '--dsw-specific-bubble-highlight': '#434c5e',
      '--dsw-specific-input-major': '#3b4252',
      '--dsw-specific-login-input': '#2e3440',
      '--dsw-specific-sidebar-nav-item-hover': '#3b4252',
      '--dsw-specific-sidebar-nav-item-active': '#434c5e',
      '--dsw-specific-sidebar-nav-item-active-accent': '#4c566a',
      '--dsw-specific-tip': '#3b4252',
      '--dsw-alias-tooltip-bg': '#434c5e',
      '--dsw-alias-toast-bg': '#434c5e',
      // Snow Storm and Frost: the text ladder. `nord6` is the body, `nord4`
      // the secondary tier, `nord9` the muted one.
      '--dsw-alias-label-primary': '#eceff4',
      '--dsw-alias-label-primary-bluish': '#eceff4',
      '--dsw-alias-label-primary-dimmed': '#d8dee9',
      '--dsw-alias-label-primary-inverted': '#2e3440',
      '--dsw-alias-label-primary-foreground': '#2e3440',
      '--dsw-alias-label-secondary': '#d8dee9',
      '--dsw-alias-label-tertiary': '#81a1c1',
      '--dsw-alias-label-caption': '#81a1c1',
      '--dsw-alias-label-dimmed': '#4c566a',
      // Frost: the accent. `nord8` is the brand (switches, focus rings, the
      // primary button), `nord9` the quieter interaction, `nord10` the pressed
      // step; a dark `nord0` foreground keeps light-blue fills legible.
      '--dsw-alias-brand-primary': '#88c0d0',
      '--dsw-alias-brand-primary-invert': '#2e3440',
      // The right bar's active-tab caret and the dock hint accent read this one,
      // not `brand-primary` (ui-sidebar-right's own generated token name), so
      // Nord has to name it too or a DeepSeek blue would mark the active tab.
      '--dsw-alias-brand-primary-new-colorprimary-new-color': '#88c0d0',
      '--dsw-alias-brand-text': '#88c0d0',
      '--dsw-alias-link': '#88c0d0',
      '--dsw-alias-button-primary-fill': '#88c0d0',
      '--dsw-alias-button-primary-hover': '#8fbcbb',
      '--dsw-alias-button-primary-dimmed': '#5e81ac',
      '--dsw-alias-button-info-fill': '#81a1c1',
      '--dsw-alias-button-info-hover': '#5e81ac',
      '--dsw-alias-button-contrast-fill': '#eceff4',
      '--dsw-alias-button-elevated-fill': '#4c566a',
      // The floating tool-bar chip (the code block's own toolbar) is a
      // translucent grey by default: the same weight, tinted Polar Night.
      '--dsw-alias-button-tool-bar-fill': '#4c566a80',
      '--dsw-alias-button-tool-bar-hover': '#4c566a99',
      '--dsw-alias-button-floating-fill': '#3b4252',
      '--dsw-alias-button-floating-hover': '#434c5e',
      '--dsw-alias-button-ghost-active-border': '#81a1c1',
      '--dsw-alias-button-ghost-active-fill': '#4c566a',
      '--dsw-alias-button-ghost-active-hover': '#434c5e',
      // The interaction washes and the card borders: the shipped palette uses
      // white alphas on dark, so these are the same weights tinted with Snow
      // Storm instead - the blue cast is what makes them read as Nord.
      '--dsw-alias-interactive-bg-hover': '#d8dee91a',
      '--dsw-alias-interactive-bg-hover-solid': '#434c5e',
      '--dsw-alias-interactive-bg-hover-accent': '#88c0d040',
      '--dsw-alias-interactive-bg-hover-danger': '#bf616a2e',
      '--dsw-alias-interactive-bg-active': '#d8dee926',
      '--dsw-alias-border-inverted': '#d8dee90f',
      '--dsw-alias-border-inverted2': '#d8dee914',
      '--dsw-alias-border-l1': '#d8dee90f',
      '--dsw-alias-border-l2': '#d8dee921',
      '--dsw-alias-border-l2-darkmode-thin': '#d8dee90f',
      '--dsw-alias-border-l3': '#d8dee92e',
      '--dsw-alias-border-l4': '#d8dee938',
      // Aurora: the four states. Tertiary steps are the same hue as a wash, the
      // way the shipped palette uses its darkest static for those slots.
      '--dsw-alias-state-error-primary': '#bf616a',
      '--dsw-alias-state-error-secondary': '#bf616a',
      '--dsw-alias-state-success-primary': '#a3be8c',
      '--dsw-alias-state-success-secondary': '#a3be8c',
      '--dsw-alias-state-success-tertiary': '#a3be8c2e',
      '--dsw-alias-state-warn-primary': '#ebcb8b',
      '--dsw-alias-state-warn-secondary': '#d08770',
      '--dsw-alias-state-warn-label': '#ebcb8b',
      '--dsw-alias-state-warn-tertiary': '#ebcb8b2e',
      '--dsw-alias-state-business-primary': '#81a1c1',
      '--dsw-alias-state-business-tertiary': '#5e81ac',
      // Code: a block sits one step ABOVE the page (`nord1`), its banner and the
      // inline chip one more (`nord2`), so a fence is visible without a border.
      '--dsw-alias-markdown-code-block': '#3b4252',
      '--dsw-alias-markdown-code-block-banner': '#434c5e',
      '--dsw-alias-markdown-code-segment-selected': '#434c5e',
      '--dsw-alias-markdown-code-segment-unselected': '#3b4252',
      '--dsw-alias-markdown-inline-code': '#434c5e',
      '--dsw-alias-markdown-placeholder': '#3b4252',
      '--dsw-alias-markdown-tag': '#434c5e',
      '--dsw-alias-markdown-citation': '#3b4252',
      // Syntax highlighting, on the same rules nord-vim follows: keywords and
      // constants in Frost, strings and comments in Aurora/Snow, functions in
      // `nord8`, punctuation in `nord6`.
      '--shiki-token-keyword': '#81a1c1',
      '--shiki-token-constant': '#b48ead',
      '--shiki-token-string': '#a3be8c',
      '--shiki-token-string-expression': '#a3be8c',
      '--shiki-token-comment': '#81a1c1',
      '--shiki-token-parameter': '#d08770',
      '--shiki-token-function': '#88c0d0',
      '--shiki-token-punctuation': '#eceff4',
      '--shiki-token-link': '#88c0d0',
      // Scrollbars: the shipped pair is bound to the l1/l2 surface tokens, so
      // the thumb is a Polar Night step and its hover the Frost accent.
      '--dsw-alias-scrollbar-bg-l1': '#434c5e',
      '--dsw-alias-scrollbar-bg-l2': '#4c566a',
      '--dsw-alias-scrollbar-hover-l1': '#4c566a',
      '--dsw-alias-scrollbar-hover-l2': '#5e81ac',
    })

    /**
     * MONOKAI (monokai.nl) on the DARK base palette: the classic TextMate theme
     * Wimer Hazenberg wrote for Coda - the near-black warm page (`#272822`), the
     * off-white body (`#f8f8f2`), the pink keywords (`#f92672`), the cyan types
     * (`#66d9ef`), the yellow strings (`#e6db74`), the green functions
     * (`#a6e22e`), the orange parameters (`#fd971f`), the purple constants
     * (`#ae81ff`) and the olive comment grey (`#75715e`), with the theme's own
     * line highlight (`#3e3d32`) and selection (`#49483e`) as the surface steps.
     *
     * Same rules as Nord above: every name is an alias the app already asks for,
     * so the palette reaches the bars, panes, menus, buttons, code blocks,
     * scrollbars, tooltips and the four state colours, and the aliases NOT named
     * here keep their shipped dark value (the scheme-neutral scrims, elevation
     * strokes and shadow scale).
     *
     * Where the classic palette has no second step for a hover or a pressed
     * fill, the step is DERIVED from the palette's own colour rather than
     * invented: the pink lightens to Monokai Pro's `#ff6188` on hover and
     * darkens to `#b31b52` when dimmed, the cyan lifts a fifth toward white for
     * its hover, and the two text tiers between the body and the comment grey
     * are the body darkened 12% (`#dadad5`) and the comment grey lifted halfway
     * back to the body (`#b6b4a8`).
     */
    const MONOKAI_TOKENS = Object.freeze({
      // The surfaces. The page is the classic `#272822`, the raised step is the
      // theme's line highlight (`#3e3d32`) and the selection (`#49483e`) is the
      // highest one - so a menu, a bubble and a selected row read as steps of the
      // same near-black, the way the editor draws them.
      '--dsw-alias-bg-base': '#272822',
      '--dsw-specific-sidebar-fill': '#272822',
      '--dsw-alias-bg-layer-1': '#2f3029',
      '--dsw-alias-bg-layer-2': '#2f3029',
      '--dsw-alias-bg-layer-3': '#3e3d32',
      '--dsw-alias-bg-overlay': '#3e3d32',
      '--dsw-alias-bg-module-platform': '#2f3029',
      '--dsw-alias-bg-multi-select': '#3e3d32',
      '--dsw-alias-bg-skeleton': '#f8f8f214',
      '--dsw-specific-menu': '#3e3d32',
      '--dsw-specific-selector': '#3e3d32',
      '--dsw-specific-bubble': '#2f3029',
      '--dsw-specific-bubble-highlight': '#3e3d32',
      '--dsw-specific-input-major': '#2f3029',
      '--dsw-specific-login-input': '#272822',
      '--dsw-specific-sidebar-nav-item-hover': '#2f3029',
      '--dsw-specific-sidebar-nav-item-active': '#3e3d32',
      '--dsw-specific-sidebar-nav-item-active-accent': '#49483e',
      '--dsw-specific-tip': '#2f3029',
      '--dsw-alias-tooltip-bg': '#3e3d32',
      '--dsw-alias-toast-bg': '#3e3d32',
      // The text ladder: the body is the off-white `#f8f8f2`, the two quieter
      // tiers its 12% darker step and the comment grey lifted halfway back to it,
      // and the quietest is the palette's own `#75715e`.
      '--dsw-alias-label-primary': '#f8f8f2',
      '--dsw-alias-label-primary-bluish': '#f8f8f2',
      '--dsw-alias-label-primary-dimmed': '#dadad5',
      '--dsw-alias-label-primary-inverted': '#272822',
      '--dsw-alias-label-primary-foreground': '#272822',
      '--dsw-alias-label-secondary': '#dadad5',
      '--dsw-alias-label-tertiary': '#b6b4a8',
      '--dsw-alias-label-caption': '#b6b4a8',
      '--dsw-alias-label-dimmed': '#75715e',
      // The accent. Monokai's signature is the pink it paints keywords with, so
      // that is the brand (switches, focus rings, the primary button) and a dark
      // `#272822` foreground keeps the fill legible; links take the cyan the
      // palette paints types with, which reads better than pink for body copy.
      '--dsw-alias-brand-primary': '#f92672',
      '--dsw-alias-brand-primary-invert': '#272822',
      // The right bar's active-tab caret and the dock hint accent read this one,
      // not `brand-primary` (ui-sidebar-right's own generated token name), so
      // Monokai has to name it too or a DeepSeek blue would mark the active tab.
      '--dsw-alias-brand-primary-new-colorprimary-new-color': '#f92672',
      '--dsw-alias-brand-text': '#f92672',
      '--dsw-alias-link': '#66d9ef',
      '--dsw-alias-button-primary-fill': '#f92672',
      '--dsw-alias-button-primary-hover': '#ff6188',
      '--dsw-alias-button-primary-dimmed': '#b31b52',
      '--dsw-alias-button-info-fill': '#66d9ef',
      '--dsw-alias-button-info-hover': '#85e1f2',
      '--dsw-alias-button-contrast-fill': '#f8f8f2',
      '--dsw-alias-button-elevated-fill': '#49483e',
      // The floating tool-bar chip (the code block's own toolbar) is a
      // translucent grey by default: the same weight, tinted with the selection.
      '--dsw-alias-button-tool-bar-fill': '#49483e80',
      '--dsw-alias-button-tool-bar-hover': '#49483e99',
      '--dsw-alias-button-floating-fill': '#3e3d32',
      '--dsw-alias-button-floating-hover': '#49483e',
      '--dsw-alias-button-ghost-active-border': '#66d9ef',
      '--dsw-alias-button-ghost-active-fill': '#49483e',
      '--dsw-alias-button-ghost-active-hover': '#3e3d32',
      // The interaction washes and the card borders: the shipped palette uses
      // white alphas on dark, so these are the same weights tinted with the
      // off-white body instead - the warm cast is what makes them read as Monokai.
      '--dsw-alias-interactive-bg-hover': '#f8f8f21a',
      '--dsw-alias-interactive-bg-hover-solid': '#49483e',
      '--dsw-alias-interactive-bg-hover-accent': '#f9267240',
      '--dsw-alias-interactive-bg-hover-danger': '#f926722e',
      '--dsw-alias-interactive-bg-active': '#f8f8f226',
      '--dsw-alias-border-inverted': '#f8f8f20f',
      '--dsw-alias-border-inverted2': '#f8f8f214',
      '--dsw-alias-border-l1': '#f8f8f20f',
      '--dsw-alias-border-l2': '#f8f8f221',
      '--dsw-alias-border-l2-darkmode-thin': '#f8f8f20f',
      '--dsw-alias-border-l3': '#f8f8f22e',
      '--dsw-alias-border-l4': '#f8f8f238',
      // The four states, in the palette's own language: pink for an error (that
      // is the colour Monokai marks a bad token with), green for success, the
      // yellow/orange pair for a warning and the cyan for business.
      '--dsw-alias-state-error-primary': '#f92672',
      '--dsw-alias-state-error-secondary': '#f92672',
      '--dsw-alias-state-success-primary': '#a6e22e',
      '--dsw-alias-state-success-secondary': '#a6e22e',
      '--dsw-alias-state-success-tertiary': '#a6e22e2e',
      '--dsw-alias-state-warn-primary': '#e6db74',
      '--dsw-alias-state-warn-secondary': '#fd971f',
      '--dsw-alias-state-warn-label': '#e6db74',
      '--dsw-alias-state-warn-tertiary': '#e6db742e',
      '--dsw-alias-state-business-primary': '#66d9ef',
      '--dsw-alias-state-business-tertiary': '#ae81ff',
      // Code: a block sits one step ABOVE the page (the line highlight), its
      // banner and the inline chip one more (the selection), so a fence is
      // visible without a border.
      '--dsw-alias-markdown-code-block': '#3e3d32',
      '--dsw-alias-markdown-code-block-banner': '#49483e',
      '--dsw-alias-markdown-code-segment-selected': '#49483e',
      '--dsw-alias-markdown-code-segment-unselected': '#3e3d32',
      '--dsw-alias-markdown-inline-code': '#49483e',
      '--dsw-alias-markdown-placeholder': '#3e3d32',
      '--dsw-alias-markdown-tag': '#49483e',
      '--dsw-alias-markdown-citation': '#3e3d32',
      // Syntax highlighting: the classic Monokai roles, unchanged - keywords and
      // tags pink, constants purple, strings yellow, comments the olive grey,
      // parameters orange, functions green, punctuation the off-white body.
      '--shiki-token-keyword': '#f92672',
      '--shiki-token-constant': '#ae81ff',
      '--shiki-token-string': '#e6db74',
      '--shiki-token-string-expression': '#e6db74',
      '--shiki-token-comment': '#75715e',
      '--shiki-token-parameter': '#fd971f',
      '--shiki-token-function': '#a6e22e',
      '--shiki-token-punctuation': '#f8f8f2',
      '--shiki-token-link': '#66d9ef',
      // Scrollbars: the shipped pair is bound to the l1/l2 surface tokens, so
      // the thumb is a Monokai surface step and its hover the pink accent.
      '--dsw-alias-scrollbar-bg-l1': '#3e3d32',
      '--dsw-alias-scrollbar-bg-l2': '#49483e',
      '--dsw-alias-scrollbar-hover-l1': '#49483e',
      '--dsw-alias-scrollbar-hover-l2': '#f92672',
    })

    /**
     * The themes this package registers, in menu order. Adding one is one entry
     * here plus its copy (`theme.<id>`, in both dictionaries); the registration
     * below is what makes it selectable, and the menu picks it up from the
     * registry without being told about it anywhere else.
     */
    const THEME_EXTENSIONS = Object.freeze([
      Object.freeze({
        id: 'nord',
        label: 'theme.nord',
        colorScheme: 'dark',
        tokens: NORD_TOKENS,
        Icon: IconSnowflakeOutline16,
      }),
      Object.freeze({
        id: 'monokai',
        label: 'theme.monokai',
        colorScheme: 'dark',
        tokens: MONOKAI_TOKENS,
        Icon: IconBracesOutline16,
      }),
    ])

    /** Theme ids this row has registered and not given back. */
    const REGISTERED_EXTENSIONS = new Set()
    /** Ids another plugin already owns: reported once, not on every retry. */
    const REFUSED_EXTENSIONS = new Set()

    /**
     * Put this pack's themes into the shipped registry.
     *
     * IDEMPOTENT AND RE-ENTRANT. ui-theme may provide its service a tick after
     * this row activates - the same reason the control re-reads its snapshot on
     * the next microtask - so this is called again on that tick and on every
     * `theme/change` while one of our themes is still missing. A profile without
     * ui-theme simply has nothing to register into. An id taken by ANOTHER
     * plugin is REPORTED once and never thrown: one refused theme must not take
     * the header control down with it. The id is claimed BEFORE the service is
     * asked, because `register` publishes synchronously and the re-entrant call
     * that publish makes must not try the same id a second time.
     * @param ctx - the owning client context.
     * @returns whether every theme of this package is registered.
     */
    function registerThemeExtensions(ctx) {
      let service = null
      try {
        const resolved = typeof ctx.get === 'function' ? ctx.get(THEME_SERVICE) : undefined
        if (resolved && typeof resolved.register === 'function' && typeof resolved.setTheme === 'function') service = resolved
      } catch (e) {
        service = null
      }
      if (service === null) return false
      let complete = true
      for (const theme of THEME_EXTENSIONS) {
        if (REGISTERED_EXTENSIONS.has(theme.id)) continue
        if (REFUSED_EXTENSIONS.has(theme.id)) {
          complete = false
          continue
        }
        REGISTERED_EXTENSIONS.add(theme.id)
        let dispose = null
        try {
          dispose = service.register({
            id: theme.id,
            colorScheme: theme.colorScheme,
            tokens: theme.tokens,
          })
        } catch (err) {
          REGISTERED_EXTENSIONS.delete(theme.id)
          REFUSED_EXTENSIONS.add(theme.id)
          complete = false
          ctx.logger?.warn?.(
            '[dsh-themes] the "' + theme.id + '" theme was not registered: ' + (err && err.message ? err.message : err),
          )
          continue
        }
        ctx.effect(
          () => () => {
            REGISTERED_EXTENSIONS.delete(theme.id)
            try {
              if (typeof dispose === 'function') dispose()
            } catch (e) {}
          },
          'dsh-themes: ' + theme.id + ' theme',
        )
      }
      return complete
    }

    // ---------------------------------------------------------------------
    // The Markdown paper: the RENDERED Markdown view stays on the light palette
    // in either appearance.
    //
    // The shipped document preview draws Markdown into a container marked
    // `data-document-markdown` and paints it from the `--dsw-*` tokens. Those
    // tokens are declared on `body` (light) and OVERRIDDEN on
    // `body[data-ds-dark-theme]` (dark), so a subtree cannot un-dark itself by
    // referencing them - it simply inherits the dark values. This builds one
    // rule that re-declares ui-theme's own LIGHT declarations on that container,
    // which turns it into a white page (with a light-palette code block, list
    // marker and link colour) whatever the app theme is.
    //
    // The light layer is READ from the theme plugin's stylesheets - every
    // top-level `:root` / `body` rule that is not the dark one - instead of
    // freezing today's hex values here, so a palette change on a harness bump
    // carries over on its own. If the stylesheets cannot be read, nothing is
    // injected: forcing white without the light tokens would paint light text on
    // a white page, which is worse than leaving the view on the app theme.
    // ---------------------------------------------------------------------
    /** The theme package whose stylesheets declare the palettes. */
    const THEME_PLUGIN_ID = '@deepseek-ai/dsh-client-ui-theme'
    /** The document preview's own marker on the Markdown view root. */
    const MARKDOWN_ATTRIBUTE = 'data-document-markdown'
    /** The paper rule's style-tag identity (idempotent injection). */
    const PAPER_TAG = 'dsh-themes/markdown-paper.css'
    /**
     * The shipped Markdown implementation's registry id. It is the value the
     * preview writes into `data-document-preview` on a document it is rendering
     * with the Markdown body, i.e. the handle this package's chrome override
     * scopes to (and the same constant dsh-editor pins as `MARKDOWN_BODY_KEY`).
     */
    const MARKDOWN_RENDERER_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/markdown'
    /** The chrome override's style-tag identity (idempotent injection). */
    const CHROME_TAG = 'dsh-themes/markdown-chrome.css'

    /**
     * The custom properties one rule declares, by whichever CSSOM path the
     * engine supports: indexed declarations where custom properties are
     * enumerated (Blink/Gecko today), else the rule's own text.
     * @param rule - a CSSStyleRule.
     * @returns `[name, value]` pairs.
     */
    function ruleDeclarations(rule) {
      const out = []
      const style = rule.style
      if (style && typeof style.length === 'number') {
        for (let i = 0; i < style.length; i++) {
          const name = style[i]
          if (typeof name !== 'string' || name.slice(0, 2) !== '--') continue
          out.push([name, style.getPropertyValue(name)])
        }
      }
      if (out.length === 0 && typeof rule.cssText === 'string') {
        const open = rule.cssText.indexOf('{')
        const text = open < 0 ? '' : rule.cssText.slice(open + 1)
        for (const match of text.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;}]+)/g)) out.push([match[1], match[2]])
      }
      return out
    }

    /**
     * Collect the light custom properties ui-theme declares: the static palette
     * and the alias layer live in `body`/`:root` rules, and the dark palette in
     * `body[data-ds-dark-theme]` rules that are skipped here.
     * @returns the `name:value` declarations, or `null` when nothing was readable.
     */
    function readLightDeclarations() {
      let sheets = null
      try {
        sheets = document.styleSheets
      } catch (e) {
        return null
      }
      if (!sheets) return null
      const declarations = []
      const seen = new Set()
      for (const sheet of Array.from(sheets)) {
        let owner = ''
        try {
          const node = sheet.ownerNode
          owner = node && node.dataset ? String(node.dataset.plugin || node.dataset.pluginCss || '') : ''
        } catch (e) {
          owner = ''
        }
        // Only the theme package's own sheets carry the palettes.
        if (owner.indexOf(THEME_PLUGIN_ID) !== 0) continue
        let rules = null
        try {
          rules = sheet.cssRules
        } catch (e) {
          continue
        }
        for (const rule of Array.from(rules || [])) {
          const selector = rule && rule.selectorText
          if (typeof selector !== 'string') continue
          const flat = selector.replace(/\s+/g, '')
          if (flat !== ':root' && flat !== 'body' && flat !== 'html,body') continue
          for (const [name, raw] of ruleDeclarations(rule)) {
            const value = typeof raw === 'string' ? raw.trim() : ''
            if (name.slice(0, 2) !== '--' || value === '' || seen.has(name)) continue
            seen.add(name)
            declarations.push(name + ':' + value)
          }
        }
      }
      return declarations.length === 0 ? null : declarations
    }

    /**
     * Install (or refresh) the paper rule. Idempotent: the same tag is reused and
     * only rewritten when the declarations changed.
     * @returns whether the rule is in place.
     */
    function installMarkdownPaper() {
      if (typeof document === 'undefined') return false
      let declarations = null
      try {
        declarations = readLightDeclarations()
      } catch (e) {
        declarations = null
      }
      if (declarations === null) return false
      const paper =
        'body [' +
        MARKDOWN_ATTRIBUTE +
        ']{' +
        declarations.join(';') +
        ';background:#fff;color:var(--dsw-alias-label-primary,#1f1f1f);box-sizing:border-box;min-height:100%;padding:12px 14px}' +
        // The scrollport behind the document joins the page too, so a short
        // document does not sit on the app's dark canvas underneath. Only the
        // Markdown implementation is matched; plain-text and code previews keep
        // the app theme. Where `:has()` is unsupported the whole rule is
        // dropped, and the document itself is still white.
        'body [data-textpreview-body]:has([' +
        MARKDOWN_ATTRIBUTE +
        ']){background:#fff}'
      let tag = null
      try {
        tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(PAPER_TAG) + ']')
      } catch (e) {
        tag = null
      }
      if (!tag) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-themes'
        tag.dataset.pluginCss = PAPER_TAG
        document.head.appendChild(tag)
      }
      if (tag.textContent !== paper) tag.textContent = paper
      return true
    }

    /**
     * Install the Markdown chrome override (alpha.3). A rendered Markdown page
     * has exactly one viewer, but the shipped preview header builds its viewer
     * menu from every candidate implementation - the Markdown body plus the
     * plain-text fallback - so a Markdown tab offers "Markdown" / "Plain text".
     * On this pack that choice is noise: the editable surface is reached through
     * the **Edit** button the editor's own document body draws on the page, not
     * through a second renderer. The menu is hidden on Markdown tabs and left
     * alone everywhere else (a code/plain-text tab keeps its own menu).
     *
     * Static CSS with no palette dependency, so - unlike the paper - it is
     * installed once and does not need a refresh on `theme/change`. Scoped by
     * the renderer id the preview stamps on the document root.
     * @returns whether the rule is in place.
     */
    function installMarkdownChrome() {
      if (typeof document === 'undefined') return false
      const chrome =
        'body [data-document-preview=' +
        JSON.stringify(MARKDOWN_RENDERER_ID) +
        '] [data-document-viewer-menu]{display:none}'
      let tag = null
      try {
        tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(CHROME_TAG) + ']')
      } catch (e) {
        tag = null
      }
      if (!tag) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-themes'
        tag.dataset.pluginCss = CHROME_TAG
        document.head.appendChild(tag)
      }
      if (tag.textContent !== chrome) tag.textContent = chrome
      return true
    }

    // ---------------------------------------------------------------------
    // The left column's TOP BAR (alpha.4; the gap under the line is alpha.5).
    // The frame opens with one band per
    // column, and every column's band ends in the same hairline at y=76: the
    // conversation header is `min-height:76px` with a `.5px`
    // `--dsw-alias-border-l3` bottom border, and the right column's first line
    // is the open tab's own header (the shipped Files tab is 38px tall under
    // the 38px docking strip, which lands on that very same 76px). The left
    // column had neither: its branding row was a vertically centred 60px row
    // (so it ended at 66), and the collapsed rail changed BOTH the root's top
    // padding (6px -> 18px) and that row's height (60px -> 36px) - anything
    // drawn under it moved with the toggle.
    //
    // This gives the branding row the same band, in both rail states: the row
    // keeps a 30px content strip at its top - the strip the conversation's own
    // `titleRow` occupies - so the mark, the brand name and the collapse
    // control sit ON the top bar, level with the conversation title (a common
    // centre at the frame's y=25), and the hairline stays at y=76 whether the
    // rail is open or collapsed.
    //
    // The row's own bottom edge IS the hairline, so the row keeps a bottom
    // margin as the breathing room under it (the core's 8px open, 12px in the
    // rail): with the margin zeroed, "New session" sat flush against the rule.
    //
    // Plain, engine-neutral CSS - no `:has()`, no `corner-shape`, nothing a
    // non-Blink browser would drop - and it holds in either appearance. The
    // selectors are the sidebar module's own hashed class names, pinned to the
    // harness line in `.dsh-version.json`: on a bump that renames them this
    // matches nothing and is a no-op, never a broken layout.
    // ---------------------------------------------------------------------
    /** The top bar override's style-tag identity (idempotent injection). */
    const TOPBAR_TAG = 'dsh-themes/left-topbar.css'

    /**
     * Install the left column's top bar (alpha.4) and its VN branding (alpha.6).
     * Static CSS with no palette dependency beyond the border token itself, which
     * carries a literal fallback for a profile that never mounts ui-theme - so,
     * like the chrome override, it is installed once and needs no refresh on
     * `theme/change`.
     *
     * **Why the branding is an override and not a slot registration.** The mark
     * and the product name are SLOTS (`sidebar.brand.mark`, `sidebar.brand.name`,
     * both `single`), and the harness fills them from its own
     * `@deepseek-ai/dsh-client-ui-brand-official` plugin. Registering our own
     * occupants would mean fighting that plugin for a single-occupant slot; the
     * row is `aria-hidden` decoration, and this package already owns this exact
     * row (the band above). So the art is hidden and redrawn here, which also
     * covers the layout's OWN fallback (`FishLogo`, used when no brand plugin is
     * mounted at all): the children are hidden whatever they are, rather than
     * assuming an `<svg>` from one particular provider.
     *
     * @returns whether the rule is in place.
     */
    function installLeftTopBar() {
      if (typeof document === 'undefined') return false
      const topBar = [
        // The rail keeps the frame's own 6px top padding, so the band's height,
        // the hairline and the toggle's centre all stay put when it collapses.
        'html .hHd-Xa_root.hHd-Xa_collapsed{padding-top:6px}',
        // The band: 6px (root) + 70px = the 76px line the other two columns
        // draw. `box-sizing` is border-box, so the .5px rule sits inside the
        // 70px. The 4px / 35.5px split leaves a 30px content strip at the top,
        // and the negative inline margins run the rule to both column edges.
        // The 8px bottom margin is the breathing room the core gave the row
        // (`margin-bottom:8px`): the row's own bottom IS the hairline, so this
        // is the gap under the line, before "New session".
        'html .hHd-Xa_root .hHd-Xa_logoRow{height:70px;margin:0 -12px 8px;padding:4px 12px 35.5px 16px;align-items:center;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}',
        // The rail's own dress: 10px to bleed past (its root padding), a 36px
        // strip for the 36px rail toggle centred on the same y=25, and the
        // core's own 12px rail gap under the line.
        'html .hHd-Xa_root.hHd-Xa_collapsed .hHd-Xa_logoRow{margin:0 -10px 12px;padding:1px 10px 32.5px}',
        // The VN branding: whatever the mark and the name hold - the shipped
        // wordmark, the fish, or the layout's own fallback label - is hidden, and
        // the disc and the product text are drawn in its place. `!important`
        // because the occupants are React-rendered art this rule must beat.
        'html .hHd-Xa_root .hHd-Xa_brandMark>*,html .hHd-Xa_root .hHd-Xa_brandName>*,html .hHd-Xa_root .hHd-Xa_railMark>*{display:none!important}',
        // The mark: the app icon, in the wide row and in the collapsed rail (which
        // draws the mark alone). `contain` keeps the artwork's own 1px margin, which
        // is what stops an exact-fit, `overflow:hidden` container from shaving the
        // circle's edge.
        'html .hHd-Xa_root .hHd-Xa_brandMark::before,html .hHd-Xa_root .hHd-Xa_railMark::before{content:"";width:24px;height:24px;flex:none;display:block;background:url("' +
          MARK_ICON +
          '") center/contain no-repeat}',
        // The name: the pack's own product text, in the REPOSITORY'S OWN
        // spelling - lowercase and hyphenated, the way the repo, the npm
        // package and `run-desktop.bat` name it - not the title-case form the
        // draw-strings used through alpha.13.
        'html .hHd-Xa_root .hHd-Xa_brandName::before{content:"vn-harness"}',
        // ...wearing the CHAT TITLE's type, not the shipped brand name's. The
        // conversation's own title - the current crumb in the header strip this
        // band is levelled with - is `.wSkVaW_crumb` + `.wSkVaW_crumbCurrent` in
        // ui-conversation: 14px / 20px at weight 500. The shipped brand name is
        // 18px / 600 in the same 30px strip, so the two read as different sizes a
        // few pixels apart; this makes the product text the title's size.
        'html .hHd-Xa_root .hHd-Xa_brandName{font-size:14px;font-weight:500;line-height:20px;letter-spacing:0}',
        // The empty conversation's hero - "Into the Unknown" - draws the same whale
        // from its own `single` slot (`conversation.hero.brand.mark`), wrapped the
        // same way in `div[data-slot]`. Same treatment: hide whatever the occupant
        // is (the shipped fish, or the layout's fallback HeroFish) and draw the app
        // icon in its place, sized to sit on the headline's 32px line.
        'html ' + HERO_MARK_SLOT_CLASS + '>*{display:none!important}',
        'html ' +
          HERO_MARK_SLOT_CLASS +
          '::before{content:"";width:' +
          String(HERO_MARK_SIZE) +
          'px;height:' +
          String(HERO_MARK_SIZE) +
          'px;flex:none;display:block;background:url("' +
          MARK_ICON +
          '") center/contain no-repeat}',
      ].join('')
      let tag = null
      try {
        tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(TOPBAR_TAG) + ']')
      } catch (e) {
        tag = null
      }
      if (!tag) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-themes'
        tag.dataset.pluginCss = TOPBAR_TAG
        document.head.appendChild(tag)
      }
      if (tag.textContent !== topBar) tag.textContent = topBar
      return true
    }

    // ---------------------------------------------------------------------
    // The header's icon-button RING (alpha.9).
    //
    // The conversation header's icon buttons read as one group, and the pack's
    // own controls draw that group's dress themselves: the terminal control
    // (`.dst-btn`) wears a `.5px` round outline, the Themes control now wears the
    // same one, and the Session-log download seat does too. The ONE control on
    // that bar that could not be given it where it lives is the right bar's own
    // collapse/expand toggle in the header corner: it is the pack's forked right
    // bar's button (a GENERATED bundle), and its shipped dress is a bare 28px
    // disc with no outline. Rather than edit a generated file, this one rule
    // gives it the same ring.
    //
    // The selector is the conversation header's own STABLE marker - the corner
    // element carries `data-conversation-header-corner` (ui-conversation), not a
    // hashed class - so it survives a class-name churn on a harness bump. The
    // corner is a `single` slot, so this cannot leak onto other controls by
    // accident; `box-sizing:border-box` keeps the box exactly 28px, which matters
    // because the toggle's own rule does not set it.
    //
    // Static CSS with no palette dependency beyond the border token, which
    // carries a literal fallback - like the top bar above, it is installed once.
    // ---------------------------------------------------------------------
    /** The header ring override's style-tag identity (idempotent injection). */
    const RING_TAG = 'dsh-themes/header-ring.css'

    /**
     * Install the header icon-button ring override (alpha.9).
     * @returns whether the rule is in place.
     */
    function installHeaderRing() {
      if (typeof document === 'undefined') return false
      const ring =
        'html [data-conversation-header-corner] button{border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:28px;box-sizing:border-box}'
      let tag = null
      try {
        tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(RING_TAG) + ']')
      } catch (e) {
        tag = null
      }
      if (!tag) {
        tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-themes'
        tag.dataset.pluginCss = RING_TAG
        document.head.appendChild(tag)
      }
      if (tag.textContent !== ring) tag.textContent = ring
      return true
    }

    // ---------------------------------------------------------------------
    // The theme snapshot as a `useSyncExternalStore` source: the service's own
    // snapshot object (stable until it changes) with a fallback, refreshed by
    // the service's `theme/change` event and once more after boot, in case
    // ui-theme provides the service a tick after this row activates.
    // ---------------------------------------------------------------------
    /**
     * @param ctx - the owning client context.
     * @returns `{ getSnapshot, getServerSnapshot, subscribe, refresh, adopt }`.
     */
    function createThemeState(ctx) {
      let snapshot = null
      const listeners = new Set()

      function serviceNow() {
        try {
          const service = ctx.get ? ctx.get(THEME_SERVICE) : undefined
          return service && typeof service.setTheme === 'function' ? service : null
        } catch (e) {
          return null
        }
      }

      function resolve() {
        try {
          const service = serviceNow()
          const value = service && typeof service.getTheme === 'function' ? service.getTheme() : null
          if (value && typeof value.preference === 'string') return value
        } catch (e) {}
        return UNKNOWN_SNAPSHOT
      }

      function publish(next) {
        const settled = next && typeof next.preference === 'string' ? next : UNKNOWN_SNAPSHOT
        if (snapshot !== null && settled.preference === snapshot.preference && settled.revision === snapshot.revision) {
          return
        }
        snapshot = settled
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (e) {
            /* a throwing subscriber must not break the others */
          }
        }
      }

      return {
        getSnapshot() {
          if (snapshot === null) snapshot = resolve()
          return snapshot
        },
        getServerSnapshot() {
          return UNKNOWN_SNAPSHOT
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /** Re-read the service (a change event, or the service arriving late). */
        refresh() {
          publish(resolve())
        },
        /** Adopt the snapshot a change event carried. */
        adopt(value) {
          publish(value)
        },
        /** Whether the service this control needs is mounted. */
        available() {
          return serviceNow() !== null
        },
        /** The only preference write entry: ui-theme's own `setTheme`. */
        setTheme(id) {
          const service = serviceNow()
          if (!service) throw new Error('the theme service is unavailable')
          service.setTheme(id)
          // Read the accepted value back: ui-theme publishes synchronously, and
          // its `theme/change` event (adopted above) carries the same snapshot.
          publish(resolve())
        },
      }
    }

    // ---------------------------------------------------------------------
    // The control
    // ---------------------------------------------------------------------
    /**
     * One menu entry's copy and glyph, by theme id.
     *
     * The shipped three keep their own words and icons; an extension theme
     * carries its own (Nord: `theme.nord` and the snowflake; Monokai:
     * `theme.monokai` and the braces); and a theme some OTHER plugin registered -
     * a valid case, the registry is shared - is named by its id and wears the
     * generic appearance mark rather than a glyph this package would be
     * inventing for it.
     * @param id - a theme id, or the `system` preference.
     * @returns `{ id, label, Icon }`, where `label` is a locale key or `null`.
     */
    function themeMeta(id) {
      const known = PREFERENCES.find((item) => item.id === id) || THEME_EXTENSIONS.find((item) => item.id === id)
      if (known) return known
      return { id: id, label: null, Icon: IconThemeOutline16 }
    }

    /**
     * The menu's entries, in the shipped registry's own order.
     *
     * `snapshot.themes` IS the registry's list - the built-in `light` / `dark`
     * pair first, every registered theme after it - so a theme this package
     * registers (or another plugin does) shows up in the menu by existing. The
     * `system` preference is not a theme and, as before alpha.12, is appended
     * last. A snapshot with no `themes` (a stand-in, or a service from an older
     * line) falls back to the built-in pair, so the menu is never empty.
     * @param snapshot - the theme snapshot the control is rendering.
     * @returns the entries to draw, with `system` last.
     */
    function themeMenuEntries(snapshot) {
      const registered = snapshot && Array.isArray(snapshot.themes) ? snapshot.themes : null
      const ids = []
      if (registered === null) {
        ids.push('light', 'dark')
      } else {
        for (const theme of registered) {
          const id = theme && typeof theme.id === 'string' ? theme.id : null
          if (id === null || id === 'system' || ids.indexOf(id) !== -1) continue
          ids.push(id)
        }
        if (ids.length === 0) ids.push('light', 'dark')
      }
      return ids.map(themeMeta).concat([themeMeta('system')])
    }

    /**
     * The header button and its menu.
     *
     * The glyph is the STATIC appearance mark (alpha.12): it used to be the
     * active preference's own icon, which meant a sun/moon/display in one place
     * and nothing to draw once a registered theme became selectable. The menu -
     * and the tooltip, which names the active theme - carry the choice instead.
     */
    function ThemesAction(props) {
      const t = props.t
      const state = props.themeState
      const current = React.useSyncExternalStore(state.subscribe, state.getSnapshot, state.getServerSnapshot)
      const [open, setOpen] = React.useState(false)
      const available = state.available()
      const preference = current && typeof current.preference === 'string' ? current.preference : 'system'
      const entries = themeMenuEntries(current)
      const active = themeMeta(preference)
      const activeName = active.label === null ? preference : t(active.label)
      const label = available ? t('theme.current', { name: activeName }) : t('theme.unavailable')
      const items = entries.map((item) => ({
        id: item.id,
        label: item.label === null ? item.id : t(item.label),
        icon: h(item.Icon, { size: 16 }),
      }))
      return h(
        Menu,
        {
          open: open && available,
          align: 'end',
          dense: true,
          selection: 'fill',
          onClose: () => setOpen(false),
          items: items,
          selectedId: preference,
          onSelect: (id) => {
            setOpen(false)
            try {
              state.setTheme(id)
            } catch (err) {
              // eslint-disable-next-line no-console
              console.warn('[dsh-themes] could not switch the theme', err && err.message ? err.message : err)
            }
          },
          anchor: h(
            'div',
            { className: 'dst-slot' },
            h(
              Tooltip,
              { label: label, side: 'bottom' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dst-button',
                  'data-theme-preference': preference,
                  'aria-label': label,
                  'aria-haspopup': 'menu',
                  'aria-expanded': open && available,
                  disabled: !available,
                  // A disabled control fires no pointer events for the custom
                  // tooltip, so the native one carries the reason.
                  title: available ? undefined : label,
                  onClick: () => {
                    if (!available) return
                    setOpen((value) => !value)
                  },
                },
                // The static appearance mark: this button is "the theme", not
                // "the sun" or "the moon" (see the extensions section above).
                h(IconThemeOutline16, { size: 16 }),
              ),
            ),
          ),
        },
      )
    }

    // ---------------------------------------------------------------------
    // The Session-log download seat (alpha.9).
    //
    // The shipped `@deepseek-ai/dsh-session-log-export` browser half put a
    // three-dot "more actions" button into this same utilities list whose menu
    // held exactly ONE item, "Download session log" - one click to open a menu, a
    // second to pick the only thing in it. This package takes the seat and draws
    // the download glyph on it: one click, and the export starts.
    //
    // HOW THE SEAT IS TAKEN. `conversation.session.header.utilities` is a LIST
    // slot, and a list slot renders the LOWEST priority registration for a given
    // occupant `id` (the slot system's own shadowing rule - the same one
    // dsh-editor uses for the rendered Markdown body). Registering the SHIPPED
    // occupant's id at `priority: -10`, one below its default `0`, therefore makes
    // this component the rendered one and leaves the shipped registration in the
    // registry, unrendered. Nothing is hidden with CSS, nothing shipped is
    // disabled and no DOM is touched.
    //
    // WHY THE SHIPPED ROW STAYS MOUNTED. The export is NOT reimplemented here. The
    // shipped row is dual-face: its HOST half owns the authenticated
    // `/api/session.export` stream and the `/export` slash command, and its
    // browser half publishes the `sessionLogDownload` controller - a
    // one-export-per-Session state machine that HEADs the export URL, hands the
    // browser its own download, and publishes preparing / success / error state.
    // This control resolves that controller lazily and calls it, so the header
    // button and `/export` stay ONE implementation with ONE busy state; a profile
    // without the service renders the button disabled rather than pretending.
    //
    // THE FEEDBACK IS PART OF THE SEAT. The shipped seat also rendered the
    // export's preparing / success / error dialog, and shadowing the seat takes
    // that dialog with it - so it is rendered here, from the same store, with the
    // same three states and a Close button. `/export` keeps the feedback it always
    // had; what is gone is the dropdown.
    // ---------------------------------------------------------------------
    /**
     * The source the busy hook reads while the shipped controller is absent. A
     * constant observable with no snapshot: the renderer binds the Hook from the
     * inject face, so it must always be a source (never `undefined`) to keep the
     * component's Hook call order stable.
     */
    const ABSENT_SOURCE = {
      getSnapshot: () => undefined,
      subscribe: () => () => {},
    }

    /**
     * @param ctx - the owning client context.
     * @returns the shipped export controller, or `null` when it is not mounted.
     */
    function resolveDownloadController(ctx) {
      try {
        const service = typeof ctx.get === 'function' ? ctx.get(DOWNLOAD_SERVICE) : undefined
        return service !== undefined && service !== null && typeof service.download === 'function' ? service : null
      } catch (e) {
        return null
      }
    }

    /** The observable source the busy state is read from (never `undefined`). */
    function downloadSourceOf(controller) {
      const store = controller === null ? undefined : controller.store
      return store !== undefined && store !== null && typeof store.getSnapshot === 'function' ? store : ABSENT_SOURCE
    }

    /**
     * The dialog the seat owns: the shipped export's own feedback, drawn from the
     * same store the shipped seat read (`preparing` / `success` / `error`,
     * dismissed by the Close button and by the mask).
     * @param props - Session id, bound store hook, dismiss action, and copy.
     * @returns the modal contribution (nothing while the Session is idle).
     */
    function ExportDialog(props) {
      const { sessionId, t, dismiss, useSessionLogDownload } = props
      const entry = useSessionLogDownload((state) => (state === undefined || state === null ? undefined : state.bySession[String(sessionId)]))
      const open = entry !== undefined && entry !== null && entry.open === true
      const status = entry === undefined || entry === null ? undefined : entry.status
      const title =
        status === 'downloading'
          ? t('download.preparingTitle')
          : status === 'success'
            ? t('download.successTitle')
            : t('download.errorTitle')
      const description =
        status === 'downloading'
          ? t('download.preparingDescription')
          : status === 'success'
            ? t('download.successDescription')
            : (entry !== undefined && entry !== null && entry.error) || t('download.commandFailed')
      return h(Modal, {
        open: open,
        onClose: () => {
          dismiss(sessionId)
        },
        title: title,
        description: description,
        closeLabel: t('download.close'),
        footer: h(
          Button,
          {
            variant: 'primary',
            onClick: () => {
              dismiss(sessionId)
            },
          },
          t('download.close'),
        ),
      })
    }

    /**
     * The download icon button: one click exports, with no menu and no second
     * gesture. Its busy state is the shipped controller's own, so a second click
     * during an export cannot start another one.
     * @param props - Session id, bound store hook, request/dismiss, and copy.
     * @returns the header seat: the button plus the seat's own dialog.
     */
    function SessionLogDownloadAction(props) {
      const { sessionId, t, request, dismiss, available, useSessionLogDownload } = props
      const entry = useSessionLogDownload((state) => (state === undefined || state === null ? undefined : state.bySession[String(sessionId)]))
      const busy = entry !== undefined && entry !== null && entry.status === 'downloading'
      const ready = available === true
      const enabled = ready && !busy
      const label = ready === false ? t('download.unavailable') : busy ? t('download.busy') : t('download.title')
      return h(
        React.Fragment,
        null,
        h(
          Tooltip,
          { label: label, side: 'bottom', delayMs: 500 },
          h(
            'button',
            {
              type: 'button',
              className: 'dst-button',
              'data-dsh-session-log-download': '',
              'aria-label': t('download.title'),
              'aria-busy': busy ? 'true' : 'false',
              disabled: !enabled,
              // A disabled control fires no pointer events for the custom tooltip,
              // so the native one carries the reason.
              title: ready ? undefined : label,
              onClick: () => {
                if (!enabled) return
                request(sessionId)
              },
            },
            h(DownloadGlyph, { size: 15 }),
          ),
        ),
        h(ExportDialog, { sessionId: sessionId, t: t, dismiss: dismiss, useSessionLogDownload: useSessionLogDownload }),
      )
    }

    // ---------------------------------------------------------------------
    // The screenshot control (alpha.10).
    //
    // WHAT "THE WEBPAGE" IS HERE. The Web GUI is a fixed-viewport shell: the
    // document itself does not scroll - the columns do, each keeping its own
    // position. So 100% width and 100% height of the page is exactly the tab's
    // visible box, and one frame of the tab's own surface is the whole thing: no
    // stitching, no scrolled-out remainder to guess at.
    //
    // WHY THE BROWSER TAKES THE PICTURE. Only the page can photograph itself in
    // real pixels. A DOM-to-canvas render would have to stand in for the engine
    // (the terminal dock is an xterm canvas, dialogs and menus are portalled, the
    // app paints itself from layers of hashed stylesheets), and a headless browser
    // pointed at the same URL would photograph a FRESH load - the open tab, the
    // editor buffer and the dock are THIS client's state, not the server's.
    // `getDisplayMedia` with `preferCurrentTab` is the one API that hands the page
    // its own pixels, so that is what the button asks for: the browser shows its
    // share prompt, the stream is stopped the instant the frame is grabbed.
    //
    // WHERE THE FILE GOES. Not the download folder. The PNG is POSTed to the
    // package's host route, which writes it to THIS machine's Desktop and answers
    // the path (see lib/index.js) - and if that row is not mounted, the browser's
    // own download is the fallback, so the control still produces a picture.
    // ---------------------------------------------------------------------
    /**
     * The screenshot glyph: a camera. The shipped primitive set has no capture
     * icon, so this draws its own 16px outline in the weight of the icons beside
     * it, stroked in `currentColor` so it follows the button (and the app theme).
     */
    function IconScreenshotOutline16(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        h('path', { d: 'M5.6 4.2 6.4 2.6h3.2l.8 1.6' }),
        h('rect', { x: '1.4', y: '4.2', width: '13.2', height: '9.4', rx: '2' }),
        h('circle', { cx: '8', cy: '9', r: '2.6' }),
      )
    }

    /** One animation frame, so a paint that was just requested has landed. */
    function nextFrame() {
      return new Promise((resolve) => {
        if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
          window.requestAnimationFrame(() => resolve())
        } else {
          setTimeout(resolve, 60)
        }
      })
    }

    /** Resolve once the capture surface has delivered its first frame. */
    function firstFrame(video) {
      if (typeof video.requestVideoFrameCallback === 'function') {
        return new Promise((resolve) => {
          video.requestVideoFrameCallback(() => resolve())
        })
      }
      return new Promise((resolve) => {
        setTimeout(resolve, 160)
      })
    }

    /**
     * Capture this tab at its own size, as a PNG.
     *
     * The picture is the interface as it stands, this package's own three header
     * controls included. The one thing taken out of the frame is the OPEN TOOLTIP
     * bubble (the `html[data-dsh-screenshot]` rule above), because a hover card is
     * not part of the interface and the pointer is usually still on the button
     * that started the capture. That button asks its own Tooltip to close while
     * the capture runs (`disabled`), so there is normally no bubble left to hide.
     *
     * @param t - the locale lookup, for the failure copy the caller shows.
     * @returns {Promise<{blob: Blob, width: number, height: number}>} the picture.
     */
    async function captureTab(t) {
      const media = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined
      if (!media || typeof media.getDisplayMedia !== 'function') {
        throw new Error(t('screenshot.unsupported'))
      }
      let stream
      try {
        stream = await media.getDisplayMedia({
          video: { displaySurface: 'browser' },
          audio: false,
          // Chrome / Edge hints: offer THIS tab, allow it to be picked, and do not
          // offer to switch the shared surface mid-capture.
          preferCurrentTab: true,
          selfBrowserSurface: 'include',
          surfaceSwitching: 'exclude',
        })
      } catch (err) {
        // The user dismissed the picker, or the browser refused the surface.
        throw new Error(t('screenshot.cancelled'))
      }
      const root = typeof document !== 'undefined' ? document.documentElement : null
      try {
        const video = document.createElement('video')
        video.muted = true
        video.playsInline = true
        video.srcObject = stream
        await video.play()
        if (root !== null) root.setAttribute('data-dsh-screenshot', '')
        if (document.activeElement && typeof document.activeElement.blur === 'function') {
          document.activeElement.blur()
        }
        await firstFrame(video)
        // Two frames, not one: the first rAF callback can still run before the
        // repaint that the hidden-controls attribute just caused, and the capture
        // surface delivers whole composited frames.
        await nextFrame()
        await nextFrame()
        const track = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks()[0] : undefined
        const settings = track && typeof track.getSettings === 'function' ? track.getSettings() : {}
        const width = video.videoWidth || settings.width || 0
        const height = video.videoHeight || settings.height || 0
        if (!width || !height) throw new Error(t('screenshot.failed'))
        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const painter = canvas.getContext('2d')
        if (!painter) throw new Error(t('screenshot.failed'))
        painter.drawImage(video, 0, 0, width, height)
        const blob = await new Promise((resolve, reject) => {
          canvas.toBlob((value) => (value ? resolve(value) : reject(new Error(t('screenshot.failed')))), 'image/png')
        })
        return { blob: blob, width: width, height: height }
      } finally {
        if (root !== null) root.removeAttribute('data-dsh-screenshot')
        const tracks = typeof stream.getTracks === 'function' ? stream.getTracks() : []
        for (const track of tracks) {
          try {
            track.stop()
          } catch (err) {}
        }
      }
    }

    /** The PNG's name: the pack's name plus a local timestamp, `-2` on collision. */
    function screenshotName(date) {
      const pad = (value) => String(value).padStart(2, '0')
      return (
        SCREENSHOT_PREFIX +
        String(date.getFullYear()) +
        pad(date.getMonth() + 1) +
        pad(date.getDate()) +
        '-' +
        pad(date.getHours()) +
        pad(date.getMinutes()) +
        pad(date.getSeconds()) +
        '.png'
      )
    }

    /** Hand the PNG to the browser's own download (the fallback path). */
    function downloadPng(blob, name) {
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = name
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    }

    /**
     * Save the PNG: the host route first (the file lands on this machine's
     * Desktop), the browser's download as the fallback.
     * @returns {Promise<{path: string|null}>} the saved path, or `null` when the
     *   browser took the file instead.
     */
    async function deliverPng(blob, name) {
      try {
        const response = await fetch(SCREENSHOT_ROUTE, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'image/png' },
          body: blob,
        })
        const payload = await response.json().catch(() => null)
        if (response.ok && payload && payload.ok === true && typeof payload.path === 'string') {
          return { path: payload.path }
        }
      } catch (err) {
        /* no route (or no host half): the browser download below still saves it */
      }
      downloadPng(blob, name)
      return { path: null }
    }

    /**
     * The screenshot button and its toast. One click captures the window; the
     * toast reports where the file went - the host path the route answered, or
     * that the browser took the download - and a failure is reported in the same
     * place instead of being swallowed.
     */
    function ScreenshotAction(props) {
      const t = props.t
      const anchor = React.useRef(null)
      const sequence = React.useRef(0)
      const [busy, setBusy] = React.useState(false)
      const [toast, setToast] = React.useState(null)
      const label = busy ? t('screenshot.busy') : t('screenshot.title')
      const run = async () => {
        if (busy) return
        setBusy(true)
        setToast(null)
        try {
          const shot = await captureTab(t)
          const saved = await deliverPng(shot.blob, screenshotName(new Date()))
          sequence.current += 1
          setToast({
            seq: sequence.current,
            ok: true,
            text: saved.path === null ? t('screenshot.downloaded') : t('screenshot.saved', { path: saved.path }),
          })
        } catch (err) {
          sequence.current += 1
          setToast({
            seq: sequence.current,
            ok: false,
            text: err && err.message ? err.message : t('screenshot.failed'),
          })
          // eslint-disable-next-line no-console
          console.warn('[dsh-themes] screenshot failed', err && err.message ? err.message : err)
        } finally {
          setBusy(false)
        }
      }
      return h(
        React.Fragment,
        null,
        h(
          Tooltip,
          // `disabled` while the capture runs: the shipped Tooltip closes its
          // bubble and refuses to reopen (its own effect, keyed on this prop), so
          // this button's hover card cannot end up in the frame even though the
          // pointer is still on it when the captured surface arrives.
          { label: label, side: 'bottom', delayMs: 500, disabled: busy },
          h(
            'div',
            { className: 'dst-slot', ref: anchor },
            h(
              'button',
              {
                type: 'button',
                className: 'dst-button',
                'data-dsh-screenshot': '',
                'aria-label': t('screenshot.title'),
                'aria-busy': busy ? 'true' : 'false',
                disabled: busy,
                onClick: () => {
                  run()
                },
              },
              h(IconScreenshotOutline16, { size: 15 }),
            ),
          ),
        ),
        // The shipped Toast portals a one-line message anchored to the control.
        // It is only reachable after an attempt, so the anchor element exists by
        // the time it renders.
        toast !== null && anchor.current !== null
          ? h(Toast, {
              key: toast.seq,
              text: toast.text,
              icon: h(toast.ok ? CheckGlyph : WarningGlyph, {}),
              anchor: anchor.current,
              onDone: () => {
                setToast(null)
              },
            })
          : null,
      )
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------
    /** Services required to register copy and take a seat in the header. */
    const inject = ['slots', 'locale']

    function apply(ctx) {
      const state = createThemeState(ctx)
      ctx.effect(
        () =>
          ctx.locale.register(LOCALE_NS, {
            zh,
            en,
          }),
        'dsh-themes: dictionaries',
      )
      // alpha.12: this pack's own palettes go into the shipped registry. The
      // control's menu lists what the REGISTRY holds, so registering is the whole
      // of "adding a theme" - there is no second list to keep in step. ui-theme
      // can provide its service a tick after this row, hence the second call on
      // the post-boot microtask and the one on every later change below.
      const ensureThemes = () => registerThemeExtensions(ctx)
      ensureThemes()
      // Every accepted preference change (from this control, from Settings, or
      // from the OS while the preference is `system`) arrives here.
      if (typeof ctx.on === 'function') {
        ctx.on('theme/change', (snapshot) => {
          ensureThemes()
          state.adopt(snapshot)
        })
      }
      // ui-theme may provide the service a tick after this row activates; the
      // microtask picks up the snapshot once every plugin has applied. A change
      // made later always arrives as a `theme/change` event (including the
      // namespace refetch after a reconnect), so no DOM observation is needed
      // here - the palette itself is not this control's business.
      Promise.resolve().then(() => {
        ensureThemes()
        state.refresh()
      })

      // The Markdown paper copies ui-theme's own light declarations, and those
      // stylesheets may land a tick after this row (both are boot plugins): try
      // at once, again on the next tick, and once more whenever the theme
      // changes (a palette swap re-registers the sheets, so the copy is rebuilt
      // from whatever the theme declares then).
      installMarkdownPaper()
      Promise.resolve().then(() => {
        installMarkdownPaper()
      })
      if (typeof ctx.on === 'function') {
        ctx.on('theme/change', () => {
          installMarkdownPaper()
        })
      }

      // One-shot: the viewer-menu override is static CSS.
      installMarkdownChrome()

      // One-shot: the left column's top bar is static CSS too, and belongs to
      // the frame rather than to any one appearance.
      installLeftTopBar()

      // One-shot (alpha.9): the header's shipped corner toggle joins the round
      // outline the pack's own header icon buttons draw.
      installHeaderRing()

      try {
        ctx.effect(
          () =>
            ctx.slots.inject(HEADER_SLOT, () =>
              ctx.slots.register(
                {
                  name: HEADER_SLOT,
                  id: THEMES_ID,
                  order: HEADER_ORDER,
                  locale: LOCALE_NS,
                  inject: () => ({ themeState: state }),
                },
                ThemesAction,
              ),
            ),
          'dsh-themes: header control',
        )
        // The screenshot control (alpha.10): one more occupant of the same list,
        // one order step LEFT of the Themes control (lower renders first), so the
        // three controls read capture | themes | download next to Open In.
        ctx.effect(
          () =>
            ctx.slots.inject(HEADER_SLOT, () =>
              ctx.slots.register(
                {
                  name: HEADER_SLOT,
                  id: SCREENSHOT_ID,
                  order: SCREENSHOT_ORDER,
                  locale: LOCALE_NS,
                  inject: () => ({}),
                },
                ScreenshotAction,
              ),
            ),
          'dsh-themes: screenshot control',
        )
        // The Session-log download seat (alpha.9): the SHIPPED occupant's id one
        // priority lower, which in a list slot is what makes this registration the
        // rendered one - the three-dot button with its one-item menu stops
        // rendering and this package's download button takes the seat.
        ctx.effect(
          () =>
            ctx.slots.inject(HEADER_SLOT, () =>
              ctx.slots.register(
                {
                  name: HEADER_SLOT,
                  id: DOWNLOAD_SEAT_ID,
                  order: DOWNLOAD_SEAT_ORDER,
                  priority: DOWNLOAD_SEAT_PRIORITY,
                  locale: LOCALE_NS,
                  inject: () => {
                    const controller = resolveDownloadController(ctx)
                    return {
                      hooks: { sessionLogDownload: downloadSourceOf(controller) },
                      request: (sessionId) => {
                        const live = resolveDownloadController(ctx)
                        if (live !== null) live.download(sessionId)
                      },
                      dismiss: (sessionId) => {
                        const live = resolveDownloadController(ctx)
                        if (live !== null) live.dismiss(sessionId)
                      },
                      available: controller !== null,
                    }
                  },
                },
                SessionLogDownloadAction,
              ),
            ),
          'dsh-themes: session-log download seat',
        )
        ctx.logger?.debug?.(
          '[dsh-themes] header controls registered (' +
            PLUGIN_VERSION +
            '): screenshot at order ' +
            SCREENSHOT_ORDER +
            ', themes at order ' +
            HEADER_ORDER +
            ' left of Open In at ' +
            OPEN_IN_APP_ORDER +
            ', download seat ' +
            DOWNLOAD_SEAT_ID +
            ' at priority ' +
            DOWNLOAD_SEAT_PRIORITY,
        )
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-themes] activation failed', err)
        ctx.logger?.warn?.('[dsh-themes] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.name = 'dsh-themes'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})

// # sourceMappingURL=client.js.map
