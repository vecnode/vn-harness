/**
 * dsh-pdf — the content-addressed artifact cache.
 *
 * Everything an extraction produces lands under one directory named by the
 * SHA-256 of the PDF's BYTES, never by path or session:
 *
 *   - the same document read from two places, or from two conversations, is one
 *     entry, so the second reader pays nothing;
 *   - editing a file produces a different hash, so a stale answer can never be
 *     served for a changed document - which is the whole reason the key is the
 *     content and not the path or its mtime;
 *   - the cache is disposable: deleting it costs one parse and nothing else,
 *     because the document itself is the source of truth.
 *
 * One entry is a small directory tree, and it is filled in pieces because a
 * caller rarely wants the whole document at once:
 *
 *   index.json          the document facts (page count, metadata, outline,
 *                       attachments, engine version) - what `pdf_info` reads
 *   stats.json          per-page numbers, merged as pages are extracted, so a
 *                       later `pdf_info` never re-parses a page it has seen
 *   pages/<n>.json      one page's text in both modes, written LAST for that
 *                       page so its presence is what marks the page complete
 *   images/<n>@<dpi>.png  a rasterized page (OCR input, alpha.2)
 *   ocr/<n>.<lang>.txt  one page's recognized text (alpha.2)
 *
 * Writes are atomic (temp file + rename) and every read is defensive: a
 * half-written or hand-edited entry reads as "not cached" and is simply redone,
 * which is the only failure mode a cache may have.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Cache ceiling; the oldest documents are dropped once the tree passes it. */
export const MAX_CACHE_BYTES = 512 * 1024 * 1024
/** One cached page's JSON is refused above this; a page of text is not a book. */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024
/** One cached raster is refused above this. */
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024
/** Hash id grammar (every path this class builds is validated against it). */
export const HASH_PATTERN = /^[0-9a-f]{8,64}$/
/** DPI values a cached raster may be filed under. */
export const DPI_PATTERN = /^(?:[1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$/
/** OCR language tags a cached result may be filed under. */
export const LANG_PATTERN = /^[a-z]{3}(?:\+[a-z]{3})*$/

/** The plugin's own home directory, resolved exactly like its siblings. */
export function resolveHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim())
  const home = process.env.USERPROFILE ?? process.env.HOME ?? ''
  return path.join(home === '' ? process.cwd() : home, '.dsh')
}

/** Atomic write: a reader sees the old file or the new one, never a half file. */
function writeAtomic(file, bytes) {
  const dir = path.dirname(file)
  mkdirSync(dir, { recursive: true })
  const temp = path.join(dir, '.' + path.basename(file) + '.' + randomBytes(4).toString('hex') + '.tmp')
  writeFileSync(temp, bytes)
  try {
    renameSync(temp, file)
  } catch (err) {
    try {
      unlinkSync(temp)
    } catch (cleanupErr) {
      /* the rename is the failure that matters */
    }
    throw err
  }
}

