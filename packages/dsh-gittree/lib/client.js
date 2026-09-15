/**
 * dsh-gittree — browser half.
 *
 * A tab TYPE for the pack's right bar (dsh-rightbar), the page kind beside the
 * shipped "Start" page, the "Files" tab and the pack's "Editor". It shows the
 * **commit history** of the tab's own conversation folder: the log, and - when a
 * commit is picked - that commit's id, author, date, message and the files it
 * touched. Each of those files opens through the ordinary file address, so the
 * editor (or a shipped preview) claims it; nothing is ever written to the
 * repository.
 *
 *   - the type registers through `ctx.sidebarRightTabs.register(...)` with the id
 *     `dsh-gittree` and the kind `gittree`. It is a PAGE type: it declares no
 *     `patterns`, so it never competes for a file address - `sidebar://gittree`
 *     is its only address, and its body and chip title register in the keyed
 *     seats `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` under that
 *     same id, exactly like the tab types the product ships;
 *   - it contributes a guide entry, so the tab strip's "+" control (which opens
 *     the "Start" page) offers **History** at `order: 30` - after Files (10) and
 *     Editor (20);
 *   - the file bar keeps the workspace's git facts: the branch (or `(detached)`),
 *     the short HEAD commit, `ahead`/`behind` when there is an upstream, and how
 *     many files git reports as changed. It is read with the state route's
 *     `brief=1` form, which answers exactly those facts and never builds the file
 *     list this surface does not show;
 *   - a commit row opens its detail in place (no navigation, no new tab), and a
 *     file row inside that detail opens the file with the tab record's own
 *     `openResource` action and a `dsh-resource://file/session/<id>/<path>`
 *     address - **no options** - so the registry's ranking decides what claims
 *     it. The History tab stays open;
 *   - the surface follows the pack's tab dress (the toolbar and file-bar geometry
 *     and `--dsw-*` tokens the editor and the Files tab use, under its own `dsg-`
 *     prefix), so it reads as one more tab of the same bar and uninstalls without
 *     residue.
 *
 * Every request carries a **token** (`useRef`), not an effect cleanup: an answer
 * is applied only while it is still the newest one. That is what keeps Reload
 * honest - and it is the bug alpha.1 shipped, where the effect's cleanup ran on
 * the next render and cancelled the very request it had started, so the view sat
 * on "Reading the history..." forever.
 *
 * No services beyond the bar's registry and the slot system are required: `fetch`
 * is the browser's own, and the session id arrives as a seat prop. The plugin
 * therefore keeps working on a profile that has no editor, no modal surface and
 * no theme package - a file row click simply lands wherever the registry sends it.
 *
 * Module-table format of every client bundle here; no build step.
 */
