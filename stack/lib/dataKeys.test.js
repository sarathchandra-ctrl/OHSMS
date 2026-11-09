import { describe, it, expect } from 'vitest'
import {
  GENERAL,
  MEDICAL,
  KEY_DOC_PATH,
  keyIdFor,
  parseKeyId,
  toB64u,
  fromB64u,
  wrapKey,
  unwrapKey,
  generateKeyset,
  grantsFor,
  releaseKeyset,
  KEY_BYTES,
} from './dataKeys.js'

const MASTER = toB64u(new Uint8Array(KEY_BYTES).fill(11))
const OTHER_MASTER = toB64u(new Uint8Array(KEY_BYTES).fill(22))
const ORG = 'org-alpha'

const profile = (role, status = 'approved') => ({ role, status, orgId: ORG })

describe('key ids', () => {
  it('names the class and the version', () => {
    expect(keyIdFor(GENERAL, 1)).toBe('general.1')
    expect(keyIdFor(MEDICAL, 4)).toBe('medical.4')
  })

  it('uses a separator the envelope format survives', () => {
    // The envelope is colon-separated; a colon here would produce values that
    // parse back with the wrong segments and are silently unreadable.
    expect(keyIdFor(MEDICAL, 1)).not.toContain(':')
  })

  it('round-trips through parseKeyId', () => {
    expect(parseKeyId('medical.3')).toEqual({ keyClass: 'medical', version: 3 })
    expect(parseKeyId('general.1')).toEqual({ keyClass: 'general', version: 1 })
  })

  it('refuses anything it did not mint', () => {
    expect(parseKeyId('finance.1')).toBe(null)
    expect(parseKeyId('medical')).toBe(null)
    expect(parseKeyId('')).toBe(null)
    expect(parseKeyId(null)).toBe(null)
  })
})

describe('where the keyset lives', () => {
  it('sits under /meta, which is already carved out of the generic rules', () => {
    expect(KEY_DOC_PATH(ORG)).toBe('organizations/org-alpha/meta/cryptoKeys')
  })
})

describe('base64URL', () => {
  it('round-trips and emits the same alphabet the client expects', () => {
    const bytes = new Uint8Array([0, 251, 252, 253, 254, 255, 62, 63])
    expect(toB64u(bytes)).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Array.from(fromB64u(toB64u(bytes)))).toEqual(Array.from(bytes))
  })
})

describe('wrapping', () => {
  const secret = new Uint8Array(KEY_BYTES).fill(5)

  it('round-trips', async () => {
    const wrapped = await wrapKey(MASTER, ORG, 'general.1', secret)
    expect(Array.from(await unwrapKey(MASTER, ORG, 'general.1', wrapped))).toEqual(Array.from(secret))
  })

  it('never contains the key it wraps', async () => {
    const wrapped = await wrapKey(MASTER, ORG, 'general.1', secret)
    expect(wrapped).not.toContain(toB64u(secret))
  })

  it('refuses a blob moved to another organization', async () => {
    // The escrow performing a cross-tenant break on its own would be the worst
    // possible failure: the Admin SDK consults no rule, so nothing else would
    // catch a key document copied between tenants.
    const wrapped = await wrapKey(MASTER, ORG, 'general.1', secret)
    await expect(unwrapKey(MASTER, 'org-beta', 'general.1', wrapped)).rejects.toThrow()
  })

  it('refuses a blob moved to another key id', async () => {
    const wrapped = await wrapKey(MASTER, ORG, 'general.1', secret)
    await expect(unwrapKey(MASTER, ORG, 'medical.1', wrapped)).rejects.toThrow()
  })

  it('refuses the wrong master secret', async () => {
    const wrapped = await wrapKey(MASTER, ORG, 'general.1', secret)
    await expect(unwrapKey(OTHER_MASTER, ORG, 'general.1', wrapped)).rejects.toThrow()
  })

  it('refuses a truncated blob rather than reading past it', async () => {
    await expect(unwrapKey(MASTER, ORG, 'general.1', toB64u(new Uint8Array(4)))).rejects.toThrow(/truncated/)
  })

  it('refuses a master secret that is not 32 bytes', async () => {
    // Stretching a mistyped secret into a valid-looking key would encrypt every
    // tenant's keys under something nobody can reproduce deliberately.
    await expect(wrapKey(toB64u(new Uint8Array(16)), ORG, 'general.1', secret))
      .rejects.toThrow(/must be 32/)
  })
})

