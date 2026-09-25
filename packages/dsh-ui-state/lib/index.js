/**
 * dsh-ui-state - Node half.
 *
 * The pack remembers what a reload would otherwise forget. Everything that
 * survives a restart today does so because it already lives on the HOST:
 * `$DSH_HOME/sessions` holds the conversations (which is why a new chat opens
 * the last one), `$DSH_HOME/storages/workspace.json` holds the workspaces, and
 * `$DSH_HOME/settings.yaml` holds the shipped preferences (the light/dark/system
 * theme, the content font size, the model and its reasoning effort). Everything
 * the interface forgets lives in the BROWSER instead - and there it is per
 * ORIGIN and per browser PROFILE, so a Chrome tab and the desktop window's
 * WebView2 have never been able to share it, and the desktop shell picks port
 * 3080 only when it is free, so even one host can lose it by moving a port.
 *
 * This row makes the pack's own UI state HOST state, in one settings section:
 *
 *   $DSH_HOME/settings.yaml
 *     vn-harness:
 *       pageZoom: 125
 *       theme: nord
 *       dockHeight: 340
 *       sidebarWidth: 300
 *
 * A settings namespace is the right medium for exactly the reasons the shipped
 * preferences use one: it is one document both the web profile and the desktop
 * shell read, it is user-editable by hand, its writes are atomic and validated
 * against a schema, and an external edit hot-reloads. It is NOT session state -
 * `dsh-session-persistence` rejects an unknown event type, so a plugin-owned
 * session event would make the conversation unreadable, and `ctx.storageDomain`
 * needs a projection the browser cannot read. A namespace is the documented
 * third-party seam for a preference, which is what all of this is.
 *
 * WHY SCHEMASTERY IS RESOLVED AND NOT IMPORTED. This pack ships zero npm
 * dependencies and every other Node half imports only `node:*` builtins: the
 * web profile installs each bundle as a LIVE LINK into the repo, so a bare
 * `import '@deepseek-ai/schemastery'` resolves from the repo folder and fails
 * with ERR_MODULE_NOT_FOUND (measured). `settings.register` wants a schemastery
 * schema, so the module is loaded at runtime instead through the anchors
 * `packages/dsh-terminal/lib/pty.js` established for the harness's own node-pty:
 * the running entry, then `$DSH_HOME/profiles` - which `dsh-app-boot` keeps as a
 * mirror of the installation's dependency closure, so Node's ordinary parent
 * walk finds the very same copy the harness itself loaded. The CJS build is what
 * makes `createRequire` work here (schemastery is `type: module` but publishes
 * `exports.require`), and duck typing is what makes it safe: `dsh-settings`
 * treats the schema as a function and reads `schema.toJSON()`, so it never
 * compares class identity across the two module graphs.
 *
 * The second job is the page zoom. A zoom that arrives after the client boots is
 * a visible reflow of the whole shell, so - exactly like ui-theme's own theme
 * bootstrap - the remembered level is inlined into the page as a script row
 * before the shell mounts. That is what keeps "the zoom I left it at" from
 * costing a jump on every launch.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-ui-state'

/**
 * The settings namespace this package owns, and the section name a person sees
 * in `$DSH_HOME/settings.yaml`. Keep in sync with the client's constant.
 */
const NAMESPACE = 'vn-harness'

/**
 * The namespace's schema. Every field carries a default, so the resolved
 * section is a complete object even before anyone has written a thing, while the
 * USER layer in the document stays empty until a value actually differs - a
 * fresh install writes no `vn-harness` section at all.
 *
 * The defaults ARE the "nothing remembered yet" state, and they must stay in
 * step with the client's `DEFAULTS`:
 *
 *   - `theme: ''` - no extension theme is remembered. Light/dark/system are NOT
 *     stored here: ui-theme already persists those durably, and duplicating the
 *     preference would give one setting two owners that could disagree.
 *   - `pageZoom: 100` - the resting level, at which no declaration is written.
 *   - `dockHeight: 280` - dsh-terminal's own contract height.
 *   - `sidebarWidth` / `rightbarWidth: -1` - NEGATIVE means "this host has never
 *     recorded a width", which is deliberately not the same as 0: for the
 *     sidebar 0 is a real state (collapsed), so a sentinel is the only way to
 *     say "leave the layout's own contract default alone" without lying about a
 *     width nobody ever chose.
 *
 * There is deliberately NO field for the terminal dock's OPEN state. The panel
 * is the window onto a PROCESS: after a reload the client holds no slots, so
 * reopening it would either show an empty panel or, once the server's five
 * minute PTY retention has lapsed, START a shell nobody asked for. A height is
 * a preference; "a shell was running" is not.
 */
const FIELD_DEFAULTS = {
  theme: '',
  pageZoom: 100,
  dockHeight: 280,
  sidebarWidth: -1,
  rightbarWidth: -1,
}

/** The ladder's ends, so a hand-edited document cannot ask for an unreadable page. */
const ZOOM_MIN = 50
const ZOOM_MAX = 200

/** The marker a live zoom writes on the document element; keep in sync with dsh-themes. */
const ZOOM_MARKER = 'data-dsh-page-zoomed'

/**
 * The harness config root: `$DSH_HOME`, else `~/.dsh` (the resolution the
 * installer, dsh-terminal, dsh-diagrams and `dsh-skill-filesystem` all use).
 * @param env - environment to read.
 * @returns {string} the absolute DSH home path.
 */