/** Read JSON, or null for anything that is not a readable JSON object. */
function readJson(file) {
  try {
    const stats = statSync(file)
    if (!stats.isFile() || stats.size > MAX_PAGE_BYTES * 8) return null
    const value = JSON.parse(readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : null
  } catch (err) {
    return null
  }
}

/** The extraction cache rooted under the plugin's own DSH home directory. */
export class PdfCache {
  /**
   * @param options - `{ root }`, the cache root.
   * @param options.root - absolute directory the cache owns.
   */
  constructor({ root } = {}) {
    this.root = root ?? path.join(resolveHome(), 'dsh-pdf', 'artifacts')
  }

  /** The directory one document's artifacts live in. */
  dirFor(sha) {
    return path.join(this.root, String(sha).slice(0, 24))
  }

  /** Whether the document facts for this content are already stored. */
  hasIndex(sha) {
    return this.index(sha) !== null
  }

  /** One document's facts, or null. */
  index(sha) {
    if (!HASH_PATTERN.test(String(sha))) return null
    return readJson(path.join(this.dirFor(sha), 'index.json'))
  }

  /** Store the document facts. */
  writeIndex(sha, doc) {
    if (!HASH_PATTERN.test(String(sha))) throw new Error('refusing to cache under a malformed hash')
    writeAtomic(path.join(this.dirFor(sha), 'index.json'), Buffer.from(JSON.stringify(doc), 'utf8'))
    this.prune()
    return doc
  }

  /** Every page's stored numbers, keyed by 1-based page number. */
  stats(sha) {
    if (!HASH_PATTERN.test(String(sha))) return {}
    const found = readJson(path.join(this.dirFor(sha), 'stats.json'))
    return found && typeof found === 'object' ? found : {}
  }

  /**
   * Merge page numbers into the per-page stats file.
   *
   * @param sha - document content hash.
   * @param entries - `{ [pageNumber]: stats }`.
   * @returns the merged map.
   */
  writeStats(sha, entries) {
    if (!HASH_PATTERN.test(String(sha))) throw new Error('refusing to cache under a malformed hash')
    const merged = { ...this.stats(sha), ...entries }
    writeAtomic(path.join(this.dirFor(sha), 'stats.json'), Buffer.from(JSON.stringify(merged), 'utf8'))
    return merged
  }

  /** One page's cached extraction, or null. */
  page(sha, n) {
    if (!HASH_PATTERN.test(String(sha)) || !Number.isInteger(n) || n < 1) return null
    return readJson(path.join(this.dirFor(sha), 'pages', String(n) + '.json'))
  }

  /** Store one page's extraction (`{ n, text, layout, ...stats }`). */
  writePage(sha, page) {
    if (!HASH_PATTERN.test(String(sha))) throw new Error('refusing to cache under a malformed hash')
    const n = Number(page.n)
    if (!Number.isInteger(n) || n < 1) throw new Error('refusing to cache a page without a page number')
    writeAtomic(path.join(this.dirFor(sha), 'pages', String(n) + '.json'), Buffer.from(JSON.stringify(page), 'utf8'))
    return page
  }

  /** Which pages of a document have a stored extraction (cheap directory read). */
  cachedPages(sha) {
    if (!HASH_PATTERN.test(String(sha))) return []
    try {
      return readdirSync(path.join(this.dirFor(sha), 'pages'))
        .map((name) => (/^(\d+)\.json$/.exec(name) ? Number(/^(\d+)\.json$/.exec(name)[1]) : null))
        .filter((n) => n !== null)
        .sort((a, b) => a - b)
    } catch (err) {
      return []
    }
  }

  /** The path a rasterized page is (or would be) stored at. */
  imagePath(sha, n, dpi) {
    if (!HASH_PATTERN.test(String(sha)) || !Number.isInteger(n) || n < 1 || !DPI_PATTERN.test(String(dpi))) return null
    return path.join(this.dirFor(sha), 'images', String(n) + '@' + dpi + '.png')
  }

  /** Store a rasterized page; `bytes` must be a real PNG buffer. */
  writeImage(sha, n, dpi, bytes) {
    const file = this.imagePath(sha, n, dpi)
    if (file === null) throw new Error('refusing to cache a raster under a malformed key')
    if (!Buffer.isBuffer(bytes) || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('refusing to cache an oversized raster')
    writeAtomic(file, bytes)
    this.prune()
    return file
  }

  /** Read a cached raster, or null. */
  image(sha, n, dpi) {
    const file = this.imagePath(sha, n, dpi)
    if (file === null) return null
    try {
      const stats = statSync(file)
      if (!stats.isFile() || stats.size > MAX_IMAGE_BYTES) return null
      return readFileSync(file)
    } catch (err) {
      return null
    }
  }

  /** One page's recognized text, or null. */
  ocr(sha, n, lang) {
    if (!HASH_PATTERN.test(String(sha)) || !Number.isInteger(n) || !LANG_PATTERN.test(String(lang))) return null
    const file = path.join(this.dirFor(sha), 'ocr', String(n) + '.' + lang + '.txt')
    try {
      const stats = statSync(file)
      if (!stats.isFile() || stats.size > MAX_PAGE_BYTES) return null
      return readFileSync(file, 'utf8')
    } catch (err) {
      return null
    }
  }

  /** Store one page's recognized text. */
  writeOcr(sha, n, lang, text) {
    if (!HASH_PATTERN.test(String(sha)) || !Number.isInteger(n) || !LANG_PATTERN.test(String(lang))) {
      throw new Error('refusing to cache OCR under a malformed key')
    }
    const bytes = Buffer.from(typeof text === 'string' ? text : String(text), 'utf8')
    if (bytes.byteLength > MAX_PAGE_BYTES) throw new Error('refusing to cache oversized OCR text')
    writeAtomic(path.join(this.dirFor(sha), 'ocr', String(n) + '.' + lang + '.txt'), bytes)
    return text
  }

  /** One document's cache entry, with its size and mtime. */
  entry(sha) {
    if (!HASH_PATTERN.test(String(sha))) return null
    const dir = this.dirFor(sha)
    try {
      const stats = statSync(dir)
      if (!stats.isDirectory()) return null
      return { key: String(sha).slice(0, 24), dir, bytes: directoryBytes(dir), mtimeMs: stats.mtimeMs }
    } catch (err) {
      return null
    }
  }

  /** Every cache entry, oldest first. */
  entries() {
    if (!existsSync(this.root)) return []
    const found = []
    for (const name of readdirSync(this.root)) {
      if (!/^[0-9a-f]{8,64}$/.test(name)) continue
      const entry = this.entry(name)
      if (entry) found.push(entry)
    }
    return found.sort((a, b) => a.mtimeMs - b.mtimeMs)
  }

  /** Total bytes currently held. */
  size() {
    let total = 0
    for (const entry of this.entries()) total += entry.bytes
    return total
  }

  /**
   * Drop the oldest documents until the tree is back under `maxBytes`.
   * Best-effort by design: a file that will not delete is skipped, never fatal.
   *
   * @param maxBytes - ceiling to fall back to.
   * @returns `{ removed, bytes }` after pruning.
   */
  prune(maxBytes = MAX_CACHE_BYTES) {
    let total = this.size()
    let removed = 0
    if (total <= maxBytes) return { removed, bytes: total }
    for (const entry of this.entries()) {
      if (total <= maxBytes) break
      try {
        rmSync(entry.dir, { recursive: true, force: true })
        total -= entry.bytes
        removed += 1
      } catch (err) {
        /* leave it and move on */
      }
    }
    return { removed, bytes: Math.max(total, 0) }
  }

  /** Remove one document's entry. */
  drop(sha) {
    if (!HASH_PATTERN.test(String(sha))) return false
    try {
      rmSync(this.dirFor(sha), { recursive: true, force: true })
      return true
    } catch (err) {
      return false
    }
  }
}

/** Total bytes of one cache entry's tree. */
function directoryBytes(dir) {
  let total = 0
  const visit = (current) => {
    let names = []
    try {
      names = readdirSync(current, { withFileTypes: true })
    } catch (err) {
      return
    }
    for (const entry of names) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) visit(full)
      else {
        try {
          total += statSync(full).size
        } catch (err) {
          /* raced away */
        }
      }
    }
  }
  visit(dir)
  return total
}

/** sha256 of a document's bytes, as a hex digest. */
export function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
