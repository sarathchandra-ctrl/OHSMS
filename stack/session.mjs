// Session tokens for an own-stack host.
//
// The token proves uid and when the person authenticated. It does not carry
// role, org, or mustChangePassword. Those are read from the profile on every
// request that needs them (presign deletes, RLS). A claim that outlives a
// suspension is the S-19 failure again.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const TTL_S = 8 * 60 * 60

function b64(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

export function newSessionSecret() {
  return randomBytes(32).toString('base64url')
}

// `ep` is the person's session epoch when the token was issued (the profile's
// sessionEpoch). A token used to be good for its whole eight hours whatever
// happened: a password change, a reset or a lost phone left a stolen session
// working. Bumping the epoch ends every token issued before it
// (handler.mjs liveSession).
export function signSession(secret, { sub, authTime = Math.floor(Date.now() / 1000), ep = 0 } = {}) {
  if (!secret || !sub) throw new Error('session: secret and sub are required')
  const now = Math.floor(Date.now() / 1000)
  const header = b64({ alg: 'HS256', typ: 'JWT' })
  const body = b64({ sub, iat: now, auth_time: authTime, exp: now + TTL_S, ep: Number(ep) || 0 })
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')
  return `${header}.${body}.${sig}`
}

export function verifySession(secret, token) {
  if (!secret) return null
  const parts = String(token || '').split('.')
  if (parts.length !== 3) return null
  const [header, body, sig] = parts
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest()
  let got
  try {
    got = Buffer.from(sig, 'base64url')
  } catch {
    return null
  }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (!payload || typeof payload.sub !== 'string' || !payload.sub) return null
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null
  if ('role' in payload || 'orgId' in payload || 'mustChangePassword' in payload) return null
  return {
    sub: payload.sub,
    authTime: payload.auth_time || payload.iat,
    ep: Number.isInteger(payload.ep) ? payload.ep : 0,
  }
}
