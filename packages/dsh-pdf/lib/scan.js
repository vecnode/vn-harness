/**
 * dsh-pdf — the scanning pass: image-only pages in, recognized text out.
 *
 * A scanned page is a picture of text, and no amount of parsing produces its
 * words: pdf.js reports 0 characters because there are none, and that is the
 * honest answer. Recognising it takes two engines that pdf.js cannot be - a
 * RASTERIZER (Node has no canvas, so the machine's own tooling draws the page)
 * and an OCR engine - and this file is the one place that puts them together,
 * shared by the `pdf_scan` tool and by the reader's own "scan this page" action
 * through POST /api/dsh-pdf/scan. One pipeline, so what the model is told and
 * what a person sees cannot drift.
 *
 * Three rules make the result trustworthy rather than merely plausible:
 *
 *   - **Nothing is recognized twice for nothing, and nothing is reused wrongly.**
 *     A result is cached under the page, language, raster resolution and
 *     page-segmentation mode that produced it (see `PdfCache.ocrName`), so the
 *     second read is free while reading the same page at another resolution for
 *     tables after reading it for prose is a NEW recognition.
 *   - **A page that already has a text layer is not OCR'd** unless the caller
 *     asks for that exact page. Recognized text of a page that already had real
 *     text is strictly worse than the real text, and offering it as a default
 *     would tempt a model into quoting the inferior copy.
 *   - **Every absence is a sentence, never a failure.** No rasterizer, no OCR
 *     engine, no data for the requested language: each comes back as a reason
 *     the caller can word for its surface, and the pages that need scanning are
 *     still named.
 */
import { DEFAULT_DPI, clampDpi, ocr, ocrLanguages, rasterize } from './engines.js'

/** Pages one scan call may recognize. Recognition is slow; ten is a chapter. */
export const MAX_SCAN_PAGES = 10
/** The raster resolution a scan uses when the caller does not choose one. */
export const SCAN_DPI = 200
/** tesseract's "fully automatic page segmentation, but no OSD" - the sane default. */
export const DEFAULT_PSM = 3
/** The language a scan uses when the caller does not choose one. */
export const DEFAULT_LANG = 'eng'
/** Language tags this plugin will pass through (three-letter tags, joined by `+`). */
const LANG_PATTERN = /^[a-z]{3}(?:\+[a-z]{3})*$/

/** Languages per engine binary, remembered for this process: one spawn each. */
const languageMemo = new Map()

/**
 * The languages an engine has data for, memoized per binary for this process.
 *
 * @param engine - the OCR engine entry.
 * @returns `{ list, checkedAt }`, `list` being null when it could not be asked.
 */
export async function languagesFor(engine) {
  if (!engine || typeof engine.file !== 'string') return { list: null, checkedAt: null }
  const memo = languageMemo.get(engine.file)
  if (memo) return memo
  const list = await ocrLanguages(engine)
  const entry = { list, checkedAt: new Date().toISOString() }
  languageMemo.set(engine.file, entry)
  return entry
}

/** Forget the memoized language list (used when a caller re-probes engines). */
export function forgetLanguages() {
  languageMemo.clear()
}

/**
 * The sentence one refusal reason deserves, wherever it is shown.
 *
 * @param reason - a reason code from {@link scanPages}.
 * @param extra - `{ available, pages }`, when the reason carries facts.
 * @returns one line, in plain words.
 */
export function scanReasonText(reason, extra = {}) {
  if (reason === 'no-ocr') {
    return 'No OCR engine is installed on this host, so scanned pages cannot be recognized here. Install tesseract (with the language data for the document) on the machine running the harness; `pdf_info` and this tool both report whether it is there.'
  }
  if (reason === 'no-rasterizer') {
    return 'This host has no PDF rasterizer, so a scanned page cannot even be turned into a picture to recognize. Install poppler (`pdftoppm`), `mutool` or Ghostscript.'
  }
  if (reason === 'no-language') {
    const available = Array.isArray(extra.available) && extra.available.length > 0 ? extra.available.join(', ') : 'none reported'
    return 'The OCR engine has no data for that language. It reports: ' + available + '.'
  }
  if (reason === 'no-pages') {
    return 'No page needed scanning: every inspected page already has a text layer.'
  }
  if (reason === 'bad-language') {
    return 'That is not a language tag. Use a three-letter code such as `eng`, `por`, `deu`, or several joined with `+` (for example `eng+por`).'
  }
  return 'The scan could not run.'
}

