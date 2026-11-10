import { describe, expect, it } from 'vitest'
import {
  base32Decode,
  base32Encode,
  openSecret,
  otpauthUri,
  sealSecret,
  totpCode,
  verifyTotp,
} from './totp.mjs'

// RFC 6238 Appendix B, SHA1: the secret is the ASCII "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'))

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors (last 6 digits)', () => {
    expect(totpCode(RFC_SECRET, Math.floor(59 / 30))).toBe('287082')
    expect(totpCode(RFC_SECRET, Math.floor(1111111109 / 30))).toBe('081804')
    expect(totpCode(RFC_SECRET, Math.floor(1234567890 / 30))).toBe('005924')
    expect(totpCode(RFC_SECRET, Math.floor(2000000000 / 30))).toBe('279037')
  })

  it('round-trips base32', () => {
    expect(base32Decode(base32Encode(Buffer.from('hello world!'))).toString()).toBe('hello world!')
  })

  it('accepts one step either side of now, and never the same step twice', () => {
    const now = 1_700_000_000_000
    const step = Math.floor(now / 30000)
    const code = totpCode(RFC_SECRET, step)
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now })).toBe(step)
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), { nowMs: now })).toBe(step - 1)
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), { nowMs: now })).toBeNull()
    expect(verifyTotp(RFC_SECRET, code, { nowMs: now, lastStep: step })).toBeNull()
    expect(verifyTotp(RFC_SECRET, '12345', { nowMs: now })).toBeNull()
    expect(verifyTotp(RFC_SECRET, 'abcdef', { nowMs: now })).toBeNull()
  })

  it('seals the secret so only the right server key opens it', () => {
    const sealed = sealSecret(RFC_SECRET, 'master-a')
    expect(sealed).not.toContain(RFC_SECRET)
    expect(openSecret(sealed, 'master-a')).toBe(RFC_SECRET)
    expect(() => openSecret(sealed, 'master-b')).toThrow()
  })

  it('builds the URI authenticator apps read', () => {
    expect(otpauthUri({ issuer: 'OHSMS', account: 'a@b.test', secret: 'ABC' })).toBe(
      'otpauth://totp/OHSMS%3Aa%40b.test?secret=ABC&issuer=OHSMS&algorithm=SHA1&digits=6&period=30'
    )
  })
})
