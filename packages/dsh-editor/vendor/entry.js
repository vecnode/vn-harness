/**
 * CodeMirror 6 vendor entry - the runtime face the dsh-editor client uses.
 *
 * Bundled ONCE at build time into a single classic IIFE assigned to
 * `window.DSHEditorCM` (esbuild --format=iife --global-name=DSHEditorCM).
 * The dsh-editor client fetches that bundle over its authenticated
 * /api/dsh-editor/vendor route and runs it as a classic script before the
 * first editor opens. Everything reachable here is inlined by esbuild, so no
 * runtime module resolution happens in the browser.
 */
export {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands'

export {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete'

export {
  Compartment,
  EditorSelection,
  EditorState,
  Prec,
  StateEffect,
} from '@codemirror/state'

export {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  indentOnInput,
  StreamLanguage,
  syntaxHighlighting,
} from '@codemirror/language'

export {
  closeSearchPanel,
  highlightSelectionMatches,
  openSearchPanel,
  search,
  SearchQuery,
  searchKeymap,
  setSearchQuery,
} from '@codemirror/search'

export {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'

export { css } from '@codemirror/lang-css'
export { html } from '@codemirror/lang-html'
export { javascript } from '@codemirror/lang-javascript'
export { json } from '@codemirror/lang-json'
export { markdown } from '@codemirror/lang-markdown'
export { python } from '@codemirror/lang-python'
export { yaml } from '@codemirror/lang-yaml'
export { oneDark } from '@codemirror/theme-one-dark'

// Shell languages ride on StreamLanguage: CodeMirror 6 has no Lezer parser for
// either, and legacy-modes carries the two ported CM5 modes this needs.
// `shell` covers sh/bash/zsh/dash; `powerShell` covers ps1/psm1/psd1. There is
// no batch mode anywhere (CM5 never shipped one), so the batch tokenizer lives
// in the client and is wrapped by the same StreamLanguage.define().
export { shell } from '@codemirror/legacy-modes/mode/shell'
export { powerShell } from '@codemirror/legacy-modes/mode/powershell'
export { batch } from './batch-mode.js'
