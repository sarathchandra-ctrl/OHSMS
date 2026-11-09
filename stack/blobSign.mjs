// Signed links for stored files, shared by the disk store (stack/blobs.mjs)
// and the R2 store on Cloudflare (worker/files.js). No file-system imports.
//
//   PUT  /blob?op=put&path=…&exp=…&sig=…   upload, valid for 15 minutes
//   GET  /blob?op=get&path=…&sig=…         download, a capability URL
//
// The signature is an HMAC over (operation, path, expiry) with a key only the
// server holds, derived from SESSION_SECRET (blobKeyFrom).

import { createHmac, timingSafeEqual } from 'node:crypto'
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

/** A signing key for blob URLs that is not the session secret itself. */
export function blobKeyFrom(sessionSecret) {
  return createHmac('sha256', String(sessionSecret)).update('ohsms:blob-urls:v1').digest()
}

export function createBlobSigner({ key, origin }) {
  return {
    uploadUrl(path, now = Date.now()) {
      const exp = String(now + UPLOAD_TTL_MS)
      const q = new URLSearchParams({ op: 'put', path, exp, sig: sign(key, ['put', path, exp]) })
      return `${origin}/blob?${q}`
    },
    downloadUrl(path) {
      const q = new URLSearchParams({ op: 'get', path, sig: sign(key, ['get', path]) })
      return `${origin}/blob?${q}`
    },
    /** The file path a signed URL names, or null when the link is not valid. */
    check(url, op, now = Date.now()) {
      const path = url.searchParams.get('path') || ''
      const sig = url.searchParams.get('sig') || ''
      if (url.searchParams.get('op') !== op || !isAppFilePath(path)) return null
      if (op === 'put') {
        const exp = url.searchParams.get('exp') || ''
        if (!/^\d+$/.test(exp) || Number(exp) < now) return null
        if (!same(sig, sign(key, ['put', path, exp]))) return null
      } else if (!same(sig, sign(key, ['get', path]))) {
        return null
      }
      return path
    },
  }
}

// The app never renders a stored file as a page on this origin.
export const DOWNLOAD_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'private, max-age=3600',
}
