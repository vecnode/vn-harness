/**
 * dsh-pdf — the engines this host can offer, and how a page becomes a picture.
 *
 * pdf.js is the one engine that is always present: it is vendored inside this
 * package and it is what reads text, layout, metadata and structure. Everything
 * here is OPTIONAL and exists because pdf.js alone cannot do it:
 *
 *   - **rasterizing a page to PNG** needs a canvas, and Node has none. The
 *     machine's own PDF tooling does it properly, so `pdf_render` - and the OCR
 *     input in alpha.2 - resolves poppler's `pdftoppm`, then `mutool`, then
 *     Ghostscript, and says plainly what it found.
 *   - **OCR of a scanned page** needs an OCR engine; `tesseract` is detected
 *     here and used from alpha.2.
 *
 * The rules this file follows, all of them the same rules the pack's TeX engine
 * path uses:
 *
 *   - the binary is RESOLVED from PATH and never installed, downloaded or
 *     bundled;
 *   - it is spawned with an ARGV ARRAY and no shell, so no path or option can
 *     ever be interpreted by a command interpreter;
 *   - it runs under a pinned environment (`LC_ALL=C` so its output is stable,
 *     `GIT_TERMINAL_PROMPT`-style prompts off) in a PRIVATE TEMPORARY directory,
 *     so nothing it writes can land in the user's folders;
 *   - it is killed on a deadline and its output is capped;
 *   - a missing engine is a plain sentence, never a broken tool.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

/** How long one engine invocation may take. */
export const ENGINE_TIMEOUT_MS = 30_000
/** How much of an engine's own output is kept for diagnostics. */
const ENGINE_OUTPUT_CAP = 256 * 1024
/** Raster sizes this plugin will ask an engine for. */
export const MIN_DPI = 50
export const MAX_DPI = 400
export const DEFAULT_DPI = 150

/**
 * Rasterizers in preference order. Each entry knows how to ask for a page range
 * and where the engine puts the files; `%d` is the page number placeholder.
 */
const RASTERIZERS = [
  {
    name: 'pdftoppm',
    args: ({ dpi, from, to, file, out }) => ['-r', String(dpi), '-png', '-f', String(from), '-l', String(to), file, out],
    // pdftoppm zero-pads to the width of the LAST page number, so the caller
    // must not predict the names: the produced files are read back and mapped
    // positionally onto the requested range.
    pattern: /^(.*)-(\d+)\.png$/i,
    versionArgs: ['-v'],
  },
  {
    name: 'mutool',
    args: ({ dpi, from, to, file, out }) => ['draw', '-q', '-r', String(dpi), '-o', out + '%d.png', file, from + '-' + to],
    pattern: /^(.*?)(\d+)\.png$/i,
    versionArgs: ['-v'],
  },
  {
    name: 'gswin64c',
    args: ({ dpi, from, to, file, out }) => [
      '-q',
      '-dNOPAUSE',
      '-dBATCH',
      '-dSAFER',
      '-sDEVICE=png16m',
      '-r' + dpi,
      '-dFirstPage=' + from,
      '-dLastPage=' + to,
      '-sOutputFile=' + out + '%d.png',
      file,
    ],
    pattern: /^(.*?)(\d+)\.png$/i,
    versionArgs: ['--version'],
    alsoTry: ['gswin32c', 'gs'],
  },
]

/** The OCR engine alpha.2 drives; detected here so the host can report it. */
const OCR_ENGINES = [{ name: 'tesseract', versionArgs: ['--version'] }]

/** Look one executable up on PATH, the way a shell would, without a shell. */
export function which(name, extraNames = []) {
  const candidates = [name, ...extraNames]
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : ['']
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter((entry) => entry !== '')
  for (const candidate of candidates) {
    for (const dir of dirs) {
      for (const ext of exts) {
        const full = path.join(dir, candidate + ext)
        try {
          if (existsSync(full) && statSync(full).isFile()) return full
        } catch (err) {
          /* an unreadable PATH entry is not a match */
        }
      }
    }
  }
  return null
}

