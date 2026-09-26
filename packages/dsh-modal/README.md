# dsh-modal (alpha.1)

**Modal** is the pack's shared dialog surface for the DeepSeek Harness web GUI.
It is a **client-service plugin**: its browser half mounts one body-level
overlay and provides the **`modals`** service on the client context, so any other
client plugin — inside this pack or in a deployment — opens a dialog with

```js
const modals = ctx.get('modals')
const values = await modals.open({ title: 'Save new file', fields: [...], submit })
```

instead of shipping its own prompt markup. One dialog shows at a time and every
dialog in the app looks and behaves the same. Alpha.

## The API

| Call | Answers |
|---|---|
| `modals.open(spec)` | a Promise: **`null`** when the dialog is cancelled, otherwise the field values — or whatever `spec.submit` returned |
| `modals.alert(specOrMessage)` | a Promise that settles when the single-button dialog is dismissed |
| `modals.confirm(specOrMessage)` | `true` only when the confirm button was used |
| `modals.prompt(spec)` | the typed string, or `null` when cancelled |
| `modals.close(result?)` | closes whatever is open, resolving it with `result` (default `null`) |
| `modals.isOpen()` | whether a dialog is currently up |

`spec` (all fields optional):

| Field | Meaning |
|---|---|
| `title`, `message` | the heading and the body line |
| `fields` | `[{ name, label?, value?, placeholder?, hint?, mono?, required?, maxLength? }]` — text inputs; the first one is focused and selected |
| `validate(values)` | returns an error **string** to show inline and block the submit |
| `submit(values, …)` | async work that runs **while the dialog stays open** |
| `confirmLabel`, `cancelLabel`, `busyLabel` | button copy (`cancelLabel: null` renders no cancel button — an alert) |
| `danger` | paints the confirm button as the error color |

`submit` is the point of the whole surface: a save, a rename or a request that
can fail runs with the dialog still on screen, so the failure is reported
**inside** it and the user keeps everything they typed. Throwing (or rejecting)
shows the message and leaves the dialog open; resolving closes it and settles the
`open()` Promise with the returned value (or the values when it returns
`undefined`).

Cancel paths are the Cancel button, **Escape** (captured on the document, so the
pane underneath never sees the key) and a click on the mask. None of them fires
while `submit` is still running. Focus moves to the first field and returns to
whatever had it when the dialog closes.

Two calls that overlap **queue**: the second dialog opens when the first settles,
so two racing saves can never replace each other's UI.

## Why it owns no slot

The host creates its own container on `document.body` and renders it with
`react-dom/client`'s `createRoot`. Both `react-dom` and `react-dom/client` are
seeded in the shell's module table, so no slot registration, no layout
contribution and no ordering constraint is involved — which is exactly what makes
the service callable from every plugin. The service itself is published with
`ctx.reflect.provide('modals', …)`, the same client-service mechanism
`dsh-rightbar` uses for `sidebarRightTabs` / `sidebarRight`.

## Layout

```
cordis.patch.yml   bundle layer: inserts the 'modal' row (nothing else patched)
lib/index.js       Node half: a no-op row, so the client bundle joins the boot graph
lib/client.js      Browser half: the overlay host, the queue, and the `modals` service
```

## Consumers

- [`packages/dsh-editor`](../dsh-editor) uses `modals.open` for the save-as
  dialog (name + extension) that creates a new file.

## Install / uninstall

The repo launcher (`install.bat` on Windows, `./install.sh` on macOS/Linux)
auto-discovers this package - it is a standard `dsh.bundle`. Adding a package
changes the profile's bundle set, and a bundle the profile does not list yet is
added by one plain launcher run (no `-Force` needed); after that a plain run is
enough. The web profile links
it into this repo, so code edits only need a restart of
`npx @deepseek-ai/dsh web` plus a hard browser refresh. Starting it is
`run-web.bat` / `./run-web.sh` - the launcher that starts `dsh web` and opens the URL it
prints in Chrome.
