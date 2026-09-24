/**
 * dsh-pdf — one extraction job, run as a CHILD PROCESS.
 *
 * Why a child: a PDF is untrusted input handed to a large parser. pdf.js has
 * had parsing crashes and decompression bombs before, and any parser can spin.
 * Running it in this process means the worst case is a killed child that the
 * host reports as "could not read this document" - never a harness that stops
 * answering. The parent owns the timeout, the heap cap, the cache and every cap
 * on what is kept; this process only reads a document and says what is in it.
 *
 * The interface is deliberately tiny: a JSON request on stdin, ONE JSON line on
 * stdout, and the exit code is not part of the contract (a verdict is always
 * printed, including for a corrupt file - the caller must be able to tell "this
 * is not a PDF" from "the child died").
 *
 *   request  { file, from?, to?, includeDoc?, maxTotalChars?, password? }
 *   answer    { ok: true, engine, bytes, sha256, numPages, fingerprints,
 *               info?, xmp?, outline?, attachments?, pages: [...], warnings, ms }
 *             { ok: false, failure: { kind }, error, ... }
 *
 * Gating, all of it load-bearing:
 *
 *   - the engine is this package's OWN vendored build (lib/vendor), never an
 *     npm dependency and never a network fetch;
 *   - `isEvalSupported: false`, so a document's embedded JavaScript is never
 *     evaluated;
 *   - `useWorkerFetch: false` and no URL fetching anywhere, so a PDF cannot make
 *     this process reach the network;
 *   - `enableXfa: false`, so an XFA form is not a scripting surface;
 *   - `useSystemFonts: false` and `disableFontFace: true`, so nothing about the
 *     host's font configuration can be inferred or loaded;
 *   - the cMap and standard-font trees are the vendored ones, addressed as
 *     file:// URLs so no fetch is even attempted.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as pdfjs from './vendor/pdf.min.mjs'

const VENDOR = new URL('./vendor/', import.meta.url)

/** One JSON line on stdout - the only thing the parent reads. */
function say(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

/** The request, from stdin (a file argument is accepted for manual runs). */
function requestText() {
  const file = process.argv[2]
  if (typeof file === 'string' && file !== '' && file !== '-') return readFileSync(file, 'utf8')
  try {
    return readFileSync(0, 'utf8')
  } catch (err) {
    return ''
  }
}

/** pdf.js wants a trailing slash on every asset root. */
const assetUrl = (name) => new URL(name + '/', VENDOR).href

/**
 * The failure kinds a caller can act on, rather than a bare message: a locked
 * document is a question to ask, an invalid one is a file to replace, and
 * anything else is an engine problem worth its stack-free message.
 */
function classify(err) {
  const name = err && err.name ? String(err.name) : ''
  if (name === 'PasswordException') return { kind: 'password', code: err.code ?? null }
  if (name === 'InvalidPDFException') return { kind: 'invalid' }
  if (name === 'MissingPDFException') return { kind: 'missing' }
  if (name === 'UnexpectedResponseException') return { kind: 'response' }
  return { kind: 'error' }
}

/** Whatever was thrown, as one line. */
function messageOf(err) {
  return err && err.message ? String(err.message) : String(err)
}

async function main() {
  const raw = requestText().replace(/^\uFEFF/, '').trim()
  if (raw === '') {
    say({ ok: false, failure: { kind: 'request' }, error: 'no request on stdin' })
    return
  }
  let request
  try {
    request = JSON.parse(raw)
  } catch (err) {
    say({ ok: false, failure: { kind: 'request' }, error: 'the request is not JSON: ' + messageOf(err) })
    return
  }
  if (typeof request.file !== 'string' || request.file === '') {
    say({ ok: false, failure: { kind: 'request' }, error: 'the request names no file' })
    return
  }

  const started = Date.now()
  let bytes
  try {
    bytes = new Uint8Array(readFileSync(request.file))
  } catch (err) {
    say({ ok: false, failure: { kind: 'unreadable' }, error: messageOf(err), ms: Date.now() - started })
    return
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  // A file:// URL, never a native path: the Node fallback loads this module with
  // `import(workerSrc)`, and on Windows a bare `C:\...` is not a specifier the
  // ESM loader accepts.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', VENDOR).href

  let task
  try {
    task = pdfjs.getDocument({
      data: bytes,
      isEvalSupported: false,
      useWorkerFetch: false,
      useSystemFonts: false,
      disableFontFace: true,
      enableXfa: false,
      cMapUrl: assetUrl('cmaps'),
      cMapPacked: true,
      standardFontDataUrl: assetUrl('standard_fonts'),
      ...(typeof request.password === 'string' && request.password !== '' ? { password: request.password } : {}),
    })
  } catch (err) {
    say({ ok: false, failure: classify(err), error: messageOf(err), bytes: bytes.byteLength, sha256, ms: Date.now() - started })
    return
  }

  let doc
  try {
    doc = await task.promise
  } catch (err) {
    say({
      ok: false,
      failure: classify(err),
      error: messageOf(err),
      bytes: bytes.byteLength,
      sha256,
      ...(err && err.name === 'PasswordException' ? { passwordCode: err.code ?? null } : {}),
      ms: Date.now() - started,
    })
    return
  }

  const warnings = []
  const result = {
    ok: true,
    engine: pdfjs.version,
    bytes: bytes.byteLength,
    sha256,
    numPages: doc.numPages,
    fingerprints: doc.fingerprints ?? [],
    pages: [],
    warnings,
  }

  // ---- the document-level facts (one parse, shared by pdf_info/pdf_read) ----
  if (request.includeDoc !== false) {
    try {
      const meta = await doc.getMetadata()
      const info = meta && meta.info ? meta.info : {}
      result.info = {
        Title: info.Title ?? null,
        Author: info.Author ?? null,
        Subject: info.Subject ?? null,
        Keywords: info.Keywords ?? null,
        Creator: info.Creator ?? null,
        Producer: info.Producer ?? null,
        CreationDate: info.CreationDate instanceof Date ? info.CreationDate.toISOString() : (info.CreationDate ?? null),
        ModDate: info.ModDate instanceof Date ? info.ModDate.toISOString() : (info.ModDate ?? null),
        PDFFormatVersion: info.PDFFormatVersion ?? null,
        Language: info.Language ?? null,
        IsLinearized: info.IsLinearized === true,
        IsAcroFormPresent: info.IsAcroFormPresent === true,
        IsXFAPresent: info.IsXFAPresent === true,
        IsCollectionPresent: info.IsCollectionPresent === true,
        IsSignaturesPresent: info.IsSignaturesPresent === true,
        EncryptFilterName: info.EncryptFilterName ?? null,
        Custom: info.Custom && typeof info.Custom === 'object' ? Object.keys(info.Custom) : [],
      }
      if (meta && meta.metadata) {
        const all = meta.metadata.getAll()
        result.xmp = { title: all.dc_title ?? null, creator: all.dc_creator ?? null, description: all.dc_description ?? null }
      }
    } catch (err) {
      // Not fatal: a document with no readable metadata still has pages.
      warnings.push('metadata: ' + messageOf(err))
    }
    try {
      const outline = await doc.getOutline()
      result.outline = outline ? await resolveOutline(doc, outline) : []
    } catch (err) {
      warnings.push('outline: ' + messageOf(err))
    }
    try {
      const attachments = await doc.getAttachments()
      result.attachments = attachments
        ? Object.entries(attachments).map(([name, value]) => ({
            name,
            size: value && value.content ? value.content.length : null,
            description: (value && value.description) || null,
          }))
        : []
    } catch (err) {
      warnings.push('attachments: ' + messageOf(err))
    }
  }

  // ---- the requested pages ----
  const lastPage = doc.numPages
  const from = Math.max(1, Number.isInteger(request.from) ? request.from : 1)
  const to = Math.min(lastPage, Number.isInteger(request.to) ? request.to : lastPage)
  const maxTotalChars = Number.isInteger(request.maxTotalChars) && request.maxTotalChars > 0 ? request.maxTotalChars : 4 * 1024 * 1024
  let totalChars = 0

  for (let n = from; n <= to; n++) {
    let page
    try {
      page = await doc.getPage(n)
    } catch (err) {
      warnings.push('page ' + n + ': ' + messageOf(err))
      continue
    }
    const view = page.view
    const content = await page.getTextContent()
    const items = content.items.filter((item) => typeof item.str === 'string' && item.str !== '')
    const text = items.map((item) => item.str).join(' ')
    const layout = reconstruct(items)
    const fonts = [...new Set(items.map((item) => item.fontName).filter(Boolean))]
    let images = 0
    try {
      const ops = await page.getOperatorList()
      images = ops.fnArray.filter((fn) => fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject).length
    } catch (err) {
      warnings.push('page ' + n + ' operators: ' + messageOf(err))
    }
    let annots = 0
    try {
      annots = (await page.getAnnotations()).length
    } catch (err) {
      /* annotations are detail, never a reason to fail a page */
    }
    const keepText = totalChars < maxTotalChars
    totalChars += text.length
    result.pages.push({
      n,
      width: Math.round(view[2] - view[0]),
      height: Math.round(view[3] - view[1]),
      rotate: page.rotate ?? 0,
      chars: text.length,
      images,
      annots,
      fonts,
      truncated: !keepText,
      ...(keepText ? { text, layout } : {}),
    })
    page.cleanup()
  }

  await task.destroy()
  result.ms = Date.now() - started
  say(result)
}

/**
 * Resolve an outline tree's destinations to 1-based page numbers. A bookmark
 * whose destination cannot be resolved keeps `page: null` rather than being
 * dropped: an entry the reader can see but not jump to is still information.
 */
async function resolveOutline(doc, entries, depth = 0) {
  const out = []
  for (const entry of entries.slice(0, 200)) {
    let page = null
    try {
      const dest = typeof entry.dest === 'string' ? await doc.getDestination(entry.dest) : entry.dest
      if (Array.isArray(dest) && dest.length > 0) page = (await doc.getPageIndex(dest[0])) + 1
    } catch (err) {
      page = null
    }
    out.push({
      title: String(entry.title ?? ''),
      page,
      children: Array.isArray(entry.items) && entry.items.length > 0 && depth < 4 ? await resolveOutline(doc, entry.items, depth + 1) : [],
    })
  }
  return out
}

/**
 * Reading-order reconstruction from positioned text items.
 *
 * pdf.js hands back text as a stream of positioned runs with no line or column
 * structure, which is why a naive join turns a two-column paper - or an invoice
 * with a label and a value on the same line - into an unreadable run-on. This
 * groups runs into lines by baseline (tolerance from the run's own height),
 * orders lines top-to-bottom, and joins each line left-to-right, turning the
 * horizontal gaps into the spaces and column breaks the geometry implies while
 * keeping the line's own leading. It is deterministic: the same document always
 * produces the same text.
 */
function reconstruct(items) {
  const rows = []
  for (const item of items) {
    const x = item.transform[4]
    const y = item.transform[5]
    const height = Math.abs(item.height || item.transform[3] || 10)
    let row = rows.find((candidate) => Math.abs(candidate.y - y) <= Math.max(2, height * 0.5))
    if (!row) {
      row = { y, parts: [], height: 0 }
      rows.push(row)
    }
    row.parts.push({ x, text: item.str, width: item.width ?? 0, height })
    row.height = Math.max(row.height, height)
  }
  rows.sort((a, b) => b.y - a.y)
  const lines = []
  for (const row of rows) {
    row.parts.sort((a, b) => a.x - b.x)
    let line = ''
    let cursor = null
    for (const part of row.parts) {
      if (part.text === '') continue
      if (cursor !== null) {
        const gap = part.x - cursor
        // A gap wider than a quarter of the type size is a word space; wider
        // than a whole one is a column break, which is what keeps a table row
        // from reading as prose.
        if (gap > part.height * 0.25) line += gap > part.height * 1.2 ? '   ' : ' '
      }
      line += part.text
      cursor = part.x + part.width
    }
    const trimmed = line.replace(/\s+$/, '')
    if (trimmed !== '') lines.push(trimmed)
  }
  return lines.join('\n')
}

main().catch((err) => {
  say({ ok: false, failure: { kind: 'error' }, error: messageOf(err) })
})
