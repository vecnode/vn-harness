/**
 * dsh-diagrams — the content-addressed artifact cache.
 *
 * Everything the engines produce lands under one directory named by a hash of
 * WHAT produced it (engine + version + source), never by diagram id or session:
 *
 *   - editing a diagram back to a previous revision is an instant cache hit;
 *   - two conversations that happen to hold the same picture share one entry;
 *   - the cache is disposable - deleting it costs a recompile and nothing else,
 *     because the diagrams themselves live in the session store.
 *
 * A compile writes all of its products in one step (`tex`, optional `pdf`,
 * `svg`, `png`, plus `meta.json` with the engine, page count and box), so a
 * half-written entry is not a state the reader can observe. The reader is
 * served from here by the artifact route; the writer prunes the directory back
 * under its byte ceiling after each insertion.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { resolveHome } from './store.js'

/** Cache ceiling; the oldest entries are dropped once the tree passes it. */
export const MAX_CACHE_BYTES = 200 * 1024 * 1024
/** One artifact file is refused above this; a diagram is not a photo library. */
export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024
/** The names one cache entry may hold - also the allow-list the route serves. */
export const ARTIFACT_FILES = ['doc.tex', 'doc.pdf', 'doc.svg', 'doc.png', 'meta.json']
/** Hash id grammar (the route validates ids against this before touching disk). */
export const HASH_PATTERN = /^[0-9a-f]{8,64}$/

/** The artifact cache rooted under the plugin's own DSH home directory. */
export class ArtifactCache {
  /**
   * @param options - `{ root }`, the cache root (defaults to beside the session store).
   * @param options.root - absolute directory the cache owns.
   */
  constructor({ root } = {}) {
    this.root = root ?? path.join(resolveHome(), 'dsh-diagrams', 'artifacts')
  }

  /**
   * The cache key for one engine run. Everything that can change the output is
   * in the hash; nothing that cannot (session, diagram id, title) is.
   *
   * @param input - `{ kind, source, engine, renderer, version }`.
   * @returns a 24-character hexadecimal key.
   */
  keyFor({ kind, source, engine = '', renderer = '', version = '' }) {
    return createHash('sha256')
      .update([String(kind), String(engine), String(renderer), String(version), String(source)].join('\u0000'))
      .digest('hex')
      .slice(0, 24)
  }

  /** Absolute directory for one key. */
  dirFor(key) {
    return path.join(this.root, key)
  }

  /** Whether an entry exists with at least one product. */
  has(key) {
    return this.read(key, 'meta.json') !== null
  }

  /**
   * Read one product of one entry.
   *
   * @param key - cache key.
   * @param name - one of {@link ARTIFACT_FILES}.
   * @returns the bytes, or null when the entry or file is absent/oversized.
   */
  read(key, name) {
    if (!HASH_PATTERN.test(String(key)) || !ARTIFACT_FILES.includes(name)) return null
    const file = path.join(this.dirFor(key), name)
    try {
      const stats = statSync(file)
      if (!stats.isFile() || stats.size > MAX_ARTIFACT_BYTES * 4) return null
      return readFileSync(file)
    } catch (err) {
      return null
    }
  }

  /** One entry's metadata, or null. */
  meta(key) {
    const bytes = this.read(key, 'meta.json')
    if (!bytes) return null
    try {
      return JSON.parse(bytes.toString('utf8'))
    } catch (err) {
      return null
    }
  }

  /**
   * Write one entry. `meta.json` is written LAST so its presence is what marks
   * the entry complete.
   *
   * @param key - cache key.
   * @param products - `{ meta, tex?, pdf?, svg?, png? }` (Buffers or strings).
   * @returns the metadata actually stored.
   */
  write(key, products) {
    if (!HASH_PATTERN.test(String(key))) throw new Error('refusing to write an artifact under a malformed key')
    const dir = this.dirFor(key)
    mkdirSync(dir, { recursive: true })
    const put = (name, value) => {
      if (value === undefined || value === null) return false
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
      if (bytes.byteLength > MAX_ARTIFACT_BYTES) return false
      writeFileSync(path.join(dir, name), bytes)
      return true
    }
    const formats = []
    if (put('doc.tex', products.tex)) formats.push('tex')
    if (put('doc.pdf', products.pdf)) formats.push('pdf')
    if (put('doc.svg', products.svg)) formats.push('svg')
    if (put('doc.png', products.png)) formats.push('png')
    const meta = { ...(products.meta ?? {}), key, formats, at: new Date().toISOString() }
    put('meta.json', JSON.stringify(meta))
    this.prune()
    return meta
  }

  /** Total bytes currently held. */
  size() {
    let total = 0
    for (const entry of this.entries()) total += entry.bytes
    return total
  }

  /** Every cache entry with its size and mtime, oldest first. */
  entries() {
    if (!existsSync(this.root)) return []
    const found = []
    for (const name of readdirSync(this.root)) {
      if (!HASH_PATTERN.test(name)) continue
      const dir = path.join(this.root, name)
      try {
        const stats = statSync(dir)
        if (!stats.isDirectory()) continue
        let bytes = 0
        for (const file of readdirSync(dir)) {
          try {
            bytes += statSync(path.join(dir, file)).size
          } catch (err) {
            /* raced away */
          }
        }
        found.push({ key: name, dir, bytes, mtimeMs: stats.mtimeMs })
      } catch (err) {
        /* not ours any more */
      }
    }
    return found.sort((a, b) => a.mtimeMs - b.mtimeMs)
  }

  /**
   * Drop the oldest entries until the tree is back under `maxBytes`.
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

  /** Remove one entry (used when a diagram is deleted). */
  drop(key) {
    if (!HASH_PATTERN.test(String(key))) return false
    try {
      rmSync(this.dirFor(key), { recursive: true, force: true })
      return true
    } catch (err) {
      return false
    }
  }
}
