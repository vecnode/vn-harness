/**
 * dsh-diagrams — the TikZ engine: probe, normalize, compile, convert.
 *
 * TikZ has no browser runtime worth shipping: it needs a TeX engine. This
 * module is the whole host side of that - it finds the machine's own engine,
 * turns whatever the model wrote into a document that compiles, runs it under
 * a pinned environment and hard limits, and hands back the PDF plus the
 * converted SVG/PNG the tab and the conversation card draw.
 *
 * The rules that make owning this safe:
 *
 *   - **argv, never a shell.** Every engine and converter is spawned with an
 *     argument array; nothing a model writes is ever parsed by a shell.
 *   - **No shell escape, no installer, no network.** `-no-shell-escape` is on,
 *     `MIKTEX_AUTOINSTALL=0` makes a missing package fail in ~300 ms instead of
 *     reaching for the internet, and `openin_any`/`openout_any` are pinned
 *     paranoid so a document cannot read or write outside its own temp folder.
 *     `tectonic` is deliberately NOT an accepted engine: it downloads packages
 *     on first use, which is exactly the network dependency this pack refuses.
 *   - **A private temp folder per compile**, always removed, with the engine's
 *     cwd inside it, so `\input`/`\write` stay contained and errors name
 *     `diagram.tex:12:` instead of leaking absolute host paths.
 *   - **Bounded.** Wall-clock kill, capped captured output, capped source.
 *   - **Diagnostics are the product.** A failed compile returns the engine's
 *     own lines (`diagram.tex:5: Package pgf Error: ...`), because that is what
 *     lets the model fix the diagram in the same turn.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Default wall-clock budget for one engine run. */
export const COMPILE_TIMEOUT_MS = 20_000
/** Captured engine output is cut here; a runaway log cannot grow without bound. */
const MAX_LOG_CHARS = 512 * 1024
/** At most this many diagnostics travel back to the model. */
const MAX_DIAGNOSTICS = 12

/** The preamble every wrapped TikZ document gets. Verified on MiKTeX 24.1 with
 * `MIKTEX_AUTOINSTALL=0`: every package and library below is present in a
 * standard install, so a wrapped fragment compiles without a network fetch.
 * The library list is deliberately generous - each one a model reaches for
 * routinely (automata for state machines, graphs for `\graph`, trees for
 * `child`, callouts and shadows for annotation) - because a missing library
 * fails the whole compile with "I do not know the key", which is a bad trade
 * against a few hundred milliseconds. */
const PREAMBLE = [
  '\\documentclass[tikz,border=4pt]{standalone}',
  '\\usepackage[T1]{fontenc}',
  '\\usepackage{lmodern}',
  '\\usepackage{amsmath,amssymb}',
  '\\usepackage{tikz}',
  '\\usetikzlibrary{arrows.meta,positioning,shapes.geometric,shapes.misc,shapes.callouts,calc,fit,backgrounds,matrix,chains,automata,graphs,trees,decorations.pathreplacing,decorations.markings,patterns,shadows.blur,quotes,angles,intersections}',
  '\\usepackage{pgfplots}',
  '\\pgfplotsset{compat=1.18}',
  '\\usepgfplotslibrary{fillbetween}',
]

/** Leading lines a model may put in front of the picture; they belong in the preamble. */
const PREAMBLE_LINE = /^\s*\\(usepackage|usetikzlibrary|usepgfplotslibrary|pgfplotsset|tikzset|definecolor|pgfkeys|newcommand|renewcommand|DeclareMathOperator)\b/

/**
 * The flags every engine run gets. `-no-shell-escape` is the one that matters
 * most: without it a document could ask TeX to run a shell command. It is
 * asserted here (and not only in the docs) because the engine is reached from
 * model-written input.
 */
const ENGINE_FLAGS = ['-interaction=nonstopmode', '-no-shell-escape', '-file-line-error']

