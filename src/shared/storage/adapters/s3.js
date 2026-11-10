// ─────────────────────────────────────────────────────────────────────────────
// S3-compatible adapter — AWS S3, Cloudflare R2, MinIO, Backblaze B2, GCS…
//
// A browser must NEVER hold S3 credentials, so this adapter does not talk to
// the bucket directly. It talks to a small presign endpoint YOU host (Cloud
// Function, Lambda, one Express route) that checks the caller's auth and
// returns short-lived signed URLs:
//
//   POST  {VITE_S3_PRESIGN_ENDPOINT}
//   body  { op: 'put',    path, contentType }  ->  { uploadUrl, publicUrl }
//   body  { op: 'delete', path }               ->  { deleteUrl }
//
// The endpoint is the security boundary — it verifies the user's session and
// the path. This installation's server is the default endpoint (/presign,
// stack/server.mjs), and it stores files on its own disk.
// ─────────────────────────────────────────────────────────────────────────────
import { currentAccessToken, noteSessionEnded, ownStackGateway } from '../../auth/ownStackSession'
import { runtimeEnv } from '../../runtimeConfig'

// Defaults to this installation's own server (files in R2 on Cloudflare; on
// disk in local development).
const ENDPOINT = String(
  runtimeEnv('S3_PRESIGN_ENDPOINT') || (ownStackGateway() ? `${ownStackGateway()}/presign` : '')
).trim()

async function presign(body) {
  // The session token from this installation's server. It is not a storage
  // credential, and a delete is not authorised from the token alone: the
  // server re-reads the live profile.
  const token = currentAccessToken()
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    noteSessionEnded(res, await res.clone().json().catch(() => ({})))
    throw new Error(`presign failed: ${res.status}`)
  }
  return res.json()
}

export default {
  name: 's3',

  async put(path, blob) {
    if (!ENDPOINT) return null // not configured — caller falls back to inline
    const { uploadUrl, publicUrl } = await presign({
      op: 'put',
      path,
      contentType: blob.type || 'application/octet-stream',
    })
    const res = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': blob.type || 'application/octet-stream' },
      body: blob,
    })
    if (!res.ok) throw new Error(`upload failed: ${res.status}`)
    return { url: publicUrl }
  },

  // A fresh download link, valid for an hour, from this installation's server
  // (/presign op 'get', which re-reads the signed-in person's live profile).
  // The link stored on a record when the file was uploaded expires, so files
  // are always shown through this.
  async resolve(path) {
    if (!ENDPOINT) return null
    const { url } = await presign({ op: 'get', path })
    return url || null
  },

  // The bytes, for an encrypted file the browser has to open itself.
  async resolveBlob(path) {
    const url = await this.resolve(path)
    if (!url) return null
    const res = await fetch(url)
    if (!res.ok) throw new Error(`download failed: ${res.status}`)
    return res.blob()
  },

  async remove(path) {
    if (!ENDPOINT) return
    const { deleteUrl } = await presign({ op: 'delete', path })
    if (deleteUrl) await fetch(deleteUrl, { method: 'DELETE' })
  },
}
