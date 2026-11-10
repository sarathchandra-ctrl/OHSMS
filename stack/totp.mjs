// Authenticator-app codes for two-step login (RFC 6238 TOTP: HMAC-SHA1, 30-
// second steps, 6 digits), the format Google Authenticator, Microsoft
// Authenticator, 1Password and the rest all read from the same QR code.
//
// A code is accepted one step either side of now (clock drift on a phone),
// and never twice: the step of the last accepted code is stored, and a code
// for that step or an earlier one is refused, so a code read over someone's
// shoulder cannot be replayed within its 90-second window.
//
// The shared secret is sealed at rest with AES-256-GCM under a key derived
// from DATA_KEY_MASTER, the server secret that must not change between
// versions; a copy of the database alone does not yield anyone's codes.

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

const STEP_S = 30
const DIGITS = 6
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text) {
  const clean = String(text || '')
    .toUpperCase()
    .replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch)
    if (i < 0) throw new Error('not base32')
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** A new shared secret: 160 random bits, base32 as authenticator apps expect. */
export const newTotpSecret = () => base32Encode(randomBytes(20))

/** The code for one 30-second step. */
export function totpCode(secret, step) {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest()
  const offset = mac[mac.length - 1] & 15
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS
  return String(n).padStart(DIGITS, '0')
}

export const stepAt = (nowMs) => Math.floor(nowMs / 1000 / STEP_S)

/**
 * Does `code` match, one step either side of now, for a step later than
 * `lastStep`? Returns the matched step, or null.
 */
export function verifyTotp(secret, code, { nowMs = Date.now(), lastStep = -1 } = {}) {
  const given = String(code || '').replace(/\s/g, '')
  if (!/^\d{6}$/.test(given)) return null
  const now = stepAt(nowMs)
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue
    const want = Buffer.from(totpCode(secret, step))
    if (timingSafeEqual(want, Buffer.from(given))) return step
  }
  return null
}

/** The otpauth:// URI an authenticator app reads from the QR code. */
export function otpauthUri({ issuer, account, secret }) {
  const label = encodeURIComponent(`${issuer}:${account}`)
  const q = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_S),
  })
  return `otpauth://totp/${label}?${q}`
}

const keyFrom = (master) => createHash('sha256').update(`ohsms:totp:v1:${master}`).digest()

/** Seal a secret for storage. */
export function sealSecret(secret, master) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFrom(master), iv)
  const body = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.')
}

/** Open a sealed secret. Throws if it was altered or sealed under another key. */
export function openSecret(sealed, master) {
  const [iv, tag, body] = String(sealed)
    .split('.')
    .map((p) => Buffer.from(p, 'base64url'))
  const decipher = createDecipheriv('aes-256-gcm', keyFrom(master), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
}
