// Stored files in Cloudflare R2, for the server running on Cloudflare.
//
// Same signed links as the disk store (stack/blobSign.mjs): /presign hands
// out a 15-minute upload URL and a download capability URL, and /blob checks
// the signature before touching the bucket.

import { DOWNLOAD_HEADERS, MAX_BLOB_BYTES, createBlobSigner } from '../stack/blobSign.mjs'

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
        const length = Number(request.headers.get('content-length') || 0)
        if (!length) return deny(411, 'Content-Length is required')
        if (length > MAX_BLOB_BYTES) return deny(413, 'file too large')
        const type = String(request.headers.get('content-type') || 'application/octet-stream').slice(0, 200)
        await bucket.put(path, request.body, { httpMetadata: { contentType: type } })
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
