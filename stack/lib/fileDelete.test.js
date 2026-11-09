import { describe, it, expect } from 'vitest'
import { mayDeleteFile, isAppFilePath, DELETING_ROLES } from './fileDelete.js'

const manager = { role: 'manager', status: 'approved' }
const P = 'files/incidents/evidence.jpg'

describe('the boundary on a client-supplied path', () => {
  it('accepts a path inside files/', () => {
    expect(isAppFilePath('files/incidents/x.jpg')).toBe(true)
  })

  it('refuses traversal rather than normalising it', () => {
    expect(isAppFilePath('files/../secret/x.jpg')).toBe(false)
    expect(isAppFilePath('files/a\\..\\b.jpg')).toBe(false)
  })

  it('refuses a path outside the files tree entirely', () => {
    expect(isAppFilePath('secret.jpg')).toBe(false)
    expect(isAppFilePath('filesx/x.jpg')).toBe(false)
    expect(isAppFilePath('orgs/orgA/x.jpg')).toBe(false)
  })

  it('refuses when the path is missing', () => {
    expect(isAppFilePath('')).toBe(false)
    expect(isAppFilePath(null)).toBe(false)
  })
})

describe('who may delete a file', () => {
  it('allows a manager and an admin', () => {
    expect(mayDeleteFile(manager, P).ok).toBe(true)
    expect(mayDeleteFile({ ...manager, role: 'admin' }, P).ok).toBe(true)
  })

  it('refuses a member and an auditor', () => {
    expect(mayDeleteFile({ ...manager, role: 'member' }, P)).toEqual({ ok: false, reason: 'role' })
    expect(mayDeleteFile({ ...manager, role: 'auditor' }, P)).toEqual({ ok: false, reason: 'role' })
  })

  it('keeps the role list identical to the one firestore.rules enforces', () => {
    expect(DELETING_ROLES).toEqual(['admin', 'manager'])
  })

  // ── The whole point of the callable: the LIVE profile overrules the token ──
  //
  // Each of these is a caller whose ID token still says "manager of orgA",
  // because a token stays valid until it expires. Before this existed, every
  // one of them could delete.
  it('refuses a manager whose profile has been suspended', () => {
    expect(mayDeleteFile({ ...manager, status: 'revoked' }, P)).toEqual({
      ok: false,
      reason: 'not-approved',
    })
    expect(mayDeleteFile({ ...manager, status: 'pending' }, P).ok).toBe(false)
  })

  it('refuses when the profile is gone entirely', () => {
    expect(mayDeleteFile(null, P)).toEqual({ ok: false, reason: 'no-profile' })
    expect(mayDeleteFile(undefined, P).ok).toBe(false)
  })

  // The clause a custom claim could never carry.
  it('refuses an account still on the password an admin typed for it', () => {
    expect(mayDeleteFile({ ...manager, mustChangePassword: true }, P)).toEqual({
      ok: false,
      reason: 'must-change-password',
    })
  })

  // Profiles predating the field have no such key; treating that as "must
  // change" would refuse every established manager the first time this shipped.
  it('allows a manager whose profile predates mustChangePassword', () => {
    expect(mayDeleteFile(manager, P).ok).toBe(true)
    expect(mayDeleteFile({ ...manager, mustChangePassword: false }, P).ok).toBe(true)
  })

  it('refuses a legitimate manager pointing outside the stored files', () => {
    expect(mayDeleteFile(manager, 'secrets/evidence.jpg')).toEqual({
      ok: false,
      reason: 'foreign-path',
    })
  })

  it('refuses an empty or missing path', () => {
    expect(mayDeleteFile(manager, '').ok).toBe(false)
    expect(mayDeleteFile(manager, null).ok).toBe(false)
  })
})