/* global window, document, fetch */
window.__ModuleLoader__.load({
  id: 'dsh-gittree',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------
    /** This implementation's identity in the tab system, and its slot key. */
    const TYPE_ID = 'dsh-gittree'
    /** The tab kind this package owns. */
    const KIND = 'gittree'
    /** The address a page tab of this kind is recorded under. */
    const PAGE_ADDRESS = 'sidebar://' + KIND
    /** Keep in sync with lib/index.js. */
    const API_ROOT = '/api/dsh-gittree'
    const STATE_ROUTE = API_ROOT + '/state'
    const HISTORY_ROUTE = API_ROOT + '/history'
    const COMMIT_ROUTE = API_ROOT + '/commit'
    /** Address grammar owned by @deepseek-ai/dsh-util-workspace-path. */
    const FILE_PREFIX = 'dsh-resource://file/'
    const SESSION_SEGMENT = 'session/'
    /** Version marker shown on the tool bar so a freshly loaded bundle is easy to verify. */
    const PLUGIN_VERSION = '0.1.0-alpha.4'
    /** The keyed seats every tab type occupies. */
    const TAB_SLOT = 'sidebar.right.pane.tab'
    const TITLE_SLOT = 'sidebar.right.pane.tab.title'
    /** How many commits one History page asks for. */
    const HISTORY_LIMIT = 80

    // ---------------------------------------------------------------------
    // Styles (the pack's tab dress, under this package's own prefix)
    // ---------------------------------------------------------------------
    const css = `
.dsg-root{height:100%;min-height:0;flex:auto;display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;color:var(--dsw-alias-label-primary,#1f1f1f);font-size:13px;line-height:1.5}
/* The toolbar IS this tab's top bar, and every column's top band ends in the
   same hairline at y=76: the docking strip above a pane is 38px (28px + 10px
   top padding) and the conversation header is min-height:76px, which is why the
   shipped Files tab's own 38px header lands exactly on that line. This bar was
   26px of control in 8px/8px of padding (42.5px), so its rule sat ~4.5px BELOW
   the other two columns'. It is now the same 38px box, with a size-down 24px
   control inside it, so the three hairlines are one line. */
.dsg-tools{flex:none;display:flex;align-items:center;gap:6px;box-sizing:border-box;height:38px;padding:0 10px 0 12px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.18))}
.dsg-scope{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}
.dsg-title{white-space:nowrap}
.dsg-glyph{flex:none;color:var(--dsw-alias-label-tertiary,#999)}
.dsg-btn{flex:none;display:inline-flex;align-items:center;height:24px;box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,#1f1f1f);font:inherit;font-size:12px;padding:0 9px;cursor:pointer;white-space:nowrap}
.dsg-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.dsg-fileBar{flex:none;display:flex;align-items:center;gap:8px;padding:4px 10px 5px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3,rgba(127,127,127,.14));font-size:11.5px;color:var(--dsw-alias-label-tertiary,#999);min-width:0}
.dsg-branch{flex:none;display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-secondary,#666);min-width:0}
.dsg-branchName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:220px}
.dsg-sha{flex:none;font-family:ui-monospace,'Cascadia Code',Consolas,monospace;opacity:.85}
.dsg-spacer{flex:1;min-width:0}
.dsg-ver{flex:none;white-space:nowrap;opacity:.7}
.dsg-body{flex:1;min-height:0;overflow:auto;position:relative}
.dsg-state{height:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:24px;color:var(--dsw-alias-label-tertiary,#999);font-size:12.5px;line-height:18px;text-align:center}
.dsg-stateTitle{font-size:13px;color:var(--dsw-alias-label-secondary,#666);font-weight:500}
.dsg-stateErr{color:var(--dsw-alias-state-error-primary,#d3382c)}
.dsg-stateCode{font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:11px;opacity:.8}
.dsg-list{margin:0;padding:6px 4px 12px 6px;list-style:none}
.dsg-item{margin:0;padding:0}
.dsg-commitRow{width:100%;min-width:0;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:8px;display:flex;align-items:baseline;gap:8px;padding:5px 8px}
.dsg-commitRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dsg-commitRow[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.dsg-commitSha{flex:none;font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary,#666)}
.dsg-subject{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsg-meta{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}
.dsg-detail{margin:2px 8px 10px 8px;padding:8px 10px;border-left:2px solid var(--dsw-alias-border-l3,rgba(127,127,127,.3));background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.06));border-radius:0 8px 8px 0}
.dsg-detailHead{font-size:11.5px;color:var(--dsw-alias-label-secondary,#666);margin-bottom:6px;word-break:break-word}
.dsg-detailBody{white-space:pre-wrap;font-size:12px;color:var(--dsw-alias-label-primary,#1f1f1f);margin:0 0 6px 0}
.dsg-detailEmpty{font-size:12px;color:var(--dsw-alias-label-tertiary,#999);margin:0}
.dsg-detailList{margin:0;padding:0;list-style:none}
.dsg-row{width:100%;min-width:0;color:inherit;font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:8px;display:flex;align-items:center;gap:6px;padding:4px 8px}
.dsg-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dsg-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:12px}
.dsg-badge{flex:none;min-width:14px;text-align:center;font-family:ui-monospace,'Cascadia Code',Consolas,monospace;font-size:10.5px;line-height:1;padding:3px 4px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary,#666)}
.dsg-badge[data-st="m"]{background:var(--dsw-alias-state-warning-primary,#d29922);color:#fff}
.dsg-badge[data-st="a"]{background:var(--dsw-alias-state-success-primary,#2f9e44);color:#fff}
.dsg-badge[data-st="d"]{background:var(--dsw-alias-state-error-primary,#d3382c);color:#fff}
.dsg-badge[data-st="r"]{background:var(--dsw-alias-state-business-primary,#4f8cff);color:#fff}
.dsg-badge[data-st="u"]{background:var(--dsw-alias-state-error-primary,#d3382c);color:#fff}
.dsg-note{margin:0;padding:6px 10px;color:var(--dsw-alias-label-tertiary,#999);font-size:11.5px}
`
    const CSS_TAG = 'dsh-gittree/gittree.css'
    if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']')) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-gittree'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // ---------------------------------------------------------------------
    // Address helpers (the grammar @deepseek-ai/dsh-util-workspace-path owns:
    // `dsh-resource://file/session/<sessionId>/<path-segments>`, one
    // component-encoded segment per path segment, `:` kept literal). A row click
    // is handed to the tab record's own `openResource` action, so the registry -
    // not this package - decides what claims the file.
    // ---------------------------------------------------------------------
    function encodeSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ':')
    }

    /** Build a session-scoped file address for a workspace-relative path. */
    function sessionFileAddress(sessionId, path) {
      const normalized = String(path).replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
      return FILE_PREFIX + SESSION_SEGMENT + encodeSegment(sessionId) + '/' + normalized.split('/').map(encodeSegment).join('/')
    }

    // ---------------------------------------------------------------------
    // Status helpers (a commit's changed files carry the same letters a
    // `git status` row does, which is what `diff-tree --name-status` reports)
    // ---------------------------------------------------------------------
    const STATUS_NAMES = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' }

    /** The single letter a row shows. */
    function statusLetter(entry) {
      if (entry.status === '??') return '?'
      if (entry.unmerged || entry.status.indexOf('U') >= 0) return 'U'
      const letters = String(entry.status || '').replace(/[.\s]/g, '')
      return letters === '' ? 'M' : letters[0]
    }

    /** The badge's colour key. */
    function statusKind(entry) {
      if (entry.status === '??') return 'untracked'
      if (entry.unmerged || entry.status.indexOf('U') >= 0) return 'u'
      return statusLetter(entry).toLowerCase()
    }

    /** The badge's tooltip, including a rename's source. */
    function statusTitle(entry) {
      const parts = []
      const staged = STATUS_NAMES[String(entry.status || '')[0]]
      const worktree = STATUS_NAMES[String(entry.status || '')[1]]
      if (staged) parts.push('staged: ' + staged)
      if (worktree) parts.push('worktree: ' + worktree)
      if (entry.origPath) parts.push('from ' + entry.origPath)
      return parts.join(', ') || 'changed'
    }

    // ---------------------------------------------------------------------
    // Icons
    // ---------------------------------------------------------------------
    /** The guide capsule's glyph (drawn before "History" on the Start page). */
    function GitTreeGlyph(props) {
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
        h('circle', { cx: 4, cy: 3.2, r: 1.6 }),
        h('circle', { cx: 4, cy: 12.8, r: 1.6 }),
        h('circle', { cx: 12, cy: 6, r: 1.6 }),
        h('path', { d: 'M4 4.8v6.4' }),
        h('path', { d: 'M12 7.6c0 2-1.6 2.6-3.4 3.2' }),
      )
    }

    // ---------------------------------------------------------------------
    // Data access (the package's read-only routes)
    // ---------------------------------------------------------------------
    /**
     * One route call. The answer's `{ ok, error }` envelope becomes a thrown
     * error carrying the server's own code, so the surface can say *why* (no
     * workspace, not a repository, git missing, ...) instead of "failed".
     */
    async function fetchJson(url) {
      let response
      try {
        response = await fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      } catch (err) {
        const error = new Error('The request to the plugin route failed.')
        error.code = 'NETWORK'
        throw error
      }
      let payload = null
      try {
        payload = await response.json()
      } catch (err) {
        payload = null
      }
      if (!response.ok || !payload || payload.ok !== true) {
        const detail = payload && payload.error ? payload.error : null
        const error = new Error(detail && detail.message ? detail.message : 'The request failed (HTTP ' + response.status + ').')
        error.code = detail && detail.code ? detail.code : 'HTTP_' + response.status
        throw error
      }
      return payload
    }

    /** A short, honest headline for a typed failure. */
    function stateTitle(error) {
      const code = error && error.code ? error.code : ''
      if (code === 'NO_WORKSPACE') return 'No workspace folder'
      if (code === 'NOT_A_REPO') return 'Not a git repository'
      if (code === 'GIT_MISSING') return 'git is not installed'
      if (code === 'TIMEOUT') return 'git timed out'
      if (code === 'GIT_FAILED') return 'git refused the request'
      if (code === 'NO_SESSION') return 'No conversation'
      if (code === 'NETWORK') return 'The plugin route did not answer'
      return 'Could not read the history'
    }

    /** The centred "nothing to draw yet / it failed" surface. */
    function StateBox(props) {
      return h(
        'div',
        { className: 'dsg-state' + (props.error ? ' dsg-stateErr' : ''), 'data-gittree-state': props.state },
        h('div', { className: 'dsg-stateTitle' }, props.title),
        props.hint ? h('div', null, props.hint) : null,
        props.error && props.error.code ? h('div', { className: 'dsg-stateCode' }, props.error.code) : null,
      )
    }

    // ---------------------------------------------------------------------
    // The history
    // ---------------------------------------------------------------------
    /** One changed file of a commit: the directory chip, the name and the badge. */
    function FileRow(props) {
      const entry = props.entry
      const name = entry.path.slice(entry.path.lastIndexOf('/') + 1)
      const directory = entry.path.slice(0, entry.path.length - name.length)
      return h(
        'button',
        {
          type: 'button',
          className: 'dsg-row',
          'data-gittree-row': 'commit-file',
          'data-gittree-path': entry.path,
          title: entry.origPath ? entry.origPath + ' \u2192 ' + entry.path : entry.path,
          onClick: () => props.onOpen(entry.path),
        },
        directory !== '' ? h('span', { className: 'dsg-commitSha' }, directory) : null,
        h('span', { className: 'dsg-name' }, name),
        h('span', { className: 'dsg-badge', 'data-st': statusKind(entry), title: statusTitle(entry) }, statusLetter(entry)),
      )
    }

    /** One commit: its header, its message and the files it touched. */
    function CommitDetail(props) {
      const detail = props.detail
      if (detail.phase === 'loading' || detail.phase === 'idle') {
        return h('div', { className: 'dsg-detail', 'data-gittree-state': 'commit-loading' }, h('p', { className: 'dsg-detailEmpty' }, 'Reading the commit\u2026'))
      }
      if (detail.phase === 'error') {
        return h(
          'div',
          { className: 'dsg-detail dsg-stateErr', 'data-gittree-state': 'commit-error' },
          h('p', { className: 'dsg-detailEmpty' }, (detail.error && detail.error.message) || 'The commit could not be read.'),
        )
      }
      const data = detail.data
      const commit = data && data.commit ? data.commit : null
      const files = data && Array.isArray(data.files) ? data.files : []
      return h(
        'div',
        { className: 'dsg-detail', 'data-gittree-state': 'commit' },
        h(
          'div',
          { className: 'dsg-detailHead' },
          commit ? commit.sha : '',
          commit ? ' \u00b7 ' + commit.author + ' \u00b7 ' + commit.date : '',
        ),
        commit && commit.body ? h('pre', { className: 'dsg-detailBody' }, commit.body) : null,
        files.length === 0
          ? h('p', { className: 'dsg-detailEmpty', 'data-gittree-row': 'commit-empty' }, 'No files changed in this commit (a merge lists none).')
          : h(
              'ul',
              { className: 'dsg-detailList' },
              files.map((file) =>
                h(
                  'li',
                  { key: file.path, className: 'dsg-item' },
                  h(FileRow, { entry: { path: file.path, status: file.status, origPath: file.origPath }, onOpen: props.onOpen }),
                ),
              ),
            ),
      )
    }

    /** The commit log; picking a row opens that commit's changed files in place. */
    function HistoryView(props) {
      const history = props.history
      if (history.phase === 'error') {
        return h(StateBox, { state: 'history-error', error: history.error, title: stateTitle(history.error), hint: history.error && history.error.message })
      }
      if (history.commits.length === 0) {
        const loading = history.phase === 'loading'
        return h(StateBox, {
          state: loading ? 'history-loading' : 'history-empty',
          title: loading ? 'Reading the history\u2026' : history.empty ? 'No commits yet' : 'No commits',
          hint: loading ? '' : history.empty ? 'Nothing has been committed in this workspace.' : 'No commit touches this workspace folder.',
        })
      }
      const rows = []
      for (const commit of history.commits) {
        const open = props.selected === commit.sha
        rows.push(
          h(
            'li',
            { key: commit.sha, className: 'dsg-item' },
            h(
              'button',
              {
                type: 'button',
                className: 'dsg-commitRow',
                'aria-expanded': open ? 'true' : 'false',
                'data-gittree-commit': commit.sha,
                title: commit.sha + ' \u2014 ' + commit.subject,
                onClick: () => props.onPick(commit),
              },
              h('span', { className: 'dsg-commitSha' }, commit.short),
              h('span', { className: 'dsg-subject' }, commit.subject),
              h('span', { className: 'dsg-meta' }, commit.author + ' \u00b7 ' + commit.date),
            ),
            open ? h(CommitDetail, { detail: props.detail, onOpen: props.onOpen }) : null,
          ),
        )
      }
      return h('div', { className: 'dsg-body', 'data-gittree-state': 'history' }, h('ul', { className: 'dsg-list' }, rows))
    }

    // ---------------------------------------------------------------------
    // The tab body
    // ---------------------------------------------------------------------
    /**
     * The History surface: the workspace's commit history, with the bar above it
     * carrying the branch and the current commit. Both requests start when the tab
     * is shown (nothing runs on an idle GUI), and each answer is applied only
     * while its token is the newest - so a re-render can never cancel an in-flight
     * request, and two racing answers cannot overwrite each other.
     */
    function GitTreeView(props) {
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const info = typeof props.useTabInfo === 'function' ? props.useTabInfo() : null
      const tabActions = info && info.tab && info.tab.actions ? info.tab.actions : null

      const [summary, setSummary] = useState({ phase: 'loading', data: null, error: null })
      const [history, setHistory] = useState({ phase: 'loading', commits: [], error: null, empty: false })
      const [selected, setSelected] = useState(null)
      const [detail, setDetail] = useState({ phase: 'idle', data: null, error: null })
      const summaryToken = useRef(0)
      const historyToken = useRef(0)
      const detailToken = useRef(0)

      const loadSummary = useCallback(() => {
        const token = summaryToken.current + 1
        summaryToken.current = token
        if (sessionId === '') {
          setSummary({ phase: 'error', data: null, error: { code: 'NO_SESSION', message: 'This tab has no conversation to read a workspace from.' } })
          return
        }
        // Keep the facts already on screen while the refresh is in flight.
        setSummary((current) => ({ phase: 'loading', data: current.data, error: null }))
        fetchJson(STATE_ROUTE + '?brief=1&session=' + encodeURIComponent(sessionId))
          .then((data) => {
            if (summaryToken.current !== token) return
            setSummary({ phase: 'ready', data, error: null })
          })
          .catch((err) => {
            if (summaryToken.current !== token) return
            setSummary({ phase: 'error', data: null, error: { code: err.code || 'ERROR', message: err.message } })
          })
      }, [sessionId])

      const loadHistory = useCallback(() => {
        const token = historyToken.current + 1
        historyToken.current = token
        if (sessionId === '') {
          setHistory({ phase: 'error', commits: [], error: { code: 'NO_SESSION', message: 'This tab has no conversation to read a workspace from.' }, empty: false })
          return
        }
        setHistory((current) => ({ phase: 'loading', commits: current.commits, error: null, empty: false }))
        fetchJson(HISTORY_ROUTE + '?session=' + encodeURIComponent(sessionId) + '&limit=' + String(HISTORY_LIMIT))
          .then((data) => {
            if (historyToken.current !== token) return
            setHistory({ phase: 'ready', commits: Array.isArray(data.commits) ? data.commits : [], error: null, empty: data.empty === true })
          })
          .catch((err) => {
            if (historyToken.current !== token) return
            setHistory({ phase: 'error', commits: [], error: { code: err.code || 'ERROR', message: err.message }, empty: false })
          })
      }, [sessionId])

      useEffect(() => {
        loadSummary()
        loadHistory()
      }, [loadSummary, loadHistory])

      const openFile = useCallback(
        (path) => {
          if (!tabActions || typeof tabActions.openResource !== 'function') return
          // No options: the registry's own ranking picks the tab type - the editor
          // for text, a shipped preview for anything it owns. This is the same
          // call the Files tab makes for a click.
          tabActions.openResource(sessionFileAddress(sessionId, path))
        },
        [tabActions, sessionId],
      )

      const pickCommit = useCallback(
        (commit) => {
          if (selected === commit.sha) {
            detailToken.current += 1
            setSelected(null)
            setDetail({ phase: 'idle', data: null, error: null })
            return
          }
          const token = detailToken.current + 1
          detailToken.current = token
          setSelected(commit.sha)
          setDetail({ phase: 'loading', data: null, error: null })
          fetchJson(COMMIT_ROUTE + '?session=' + encodeURIComponent(sessionId) + '&sha=' + encodeURIComponent(commit.sha))
            .then((data) => {
              if (detailToken.current !== token) return
              setDetail({ phase: 'ready', data, error: null })
            })
            .catch((err) => {
              if (detailToken.current !== token) return
              setDetail({ phase: 'error', data: null, error: { code: err.code || 'ERROR', message: err.message } })
            })
        },
        [selected, sessionId],
      )

      const data = summary.data

      // ---- the tool bar: the workspace scope, and Reload ----
      const tools = h(
        'div',
        { className: 'dsg-tools' },
        h('span', { className: 'dsg-scope', 'data-gittree-scope': data && data.scope ? data.scope : '' }, data && data.scope ? data.scope : ''),
        h(
          'button',
          {
            type: 'button',
            className: 'dsg-btn',
            'data-gittree-reload': true,
            title: 'Reload the branch, the current commit and the history from disk',
            onClick: () => {
              loadSummary()
              loadHistory()
            },
          },
          'Reload',
        ),
      )

      // ---- the file bar: branch, current commit, changed count, version ----
      const ahead = data && data.ahead > 0 ? ' \u2191' + data.ahead : ''
      const behind = data && data.behind > 0 ? ' \u2193' + data.behind : ''
      const fileBar = h(
        'div',
        { className: 'dsg-fileBar' },
        h(
          'span',
          {
            className: 'dsg-branch',
            title: data ? 'branch ' + (data.branch || '(detached)') + (data.repoRoot ? ' in ' + data.repoRoot : '') : '',
          },
          h(GitTreeGlyph, { size: 13, className: 'dsg-glyph' }),
          h('span', { className: 'dsg-branchName' }, data ? data.branch || (data.detached ? '(detached)' : '(no commits)') : '\u2026'),
          ahead + behind !== '' ? h('span', null, ahead + behind) : null,
        ),
        data && data.head ? h('span', { className: 'dsg-sha', 'data-gittree-head': data.head }, data.head) : null,
        h('span', { className: 'dsg-spacer' }),
        data ? h('span', { className: 'dsg-note', 'data-gittree-changed': String(data.changed) }, String(data.changed) + ' changed') : null,
        h('span', { className: 'dsg-ver', title: 'dsh-gittree ' + PLUGIN_VERSION }, PLUGIN_VERSION),
      )

      // ---- the body: the failure / the wait / the history ----
      let body = null
      if (summary.phase === 'error') {
        body = h(StateBox, { state: 'error', error: summary.error, title: stateTitle(summary.error), hint: summary.error && summary.error.message })
      } else if (!data) {
        body = h(StateBox, { state: 'loading', title: 'Reading the workspace\u2026' })
      } else {
        body = h(HistoryView, { history, selected, detail, onPick: pickCommit, onOpen: openFile })
      }

      return h(
        'div',
        { className: 'dsg-root', 'data-gittree-tab': info && info.tab ? info.tab.id : '', 'data-gittree-address': PAGE_ADDRESS },
        tools,
        fileBar,
        body,
      )
    }

    // ---------------------------------------------------------------------
    // The chip title
    // ---------------------------------------------------------------------
    /** The tab strip's label for this kind (the guide entry names the same word). */
    function GitTreeTitle() {
      return h('span', { className: 'dsg-title' }, 'History')
    }

    // ---------------------------------------------------------------------
    // Registry definition
    // ---------------------------------------------------------------------
    function gitTreeDefinition() {
      return {
        id: TYPE_ID,
        kind: KIND,
        // A PAGE type: no `patterns`, so it never claims a file address. Files the
        // history opens go through the ordinary `dsh-resource://file/**` grammar
        // and are claimed by whoever registers for it (the editor, a preview).
        priority: 'builtin',
        title: () => 'History',
        guide: [
          {
            order: 30,
            title: () => 'History',
            description: () => 'Browse this workspace\u2019s commit history',
            icon: GitTreeGlyph,
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
        ctx.effect(() => ctx.sidebarRightTabs.register(gitTreeDefinition()), 'dsh-gittree: gittree tab type')
        ctx.effect(
          () =>
            ctx.slots.inject(TAB_SLOT, () =>
              ctx.slots.register(
                {
                  name: TAB_SLOT,
                  key: TYPE_ID,
                },
                GitTreeView,
              ),
            ),
          'dsh-gittree: gittree tab body',
        )
        ctx.effect(
          () =>
            ctx.slots.inject(TITLE_SLOT, () =>
              ctx.slots.register(
                {
                  name: TITLE_SLOT,
                  key: TYPE_ID,
                },
                GitTreeTitle,
              ),
            ),
          'dsh-gittree: gittree tab title',
        )
        ctx.logger?.debug?.('[dsh-gittree] git tree tab type registered (' + PLUGIN_VERSION + ')')
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[dsh-gittree] activation failed', err)
        ctx.logger?.warn?.('[dsh-gittree] activation failed', err && err.message ? err.message : err)
      }
    }

    exports.name = 'dsh-gittree'
    exports.inject = inject
    exports.apply = apply
    return module.exports
  },
})