function resolveHome(env = process.env) {
  const configured = env.DSH_HOME
  if (typeof configured === 'string' && configured.trim().length > 0) return path.resolve(configured.trim())
  return path.join(os.homedir(), '.dsh')
}

/**
 * Every place the harness's own schemastery can be reached from, in order. A
 * missing anchor is simply skipped, and - the whole point of the profiles
 * anchor - the file itself need not exist, because `createRequire` uses its
 * DIRECTORY for the parent walk.
 * @returns {string[]} candidate anchor files.
 */
function schemasteryAnchors() {
  const anchors = []
  const entry = process.argv[1]
  if (typeof entry === 'string' && entry !== '') anchors.push(entry)
  anchors.push(path.join(resolveHome(), 'profiles', 'index.js'))
  anchors.push(path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js'))
  return anchors
}

/**
 * Load the harness's own schemastery through the anchors above.
 * @returns {object|null} the schema builder (`z`), or `null` when this host has
 *   no reachable copy - in which case the row degrades to "nothing is
 *   remembered" instead of failing the boot.
 */
function loadSchemastery() {
  const seen = new Set()
  for (const anchor of schemasteryAnchors()) {
    if (seen.has(anchor)) continue
    seen.add(anchor)
    try {
      const loaded = createRequire(anchor)('@deepseek-ai/schemastery')
      const z = loaded && typeof loaded.object === 'function' ? loaded : loaded && loaded.default
      if (z && typeof z.object === 'function') return z
    } catch (err) {
      /* try the next anchor */
    }
  }
  return null
}

/**
 * Build the namespace schema from the resolved builder.
 * @param z - the schemastery module.
 * @returns the schema registered for {@link NAMESPACE}.
 */
function buildSchema(z) {
  return z.object({
    theme: z.string().default(FIELD_DEFAULTS.theme),
    pageZoom: z.number().step(1).min(ZOOM_MIN).max(ZOOM_MAX).default(FIELD_DEFAULTS.pageZoom),
    dockHeight: z.number().step(1).min(120).max(4000).default(FIELD_DEFAULTS.dockHeight),
    sidebarWidth: z.number().step(1).min(-1).max(4096).default(FIELD_DEFAULTS.sidebarWidth),
    rightbarWidth: z.number().step(1).min(-1).max(4096).default(FIELD_DEFAULTS.rightbarWidth),
  })
}

/**
 * The page-zoom level as the HOST currently resolves it, for the boot row. A
 * missing settings service or an unreadable section simply means the resting
 * level, exactly like ui-theme's own `readSection`.
 * @param ctx - host context that may hold the settings service.
 * @returns {number} the level to inline.
 */
function readZoom(ctx) {
  try {
    const settings = typeof ctx.get === 'function' ? ctx.get('settings') : undefined
    if (!settings || typeof settings.get !== 'function') return FIELD_DEFAULTS.pageZoom
    const section = settings.get(NAMESPACE)
    const value = section && typeof section.pageZoom === 'number' ? section.pageZoom : FIELD_DEFAULTS.pageZoom
    if (!Number.isFinite(value)) return FIELD_DEFAULTS.pageZoom
    return Math.min(Math.max(Math.round(value), ZOOM_MIN), ZOOM_MAX)
  } catch (err) {
    return FIELD_DEFAULTS.pageZoom
  }
}

/**
 * The inline script that applies the remembered zoom before the shell mounts.
 *
 * It writes the SAME two things the client's own `applyZoom` writes - the `zoom`
 * declaration and the `data-dsh-page-zoomed` marker beside it - because the
 * marker is a contract, not a decoration: dsh-themes' alpha.16 right-bar seam
 * fix is gated on it, and a boot script that set the zoom without it would put
 * the seam 288px off the right column's edge (at 80% on a 1440px frame) for the
 * whole interval before the client applies the same level again.
 *
 * @param level - the validated level, already inside the ladder.
 * @returns {string} the script body.
 */
function bootZoomScript(level) {
  return `(() => {
  const level = ${JSON.stringify(level)}
  const root = document.documentElement
  if (level === 100) {
    root.style.removeProperty('zoom')
    root.removeAttribute(${JSON.stringify(ZOOM_MARKER)})
    return
  }
  root.style.zoom = String(level) + '%'
  root.setAttribute(${JSON.stringify(ZOOM_MARKER)}, String(level))
})()`
}

/**
 * Activate the plugin row: register the namespace, and answer every index
 * injection collection with the remembered page zoom.
 *
 * The registration is wrapped in `ctx.inject(['settings'], ...)` rather than
 * declared in the row's own `inject` array so a composition without a settings
 * provider still loads this row - it simply remembers nothing, which is exactly
 * what the client half falls back to.
 *
 * @param ctx - cordis context.
 */
export function apply(ctx) {
  const z = loadSchemastery()
  if (z === null) {
    ctx.logger?.warn?.(
      '[dsh-ui-state] no reachable @deepseek-ai/schemastery under $DSH_HOME/profiles; the vn-harness settings namespace is not registered and the pack remembers nothing',
    )
  } else {
    const schema = buildSchema(z)
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.register(NAMESPACE, schema)
      ctx.logger?.debug?.('[dsh-ui-state] settings namespace registered (' + NAMESPACE + ')')
    })
  }

  // The zoom bootstrap: one inline script immediately after the opening body
  // tag, before the shell mount, so the level is in force for the first paint.
  ctx.on('webserver/index-inject', (table) => {
    const level = readZoom(ctx)
    if (level === FIELD_DEFAULTS.pageZoom) return
    table.push({ kind: 'script', placement: 'body', text: bootZoomScript(level) })
  })
}
