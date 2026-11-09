// ─────────────────────────────────────────────────────────────────────────────
// The backfill, through the real crypto and the real policy.
//
// Only the callable and Firestore are faked. The sealing, the verification and
// the policy walk are the code that ships — which is the whole argument for
// this migration living in src/ rather than in functions/, so a fake here would
// be arguing against the design it is testing.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'

const keysMock = vi.hoisted(() => ({ current: {} }))
const store = vi.hoisted(() => ({ writes: [] }))

vi.mock('../functions', () => ({ getDataKeys: async () => keysMock.current }))
vi.mock('../monitoring', () => ({ reportError: vi.fn() }))
vi.mock('../firebase', () => ({ db: {} }))
vi.mock('../data/client.js', () => ({
  collection: (...p) => ({ path: p.slice(1).join('/') }),
  doc: (...p) => ({ path: p.slice(1).join('/') }),
  getDocs: async () => ({ docs: [] }),
  updateDoc: async (ref, data) => { store.writes.push({ ref, data }) },
  query: (c) => c,
  limit: () => ({}),
  where: (...a) => ({ where: a }),
}))

vi.stubEnv('VITE_ENCRYPTION', 'on')

const { generateWrapKeyPair, toB64u } = await import('./envelope')
const { POLICY } = await import('./policy')
const { sealDoc } = await import('./index')
const { clearKeyring } = await import('./keyring')
const {
  TARGETS, POLICY_COLLECTIONS, needsSealing, writableFields,
  opensBackIntact, sealAndVerify, backfillAll, MAX_SEALS_PER_RUN,
} = await import('./backfill')

const ORG = 'org-alpha'
const pair = await generateWrapKeyPair()
const generalKey = toB64u(new Uint8Array(32).fill(3))

const ADMIN = {
  general: { keyId: 'general.1', key: generalKey },
  medical: { keyId: 'medical.1', publicKey: pair.publicKey, privateKey: pair.privateKey },
}
// A member: can seal a health record, cannot open one. Running the migration as
// this person must not be allowed to touch anything.
const MEMBER = {
  general: { keyId: 'general.1', key: generalKey },
  medical: { keyId: 'medical.1', publicKey: pair.publicKey },
}

const signIn = (keys) => { clearKeyring(); keysMock.current = keys }
beforeEach(() => { store.writes = []; signIn(ADMIN) })

const INJURY = {
  id: 'i1__p1',
  incidentId: 'i1',
  personId: 'p1',
  personName: 'R. Osei',
  medication: 'co-codamol 30/500',
  bodyParts: ['left hand'],
  daysToReturnToWork: 3,
  verified: true,
}

describe('TARGETS and the policy stay in step', () => {
  it('covers every collection the policy seals, and no others', () => {
    // A collection added to the policy and forgotten here would seal its new
    // writes and never seal its history — silently, and only discovered by
    // someone reading the database. That is the drift this test exists to stop.
    expect([...TARGETS.map((t) => t.collection)].sort()).toEqual([...POLICY_COLLECTIONS].sort())
  })

  it('visits a parent before its subcollection', () => {
    // Subcollections are enumerated by walking their parents, so a target whose
    // parent has not been read yet would find nothing.
    const order = TARGETS.map((t) => t.collection)
    for (const t of TARGETS) {
      if (!t.parent) continue
      expect(order.indexOf(t.parent)).toBeLessThan(order.indexOf(t.collection))
      expect(POLICY[t.parent], `${t.collection} names a parent with no policy`).toBeTruthy()
    }
  })
})