describe('generateKeyset', () => {
  it('produces both classes, with the private halves wrapped', async () => {
    const ks = await generateKeyset(MASTER, ORG, 1)
    expect(ks.general.keyId).toBe('general.1')
    expect(ks.medical.keyId).toBe('medical.1')
    expect(ks.general.wrappedKey).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(ks.medical.wrappedPrivateKey).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('stores the medical PUBLIC key in the clear', async () => {
    // Not a secret, and keeping it unwrapped is what lets an ordinary member be
    // handed it without the callable unwrapping anything on their behalf.
    const ks = await generateKeyset(MASTER, ORG, 1)
    expect(ks.medical.publicKey).toMatch(/^[A-Za-z0-9_-]{300,}$/)
  })

  it('unwraps to a usable 256-bit general key', async () => {
    const ks = await generateKeyset(MASTER, ORG, 1)
    const raw = await unwrapKey(MASTER, ORG, ks.general.keyId, ks.general.wrappedKey)
    expect(raw.length).toBe(KEY_BYTES)
  })

  it('gives every organization different keys', async () => {
    const a = await generateKeyset(MASTER, 'org-a', 1)
    const b = await generateKeyset(MASTER, 'org-b', 1)
    expect(a.medical.publicKey).not.toBe(b.medical.publicKey)
    expect(a.general.wrappedKey).not.toBe(b.general.wrappedKey)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Every case below is a copy of a line in firestore.rules. A key released on a
// looser test than the documents it opens makes that rule decorative.
// ─────────────────────────────────────────────────────────────────────────────
describe('who gets which half', () => {
  it('gives an admin everything', () => {
    expect(grantsFor(profile('admin'))).toEqual({ general: true, medicalPublic: true, medicalPrivate: true })
  })

  it('gives a manager everything — isManagerOf is admin OR manager', () => {
    expect(grantsFor(profile('manager')).medicalPrivate).toBe(true)
  })

  it('gives a member the public half only', () => {
    // The member files a colleague's injury in Step 1a and cannot read it back.
    // That is the rule, and this is the arithmetic that enforces it.
    const g = grantsFor(profile('member'))
    expect(g.medicalPublic).toBe(true)
    expect(g.medicalPrivate).toBe(false)
  })

  it('refuses the auditor the medical private key', () => {
    // THE finding. An auditor is an outside party with a login; isElevatedOf
    // would have included them and isManagerOf does not.
    const g = grantsFor(profile('auditor'))
    expect(g.general).toBe(true)
    expect(g.medicalPrivate).toBe(false)
  })

  it('refuses everything to anyone not approved', () => {
    for (const status of ['pending', 'suspended', 'rejected', '']) {
      expect(grantsFor(profile('admin', status))).toEqual({
        general: false, medicalPublic: false, medicalPrivate: false,
      })
    }
  })

  it('refuses everything while a temporary password is still in force', () => {
    // passwordIsOwn() in firestore.rules already blocks such a user from
    // reading anything; a key handed to them would be the one grant looser
    // than the rules it is meant to copy.
    expect(grantsFor({ ...profile('admin'), mustChangePassword: true })).toEqual({
      general: false, medicalPublic: false, medicalPrivate: false,
    })
  })

  it('is unbothered by a profile written before that flag existed', () => {
    // Every profile predates it. Reading it as "absent means true" would lock
    // out the entire existing user base at once.
    expect(grantsFor(profile('member')).general).toBe(true)
  })

  it('refuses everything when there is no profile at all', () => {
    for (const p of [null, undefined, {}]) {
      expect(grantsFor(p).general).toBe(false)
      expect(grantsFor(p).medicalPrivate).toBe(false)
    }
  })
})

describe('releaseKeyset', () => {
  it('hands a manager a usable private key', async () => {
    const ks = await generateKeyset(MASTER, ORG, 1)
    const out = await releaseKeyset(MASTER, ORG, ks, profile('manager'))
    expect(out.general.key).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(out.medical.publicKey).toBe(ks.medical.publicKey)
    expect(out.medical.privateKey).toBeTruthy()
  })

  it('hands a member the public half and OMITS the private one', async () => {
    // Absent rather than null: the keyring reads a missing key as "redact these
    // fields", which is the whole reason a member sees an injury record with
    // the clinical columns gone instead of an error.
    const ks = await generateKeyset(MASTER, ORG, 1)
    const out = await releaseKeyset(MASTER, ORG, ks, profile('member'))
    expect(out.medical.publicKey).toBeTruthy()
    expect('privateKey' in out.medical).toBe(false)
  })

  it('hands the auditor the general key and no medical private key', async () => {
    const ks = await generateKeyset(MASTER, ORG, 1)
    const out = await releaseKeyset(MASTER, ORG, ks, profile('auditor'))
    expect(out.general).toBeTruthy()
    expect('privateKey' in (out.medical || {})).toBe(false)
  })

  it('hands an unapproved caller nothing at all', async () => {
    const ks = await generateKeyset(MASTER, ORG, 1)
    expect(await releaseKeyset(MASTER, ORG, ks, profile('admin', 'pending'))).toEqual({})
  })

  it('never returns a wrapped blob by mistake', async () => {
    // The wrapped forms are useless to a client and their presence in a
    // response would mean the unwrap step was skipped somewhere.
    const ks = await generateKeyset(MASTER, ORG, 1)
    const out = await releaseKeyset(MASTER, ORG, ks, profile('admin'))
    const body = JSON.stringify(out)
    expect(body).not.toContain(ks.general.wrappedKey)
    expect(body).not.toContain(ks.medical.wrappedPrivateKey)
  })

  it('survives a keyset that predates the medical class', async () => {
    // A stored document written by an older version has no `medical` half, and
    // a callable that threw on it would lock the whole organization out of the
    // app rather than degrading to the general key.
    const ks = await generateKeyset(MASTER, ORG, 1)
    const out = await releaseKeyset(MASTER, ORG, { general: ks.general }, profile('admin'))
    expect(out.general).toBeTruthy()
    expect(out.medical).toBe(undefined)
  })
})
