// The visitor's address, for the sign-in, reset and two-step limits.
//
// Self-hosted, nobody reaches the app directly: Caddy or the Cloudflare
// Tunnel connects to it over the compose network (selfhost/compose.yaml), so
// the socket's address is the proxy's, the same for every visitor. Every
// "per source" limit became one limit for the whole organization: fifty wrong
// passwords from one stranger and the admin's right one answered "throttled",
// and the per-address lock stopped telling a colleague's machine from an
// attacker's.
//
// The front door says where the real address is, and is believed only when
// the connection itself comes from a private address (the proxy beside the
// app). A request that reached the socket from anywhere else keeps the
// socket's address, whatever headers it sent.
//
//   caddy        X-Forwarded-For, last entry. Caddy does not trust an
//                incoming X-Forwarded-For by default and writes the address
//                it accepted the connection from; the last entry is its own.
//   cloudflare   X-OHSMS-Client-Ip, set by the Worker from cf-connecting-ip
//                (worker/index.js forward) and stripped from what browsers
//                send. The tunnel's origin hostname is Access-protected, so
//                only the Worker reaches it.
//   anything else  the socket's address.

const PRIVATE = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^::1$/,
  /^f[cd][0-9a-f]{2}:/i,
  /^fe80:/i,
]

/** Is this socket address on the machine or its private network? */
export function isPrivateAddress(address) {
  const a = String(address || '').replace(/^::ffff:/i, '')
  return PRIVATE.some((re) => re.test(a))
}

const clean = (value) => {
  const v = String(value || '').trim()
  return /^[0-9a-fA-F:.]{2,45}$/.test(v) ? v : ''
}

export const CLIENT_IP_HEADER = 'x-ohsms-client-ip'

/** `(req) => address` for a Node request behind the given front door. */
export function clientIpFor(frontDoor) {
  const door = String(frontDoor || '').toLowerCase()
  return (req) => {
    const socket = req.socket?.remoteAddress || ''
    if (!isPrivateAddress(socket)) return socket
    const headers = req.headers || {}
    if (door.includes('cloudflare')) return clean(headers[CLIENT_IP_HEADER]) || socket
    if (door.includes('caddy')) {
      const hops = String(headers['x-forwarded-for'] || '').split(',')
      return clean(hops[hops.length - 1]) || socket
    }
    return socket
  }
}
