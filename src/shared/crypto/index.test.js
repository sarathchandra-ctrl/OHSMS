// ─────────────────────────────────────────────────────────────────────────────
// The document layer, end to end, through the real keyring.
//
// Only ONE thing is faked here: the getDataKeys callable, which is the network.
// Everything else — the key import, the two schemes, the policy walk, the
// caching — is the code that ships. A test that stubbed the crypto would prove
// that the plumbing calls a stub.
//
// The four roles below are the whole point of the file. Each one is given
// exactly what stack/lib/dataKeys.js would release to it, and then asked to
// read the same two documents. What comes back is the access control.
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect, beforeEach, vi } from 'vitest'

const keysMock = vi.hoisted(() => ({ current: {} }))
// Every getDataKeys call is recorded, so a test can assert that reading data
// which is NOT encrypted costs no network round trip at all.
const calls = vi.hoisted(() => [])

vi.mock('../functions', () => ({
  getDataKeys: async () => { calls.push(1); return keysMock.current },
}))
vi.mock('../monitoring', () => ({ reportError: vi.fn() }))

// Sealing on, so sealDoc actually seals. The switch is read at module load,
// which is why it is stubbed before the import below rather than in a test.
vi.stubEnv('VITE_ENCRYPTION', 'on')

const { generateWrapKeyPair, toB64u } = await import('./envelope')
const { sealDoc, openDoc, openDocs, isRestricted, RESTRICTED_KEY, sealFileBytes, openFileBytes } = await import('./index')
const { clearKeyring } = await import('./keyring')

const pair = await generateWrapKeyPair()
const generalKey = toB64u(new Uint8Array(32).fill(3))

// Exactly what releaseKeyset() returns for each role.
const ROLE_KEYS = {
  admin: {
    general: { keyId: 'general.1', key: generalKey },
    medical: { keyId: 'medical.1', publicKey: pair.publicKey, privateKey: pair.privateKey },
  },
  manager: {
    general: { keyId: 'general.1', key: generalKey },
    medical: { keyId: 'medical.1', publicKey: pair.publicKey, privateKey: pair.privateKey },
  },
  // The member can seal a health record and cannot open one.
  member: {
    general: { keyId: 'general.1', key: generalKey },
    medical: { keyId: 'medical.1', publicKey: pair.publicKey },
  },
  // The auditor: the outside party the medical class exists to hold back.
  auditor: {
    general: { keyId: 'general.1', key: generalKey },
    medical: { keyId: 'medical.1', publicKey: pair.publicKey },
  },
}

const signIn = (role) => {
  clearKeyring()
  keysMock.current = ROLE_KEYS[role]
}

beforeEach(() => { signIn('admin') })

const INJURY = {
  incidentId: 'i1',
  personId: 'p-osei',
  personName: 'R. Osei',
  bodyParts: ['left hand', 'left forearm'],
  injuryType: 'laceration',
  medication: 'co-codamol 30/500',
  firstAidDetail: 'Wound irrigated and dressed on site',
  daysToReturnToWork: 3,
  verified: true,
  deletedAt: null,
}

const INCIDENT = {
  refNo: 'IRA-2026-0001',
  narrative: 'Operator caught their hand on a burr while clearing a jam.',
  location: 'Bay 3',
  lifecycle: 'reporting',
  affectedPersonnel: [{ id: 'a1', name: 'R. Osei', dept: 'Press shop', contact: '07700 900123' }],
  capa: [
    { id: 'c1', description: 'Fit a guard', owner: 'A Kumar', dueDate: '2026-02-01', status: 'open' },
    { id: 'c2', description: 'Retrain operators', owner: 'B Singh', dueDate: '2026-03-01', status: 'open' },
  ],
}

