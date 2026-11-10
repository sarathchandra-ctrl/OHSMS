// Fresh download links on records as they leave the server.
//
// Download links expire an hour after they are signed (stack/blobSign.mjs).
// Records keep the link they were saved with, and dozens of screens paint it
// directly, so rather than teach every screen to ask for a new one, the
// server re-signs each of its own links in a record as it hands that record
// to someone allowed to read it (handler.mjs, /data get and list). A link
// copied out of the app — into an email, a chat, a bookmark — dies within the
// hour; a link the app shows is always current.
//
// Only this server's own links are touched: a /blob URL for op=get naming a
// path under files/. The host is ignored when matching, so a link saved under
// another address (a local dev server, an old hostname) is re-signed onto the
// current one.
//
// The caller decides whether each link is re-signed (`resign` returns the new
// link, or null to leave the stored one as it is). Re-signing everything that
// looked like a link let anyone launder a path into a working download: type
// a /blob URL naming a medical file into any field you may write, read the
// record back, and the server signed it — around the rule /presign applies.
// handler.mjs re-signs only a link the server itself signed, for a reader
// /presign would give that file to.

function ownPath(value) {
  if (typeof value !== 'string' || !value.includes('/blob?')) return null
  try {
    const u = new URL(value)
    const path = u.searchParams.get('path') || ''
    if (!u.pathname.endsWith('/blob') || u.searchParams.get('op') !== 'get') return null
    return path.startsWith('files/') && !path.includes('..') ? path : null
  } catch {
    return null
  }
}

/**
 * A copy of `data` with this server's download links replaced by
 * `resign(path, link)`, wherever that returns a string.
 */
export function refreshFileLinks(data, resign) {
  if (typeof data === 'string') {
    const path = ownPath(data)
    const fresh = path ? resign(path, data) : null
    return typeof fresh === 'string' ? fresh : data
  }
  if (Array.isArray(data)) return data.map((v) => refreshFileLinks(v, resign))
  if (data && typeof data === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(data)) out[k] = refreshFileLinks(v, resign)
    return out
  }
  return data
}
