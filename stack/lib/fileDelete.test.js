import { describe, it, expect } from 'vitest'
import { mayDeleteFile, ownedByOrg, DELETING_ROLES } from './fileDelete.js'

const manager = { orgId: 'orgA', role: 'manager', status: 'approved' }
const P = 'orgs/orgA/incidents/evidence.jpg'

describe('the tenancy boundary on a client-supplied path', () => {
  it('accepts a path inside the org prefix', () => {
    expect(ownedByOrg('orgs/orgA/incidents/x.jpg', 'orgA')).toBe(true)
  })

  it('refuses another tenant prefix', () => {
    expect(ownedByOrg('orgs/orgB/incidents/x.jpg', 'orgA')).toBe(false)
  })

  // The prefix check is a string comparison, so a neighbouring org whose id
  // merely STARTS with this one must not slip through.
  it('refuses an org id that is only a prefix of another', () => {
    expect(ownedByOrg('orgs/orgAB/incidents/x.jpg', 'orgA')).toBe(false)
  })

  it('refuses traversal rather than normalising it', () => {
    expect(ownedByOrg('orgs/orgA/../orgB/x.jpg', 'orgA')).toBe(false)
  })

  it('refuses a path outside the orgs tree entirely', () => {
    expect(ownedByOrg('secret.jpg', 'orgA')).toBe(false)
    expect(ownedByOrg('orgsorgA/x.jpg', 'orgA')).toBe(false)
  })

  it('refuses when either side is missing', () => {
    expect(ownedByOrg('', 'orgA')).toBe(false)
    expect(ownedByOrg(P, '')).toBe(false)
    expect(ownedByOrg(null, null)).toBe(false)
  })
})

describe('who may delete a file', () => {
  it('allows a manager and an admin of the owning org', () => {
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
    expect(mayDeleteFile({ ...manager, status: 'revoked' }, P))
      .toEqual({ ok: false, reason: 'not-approved' })
    expect(mayDeleteFile({ ...manager, status: 'pending' }, P).ok).toBe(false)
  })

  it('refuses a manager who has been moved to another tenant', () => {
    expect(mayDeleteFile({ ...manager, orgId: 'orgB' }, P))
      .toEqual({ ok: false, reason: 'foreign-path' })
  })

  it('refuses when the profile is gone entirely', () => {
    expect(mayDeleteFile(null, P)).toEqual({ ok: false, reason: 'no-profile' })
    expect(mayDeleteFile(undefined, P).ok).toBe(false)
  })

  // The clause a custom claim could never carry.
  it('refuses an account still on the password an admin typed for it', () => {
    expect(mayDeleteFile({ ...manager, mustChangePassword: true }, P))
      .toEqual({ ok: false, reason: 'must-change-password' })
  })

  // Profiles predating the field have no such key; treating that as "must
  // change" would refuse every established manager the first time this shipped.
  it('allows a manager whose profile predates mustChangePassword', () => {
    expect(mayDeleteFile(manager, P).ok).toBe(true)
    expect(mayDeleteFile({ ...manager, mustChangePassword: false }, P).ok).toBe(true)
  })

  // Tenancy is checked against the LIVE org, so a manager of A cannot reach B's
  // files even though their role is beyond reproach.
  it('refuses a legitimate manager pointing at another org file', () => {
    expect(mayDeleteFile(manager, 'orgs/orgB/incidents/evidence.jpg'))
      .toEqual({ ok: false, reason: 'foreign-path' })
  })

  it('refuses an empty or missing path', () => {
    expect(mayDeleteFile(manager, '').ok).toBe(false)
    expect(mayDeleteFile(manager, null).ok).toBe(false)
  })
})
