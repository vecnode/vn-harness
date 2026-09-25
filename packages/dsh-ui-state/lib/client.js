/**
 * dsh-ui-state - browser half.
 *
 * One settings namespace, bound once, and published as the client service the
 * rest of the pack writes its own fields through:
 *
 *     const uiState = ctx.get('uiState')
 *     uiState.set('dockHeight', 340)      // durable, host-side, shared by both hosts
 *     uiState.get('pageZoom')             // -> 125
 *     uiState.subscribe(rerender)         // fires when an accepted section arrives
 *
 * WHY A SERVICE AND NOT THREE BINDINGS. `settingsScope` writes are framed by the
 * LATEST KNOWN namespace revision, and each bound scope is its own queue: three
 * bundles binding `vn-harness` independently could refuse each other's writes
 * when one commits while another still holds the old revision (the contract's
 * recovery is a reload, which would silently drop the write). ONE scope, one
 * queue, one revision per namespace - so this half is the only binder, and
 * dsh-themes and dsh-terminal reach it lazily, living without it when it is
 * absent (a profile that installed one bundle and not the other still works).
 *
 * WHAT THIS HALF OWNS ITSELF is the two COLUMN WIDTHS, because nothing else
 * does. ui-layout keeps them in a transient store - "transient layout
 * preferences", in its own words - so a reload returns the sidebar to its 280px
 * contract default and the right bar to 45% of the frame, and closing the
 * sidebar forgets its drag width by design. `ctx.layout` exposes no width
 * setter, so the store is reached the way ui-layout's own AppFrame reaches it:
 * through the `root` slot registration, which carries the store handle
 * (`store.create()` answers the SAME shared instance, whose `actions`,
 * `getSnapshot()` and `subscribe()` are the store's own public face). That is
 * the one core store this pack writes, so it is guarded twice: the handle must
 * look like a layout store before anything is touched, and a shape it does not
 * recognise means "remember nothing" rather than "run blind". Both widths are
 * handed to the store's own setters unclamped - it clamps to its drag range and
 * to 70% of the frame itself, so a hand-edited document cannot push the layout
 * somewhere it would refuse to go.
 *
 * Module-table format of every core client package; no build step.
 */