/** Environments that mean "the source already is a picture". */
const PICTURE_ENV = /\\begin\{(tikzpicture|axis|semilogyaxis|semilogxaxis|loglogaxis|groupplot|circuitikz|tikzcd|scope)\}/

/**
 * Resolve one executable the way a shell would, without a shell: a name that
 * carries a separator is taken literally, a bare name walks PATH and - on
 * Windows - tries each PATHEXT suffix.
 *
 * @param name - executable name or path.
 * @param env - environment to read PATH/PATHEXT from.
 * @returns the absolute path, or null when nothing matched.
 */
export function resolveBinary(name, env = process.env) {
  if (typeof name !== 'string' || name.length === 0) return null
  if (name.includes('/') || name.includes('\\')) return existsSync(name) ? name : null
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean)
  const suffixes =
    process.platform === 'win32'
      ? String(env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
      : ['']
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, name + suffix)
      try {
        if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
      } catch (err) {
        /* unreadable PATH entry: keep looking */
      }
    }
  }
  return null
}

/**
 * Find the engine and the converters this machine has. Called once per process
 * and cached by the caller; the health route re-probes on demand.
 *
 * @param env - environment to resolve from.
 * @returns the capability report the routes, the tools and the UI all read.
 */
export function probeEngines(env = process.env) {
  const engines = ['pdflatex', 'xelatex', 'lualatex']
    .map((id) => ({ id, path: resolveBinary(id, env) }))
    .filter((engine) => engine.path !== null)
  const pdfToCairo = resolveBinary('pdftocairo', env)
  const dvisvgm = resolveBinary('dvisvgm', env)
  const pdfToPpm = resolveBinary('pdftoppm', env)
  const engine = engines[0] ?? null
  return {
    engine: engine ? engine.id : null,
    enginePath: engine ? engine.path : null,
    /** Every engine found, best first - the health route reports all of them. */
    engines: engines.map((entry) => entry.id),
    svg: pdfToCairo ? 'pdftocairo' : dvisvgm ? 'dvisvgm' : null,
    png: pdfToPpm ? 'pdftoppm' : pdfToCairo ? 'pdftocairo' : null,
    paths: {
      pdflatex: engines.find((entry) => entry.id === 'pdflatex')?.path ?? null,
      xelatex: engines.find((entry) => entry.id === 'xelatex')?.path ?? null,
      lualatex: engines.find((entry) => entry.id === 'lualatex')?.path ?? null,
      pdftocairo: pdfToCairo,
      dvisvgm,
      pdftoppm: pdfToPpm,
    },
    /** True when a diagram can actually be compiled on this host. */
    available: engine !== null,
  }
}

/**
 * Turn whatever the model wrote into a document the engine can compile.
 *
 * Three shapes are accepted, and all three are documented to the model:
 *   1. a full document (`\documentclass` present) - used verbatim;
 *   2. a picture (`\begin{tikzpicture}` / `axis` / ...) - wrapped in the
 *      standard preamble;
 *   3. a bare body of TikZ commands - additionally wrapped in `tikzpicture`.
 *
 * Leading `\usepackage`/`\usetikzlibrary`/`\tikzset` style lines are lifted
 * into the preamble, because that is where a model naturally puts them and
 * LaTeX would otherwise reject them inside `document`.
 *
 * @param source - the model's TikZ source.
 * @returns `{ document, wrapped, note }` - the compilable text, whether a
 *   preamble was added, and a one-line note for the tool result.
 */
