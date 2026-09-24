/**
 * dsh-pdf — the reader: the child process, the cache, and the caps between them.
 *
 * One place decides how a document is turned into facts, how a page range is
 * turned into text, and what "not cached" costs. Everything above this file
 * (`lib/index.js`'s tools and routes) asks questions in document terms - facts,
 * pages, text, a scan - and never spawns anything itself.
 *
 * The three rules that make a hostile document boring:
 *
 *   - **Identity is content.** A document is keyed by the SHA-256 of its bytes,
 *     computed here in the parent (streamed, so a 300 MB PDF is never held in
 *     memory twice) and memoized per `path + size + mtime`, which is what makes
 *     a repeated `pdf_read` on the same unchanged file cost one `stat`.
 *   - **Every spawn is bounded.** A child gets a deadline, a heap ceiling and an
 *     output ceiling; a page range per spawn is capped, and a caller that wants
 *     more pages gets several spawns rather than one unbounded one.
 *   - **The cache answers first.** Facts and pages are read from the artifact
 *     cache before any child is started, so asking the same question twice - or
 *     reading a document the model just searched - is free.
 */
import { createHash } from 'node:crypto'
import { createReadStream, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** The child that does the parsing. */
export const CHILD_PATH = fileURLToPath(new URL('./extract.mjs', import.meta.url))
/** How long one extraction may take. */
export const EXTRACT_TIMEOUT_MS = 25_000
/** The heap ceiling one extraction may reach. */
export const EXTRACT_HEAP_MB = 512
/** Pages one child run may be asked for. */
export const MAX_PAGES_PER_RUN = 200
/** Spawns one call may make, however many gaps the cache has. */
export const MAX_SPAWNS_PER_CALL = 8
/** How many content identities are memoized. */
const IDENTITY_CACHE_MAX = 64

/** One line for a failure, whatever shape it arrived in. */
function messageOf(err) {
  return err && err.message ? String(err.message) : String(err)
}

/**
 * sha256 of a file, streamed so a large document is never read whole twice.
 *
 * @param file - absolute path.
 * @returns `{ sha256, bytes, mtimeMs }`.
 */
export function hashFileStreaming(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    let bytes = 0
    const stream = createReadStream(file)
    stream.on('data', (chunk) => {
      bytes += chunk.length
      hash.update(chunk)
    })
    stream.on('error', reject)
    stream.on('end', () => {
      let mtimeMs = null
      try {
        mtimeMs = statSync(file).mtimeMs
      } catch (err) {
        mtimeMs = null
      }
      resolve({ sha256: hash.digest('hex'), bytes, mtimeMs })
    })
  })
}

/** The reader: facts, pages and text, each answered from the cache when it can be. */
export class Reader {
  /**
   * @param options - `{ cache, engineVersion, log, timeoutMs, heapMb, maxPagesPerRun, childPath }`.
   */
  constructor({ cache, engineVersion = 'unknown', log = () => {}, timeoutMs = EXTRACT_TIMEOUT_MS, heapMb = EXTRACT_HEAP_MB, maxPagesPerRun = MAX_PAGES_PER_RUN, childPath = CHILD_PATH } = {}) {
    this.cache = cache
    /** The vendored engine version a cached entry must carry to be reused. */
    this.engineVersion = engineVersion
    this.log = log
    this.timeoutMs = timeoutMs
    this.heapMb = heapMb
    this.maxPagesPerRun = maxPagesPerRun
    this.childPath = childPath
    /** Memoized content identities, keyed by `path|size|mtime`. */
    this.identities = new Map()
    /** In-flight child runs, so two callers asking the same thing share one. */
    this.inflight = new Map()
  }

  /**
   * A document's content identity, memoized until its size or mtime moves.
   *
   * @param file - absolute path of a regular file.
   * @returns `{ sha256, bytes, mtimeMs, path }`.
   */
  async identity(file) {
    let stats
    try {
      stats = statSync(file)
    } catch (err) {
      throw Object.assign(new Error('cannot read ' + file + ': ' + messageOf(err)), { code: 'UNREADABLE' })
    }
    if (!stats.isFile()) throw Object.assign(new Error(file + ' is not a regular file'), { code: 'NOT_A_FILE' })
    const key = file + '|' + stats.size + '|' + stats.mtimeMs
    const memo = this.identities.get(key)
    if (memo) return memo
    const hashed = await hashFileStreaming(file)
    const identity = { ...hashed, path: file }
    this.identities.set(key, identity)
    while (this.identities.size > IDENTITY_CACHE_MAX) {
      const oldest = this.identities.keys().next().value
      this.identities.delete(oldest)
    }
    return identity
  }