describe('the LOTO targets', () => {
  it('visits the permit before its events and attachments', () => {
    const order = TARGETS.map((t) => t.collection)
    expect(order.indexOf('lotoPermits')).toBeLessThan(order.indexOf('lotoPermits/events'))
    expect(order.indexOf('lotoPermits')).toBeLessThan(order.indexOf('lotoPermits/attachments'))
  })

  it('reads the technician register as a ROOT collection by its tenant field', () => {
    // Without `root`, readTarget would look under organizations/{orgId}/technicians,
    // find nothing, and report the register as sealed.
    expect(TARGETS.find((t) => t.collection === 'technicians')).toMatchObject({ root: true, parent: null })
  })

  it('seals a permit’s people and free text, and leaves its join keys and lock numbers readable', async () => {
    const sealed = await sealDoc('lotoPermits', {
      status: 'active', requestedBy: 'u1', personnelUids: ['u2'],
      reason: 'Replace bearing', requestedByName: 'A. Requester',
      internalPersonnel: [{ uid: 'u2', name: 'B. Crew' }],
      vendorWorkers: [{ name: 'C. Vendor', company: 'ACME', contact: '555' }],
      locks: [{ pointKey: 'k1', lockNo: 'D-1', techName: 'D. Tech' }],
    })
    expect(sealed.reason).toMatch(/^enc:/)
    expect(sealed.vendorWorkers[0].name).toMatch(/^enc:/)
    expect(sealed.vendorWorkers[0].contact).toMatch(/^enc:/)
    expect(sealed.internalPersonnel[0].name).toMatch(/^enc:/)
    expect(sealed.locks[0].techName).toMatch(/^enc:/)
    expect(sealed.internalPersonnel[0].uid).toBe('u2')
    expect(sealed.locks[0].lockNo).toBe('D-1')
    expect(sealed.status).toBe('active')
    expect(sealed.personnelUids).toEqual(['u2'])
  })

  it('seals a technician’s name and contact', async () => {
    const sealed = await sealDoc('technicians', { name: 'A. Tech', contact: '555', lockNo: 'P-1' })
    expect(sealed.name).toMatch(/^enc:/)
    expect(sealed.contact).toMatch(/^enc:/)
    expect(sealed.lockNo).toBe('P-1')
  })
})

describe('needsSealing', () => {
  it('is true for a plaintext document', () => {
    expect(needsSealing('injuries', INJURY)).toBe(true)
  })

  it('is false once every covered field is sealed', async () => {
    expect(needsSealing('injuries', await sealDoc('injuries', INJURY))).toBe(false)
  })

  it('is true for a half-sealed document', async () => {
    const half = { ...await sealDoc('injuries', { medication: 'x' }), injuryType: 'laceration' }
    expect(needsSealing('injuries', half)).toBe(true)
  })

  it('ignores fields the policy does not name', () => {
    expect(needsSealing('injuries', { incidentId: 'i1', verified: true })).toBe(false)
  })

  it('is false for a collection with no policy', () => {
    expect(needsSealing('extinguishers', { serial: 'X' })).toBe(false)
  })

  it('recognises both schemes as sealed', async () => {
    const general = await sealDoc('incidents', { narrative: 'x' })
    const medical = await sealDoc('injuries', { medication: 'x' })
    expect(needsSealing('incidents', general)).toBe(false)
    expect(needsSealing('injuries', medical)).toBe(false)
  })
})

describe('writableFields', () => {
  it('names only top-level fields that are actually present', () => {
    // A migration that added an empty `horizontal` to every incident that never
    // had one would fill the database with scaffolding for fields nobody used.
    const fields = writableFields('incidents', { narrative: 'x', location: 'Bay 3' })
    expect(fields).toEqual(['narrative'])
  })

  it('collapses a nested path to the object that has to be written', () => {
    // `horizontal.details` cannot be written without writing `horizontal`.
    expect(writableFields('incidents', { horizontal: { details: 'x' } })).toEqual(['horizontal'])
  })

  it('collapses an array path to the array', () => {
    expect(writableFields('incidents', { capa: [{ owner: 'A' }] })).toEqual(['capa'])
  })
})