export function normalizeTikzSource(source) {
  const text = stripFence(String(source ?? ''))
    .replace(/\r\n?/g, '\n')
    .trim()
  if (text.length === 0) return { document: '', wrapped: false, note: 'the source is empty' }

  if (/\\documentclass\b/.test(text)) {
    return { document: text + '\n', wrapped: false, note: 'used as a complete document' }
  }

  const lines = text.split('\n')
  const hoisted = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '' || /^\s*%/.test(line)) {
      // Keep comments with the body; only real preamble commands move up.
      if (hoisted.length > 0) break
      index += 1
      continue
    }
    if (!PREAMBLE_LINE.test(line)) break
    hoisted.push(line.trim())
    index += 1
  }
  const body = lines.slice(index).join('\n').trim()

  const hasPicture = PICTURE_ENV.test(body)
  // Whether the source already IS a complete picture. Note that `\begin{axis}`
  // is a picture but is NOT usable at the top level of a `standalone` document:
  // pdflatex answers "Environment axis undefined" and then every `\addplot` is
  // an undefined control sequence, while the very same axis INSIDE a
  // tikzpicture compiles cleanly. So the wrapper is skipped only for the
  // environments that genuinely stand alone.
  const insidePicture = /\\begin\{tikzpicture\}/.test(body)
  const selfContained = /\\begin\{(tikzcd|circuitikz)\}/.test(body)
  const needsWrapper = !insidePicture && !selfContained
  const picture = needsWrapper ? ['\\begin{tikzpicture}', body, '\\end{tikzpicture}'].join('\n') : body
  const document = [...PREAMBLE, ...hoisted, '\\begin{document}', picture, '\\end{document}', ''].join('\n')
  return {
    document,
    wrapped: true,
    note: needsWrapper
      ? hasPicture
        ? 'wrapped in the standard preamble, inside a tikzpicture'
        : 'wrapped in the standard preamble and a tikzpicture'
      : 'wrapped in the standard preamble',
  }
}

/** Strip one surrounding ```-fence (any info string), as chat input habitually has one. */
export function stripFence(text) {
  const trimmed = text.trim()
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(trimmed)
  return fence ? fence[1] : text
}

/**
 * Compile one already-normalized document in a private temp folder, convert
 * the PDF, and report the diagnostics.
 *
 * @param options - `{ document, engines, timeoutMs, dpi, signal, want }`.
 * @param options.document - the complete LaTeX document.
 * @param options.engines - a {@link probeEngines} report.
 * @param options.timeoutMs - wall-clock budget.
 * @param options.dpi - raster density for the PNG.
 * @param options.signal - caller cancellation; aborts kill the engine.
 * @param options.want - `{ svg?: boolean, png?: boolean }`, both default true.
 * @returns `{ ok, pdf, svg, png, diagnostics, log, pages, width, height, ms, engine }`.
 */
export async function compileTikz({ document, engines, timeoutMs = COMPILE_TIMEOUT_MS, dpi = 200, signal, want } = {}) {
  const started = Date.now()
  if (!engines || !engines.available || !engines.enginePath) {
    return { ok: false, unavailable: true, diagnostics: [], log: '', ms: Date.now() - started, engine: null }
  }
  const wanted = { svg: want?.svg !== false, png: want?.png !== false }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-diagrams-'))
  const results = { ok: false, pdf: null, svg: null, png: null, diagnostics: [], log: '', pages: null, width: null, height: null }
  try {
    writeFileSync(path.join(dir, 'diagram.tex'), document, 'utf8')
    const run = await runEngine(engines.enginePath, ENGINE_FLAGS.concat(['diagram.tex']), {
      cwd: dir,
      timeoutMs,
      signal,
      env: engineEnv(dir),
    })
    results.log = run.output
    // The transcript is the primary source, but `-file-line-error`'s located
    // form (`diagram.tex:5: Package pgf Error: ...`) is written to the log file
    // reliably while the console copy can arrive as the coarser `!` form. Both
    // are read; the located form wins on a duplicate.
    let logText = ''
    try {
      logText = readFileSync(path.join(dir, 'diagram.log'), 'utf8')
    } catch (err) {
      /* no log (the engine failed before writing one): the transcript stands alone */
    }
    results.diagnostics = extractDiagnostics(logText + '\n' + run.output)
    results.ms = Date.now() - started
    results.engine = engines.engine

    const pdfPath = path.join(dir, 'diagram.pdf')
    if (!existsSync(pdfPath)) {
      return results
    }
    results.pdf = readFileSync(pdfPath)
    const info = pdfInfo(results.pdf)
    results.pages = info.pages
    results.width = info.width
    results.height = info.height

    if (wanted.svg && engines.svg) {
      results.svg = await convert(engines, 'svg', dir, { timeoutMs, signal, env: engineEnv(dir) })
    }
    if (wanted.png && engines.png) {
      results.png = await convert(engines, 'png', dir, { timeoutMs, signal, dpi, env: engineEnv(dir) })
    }
    results.ok = results.diagnostics.length === 0 && (results.svg !== null || results.png !== null || results.pdf !== null)
    return results
  } catch (err) {
    results.diagnostics = [{ kind: 'engine', text: 'the TeX engine could not be run: ' + message(err) }]
    results.ms = Date.now() - started
    return results
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      /* a temp folder that will not delete is not worth failing the call for */
    }
  }
}