describe('sealing a document', () => {
  it('seals the policy fields and leaves everything else alone', async () => {
    const sealed = await sealDoc('incidents', INCIDENT)
    expect(sealed.narrative).toMatch(/^enc:1:general\.1:/)
    expect(sealed.location).toBe('Bay 3')
    expect(sealed.lifecycle).toBe('reporting')
    expect(sealed.refNo).toBe('IRA-2026-0001')
  })

  it('uses the hybrid scheme for health records and the symmetric one otherwise', async () => {
    const injury = await sealDoc('injuries', INJURY)
    const incident = await sealDoc('incidents', INCIDENT)
    expect(injury.medication).toMatch(/^enk:1:medical\.1:/)
    expect(incident.narrative).toMatch(/^enc:1:general\.1:/)
  })

  it('leaves the join keys readable', async () => {
    // purgeIncidentMedicalRecords and the retention sweep find these records by
    // querying on incidentId and personId. A record nothing can find is a
    // record nothing can delete when the law says it must be.
    const sealed = await sealDoc('injuries', INJURY)
    expect(sealed.incidentId).toBe('i1')
    expect(sealed.personId).toBe('p-osei')
    expect(sealed.verified).toBe(true)
    expect(sealed.deletedAt).toBe(null)
  })

  it('puts no plaintext anywhere in the written document', async () => {
    const body = JSON.stringify(await sealDoc('injuries', INJURY))
    expect(body).not.toContain('co-codamol')
    expect(body).not.toContain('laceration')
    expect(body).not.toContain('left forearm')
    expect(body).not.toContain('R. Osei')
  })

  it('seals inside arrays and nested objects', async () => {
    const sealed = await sealDoc('incidents', INCIDENT)
    expect(sealed.capa[0].description).toMatch(/^enc:/)
    expect(sealed.capa[1].owner).toMatch(/^enc:/)
    expect(sealed.affectedPersonnel[0].contact).toMatch(/^enc:/)
    // The ids the app joins on are untouched.
    expect(sealed.capa[0].id).toBe('c1')
    expect(sealed.capa[0].status).toBe('open')
  })

  it('does not touch a collection with no policy', async () => {
    const doc = { serial: 'EXT-1', location: 'Bay 3' }
    expect(await sealDoc('extinguishers', doc)).toBe(doc)
  })

  it('seals a partial update without inventing the rest of the document', async () => {
    // Every module here writes with merges. A sealer that walked the policy and
    // added the missing fields would overwrite live data with blanks.
    const sealed = await sealDoc('injuries', { medication: 'ibuprofen' })
    expect(Object.keys(sealed)).toEqual(['medication'])
    expect(sealed.medication).toMatch(/^enk:/)
  })

  it('shares one content key across the fields of one write', async () => {
    // The performance property, asserted where it can regress: a key per field
    // costs a manager seconds of RSA on every list render.
    const sealed = await sealDoc('injuries', INJURY)
    const wrappedOf = (v) => v.split(':')[3]
    expect(wrappedOf(sealed.medication)).toBe(wrappedOf(sealed.injuryType))
  })
})

