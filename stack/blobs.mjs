// Stored files, on this server's own disk.
//
// The app never holds a storage credential. It asks /presign for a URL, and
// that URL carries an HMAC over (operation, path, expiry) made with a key only
// this server knows:
//
//   PUT  /blob?op=put&path=…&exp=…&sig=…   upload, valid for 15 minutes
//   GET  /blob?op=get&path=…&sig=…         download, a capability URL
//
// The download URL is what the app stores on the record (the `url` beside the
// `path`), the same role a storage download token played before. It never
// expires on its own, so a file whose record is deleted keeps working for
// whoever copied the link — exactly as before; deleting the FILE (presign
// delete, deleteOrgFile) is what ends it.
//
// Paths are checked twice: by isAppFilePath before any signature is minted,
// and again here against the directory, so a crafted path cannot escape it.

import { createHmac, timingSafeEqual } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { isAppFilePath } from './lib/fileDelete.js'

export const UPLOAD_TTL_MS = 15 * 60 * 1000
// Above MAX_UPLOAD_BYTES in src/shared/storage, with headroom for sealing.
export const MAX_BLOB_BYTES = 30 * 1024 * 1024

function sign(key, parts) {
  return createHmac('sha256', key).update(parts.join('\n')).digest('base64url')
}

function same(a, b) {
  const x = Buffer.from(String(a || ''))
  const y = Buffer.from(String(b || ''))
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y)
}

/**
 * @param {object} o
 * @param {string} o.dir     directory the files live in (created if missing)
 * @param {string} o.key     signing key (derived from SESSION_SECRET by the caller)
 * @param {string} o.origin  public origin the URLs are built on
 */
export function createBlobStore({ dir, key, origin }) {
  const root = normalize(dir)

  function fileFor(path) {
    if (!isAppFilePath(path)) return null
    const full = normalize(join(root, path))
    if (!full.startsWith(root.endsWith(sep) ? root : root + sep)) return null
    return full
  }

  function uploadUrl(path, now = Date.now()) {
    const exp = String(now + UPLOAD_TTL_MS)
    const sig = sign(key, ['put', path, exp])
    const q = new URLSearchParams({ op: 'put', path, exp, sig })
    return `${origin}/blob?${q}`
  }

  function downloadUrl(path) {
    const sig = sign(key, ['get', path])
    const q = new URLSearchParams({ op: 'get', path, sig })
    return `${origin}/blob?${q}`
  }

  async function remove(path) {
    const file = fileFor(path)
    if (!file) return false
    await rm(file, { force: true })
    await rm(`${file}.type`, { force: true })
    return true
  }

  function check(url, op, now) {
    const path = url.searchParams.get('path') || ''
    const sig = url.searchParams.get('sig') || ''
    if (url.searchParams.get('op') !== op) return null
    if (op === 'put') {
      const exp = url.searchParams.get('exp') || ''
      if (!/^\d+$/.test(exp) || Number(exp) < now) return null
      if (!same(sig, sign(key, ['put', path, exp]))) return null
    } else if (!same(sig, sign(key, ['get', path]))) {
      return null
    }
    return fileFor(path)
  }

  /** Answers /blob. Returns false when the request is not for it. */
  async function handle(req, res, url, now = Date.now()) {
    const deny = (status, message) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ code: status === 404 ? 'not-found' : 'permission-denied', message }))
    }
    if (req.method === 'PUT') {
      const file = check(url, 'put', now)
      if (!file) return deny(403, 'upload link refused')
      const declared = Number(req.headers['content-length'] || 0)
      if (declared > MAX_BLOB_BYTES) return deny(413, 'file too large')
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.part-${process.pid}-${Date.now()}`
      let size = 0
      try {
        await pipeline(
          req,
          async function* cap(source) {
            for await (const chunk of source) {
              size += chunk.length
              if (size > MAX_BLOB_BYTES)
                throw Object.assign(new Error('too large'), { code: 'big' })
              yield chunk
            }
          },
          createWriteStream(tmp, { flags: 'wx' })
        )
      } catch (err) {
        await rm(tmp, { force: true })
        return deny(err?.code === 'big' ? 413 : 400, 'upload failed')
      }
      await rename(tmp, file)
      const type = String(req.headers['content-type'] || 'application/octet-stream').slice(0, 200)
      await writeFile(`${file}.type`, type)
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify({ ok: true }))
      return true
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const file = check(url, 'get', now)
      if (!file) return deny(403, 'download link refused')
      let info
      try {
        info = await stat(file)
      } catch {
        return deny(404, 'no such file')
      }
      let type = 'application/octet-stream'
      try {
        type = (await readFile(`${file}.type`, 'utf8')).trim() || type
      } catch {
        // No recorded type: serve as bytes.
      }
      res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': info.size,
        // The app decides what to render; never let a stored file run as a page
        // on this origin.
        'Content-Security-Policy':
          "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, max-age=3600',
      })
      if (req.method === 'HEAD') return res.end()
      createReadStream(file).pipe(res)
      return true
    }
    return deny(405, 'method not allowed')
  }

  return { uploadUrl, downloadUrl, remove, handle, fileFor }
}

/** A signing key for blob URLs that is not the session secret itself. */
export function blobKeyFrom(sessionSecret) {
  return createHmac('sha256', String(sessionSecret)).update('ohsms:blob-urls:v1').digest()
}