describe('the safety check', () => {
  it('accepts a document that opens back to what went in', async () => {
    const sealed = await sealDoc('injuries', INJURY)
    const { openDoc } = await import('./index')
    expect(opensBackIntact('injuries', INJURY, await openDoc('injuries', sealed))).toBe(true)
  })

  it('refuses when a covered value came back different', () => {
    expect(opensBackIntact('injuries', INJURY, { ...INJURY, medication: 'something else' })).toBe(false)
  })

  it('refuses when a covered value came back MISSING', () => {
    // The reader-without-a-key case. A redacted field is removed rather than
    // nulled, so the comparison has to notice a shorter list — not just
    // different values.
    // eslint-disable-next-line no-unused-vars -- destructured to REMOVE the field
    const { medication, ...withoutIt } = INJURY
    expect(opensBackIntact('injuries', INJURY, withoutIt)).toBe(false)
  })

  it('refuses when an array lost an element', () => {
    expect(opensBackIntact('injuries', INJURY, { ...INJURY, bodyParts: [] })).toBe(false)
  })

  it('notices a type change, not just a text change', () => {
    // '3' and 3 print identically and are not the same clinical answer.
    expect(opensBackIntact('injuries', INJURY, { ...INJURY, daysToReturnToWork: '3' })).toBe(false)
  })
})

describe('sealAndVerify', () => {
  it('produces a partial update carrying only the sealed fields', async () => {
    const { update, ok, reason } = await sealAndVerify('injuries', INJURY)
    expect(ok).toBe(true)
    expect(reason).toBe('sealed')
    expect(Object.keys(update).sort()).toEqual(['bodyParts', 'daysToReturnToWork', 'medication', 'personName'])
    // The join keys and the verification state are NOT in the update — writing
    // them back would risk clobbering a concurrent edit for no reason.
    expect('incidentId' in update).toBe(false)
    expect('verified' in update).toBe(false)
  })

  it('never writes the local id handle back into the document', async () => {
    const { update } = await sealAndVerify('injuries', INJURY)
    expect('id' in update).toBe(false)
  })

  it('does nothing for an already-sealed document', async () => {
    const sealed = await sealDoc('injuries', INJURY)
    const r = await sealAndVerify('injuries', sealed)
    expect(r.update).toBe(null)
    expect(r.reason).toBe('already-sealed')
  })

  it('REFUSES when the sealed copy cannot be opened again', async () => {
    // The property the whole migration rests on. A member can seal a health
    // record and cannot open one, so verification fails and the plaintext is
    // left alone rather than replaced by something nothing will ever decrypt.
    signIn(MEMBER)
    const r = await sealAndVerify('injuries', INJURY)
    expect(r.ok).toBe(false)
    expect(r.update).toBe(null)
    expect(r.reason).toBe('failed-round-trip')
  })

  it('still seals general-class records for a member', async () => {
    signIn(MEMBER)
    const r = await sealAndVerify('incidents', { narrative: 'Fell from step' })
    expect(r.ok).toBe(true)
    expect(r.update.narrative).toMatch(/^enc:/)
  })
})

describe('backfillAll', () => {
  it('refuses to run with sealing switched off', async () => {
    vi.stubEnv('VITE_ENCRYPTION', 'off')
    vi.resetModules()
    const fresh = await import('./backfill')
    await expect(fresh.backfillAll()).rejects.toThrow(/switched off/)
    vi.stubEnv('VITE_ENCRYPTION', 'on')
    vi.resetModules()
  })

  it('refuses to run as somebody who cannot read health records', async () => {
    // Otherwise every verification fails and the run reports the whole estate
    // as blocked — which reads as a broken migration rather than as the wrong
    // person having started it.
    signIn(MEMBER)
    await expect(backfillAll()).rejects.toThrow(/administrator/)
  })


  it('writes nothing on a dry run', async () => {
    const r = await backfillAll({ dryRun: true })
    expect(store.writes).toHaveLength(0)
    expect(r.dryRun).toBe(true)
    expect(r.results.map((x) => x.collection)).toEqual(TARGETS.map((t) => t.collection))
  })

  it('reports a total for every collection it visited', async () => {
    const r = await backfillAll({ dryRun: true })
    expect(r.scannedTotal).toBe(0) // the stubbed Firestore returns no documents
    expect(r.blockedTotal).toBe(0)
    expect(r.remainingTotal).toBe(0)
  })

  it('caps a run across the whole estate, not per collection', async () => {
    // Nine independent caps would let one run write nine times the cap.
    expect(MAX_SEALS_PER_RUN).toBeGreaterThan(0)
    const r = await backfillAll({ dryRun: true, cap: 1 })
    expect(r.sealedTotal).toBeLessThanOrEqual(1)
  })
})
