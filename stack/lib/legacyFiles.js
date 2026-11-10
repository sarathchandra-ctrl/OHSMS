// Files still stored on Firebase Storage, named by links on records.
//
// Records written before files moved to this server carry download links to
// firebasestorage.googleapis.com (or <bucket>.firebasestorage.app). Opening
// such a record makes the viewer's browser fetch from Google, and keeps
// Google a processor of those files (docs/compliance/SUBPROCESSORS.md). The
// migrateLegacyFiles job copies each file here and points the record at the
// copy. These are its pure halves: finding the links, and rewriting them.

/** Is this a Firebase Storage download link? Exact hosts only, https only. */
export function isLegacyFileUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('https://')) return false
  try {
    const host = new URL(value).hostname
    return host === 'firebasestorage.googleapis.com' || host.endsWith('.firebasestorage.app')
  } catch {
    return false
  }
}

/** Every legacy link in a document, with the key path to it. */
export function findLegacyUrls(data, path = []) {
  const found = []
  if (isLegacyFileUrl(data)) return [{ path, url: data }]
  if (Array.isArray(data)) {
    data.forEach((v, i) => found.push(...findLegacyUrls(v, [...path, i])))
  } else if (data && typeof data === 'object') {
    for (const [k, v] of Object.entries(data)) found.push(...findLegacyUrls(v, [...path, k]))
  }
  return found
}

/** The stored path a copied file gets: stable per link, so a re-run finds it. */
export async function legacyCopyPath(url, digest) {
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'file')
    .split('/')
    .pop()
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(-80)
  return `files/legacy/${(await digest(url)).slice(0, 32)}-${name || 'file'}`
}

/**
 * A copy of `data` with each link replaced. `copies` maps the old link to
 * { url, path }. Where the link sits under a `url` key beside a `path` that is
 * not one of this server's (an old Firebase object path), the path is updated
 * too, so deleting the file from the record deletes the copy.
 */
export function rewriteLegacyUrls(data, copies) {
  const walk = (v) => {
    if (typeof v === 'string') return copies.has(v) ? copies.get(v).url : v
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out = {}
      for (const [k, x] of Object.entries(v)) out[k] = walk(x)
      const copy = typeof v.url === 'string' ? copies.get(v.url) : null
      if (copy && typeof v.path === 'string' && !v.path.startsWith('files/')) out.path = copy.path
      return out
    }
    return v
  }
  return walk(data)
}
