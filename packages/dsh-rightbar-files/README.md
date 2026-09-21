# dsh-rightbar-files (alpha.1)

**The right bar's Files tab** — the session workspace tree (directories expand
in place, one level at a time, over the `remote.workspaceFiles` namespace) as a
tab type of the pack's own bar. Alpha.

It is the second half of the fork: `lib/client.js` is a byte-for-byte copy of
the shipped `@deepseek-ai/dsh-client-ui-sidebar-files` bundle with the
module-table id rewritten to `dsh-rightbar-files`. The core row is disabled by
`dsh-rightbar`'s bundle layer, so this copy is the one that runs.

It registers exactly like any other tab type — a definition into
`ctx.sidebarRightTabs` plus its body/title under the same key:

| Piece | Value |
|---|---|
| `id` / slot key | `@deepseek-ai/dsh-client-ui-sidebar-files` — the tab type's identity is the **core** one, deliberately: `sync-vendored.ps1` rewrites the module-table id (which is `dsh-rightbar-files`, so the boot graph loads this file) and leaves `FILES_ID` alone, so a tab type keeps its identity across the fork and the shipped document preview keeps resolving the same key |
| `kind` | `files` |
| `priority` | `builtin` |
| `guide` | one entry, `order: 10` — "Files" on the Start page the "+" control opens |
| body | the tree; a file row opens `dsh-resource://file/session/<sessionId>/<path>` through `tabActions.openResource`, which the tab-type registry routes to whichever type claims it (the pack's **Editor** claims text/code files) |

`package.json`'s `dsh.client.inject` names `dsh-rightbar` (not the core
package) so the bar's module is ordered before this one.

## Re-syncing the fork

Same as `dsh-rightbar`: run `scripts/sync-vendored.ps1` after a harness-line
bump (it copies both forked bundles and rewrites their ids).

## Layout

```
cordis.patch.yml   bundle layer: inserts the 'rightbar-files' row
lib/index.js       Node half: no-op row so the browser bundle ships
lib/client.js      GENERATED vendored Files tab (do not edit; re-sync instead)
```