/** The pinned environment every engine and converter runs under. */
function engineEnv(dir) {
  return {
    ...process.env,
    // A missing package must fail fast, not reach the network.
    MIKTEX_AUTOINSTALL: '0',
    // Paranoid input/output: a document cannot read or write outside its own folder.
    openin_any: 'p',
    openout_any: 'p',
    TEXMFOUTPUT: dir,
    LC_ALL: 'C',
  }
}

/** How long a converter gets; conversion is cheap, so a shorter leash than the engine. */
const CONVERT_TIMEOUT_MS = 10_000

/** Run one converter and read its product back. */
async function convert(engines, format, dir, { timeoutMs, signal, dpi, env }) {
  const pdf = path.join(dir, 'diagram.pdf')
  if (format === 'svg') {
    if (engines.svg === 'pdftocairo') {
      const out = path.join(dir, 'diagram.svg')
      const run = await runEngine(engines.paths.pdftocairo, ['-svg', pdf, out], {
        cwd: dir,
        timeoutMs: Math.min(timeoutMs, CONVERT_TIMEOUT_MS),
        signal,
        env,
      })
      if (run.code === 0 && existsSync(out)) return readFileSync(out)
      return null
    }
    const out = path.join(dir, 'diagram.svg')
    const run = await runEngine(engines.paths.dvisvgm, ['--pdf', '--no-fonts', '--output=' + out, pdf], {
      cwd: dir,
      timeoutMs: Math.min(timeoutMs, CONVERT_TIMEOUT_MS),
      signal,
      env,
    })
    if (run.code === 0 && existsSync(out)) return readFileSync(out)
    return null
  }
  const stem = path.join(dir, 'diagram-raster')
  if (engines.png === 'pdftoppm') {
    const run = await runEngine(engines.paths.pdftoppm, ['-png', '-r', String(dpi), '-singlefile', pdf, stem], {
      cwd: dir,
      timeoutMs: Math.min(timeoutMs, CONVERT_TIMEOUT_MS),
      signal,
      env,
    })
    if (run.code === 0 && existsSync(stem + '.png')) return readFileSync(stem + '.png')
    return null
  }
  const run = await runEngine(engines.paths.pdftocairo, ['-png', '-r', String(dpi), '-singlefile', pdf, stem], {
    cwd: dir,
    timeoutMs: Math.min(timeoutMs, CONVERT_TIMEOUT_MS),
    signal,
    env,
  })
  if (run.code === 0 && existsSync(stem + '.png')) return readFileSync(stem + '.png')
  return null
}

/**
 * Spawn one engine or converter: capped output, a wall-clock kill, and the
 * caller's abort signal wired to the same kill.
 *
 * @returns `{ code, output, timedOut, aborted }`.
 */