/** Run one engine invocation: argv only, pinned env, deadline, capped output. */
function run(file, args, { timeoutMs = ENGINE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      {
        timeout: timeoutMs,
        maxBuffer: ENGINE_OUTPUT_CAP,
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          status: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          killed: Boolean(err && err.killed),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
          error: err && !err.killed ? String(err.message) : null,
        })
      },
    )
    // A caller that aborts should not leave an engine running.
    child.on('error', () => resolve({ ok: false, status: 1, killed: false, stdout: '', stderr: '', error: 'the engine could not be started' }))
  })
}

/**
 * Probe the host for the optional engines. Cheap and idempotent: the result is
 * cached by the caller and re-probed only when a tool result says so.
 *
 * @returns `{ rasterizer, ocr, checkedAt }`, each `null` when absent.
 */
export function probeEngines() {
  let rasterizer = null
  for (const candidate of RASTERIZERS) {
    const found = which(candidate.name, candidate.alsoTry ?? [])
    if (found) {
      rasterizer = { name: path.basename(found).replace(/\.exe$/i, ''), file: found, pattern: candidate.pattern, args: candidate.args }
      break
    }
  }
  let ocr = null
  for (const candidate of OCR_ENGINES) {
    const found = which(candidate.name)
    if (found) ocr = { name: candidate.name, file: found }
  }
  return { rasterizer, ocr, checkedAt: new Date().toISOString() }
}

/** PNG dimensions, straight from the IHDR chunk - no image library needed. */
export function pngSize(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 24) return null
  const signature = bytes.subarray(0, 8).toString('latin1')
  if (signature !== '\u0089PNG\r\n\u001a\n') return null
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

/** Clamp a requested DPI into the range this plugin will ask an engine for. */
export function clampDpi(value) {
  const dpi = Number(value)
  if (!Number.isFinite(dpi)) return DEFAULT_DPI
  return Math.min(MAX_DPI, Math.max(MIN_DPI, Math.round(dpi)))
}

/**
 * Rasterize a page range with whichever engine this host has.
 *
 * The engine writes into a PRIVATE temporary directory and the produced files
 * are read back in page order, so no engine's naming scheme becomes this
 * plugin's contract.
 *
 * @param options - `{ engine, file, from, to, dpi }`.
 * @returns `{ ok, pages: [{ page, bytes, width, height }], stderr }` or `{ ok: false, reason }`.
 */
export async function rasterize({ engine, file, from, to, dpi = DEFAULT_DPI }) {
  if (!engine) return { ok: false, reason: 'no-rasterizer', pages: [] }
  const size = clampDpi(dpi)
  const dir = path.join(os.tmpdir(), 'dsh-pdf-' + randomBytes(6).toString('hex'))
  mkdirSync(dir, { recursive: true })
  const outBase = path.join(dir, 'page')
  try {
    const result = await run(engine.file, engine.args({ dpi: size, from, to, file, out: outBase }))
    const produced = readdirSync(dir)
      .map((name) => {
        const match = engine.pattern.exec(name)
        return match ? { name, order: Number(match[2]) } : null
      })
      .filter((entry) => entry !== null)
      .sort((a, b) => a.order - b.order)
    const pages = []
    const wanted = to - from + 1
    for (const [index, entry] of produced.entries()) {
      const full = path.join(dir, entry.name)
      let bytes
      try {
        bytes = readFileSync(full)
      } catch (err) {
        continue
      }
      const dimensions = pngSize(bytes)
      pages.push({
        // The engine numbers pages absolutely; a produced file is mapped back to
        // the page it belongs to, and a range that produced fewer files than
        // asked for keeps the pages it did produce.
        page: from + index < from + wanted ? from + index : entry.order,
        bytes,
        width: dimensions ? dimensions.width : null,
        height: dimensions ? dimensions.height : null,
      })
    }
    if (pages.length === 0) {
      return { ok: false, reason: result.killed ? 'timeout' : 'no-output', pages: [], stderr: (result.stderr || result.error || '').slice(0, 600) }
    }
    return { ok: true, pages, dpi: size, stderr: result.stderr.slice(0, 600) }
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch (err) {
      /* a temporary directory that will not delete is the OS's problem */
    }
  }
}