describe('reading it back', () => {
  it('round-trips a health record for a manager', async () => {
    signIn('manager')
    const opened = await openDoc('injuries', await sealDoc('injuries', INJURY))
    expect(opened.medication).toBe('co-codamol 30/500')
    expect(opened.bodyParts).toEqual(['left hand', 'left forearm'])
    expect(opened.daysToReturnToWork).toBe(3)
    expect(opened[RESTRICTED_KEY]).toBe(undefined)
  })

  it('round-trips an incident, arrays and all', async () => {
    const opened = await openDoc('incidents', await sealDoc('incidents', INCIDENT))
    expect(opened.narrative).toBe(INCIDENT.narrative)
    expect(opened.capa.map((c) => c.owner)).toEqual(['A Kumar', 'B Singh'])
    expect(opened.affectedPersonnel[0].contact).toBe('07700 900123')
  })

  it('restores the original types', async () => {
    const opened = await openDoc('injuries', await sealDoc('injuries', INJURY))
    expect(typeof opened.daysToReturnToWork).toBe('number')
    expect(Array.isArray(opened.bodyParts)).toBe(true)
  })

  it('opens a list in one pass', async () => {
    const sealed = await Promise.all([INJURY, { ...INJURY, medication: 'ibuprofen' }]
      .map((d) => sealDoc('injuries', d)))
    const opened = await openDocs('injuries', sealed)
    expect(opened.map((d) => d.medication)).toEqual(['co-codamol 30/500', 'ibuprofen'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The access control. Everything above proves the crypto works; this proves it
// works for the right people.
// ─────────────────────────────────────────────────────────────────────────────
describe('who can read a health record', () => {
  let sealed
  beforeEach(async () => {
    signIn('member')                                  // a member files it…
    sealed = await sealDoc('injuries', INJURY)
  })

  it('refuses the member who wrote it', async () => {
    // firestore.rules already says a member may write /injuries and not read
    // it. Before this, that was a rule; now it is arithmetic.
    const opened = await openDoc('injuries', sealed)
    expect(opened.medication).toBe(undefined)
    expect(opened.bodyParts).toBe(undefined)
    expect(opened.personName).toBe(undefined)
    expect(opened[RESTRICTED_KEY]).toContain('medication')
  })

  it('refuses the auditor', async () => {
    // THE finding this came out of: an outside party with a login, who could
    // list every colleague's medical detail in the tenant.
    signIn('auditor')
    const opened = await openDoc('injuries', sealed)
    expect(opened.medication).toBe(undefined)
    expect(isRestricted(opened, 'medication')).toBe(true)
  })

  it('allows the manager', async () => {
    signIn('manager')
    expect((await openDoc('injuries', sealed)).medication).toBe('co-codamol 30/500')
  })

  it('still shows everyone the record itself', async () => {
    // Redaction, not refusal. The auditor confirming injuries are recorded and
    // verified can still do their job; what they cannot read is the medication.
    signIn('auditor')
    const opened = await openDoc('injuries', sealed)
    expect(opened.incidentId).toBe('i1')
    expect(opened.personId).toBe('p-osei')
    expect(opened.verified).toBe(true)
  })

  it('lets everyone read a general-class document', async () => {
    // The auditor is not shut out of the safety record — that is what they are
    // given a login for.
    signIn('admin')
    const inc = await sealDoc('incidents', INCIDENT)
    signIn('auditor')
    expect((await openDoc('incidents', inc)).narrative).toBe(INCIDENT.narrative)
  })

  it('drops the field rather than leaving null or ciphertext', async () => {
    // `(injury.bodyParts || []).map(...)` is the shape all over this codebase.
    // A null throws; an envelope prints base64 to a person.
    signIn('auditor')
    const opened = await openDoc('injuries', sealed)
    expect('bodyParts' in opened).toBe(false)
    expect(() => (opened.bodyParts || []).map((x) => x)).not.toThrow()
  })

  it('reports each restricted path once, not once per array element', async () => {
    signIn('member')
    const inc = { capa: [{ owner: 'A' }, { owner: 'B' }, { owner: 'C' }] }
    // Seal under the medical key by borrowing a collection that uses it, so the
    // member cannot read it back.
    const sealedIll = await sealDoc('illnesses', { actions: inc.capa.map((c) => ({ owner: c.owner })) })
    const opened = await openDoc('illnesses', sealedIll)
    expect(opened[RESTRICTED_KEY]).toEqual(['actions[].owner'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Reading unsealed data must not touch the network.
//
// This shipped broken. openDoc fetched the keyring up front, so every screen
// reading a covered collection called getDataKeys whether or not anything on it
// was encrypted — and where the callable is not deployed (a fresh project, the
// emulator, the Playwright smoke run) that failed and logged a console error on
// every route. The console-sweep smoke test caught it after the merge.
// ─────────────────────────────────────────────────────────────────────────────
describe('what reading costs when nothing is sealed', () => {
  it('does not ask for keys to open a document with no sealed values', async () => {
    signIn('admin')
    calls.length = 0
    await openDoc('injuries', INJURY) // plain, never sealed
    expect(calls).toEqual([])
  })

  it('does not ask for keys to open a whole list of unsealed rows', async () => {
    signIn('admin')
    calls.length = 0
    await openDocs('incidents', [INCIDENT, INCIDENT, INCIDENT])
    expect(calls).toEqual([])
  })

  it('does ask once when there IS something sealed', async () => {
    signIn('admin')
    const sealed = await sealDoc('injuries', INJURY)
    signIn('manager') // clears the cache, so the next read must fetch
    calls.length = 0
    await openDoc('injuries', sealed)
    expect(calls).toHaveLength(1)
  })

  it('asks once for a whole list, not once per row', async () => {
    // loadKeys caches the PROMISE, so rows decrypting concurrently await one
    // call rather than racing it.
    signIn('admin')
    const sealed = await sealDoc('injuries', INJURY)
    signIn('manager')
    calls.length = 0
    await openDocs('injuries', [sealed, sealed, sealed, sealed])
    expect(calls).toHaveLength(1)
  })
})

describe('mixed data during the rollout', () => {
  it('reads a document that was never sealed', async () => {
    // Every collection holds a mixture for as long as the backfill takes. A
    // reader that threw on plaintext would take the app down on deploy.
    const opened = await openDoc('injuries', INJURY)
    expect(opened.medication).toBe('co-codamol 30/500')
    expect(opened[RESTRICTED_KEY]).toBe(undefined)
  })

  it('reads a half-sealed document', async () => {
    const half = { ...await sealDoc('injuries', { medication: 'sealed one' }), injuryType: 'plain one' }
    const opened = await openDoc('injuries', half)
    expect(opened.medication).toBe('sealed one')
    expect(opened.injuryType).toBe('plain one')
  })

  it('does not re-seal a value that is already sealed', async () => {
    // Read-modify-write is how every update in this app works; wrapping again
    // each time would grow the document until Firestore refused it.
    const once = await sealDoc('injuries', INJURY)
    const twice = await sealDoc('injuries', once)
    expect(twice.medication).toBe(once.medication)
  })

  it('never throws out of a snapshot handler', async () => {
    // openDoc is called from inside onSnapshot, where a rejection kills the
    // listener and freezes the screen on stale data with nothing to say so.
    signIn('auditor')
    const corrupt = { medication: 'enk:1:medical.1:' + 'A'.repeat(342) + ':AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA' }
    await expect(openDoc('injuries', corrupt)).resolves.toBeTruthy()
  })
})

describe('file bytes', () => {
  const bytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]) // '%PDF-1.4'

  it('seals a medical record so the uploader cannot reopen it', async () => {
    signIn('member')
    const { bytes: ct, meta } = await sealFileBytes('injuries/records', bytes)
    expect(meta.encScheme).toBe('enk')
    expect(Array.from(ct)).not.toEqual(Array.from(bytes))
    await expect(openFileBytes('injuries/records', meta, ct)).rejects.toMatchObject({ reason: 'restricted' })
  })

  it('lets a manager open it', async () => {
    signIn('member')
    const { bytes: ct, meta } = await sealFileBytes('injuries/records', bytes)
    signIn('manager')
    expect(Array.from(await openFileBytes('injuries/records', meta, ct))).toEqual(Array.from(bytes))
  })

  it('passes an unsealed file straight through', async () => {
    // A gallery mixing files from before and after the switch needs no branch.
    expect(await openFileBytes('injuries/records', { path: 'orgs/x/y/z' }, bytes)).toBe(bytes)
  })

  it('does not seal files for a collection that stores none', async () => {
    const out = await sealFileBytes('injuries', bytes)
    expect(out.meta).toBe(null)
    expect(out.bytes).toBe(bytes)
  })
})