function runEngine(command, args, { cwd, timeoutMs, signal, env }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const append = (chunk) => {
      if (output.length >= MAX_LOG_CHARS) return
      output += chunk.toString('utf8').slice(0, MAX_LOG_CHARS - output.length)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGKILL')
      } catch (err) {
        /* already gone */
      }
    }, timeoutMs)
    const onAbort = () => {
      try {
        child.kill('SIGKILL')
      } catch (err) {
        /* already gone */
      }
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const finish = (code) => {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({ code, output, timedOut, aborted: Boolean(signal && signal.aborted) })
    }
    child.on('error', (err) => {
      append('could not start ' + path.basename(command) + ': ' + message(err) + '\n')
      finish(-1)
    })
    child.on('close', (code) => finish(code === null ? -1 : code))
  })
}

/**
 * Pull the readable errors out of an engine transcript (and its log).
 *
 * Two shapes matter:
 *   `diagram.tex:5: Package pgf Error: No shape named 'b' is known.`  (-file-line-error)
 *   `! LaTeX Error: File 'notapackagexyz.sty' not found.`            (classic)
 *
 * The located form wins: when both describe the same failure, only the one
 * that names a line is kept, because that is the one the model can act on.
 *
 * @param output - the captured stdout+stderr, optionally with the log prepended.
 * @returns up to {@link MAX_DIAGNOSTICS} diagnostics, `{ kind, text }`.
 */
export function extractDiagnostics(output) {
  const lines = String(output ?? '').split('\n')
  const located = []
  const plain = []
  const seen = new Set()
  const keep = (bucket, text) => {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (clean.length === 0 || seen.has(clean)) return
    // The engine's own sign-off, not a diagnostic.
    if (clean.startsWith('==>')) return
    seen.add(clean)
    bucket.push({ kind: 'error', text: clean.slice(0, 400) })
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim()
    const match = /^([^\s:]+\.(?:tex|sty|cls|def|cfg)):(\d+):\s*(.*)$/.exec(line)
    if (match) {
      keep(located, match[1] + ':' + match[2] + ': ' + match[3])
      continue
    }
    const bang = /^!\s*(.*)$/.exec(line)
    if (bang) {
      let text = bang[1]
      // `! LaTeX Error: File 'x.sty' not found.` is followed by the use site;
      // a short continuation line carries the missing name and is worth having.
      const next = (lines[i + 1] ?? '').trim()
      if (next.length > 0 && next.length < 120 && !/^l\.\d+/.test(next) && !/^<.*>$/.test(next)) {
        text = text + ' ' + next
      }
      keep(plain, text)
      continue
    }
    const missing = /^File `([^']+)' not found/.exec(line)
    if (missing) keep(plain, 'missing file: ' + missing[1])
  }
  const merged = [...located]
  for (const entry of plain) {
    const duplicate = merged.some((kept) => kept.text.includes(entry.text) || entry.text.includes(kept.text))
    if (!duplicate) merged.push(entry)
  }
  return merged.slice(0, MAX_DIAGNOSTICS)
}

/**
 * Read a PDF's page count and first page box the cheap way - by scanning the
 * bytes. A wrong guess here only mis-sizes a preview, so the heuristic stays
 * simple: `/Type /Page` entries (not `/Pages`) and the first `/MediaBox`.
 *
 * @param bytes - the PDF buffer.
 * @returns `{ pages, width, height }`; width/height are PDF points.
 */
export function pdfInfo(bytes) {
  const text = bytes.toString('latin1')
  const pages = (text.match(/\/Type\s*\/Page[^s]/g) ?? []).length
  const box = /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/.exec(text)
  let width = null
  let height = null
  if (box) {
    width = Math.abs(Number(box[3]) - Number(box[1]))
    height = Math.abs(Number(box[4]) - Number(box[2]))
    if (!Number.isFinite(width) || width <= 0) width = null
    if (!Number.isFinite(height) || height <= 0) height = null
  }
  return { pages: pages > 0 ? pages : null, width, height }
}

/** Ensure a directory exists (small helper the store and cache share). */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/** One error's message, whatever was thrown. */
function message(err) {
  return err && err.message ? String(err.message) : String(err)
}
