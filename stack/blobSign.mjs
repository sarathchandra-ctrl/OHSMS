// Signed links for stored files, shared by the disk store (stack/blobs.mjs)
// and the R2 store on Cloudflare (worker/files.js). No file-system imports.
//
//   PUT  /blob?op=put&path=…&exp=…&sig=…   upload, valid for 15 minutes
//   GET  /blob?op=get&path=…&exp=…&sig=…   download, valid for an hour
//
// A download link used to have no expiry: it was stored on the record and
// worked forever, for anyone holding it, signed in or not — a forwarded email
// or an ex-employee's bookmark kept every photo and permit document. Now the
// app asks /presign for a fresh link each time it shows a file (op 'get',
// for an approved, signed-in person), and a link stops working within two
// hours.
// Links minted before this carry no expiry and are refused; the app reads
// the file's path back out of such a link and asks for a fresh one.
//
// The signature is an HMAC over (operation, path, expiry) with a key only the
// server holds, derived from SESSION_SECRET (blobKeyFrom).

import { createHmac, timingSafeEqual } from 'node:crypto'
import { isAppFilePath } from './lib/fileDelete.js'
import { MAX_SEALED_UPLOAD_BYTES } from './lib/uploadLimits.js'

export const UPLOAD_TTL_MS = 15 * 60 * 1000
export const DOWNLOAD_TTL_MS = 60 * 60 * 1000
export const MAX_BLOB_BYTES = MAX_SEALED_UPLOAD_BYTES

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
    downloadUrl(path, now = Date.now()) {
      // Expiry rounded to the hour, so the same file gets the same link for
      // the whole hour: records are re-signed on every read (lib/fileLinks.js),
      // and a link that changed each time would make every photo download
      // again on every poll. A link therefore lives one to two hours.
      const exp = String((Math.floor(now / DOWNLOAD_TTL_MS) + 2) * DOWNLOAD_TTL_MS)
      const q = new URLSearchParams({ op: 'get', path, exp, sig: sign(key, ['get', path, exp]) })
      return `${origin}/blob?${q}`
    },
    /**
     * The path of a download link this server signed, expired or not, or
     * null. For re-signing a stored link (lib/fileLinks.js): an expired link
     * is the normal case there, a link it never signed is not.
     */
    signedPath(href, op = 'get') {
      let url
      try {
        url = new URL(href)
      } catch {
        return null
      }
      const path = url.searchParams.get('path') || ''
      const exp = url.searchParams.get('exp')
      if (url.searchParams.get('op') !== op || !isAppFilePath(path)) return null
      // A link from before expiry existed was signed over (op, path) alone.
      // Old records may hold only that; it is still this server's signature.
      const parts = exp === null ? [op, path] : /^\d+$/.test(exp) ? [op, path, exp] : null
      return parts && same(url.searchParams.get('sig'), sign(key, parts)) ? path : null
    },
    /** The file path a signed URL names, or null when the link is not valid. */
    check(url, op, now = Date.now()) {
      const path = url.searchParams.get('path') || ''
      const sig = url.searchParams.get('sig') || ''
      if (url.searchParams.get('op') !== op || !isAppFilePath(path)) return null
      // Both directions expire; a link without an expiry is refused.
      const exp = url.searchParams.get('exp') || ''
      if (!/^\d+$/.test(exp) || Number(exp) < now) return null
      if (!same(sig, sign(key, [op, path, exp]))) return null
      return path
    },
  }
}

// The app never renders a stored file as a page on this origin.
export const DOWNLOAD_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
  'X-Content-Type-Options': 'nosniff',
  // No longer than the link itself lives.
  'Cache-Control': 'private, max-age=3600',
}