/**
 * Recognize a page range.
 *
 * @param options - `{ reader, cache, engines, file, sha, pages, dpi, lang, psm, signal, log }`.
 *   `pages` is 1-based page numbers, already selected by the caller.
 * @returns `{ ok, reason?, engine, lang, dpi, psm, pages, scanned, fromCache, skipped, ms }`.
 */
export async function scanPages({ cache, engines, file, sha, pages, dpi, lang = DEFAULT_LANG, psm = DEFAULT_PSM, signal, log = () => {} }) {
  const started = Date.now()
  const wanted = [...new Set(pages)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b)
  const chosen = wanted.slice(0, MAX_SCAN_PAGES)
  const skipped = wanted.slice(MAX_SCAN_PAGES)
  const size = clampDpi(dpi ?? SCAN_DPI)
  const mode = Number.isInteger(psm) && psm >= 0 && psm <= 13 ? psm : DEFAULT_PSM
  const tag = String(lang).toLowerCase()

  if (!LANG_PATTERN.test(tag)) return { ok: false, reason: 'bad-language', pages: [], scanned: 0, fromCache: 0, skipped, ms: Date.now() - started }
  if (!engines || !engines.ocr) return { ok: false, reason: 'no-ocr', pages: [], scanned: 0, fromCache: 0, skipped, ms: Date.now() - started }
  if (!engines.rasterizer) return { ok: false, reason: 'no-rasterizer', pages: [], scanned: 0, fromCache: 0, skipped, ms: Date.now() - started }

  // Ask the engine what it can read, and refuse a language it does not have
  // rather than letting it fail per page with its own error text.
  const languages = await languagesFor(engines.ocr)
  if (languages.list !== null && !languages.list.includes(tag)) {
    return { ok: false, reason: 'no-language', available: languages.list, pages: [], scanned: 0, fromCache: 0, skipped, ms: Date.now() - started }
  }

  const results = []
  let scanned = 0
  let fromCache = 0
  for (const n of chosen) {
    const cached = cache.ocr(sha, n, tag, size, mode)
    if (typeof cached === 'string') {
      fromCache += 1
      results.push({ n, text: cached, chars: cached.length, cached: true })
      continue
    }
    // The raster is a kept artifact, not a temporary: tesseract takes a path,
    // and the same picture answers a later scan at this resolution for free.
    let imagePath = cache.imagePath(sha, n, size)
    if (!cache.image(sha, n, size)) {
      const drawn = await rasterize({ engine: engines.rasterizer, file, from: n, to: n, dpi: size })
      if (!drawn.ok) {
        results.push({ n, error: 'the page could not be drawn (' + (drawn.reason ?? 'engine failed') + ')' })
        continue
      }
      const produced = drawn.pages[0]
      if (!produced || !produced.bytes) {
        results.push({ n, error: 'the rasterizer produced no picture for this page' })
        continue
      }
      try {
        imagePath = cache.writeImage(sha, n, size, produced.bytes)
      } catch (err) {
        results.push({ n, error: 'the picture could not be cached: ' + (err && err.message ? err.message : String(err)) })
        continue
      }
    }
    const recognized = await ocr({ engine: engines.ocr, image: imagePath, lang: tag, psm: mode })
    if (!recognized.ok) {
      results.push({ n, error: 'recognition failed (' + (recognized.reason ?? 'engine failed') + ')' + (recognized.stderr ? ': ' + firstLine(recognized.stderr) : '') })
      continue
    }
    try {
      cache.writeOcr(sha, n, tag, size, mode, recognized.text)
    } catch (err) {
      log('could not cache the recognized text: ' + (err && err.message ? err.message : String(err)))
    }
    scanned += 1
    const trimmed = recognized.text.replace(/\s+$/, '')
    results.push({ n, text: trimmed, chars: trimmed.length, cached: false, ms: recognized.ms, image: imagePath })
  }

  return {
    ok: true,
    engine: engines.ocr.name,
    lang: tag,
    dpi: size,
    psm: mode,
    pages: results,
    scanned,
    fromCache,
    skipped,
    ms: Date.now() - started,
  }
}

/** The first non-empty line of an engine's complaint. */
function firstLine(text) {
  const line = String(text)
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)[0]
  return line ? line.slice(0, 200) : ''
}

/** The default raster resolution, re-exported so callers state one number. */
export { DEFAULT_DPI }