  /**
   * Run one extraction in a child process.
   *
   * @param request - the child's request object.
   * @param options - `{ signal }`.
   * @returns the child's answer, or a synthetic failure.
   */
  run(request, { signal } = {}) {
    const key = [request.file, request.from ?? '', request.to ?? '', request.includeDoc !== false ? 'doc' : 'pages', request.password ? 'pw' : ''].join('|')
    const running = this.inflight.get(key)
    if (running) return running
    const promise = new Promise((resolve) => {
      const args = ['--max-old-space-size=' + this.heapMb, this.childPath]
      const child = execFile(
        process.execPath,
        args,
        { timeout: this.timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, signal },
        (err, stdout, stderr) => {
          if (err && String(stdout ?? '') === '') {
            const killed = Boolean(err.killed) || err.name === 'AbortError'
            resolve({
              ok: false,
              failure: { kind: killed ? 'timeout' : 'spawn' },
              error: killed ? 'the extraction was stopped after ' + this.timeoutMs + ' ms' : messageOf(err),
              stderr: String(stderr ?? '').slice(0, 600),
            })
            return
          }
          try {
            resolve(JSON.parse(String(stdout).replace(/^\uFEFF/, '')))
          } catch (parseErr) {
            resolve({
              ok: false,
              failure: { kind: 'protocol' },
              error: 'the extraction child answered something that is not JSON: ' + messageOf(parseErr),
              stdout: String(stdout ?? '').slice(0, 300),
              stderr: String(stderr ?? '').slice(0, 300),
            })
          }
        },
      )
      child.stdin.on('error', () => {})
      child.stdin.end(JSON.stringify(request))
    }).finally(() => this.inflight.delete(key))
    this.inflight.set(key, promise)
    return promise
  }

  /**
   * The document-level facts: page count, metadata, outline, attachments, and
   * the fingerprints. Answered from the cache unless nothing is stored yet or
   * the stored entry came from a different engine version.
   *
   * @param file - absolute path.
   * @param options - `{ signal, password, refresh }`.
   * @returns `{ ok, sha, doc, cached }` or `{ ok: false, failure, error }`.
   */
  async facts(file, { signal, password, refresh = false } = {}) {
    const identity = await this.identity(file)
    const sha = identity.sha256
    if (!refresh) {
      const stored = this.cache.index(sha)
      if (stored && stored.engine === this.engineVersion && stored.numPages > 0) return { ok: true, sha, doc: stored, cached: true }
    }
    const answer = await this.run({ file, from: 1, to: 0, includeDoc: true, password }, { signal })
    if (!answer.ok) return { ok: false, sha, failure: answer.failure, error: answer.error, stderr: answer.stderr }
    const doc = {
      sha256: answer.sha256 ?? sha,
      bytes: answer.bytes ?? identity.bytes,
      engine: answer.engine,
      numPages: answer.numPages,
      fingerprints: answer.fingerprints ?? [],
      info: answer.info ?? {},
      xmp: answer.xmp ?? null,
      outline: answer.outline ?? [],
      attachments: answer.attachments ?? [],
      source: file,
      bytesOnDisk: identity.bytes,
      extractedAt: new Date().toISOString(),
    }
    this.cache.writeIndex(sha, doc)
    if (answer.warnings && answer.warnings.length > 0) doc.warnings = answer.warnings
    return { ok: true, sha, doc, cached: false, warnings: answer.warnings ?? [] }
  }

  /** The engine version a cached entry must carry to be reused. */
  get version() {
    return this.engineVersion
  }

