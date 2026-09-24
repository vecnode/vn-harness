/**
 * A CodeMirror 5-style stream mode for Windows batch files (.bat / .cmd).
 *
 * CodeMirror never shipped one: @codemirror/legacy-modes carries the ported CM5
 * modes and there is no `batch` among them (CM5 had no batch mode either), and
 * there is no Lezer grammar for it. So this is hand-written, and it is a
 * BUILD INPUT like entry.js - esbuild inlines it into the vendored bundle, and
 * the client wraps it with `StreamLanguage.define(CM.batch)` exactly the way it
 * wraps the two modes legacy-modes does provide (shell, powerShell).
 *
 * The token names are CM5's vocabulary ("comment", "keyword", "string", ...),
 * which is what StreamLanguage maps onto Lezer highlight tags - so the same
 * `syntaxHighlighting(defaultHighlightStyle)` and `oneDark` that color .js and
 * .py color a .bat too, in both the light and the dark palette.
 */

/** Command words that start a statement, and the contextual words cmd reads. */
const KEYWORDS = new RegExp(
  '^@?(?:' +
    [
      'echo', 'for', 'if', 'else', 'goto', 'call', 'set', 'setx', 'setlocal',
      'endlocal', 'shift', 'exit', 'cd', 'chdir', 'pushd', 'popd', 'copy',
      'xcopy', 'robocopy', 'move', 'del', 'erase', 'md', 'mkdir', 'rd', 'rmdir',
      'ren', 'rename', 'type', 'find', 'findstr', 'start', 'taskkill', 'pause',
      'cls', 'title', 'ver', 'vol', 'path', 'prompt', 'assoc', 'attrib',
      'mklink', 'timeout', 'where', 'whoami', 'choice', 'color', 'date', 'time',
      'subst', 'tree', 'fc', 'comp', 'sort', 'more', 'net', 'reg', 'sc', 'wmic',
      'schtasks', 'diskpart', 'powershell', 'do', 'in', 'not', 'exist',
      'defined', 'errorlevel', 'equ', 'neq', 'lss', 'leq', 'gtr', 'geq',
      'on', 'off',
    ].join('|') +
    ')$',
  'i',
)

/** `set` names the variable that follows, which is a definition, not a word. */
const NAMES_A_VALUE = /^@?(?:set|setx)$/i

export const batch = {
  name: 'batch',

  startState() {
    return { expectName: false }
  },

  blankLine(state) {
    state.expectName = false
  },

  token(stream, state) {
    if (stream.eatSpace()) return null

    // Whole-line forms: `rem ...` / `@rem ...`, `:: ...` (the label form nobody
    // jumps to), and a real label `:name`.
    if (stream.sol()) {
      state.expectName = false
      if (stream.match(/^@?rem(?:\s|$)/i) || stream.match(/^::/)) {
        stream.skipToEnd()
        return 'comment'
      }
      if (stream.match(/^:[^\s=]/)) {
        stream.eatWhile(/\S/)
        return 'def'
      }
    }

    // A quoted string runs to its closing quote, or to the end of the line when
    // it is never closed (cmd would take the rest of the line).
    if (stream.match(/^"(?:[^"]*)"?/)) {
      state.expectName = false
      return 'string'
    }
    // `%VAR%`, `!VAR!` (delayed expansion), and the argument forms `%1`, `%*`,
    // `%~dp0`.
    if (stream.match(/^%[^%\s]+%|^![^!\s]+!|^%~?[a-z\d*]+/i)) {
      state.expectName = false
      return 'variable-2'
    }
    // A switch: /S /Q /FOO:bar
    if (stream.match(/^\/[a-z?][\w:+-]*/i)) {
      state.expectName = false
      return 'atom'
    }
    if (stream.match(/^&&|^\|\||^[|&<>()=]/)) {
      state.expectName = false
      return 'operator'
    }
    if (stream.match(/^\d+/)) {
      state.expectName = false
      return 'number'
    }
    // A word. Only a command word is coloured; `echo.` and `echo:` are still
    // echo, so trailing punctuation does not hide the keyword.
    if (stream.match(/^@?[a-z_][\w.$-]*/i)) {
      const word = stream.current().replace(/[.,;:]+$/, '')
      const wasName = state.expectName
      state.expectName = NAMES_A_VALUE.test(word)
      if (KEYWORDS.test(word)) return 'keyword'
      if (wasName) return 'def'
      return null
    }

    stream.next()
    state.expectName = false
    return null
  },
}