/* global window, document, setTimeout, clearTimeout */
window.__ModuleLoader__.load({
  id: 'dsh-ui-state',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    /** Version marker, mirrored by the package manifest. */
    const PLUGIN_VERSION = '0.1.0-alpha.1'
    /** The client service name other halves of the pack resolve. */
    const SERVICE = 'uiState'
    /** The settings namespace, owned host-side by this package. Keep in sync. */
    const NAMESPACE = 'vn-harness'

    /**
     * The "nothing remembered yet" state, which must stay in step with the host
     * schema's defaults. Negative means "this host has never recorded a width",
     * which is deliberately not 0: 0 is a real sidebar state (collapsed).
     *
     * There is no field for the terminal dock's OPEN state on purpose - see the
     * Node half: the panel is the window onto a process, so reopening it after a
     * reload would either show an empty panel or start a shell nobody asked for.
     */
    const DEFAULTS = {
      theme: '',
      pageZoom: 100,
      dockHeight: 280,
      sidebarWidth: -1,
      rightbarWidth: -1,
    }

    /** How long a burst of store changes settles before one write is queued. */
    const WRITE_DEBOUNCE_MS = 400
    /** Below this frame width ui-layout auto-collapses the sidebar to its rail. */
    const SIDEBAR_AUTO_COLLAPSE = 1024

    /** Resolve a cordis service by property first, then through `ctx.get`. */
    function service(ctx, name) {
      const direct = ctx ? ctx[name] : undefined
      if (direct !== undefined && direct !== null) return direct
      return ctx && typeof ctx.get === 'function' ? ctx.get(name) : undefined
    }

    // ---------------------------------------------------------------------
    // The namespace scope
    // ---------------------------------------------------------------------
    /** The bound scope, or null when the transport is absent on this host. */
    let scope = null
    /** Field writes made before the first accepted section, replayed in order. */
    const pending = new Map()
    /** Snapshot listeners (the pack's consumers), independent of the scope's. */
    const listeners = new Set()

    /** @returns {object|undefined} the current accepted section. */
    function section() {
      if (scope === null) return undefined
      const snapshot = scope.getSnapshot()
      return snapshot ? snapshot.value : undefined
    }

    /** @returns {string} the transport's state. */
    function status() {
      if (scope === null) return 'absent'
      const snapshot = scope.getSnapshot()
      return snapshot ? snapshot.status : 'absent'
    }

    /**
     * Read one remembered field, falling back to the contract default for
     * anything the section does not carry.
     * @param name - a field of the namespace.
     * @returns the remembered value, or the default.
     */
    function get(name) {
      const value = section()
      if (value !== undefined && value !== null && Object.prototype.hasOwnProperty.call(value, name)) {
        const raw = value[name]
        if (raw !== undefined && raw !== null) return raw
      }
      return Object.prototype.hasOwnProperty.call(DEFAULTS, name) ? DEFAULTS[name] : undefined
    }

    /**
     * Remember one field. Safe to call before the transport is ready (the write
     * is replayed when the first section arrives) and safe to call when there is
     * no transport at all (it resolves without writing, which is what the
     * consumers' localStorage fallbacks are for).
     * @param name - a field of the namespace.
     * @param value - a JSON-shaped value.
     * @returns {Promise<void>} settlement of the queued write.
     */
    function set(name, value) {
      if (scope === null) return Promise.resolve()
      if (section() === undefined && status() === 'loading') {
        pending.set(name, value)
        return Promise.resolve()
      }
      return scope.set(name, value).catch((err) => {
        console.warn('[dsh-ui-state] could not remember ' + String(name), err)
      })
    }

    /**
     * Clear one remembered field, so it reads as inherited again.
     *
     * This is the counterpart of picking a built-in theme after an extension
     * one: the field is REMOVED rather than overwritten with the default, which
     * keeps the user's own document free of stale ids and lets the namespace
     * fall back to the schema. It shares {@link set}'s readiness rules.
     * @param name - a field of the namespace.
     * @returns {Promise<void>} settlement of the queued clear.
     */
    function unset(name) {
      if (scope === null) return Promise.resolve()
      if (section() === undefined && status() === 'loading') {
        pending.set(name, undefined)
        return Promise.resolve()
      }
      if (typeof scope.unset !== 'function') return Promise.resolve()
      return scope.unset(name).catch((err) => {
        console.warn('[dsh-ui-state] could not clear ' + String(name), err)
      })
    }

    /**
     * Observe accepted sections.
     * @param listener - invoked after each accepted snapshot.
     * @returns {() => void} the disposer.
     */
    function subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }

    /** @returns {object} what the consumers make their own decisions from. */
    function snapshot() {
      return { status: status(), value: section(), defaults: DEFAULTS }
    }

    /** Fan an accepted section out to every consumer. */
    function announce() {
      for (const listener of [...listeners]) {
        try {
          listener()
        } catch (err) {
          console.warn('[dsh-ui-state] a listener threw', err)
        }
      }
    }

    /** Send any write that was made before the transport was ready. */
    function flushPending() {
      if (pending.size === 0 || scope === null) return
      const queued = [...pending.entries()]
      pending.clear()
      for (const [name, value] of queued) {
        // `undefined` is a remembered CLEAR, not a value: the field is removed
        // so it reads as inherited again.
        const settled =
          value === undefined
            ? typeof scope.unset === 'function'
              ? scope.unset(name)
              : Promise.resolve()
            : scope.set(name, value)
        settled.catch((err) => {
          console.warn('[dsh-ui-state] could not remember ' + String(name), err)
        })
      }
    }

    // ---------------------------------------------------------------------
    // The two column widths (this half's own state)
    // ---------------------------------------------------------------------
    /** Set once the widths have been restored, so a later snapshot cannot stomp a live drag. */
    let restored = false
    /** The debounce timer for width writes. */
    let writeTimer = null
    /** The width pair most recently sent, so an unchanged store writes nothing. */
    let written = null
    /** The live layout store once it has been found. */
    let layout = null

    /**
     * The live layout store, reached through the `root` slot registration.
     *
     * The `root` registration is ui-layout's own, and it declares the store
     * handle; `create()` on it answers the shared instance the frame renders
     * from, so writing through it is the same path a drag takes. Every step is
     * checked because this is core surface: a handle that is not there, or an
     * instance without the three members this file uses, is "not yet" rather
     * than a crash.
     *
     * @param ctx - client context.
     * @returns {object|null} the store instance, or null when it is not there yet.
     */
    function layoutInstance(ctx) {
      try {
        const slots = service(ctx, 'slots')
        if (!slots || typeof slots.entries !== 'function') return null
        const entries = slots.entries('root') || []
        for (const entry of entries) {
          const handle = entry && entry.store
          if (!handle || typeof handle.create !== 'function') continue
          const instance = handle.create()
          if (
            instance &&
            instance.actions &&
            typeof instance.getSnapshot === 'function' &&
            typeof instance.subscribe === 'function'
          ) {
            return instance
          }
        }
      } catch (err) {
        console.warn('[dsh-ui-state] the layout store could not be reached', err)
      }
      return null
    }

    /**
     * Put the remembered widths back into the layout.
     *
     * The sidebar's 0 goes through `toggleSidebar()` rather than
     * `setSidebar(0)`, because the setter clamps to the drag range and 0 is not
     * in it: collapse is the toggle's own transition. A frame narrow enough to
     * auto-collapse is left alone entirely - below that width the rail is the
     * layout's decision, not a preference to restore.
     *
     * Setting the right panel's width BEFORE its first opening is deliberate: it
     * is what makes the panel open at the remembered width, because
     * `openRightbar` only fills in 45% of the frame when the preference is still
     * unset.
     *
     * @param instance - the live layout store.
     * @param state - the accepted section.
     */
    function restoreWidths(instance, state) {
      const info = instance.getSnapshot().layoutInfo
      if (!info) return
      const sidebar = Number(state.sidebarWidth)
      if (Number.isFinite(sidebar) && sidebar >= 0 && info.viewportWidth >= SIDEBAR_AUTO_COLLAPSE) {
        if (sidebar === 0) {
          if (info.sidebar > 0) instance.actions.toggleSidebar()
        } else {
          instance.actions.setSidebar(sidebar)
        }
      }
      const rightbar = Number(state.rightbarWidth)
      if (Number.isFinite(rightbar) && rightbar > 0) {
        instance.actions.setRightbar(rightbar)
      }
    }

    /** The width pair as the store holds it right now, or null when it says nothing. */
    function widthPair(instance) {
      const info = instance.getSnapshot().layoutInfo
      if (!info) return null
      return {
        sidebarWidth: Number.isFinite(info.sidebar) ? Math.round(info.sidebar) : null,
        rightbarWidth: typeof info.rightbar === 'number' ? Math.round(info.rightbar) : null,
      }
    }

    /** Remember the store's widths if they moved since the last write. */
    function writeWidths(instance) {
      const next = widthPair(instance)
      if (next === null) return
      if (written !== null && written.sidebarWidth === next.sidebarWidth && written.rightbarWidth === next.rightbarWidth) {
        return
      }
      written = next
      if (next.sidebarWidth !== null) set('sidebarWidth', next.sidebarWidth)
      if (next.rightbarWidth !== null) set('rightbarWidth', next.rightbarWidth)
    }

    /** Queue one write, coalescing a whole drag into a single request. */
    function queueWidthWrite() {
      if (writeTimer !== null) clearTimeout(writeTimer)
      writeTimer = setTimeout(() => {
        writeTimer = null
        if (layout !== null) writeWidths(layout)
      }, WRITE_DEBOUNCE_MS)
    }

    /**
     * Restore once, as soon as BOTH the section and the layout store exist.
     * @param ctx - client context.
     */
    function restoreOnce(ctx) {
      if (restored) return
      const state = section()
      if (state === undefined || state === null) return
      const instance = layoutInstance(ctx)
      if (instance === null) return
      restored = true
      layout = instance
      try {
        restoreWidths(instance, state)
      } catch (err) {
        console.warn('[dsh-ui-state] the remembered widths could not be applied', err)
      }
      // Seed the comparison with what was just restored, so putting the
      // remembered value back is not immediately written out again.
      written = widthPair(instance)
      instance.subscribe(() => {
        queueWidthWrite()
      })
    }

    // ---------------------------------------------------------------------
    // Plugin entry
    // ---------------------------------------------------------------------
    /**
     * Required services: `slots` for the layout store and the root registration
     * signal, `settingsScope` for the namespace, and `remote` because it carries
     * the forwarded settings invalidation that `bind()` subscribes to on this
     * context (the same three ui-theme declares for the same reason).
     */
    const inject = ['slots', 'remote', 'settingsScope']

    /**
     * Activate the plugin: bind the namespace, provide `uiState`, and put the
     * remembered column widths back.
     * @param ctx - client context.
     */
    function apply(ctx) {
      try {
        const binder = service(ctx, 'settingsScope')
        if (binder && typeof binder.bind === 'function') {
          scope = binder.bind({ namespace: NAMESPACE })
        } else {
          console.warn('[dsh-ui-state] the settings transport is absent - the pack remembers nothing on this host')
        }

        const disposeService = ctx.reflect.provide(SERVICE, { get, set, unset, subscribe, snapshot, status })
        const disposers = []

        if (scope !== null) {
          disposers.push(
            scope.subscribe(() => {
              flushPending()
              restoreOnce(ctx)
              announce()
            }),
          )
          // The section may already be held (a warm mirror), in which case the
          // subscription never fires and the restore has to be attempted now.
          restoreOnce(ctx)
        }

        // The layout registration may land after this row, so the root slot's own
        // change signal is the second chance to reach the store.
        try {
          const slots = service(ctx, 'slots')
          if (slots && typeof slots.subscribe === 'function') {
            disposers.push(
              slots.subscribe('root', () => {
                restoreOnce(ctx)
              }),
            )
          }
        } catch (err) {
          /* an unreachable slot signal only costs the deferred retry */
        }

        // A settled width is flushed on the way out: the debounce window a person
        // closes the tab inside is not a reason to forget their drag. It is best
        // effort by nature - the write is a request - which is why the debounce
        // is short enough that a drag has usually landed long before this.
        const onHide = () => {
          if (writeTimer !== null) {
            clearTimeout(writeTimer)
            writeTimer = null
          }
          if (layout !== null) writeWidths(layout)
        }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('pagehide', onHide)
        }

        ctx.effect(
          () => () => {
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
              window.removeEventListener('pagehide', onHide)
            }
            if (writeTimer !== null) {
              clearTimeout(writeTimer)
              writeTimer = null
            }
            for (const dispose of disposers) {
              try {
                if (typeof dispose === 'function') dispose()
              } catch (e) {}
            }
            try {
              disposeService()
            } catch (e) {}
            scope = null
            layout = null
            restored = false
            written = null
          },
          'dsh-ui-state: namespace scope and remembered widths',
        )

        ctx.logger?.debug?.('[dsh-ui-state] service provided (' + SERVICE + ', ' + PLUGIN_VERSION + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-ui-state] activation failed', err)
        ctx.logger?.warn?.('[dsh-ui-state] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.apply = apply
    exports.inject = inject
    /** The pure half: the tracked check drives these without a live layout. */
    exports.__internals = {
      DEFAULTS,
      NAMESPACE,
      SERVICE,
      layoutInstance,
      restoreWidths,
      get,
      set,
      unset,
      subscribe,
      snapshot,
      status,
    }
    return module.exports
  },
})