  /**
   * Extract a page range, taking every page already cached and spawning only
   * for the gaps (at most `maxPagesPerRun` pages per spawn, at most
   * `MAX_SPAWNS_PER_CALL` spawns per call).
   *
   * @param options - `{ file, sha, from, to, signal, password, onPage }`.
   * @returns `{ ok, pages, warnings, missing, extracted, cached }`.
   */
  async pages({ file, sha, from, to, signal, password }) {
    const found = []
    const warnings = []
    const missing = []
    for (let n = from; n <= to; n++) {
      const stored = this.cache.page(sha, n)
      if (stored) found.push({ ...stored, cached: true })
      else missing.push(n)
    }
    const runs = contiguousRuns(missing, this.maxPagesPerRun)
    const gaps = runs.slice(0, MAX_SPAWNS_PER_CALL)
    const skipped = runs.slice(MAX_SPAWNS_PER_CALL).flat()
    let extracted = 0
    for (const gap of gaps) {
      const answer = await this.run({ file, from: gap[0], to: gap[1], includeDoc: false, password }, { signal })
      if (!answer.ok) {
        warnings.push('pages ' + gap[0] + '-' + gap[1] + ': ' + (answer.error ?? answer.failure?.kind ?? 'extraction failed'))
        continue
      }
      const stats = {}
      for (const page of answer.pages ?? []) {
        this.cache.writePage(answer.sha256 ?? sha, page)
        stats[page.n] = {
          n: page.n,
          width: page.width,
          height: page.height,
          rotate: page.rotate,
          chars: page.chars,
          images: page.images,
          annots: page.annots,
          fonts: (page.fonts ?? []).length,
        }
        found.push({ ...page, cached: false })
        extracted += 1
      }
      this.cache.writeStats(answer.sha256 ?? sha, stats)
      warnings.push(...(answer.warnings ?? []))
    }
    found.sort((a, b) => a.n - b.n)
    return { ok: true, pages: found, warnings, missing: skipped, extracted, cached: found.length - extracted }
  }

  /**
   * One page's text in the requested mode, from the cache, without spawning
   * when it is already there.
   *
   * @param options - `{ sha, n, mode }`.
   * @returns the text, or null when the page is not cached.
   */
  textFromCache({ sha, n, mode = 'text' }) {
    const page = this.cache.page(sha, n)
    if (!page) return null
    if (mode === 'layout') return typeof page.layout === 'string' && page.layout !== '' ? page.layout : page.text ?? ''
    return page.text ?? ''
  }

  /**
   * Walk a page range taking text from the cache and extracting the rest, under
   * a wall-clock budget, so a search over a 500-page document stops and says so
   * instead of running until the tool timeout.
   *
   * @param options - `{ file, sha, from, to, budgetMs, signal, password }`.
   * @returns `{ pages, scanned, skipped, warnings, exhausted }`.
   */
  async walk({ file, sha, from, to, budgetMs, signal, password }) {
    const deadline = Date.now() + budgetMs
    const pages = []
    const warnings = []
    let cursor = from
    let exhausted = false
    while (cursor <= to) {
      const chunkEnd = Math.min(to, cursor + this.maxPagesPerRun - 1)
      const result = await this.pages({ file, sha, from: cursor, to: chunkEnd, signal, password })
      pages.push(...result.pages)
      warnings.push(...result.warnings)
      if (result.missing.length > 0) {
        exhausted = true
        return { pages, scanned: pages.length, skipped: result.missing.length, warnings, exhausted, nextPage: result.missing[0] }
      }
      cursor = chunkEnd + 1
      if (cursor <= to && Date.now() >= deadline) {
        exhausted = true
        return { pages, scanned: pages.length, skipped: to - cursor + 1, warnings, exhausted, nextPage: cursor }
      }
    }
    return { pages, scanned: pages.length, skipped: 0, warnings, exhausted, nextPage: null }
  }
}

/** Split page numbers into contiguous `[first, last]` runs of at most `max` pages. */
export function contiguousRuns(numbers, max) {
  const sorted = [...numbers].sort((a, b) => a - b)
  const runs = []
  for (const n of sorted) {
    const last = runs[runs.length - 1]
    if (last && n === last[1] + 1 && last[1] - last[0] + 1 < max) last[1] = n
    else runs.push([n, n])
  }
  return runs
}
