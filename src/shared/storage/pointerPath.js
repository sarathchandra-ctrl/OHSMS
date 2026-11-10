/**
 * The stored path a pointer names. Records written before uploads recorded a
 * `path` still carry this server's download link, and the path is inside it
 * (/blob?op=get&path=files/…). Those links stopped working when downloads
 * began to expire, so the path is read back out and a fresh link asked for.
 */
export function pointerPath(pointer) {
  if (typeof pointer === 'string') return pointer
  if (pointer?.path) return pointer.path
  const stored = typeof pointer?.url === 'string' ? pointer.url : ''
  try {
    const u = new URL(stored, 'http://local.invalid')
    const path = u.searchParams.get('path') || ''
    if (u.pathname.endsWith('/blob') && u.searchParams.get('op') === 'get' && path.startsWith('files/')) {
      return path
    }
  } catch {
    // Not a URL: nothing to read a path from.
  }
  return null
}
