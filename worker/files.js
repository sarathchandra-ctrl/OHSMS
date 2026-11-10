// Stored files in Cloudflare R2, for the server running on Cloudflare.
//
// Same signed links as the disk store (stack/blobSign.mjs): /presign hands
// out a 15-minute upload URL and a download capability URL, and /blob checks
// the signature before touching the bucket.

import { DOWNLOAD_HEADERS, createBlobSigner } from '../stack/blobSign.mjs'
import { storedUploadLimit } from '../stack/lib/uploadLimits.js'

function deny(status, message) {
  return new Response(
    JSON.stringify({ code: status === 404 ? 'not-found' : 'permission-denied', message }),
    { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
  )
}

/**
 * @param {object} o
 * @param {R2Bucket} o.bucket
 * @param {Uint8Array} o.key   blobKeyFrom(SESSION_SECRET)
 * @param {string} o.origin    PUBLIC_ORIGIN
 */
export function createR2FileStore({ bucket, key, origin }) {
  const signer = createBlobSigner({ key, origin })
  return {
    uploadUrl: (path) => signer.uploadUrl(path),
    downloadUrl: (path) => signer.downloadUrl(path),
    async remove(path) {
      await bucket.delete(path)
      return true
    },
    /** Answers /blob. */
    async handle(request, now = Date.now()) {
      const url = new URL(request.url)
      if (request.method === 'PUT') {
        const path = signer.check(url, 'put', now)
        if (!path) return deny(403, 'upload link refused')
        // Never replace a stored file: every upload gets a fresh random
        // path, so an object already here is someone else's evidence.
        if (await bucket.head(path)) return deny(409, 'a file already exists at this path')
        const type = String(
          request.headers.get('content-type') || 'application/octet-stream'
        ).slice(0, 200)
        const limit = storedUploadLimit(type)
        const declared = request.headers.get('content-length')
        if (declared !== null && !/^\d+$/.test(declared)) {
          return deny(400, 'invalid Content-Length')
        }
        if (declared !== null && Number(declared) > limit) {
          return deny(413, 'file too large; attachments must be at most 2 MB')
        }
        // Count the actual stream, including requests without Content-Length.
        // Buffer only this small, bounded payload so a refused upload never
        // creates or overwrites an R2 object.
        const chunks = []
        let size = 0
        const reader = request.body?.getReader()
        if (reader) {
          try {
            for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
              const { value } = chunk
              size += value.byteLength
              if (size > limit) {
                await reader.cancel()
                return deny(413, 'file too large; attachments must be at most 2 MB')
              }
              chunks.push(value)
            }
          } finally {
            reader.releaseLock()
          }
        }
        if (declared !== null && Number(declared) !== size) {
          return deny(400, 'Content-Length does not match the file')
        }
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) {
          bytes.set(chunk, offset)
          offset += chunk.byteLength
        }
        await bucket.put(path, bytes, { httpMetadata: { contentType: type } })
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        })
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        const path = signer.check(url, 'get', now)
        if (!path) return deny(403, 'download link refused')
        const object = await bucket.get(path)
        if (!object) return deny(404, 'no such file')
        return new Response(request.method === 'HEAD' ? null : object.body, {
          headers: {
            'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
            'Content-Length': String(object.size),
            ...DOWNLOAD_HEADERS,
          },
        })
      }
      return deny(405, 'method not allowed')
    },
  }
}
