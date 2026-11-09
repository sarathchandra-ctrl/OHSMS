import { describe, it, expect, beforeEach, vi } from 'vitest'

// ─────────────────────────────────────────────────────────────────────────────
// The invariant under test is about WHERE a field lands, not about Firestore, so
// the fake below records every write with the path it went to. An assertion that
// an incident document does not carry medical fields is the assertion this fix
// exists to make, and nothing anywhere made it before.
// ─────────────────────────────────────────────────────────────────────────────
const fake = vi.hoisted(() => {
  const store = new Map() // path -> data
  const writes = [] // { path, data }
  let autoId = 0
  const refTo = (a, seg) => {
    const head = a && typeof a === 'object' && a.path ? [a.path] : []
    const parts = [...head, ...seg.map(String)]
    // doc(collectionRef) with no path segments = "give me a new id".
    if (!seg.length && head.length) parts.push(`auto${(autoId += 1)}`)
    // .id as well as .path: createIncident returns ref.id to its caller.
    return { path: parts.join('/'), id: parts[parts.length - 1] }
  }
  return {
    store,
    writes,
    refTo,
    reset() { store.clear(); writes.length = 0; autoId = 0 },
    /** Everything written under a collection path, e.g. 'injuries'. */
    writesUnder: (prefix) => writes.filter((w) => w.path.startsWith(`${prefix}/`)),
  }
})

vi.mock('../db', () => ({ db: {} }))
// logAudit writes its own document; it is not what these tests are about.
vi.mock('./firestore', () => ({ logAudit: vi.fn(async () => {}) }))
// purgeInjury deletes the clinical documents out of Cloud Storage as well as
// their pointers. Mocked so the assertion is "it asked for this path", which is
// the part that matters — a bucket is not what this suite is testing.
vi.mock('../../../shared/storage', () => ({
  removeFile: vi.fn(async () => {}),
  putFile: vi.fn(async (kind) => ({
    path: `orgs/acme/${kind}/ab12-letter.pdf`,
    url: 'https://example.test/bearer',
    size: 12,
    contentType: 'application/pdf',
    name: 'letter.pdf',
    encScheme: 'enk',
    encKeyId: 'medical.1',
    encIv: 'iv',
    encWrapped: 'wrapped',
  })),
  MAX_INLINE_BYTES: 900_000,
  tooLargeForInline: (name) => `${name} is too large to store inline`,
}))

vi.mock('../../../shared/data/client.js', async (importOriginal) => {
  const actual = await importOriginal()
  const write = (ref, data, opts) => {
    fake.writes.push({ path: ref.path, data })
    const prev = fake.store.get(ref.path)
    fake.store.set(ref.path, opts?.merge && prev ? { ...prev, ...data } : { ...data })
  }
  return {
    ...actual,
    collection: (dbOrRef, ...seg) => fake.refTo(dbOrRef, seg),
    doc: (dbOrRef, ...seg) => fake.refTo(dbOrRef, seg),
    getDoc: async (ref) => ({
      exists: () => fake.store.has(ref.path),
      data: () => fake.store.get(ref.path),
    }),
    getDocs: async (q) => {
      const docs = [...fake.store.entries()]
        .filter(([path]) => path.startsWith(`${q.path}/`) && path.split('/').length === q.path.split('/').length + 1)
        .filter(([, data]) => (q.clauses || []).every((c) => data[c.field] === c.value))
        .map(([path, data]) => ({ id: path.split('/').pop(), ref: { path }, data: () => data }))
      return { docs }
    },
    setDoc: async (ref, data, opts) => write(ref, data, opts),
    addDoc: async (col, data) => {
      const ref = fake.refTo(col, [])
      write(ref, data)
      return ref
    },
    updateDoc: async (ref, data) => write(ref, data, { merge: true }),
    deleteDoc: async (ref) => { fake.store.delete(ref.path) },
    // purgeInjury takes the pointers and the parent out together, so a failure
    // cannot leave the record indexed by children that no longer exist.
    writeBatch: () => {
      const pending = []
      return {
        delete: (ref) => pending.push(ref.path),
        commit: async () => { pending.forEach((p) => fake.store.delete(p)) },
      }
    },
    query: (col, ...clauses) => ({ path: col.path, clauses: clauses.filter(Boolean) }),
    where: (field, _op, value) => ({ field, value }),
    orderBy: () => null,
    limit: () => null,
    onSnapshot: () => () => {},
    serverTimestamp: () => 'TS',
    increment: (n) => ({ inc: n }),
    runTransaction: async (_db, fn) => fn({
      get: async (ref) => ({
        exists: () => fake.store.has(ref.path),
        data: () => fake.store.get(ref.path),
      }),
      set: (ref, data, opts) => write(ref, data, opts),
      // Mirrors updateDoc above. updateIncident moved into a transaction so its
      // stats delta is computed from the state it actually wrote against —
      // without this the mock silently lacked the method the code now calls.
      update: (ref, data) => write(ref, data, { merge: true }),
    }),
  }
})

const {
  MEDICAL_FIELDS, INCIDENT_INJURY_FIELDS, incidentInjuryStub, incidentInjuryStubs,
  mergeInjuryDetail, syncIncidentInjuries, updateInjury,
  deleteInjury, restoreInjury, purgeInjury,
  medicalAttachmentTarget, addMedicalRecord, MEDICAL_RECORD_STORAGE_KIND,
} = await import('./injuries')
const { removeFile, putFile } = await import('../../../shared/storage')
const { createIncident, updateIncident, addIncidentPhoto } = await import('./incidents')

const INCIDENTS = `incidents`
const INJURIES = `injuries`
const actor = { uid: 'u1', name: 'Alex Admin' }

// One person's injury as Step 1a hands it over: join key plus the clinical half.
const REPORT = {
  personId: 'EMP-104',
  personName: 'Priya Nair',
  firstAidDone: true,
  firstAidDetail: 'Wound dressed on site',
  injuryType: 'Laceration',
  bodyParts: ['hand_l', 'wrist_l'],
  medication: 'Analgesic',
  daysToReturnToWork: 5,
}

const incident = (id = 'inc1') => ({
  id, refNo: 'IRA-2026-9001', incidentDate: '2026-07-20',
  type: 'lost_time', severity: 'high', location: 'Assembly line 2',
})

/** Every field name that reached a path — the shape of what was published there. */
const keysWrittenUnder = (prefix) =>
  new Set(fake.writesUnder(prefix).flatMap((w) => Object.keys(w.data)))

beforeEach(() => {
  fake.reset()
  vi.clearAllMocks()
})

describe('what an incident document may carry about an injury', () => {
  it('keeps the join key and drops every clinical field', () => {
    const stub = incidentInjuryStub(REPORT)
    expect(stub).toEqual({ personId: 'EMP-104', personName: 'Priya Nair', firstAidDone: true })
    for (const field of MEDICAL_FIELDS) expect(stub).not.toHaveProperty(field)
    expect(Object.keys(stub).sort()).toEqual([...INCIDENT_INJURY_FIELDS].sort())
  })

  it('survives the shapes real writers produce', () => {
    // The portal used to identify people by name/uid; anything unrecognised
    // must not be carried through on the chance that it is clinical.
    expect(incidentInjuryStub({ name: 'Priya', uid: 'u9', injuryType: 'Burn' }))
      .toEqual({ personId: '', personName: '', firstAidDone: false })
    expect(incidentInjuryStubs(undefined)).toEqual([])
    expect(incidentInjuryStubs('not an array')).toEqual([])
  })

  it('is applied by createIncident, whatever the caller passes', async () => {
    const id = await createIncident(actor, { type: 'lost_time', injuryReports: [REPORT] })
    const stored = fake.store.get(`${INCIDENTS}/${id}`)
    expect(stored.injuryReports).toEqual([{ personId: 'EMP-104', personName: 'Priya Nair', firstAidDone: true }])
    // The whole document, not just that array: nothing clinical anywhere on it.
    expect(JSON.stringify(stored)).not.toMatch(/Laceration|Analgesic|hand_l|Wound dressed/)
  })

  it('is applied by updateIncident too — the wizard writes through it', async () => {
    fake.store.set(`${INCIDENTS}/inc1`, { type: 'lost_time', injuryReports: [] })
    await updateIncident('inc1', { injuryReports: [REPORT] }, { actor, silent: true })
    expect(fake.store.get(`${INCIDENTS}/inc1`).injuryReports)
      .toEqual([{ personId: 'EMP-104', personName: 'Priya Nair', firstAidDone: true }])
  })

  it('leaves updates that mention no injury alone', async () => {
    fake.store.set(`${INCIDENTS}/inc1`, { type: 'lost_time', injuryReports: [{ personId: 'EMP-104' }] })
    await updateIncident('inc1', { narrative: 'Reworded' }, { actor, silent: true })
    expect(fake.store.get(`${INCIDENTS}/inc1`).injuryReports).toEqual([{ personId: 'EMP-104' }])
  })
})

describe('syncIncidentInjuries', () => {
  it('writes the clinical detail to /injuries and nothing to the incident', async () => {
    await syncIncidentInjuries(incident(), [REPORT], actor)

    expect(fake.store.get(`${INJURIES}/inc1__EMP-104`)).toMatchObject({
      incidentId: 'inc1',
      personId: 'EMP-104',
      injuryType: 'Laceration',
      medication: 'Analgesic',
      bodyParts: ['hand_l', 'wrist_l'],
      daysToReturnToWork: 5,
      firstAidDetail: 'Wound dressed on site',
    })
    // The whole point: this call publishes nothing to the widely-readable doc.
    expect(fake.writesUnder(INCIDENTS)).toEqual([])
  })

  it('records nothing for an entry with no personId', async () => {
    // The doc id is built from it. This is the case that made the portal's
    // injury capture exist only on the incident.
    await syncIncidentInjuries(incident(), [{ name: 'Priya', injuryType: 'Burn' }], actor)
    expect(fake.writesUnder(INJURIES)).toEqual([])
  })
})

describe('the mirror-back from an Injuries-page edit', () => {
  beforeEach(() => {
    fake.store.set(`${INJURIES}/inc1__EMP-104`, {
      incidentId: 'inc1', personId: 'EMP-104', personName: 'Priya Nair', injuryType: 'Laceration',
    })
  })

  it('puts the edit in /injuries and only the join key on the incident', async () => {
    fake.store.set(`${INCIDENTS}/inc1`, {
      injuryReports: [{ personId: 'EMP-104', personName: 'Priya Nair', firstAidDone: false }],
    })

    await updateInjury('inc1__EMP-104', {
      firstAidDone: true, firstAidDetail: 'Dressing changed', medication: 'Ibuprofen', bodyParts: ['head'],
    }, actor)

    expect(fake.store.get(`${INJURIES}/inc1__EMP-104`)).toMatchObject({
      firstAidDetail: 'Dressing changed', medication: 'Ibuprofen', bodyParts: ['head'],
    })
    // It used to spread the whole edit onto the incident, re-contaminating it
    // after every save from that page.
    expect(fake.store.get(`${INCIDENTS}/inc1`).injuryReports)
      .toEqual([{ personId: 'EMP-104', personName: 'Priya Nair', firstAidDone: true }])
    for (const field of MEDICAL_FIELDS) expect(keysWrittenUnder(INCIDENTS)).not.toContain(field)
  })

  it('scrubs an incident written before the split', async () => {
    // Documents already in the database still carry the old shape. The mirror-
    // back rebuilds the whole array, so an edit cleans the record it touches —
    // the fields go without waiting for a migration.
    fake.store.set(`${INCIDENTS}/inc1`, {
      injuryReports: [
        { personId: 'EMP-104', personName: 'Priya Nair', firstAidDone: true, injuryType: 'Laceration', medication: 'Analgesic', bodyParts: ['hand_l'], daysToReturnToWork: 5, firstAidDetail: 'On site' },
        { personId: 'EMP-207', personName: 'Sam Okafor', firstAidDone: false, injuryType: 'Bruise', bodyParts: ['knee_r'] },
      ],
    })

    await updateInjury('inc1__EMP-104', { medication: 'Ibuprofen' }, actor)

    expect(fake.store.get(`${INCIDENTS}/inc1`).injuryReports).toEqual([
      { personId: 'EMP-104', personName: 'Priya Nair', firstAidDone: true },
      { personId: 'EMP-207', personName: 'Sam Okafor', firstAidDone: false },
    ])
  })
})

describe('mergeInjuryDetail', () => {
  const stubs = [
    { personId: 'EMP-104', personName: 'Priya Nair', firstAidDone: true },
    { personId: 'EMP-207', personName: 'Sam Okafor', firstAidDone: false },
  ]

  it('rehydrates Step 1a from /injuries', () => {
    const merged = mergeInjuryDetail(stubs, [{ ...REPORT, id: 'inc1__EMP-104' }])
    expect(merged[0]).toMatchObject({
      personId: 'EMP-104', personName: 'Priya Nair', firstAidDone: true,
      injuryType: 'Laceration', medication: 'Analgesic', bodyParts: ['hand_l', 'wrist_l'],
    })
    // Nobody else's detail leaks across the join.
    expect(merged[1]).toEqual({ personId: 'EMP-207', personName: 'Sam Okafor', firstAidDone: false })
  })

  it('returns the stubs untouched when the reader cannot see /injuries', () => {
    // A member gets an empty injuries list, not an error. What must NOT happen
    // is the form inventing blank medical fields it would then save.
    const merged = mergeInjuryDetail(stubs, [])
    expect(merged).toEqual(stubs)
    for (const field of MEDICAL_FIELDS) expect(merged[0]).not.toHaveProperty(field)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The lifecycle that did not exist.
//
// `deletedAt` was written as null by injuryPayload and read back by the list
// filter, and nothing anywhere ever set it — so /injuries, the only home of a
// named colleague's clinical detail and of the documents behind it, was the one
// collection in this app with no way to remove a record. The nightly sweep in
// stack/lib/retention.js is the other half; these are the writes it acts on.
// ─────────────────────────────────────────────────────────────────────────────
describe('deleting an injury report', () => {
  const ID = 'inc1__EMP-104'
  const seed = () => fake.store.set(`${INJURIES}/${ID}`, {
    incidentId: 'inc1', incidentRefNo: 'IRA-2026-9001', personId: 'EMP-104', deletedAt: null,
  })

  it('stamps deletedAt so the sweep can find it', async () => {
    seed()
    await deleteInjury(ID, actor)
    const after = fake.store.get(`${INJURIES}/${ID}`)
    expect(after.deletedAt).toBe('TS')
    expect(after.deletedBy).toBe('Alex Admin')
  })

  // The field the Admin SDK queries on and the list filters on, before anything
  // decrypts. Sealing it would make the record undeletable by the job whose
  // whole purpose is deleting it.
  it('leaves deletedAt in the clear', async () => {
    seed()
    await deleteInjury(ID, actor)
    const written = fake.writesUnder(INJURIES).at(-1).data
    expect(written.deletedAt).toBe('TS')
    expect(typeof written.deletedAt).not.toBe('object')
  })

  it('does nothing at all for an id that is not there', async () => {
    await deleteInjury('inc9__nobody', actor)
    expect(fake.writesUnder(INJURIES)).toHaveLength(0)
  })

  it('restores by clearing the clock, not by rewriting the record', async () => {
    seed()
    await deleteInjury(ID, actor)
    await restoreInjury(ID, actor)
    const after = fake.store.get(`${INJURIES}/${ID}`)
    expect(after.deletedAt).toBeNull()
    expect(after.deletedBy).toBeNull()
    // Still the same record: the join keys the sweep and the register need.
    expect(after.incidentId).toBe('inc1')
    expect(after.personId).toBe('EMP-104')
  })
})

describe('filing a medical record', () => {
  const file = {
    name: 'gp-letter.pdf',
    type: 'application/pdf',
    size: 1200,
    dataUrl: 'data:application/pdf;base64,AAAA',
    uploadedBy: 'member1',
  }

  beforeEach(() => {
    putFile.mockClear()
  })

  it('chooses the injury-record path and the medical storage prefix', () => {
    expect(medicalAttachmentTarget('inc1', 'EMP-104')).toEqual({
      injuryId: 'inc1__EMP-104',
      storageKind: 'medical-records',
      collection: 'injuries/records',
      incidentId: 'inc1',
      personId: 'EMP-104',
    })
    expect(MEDICAL_RECORD_STORAGE_KIND).toBe('medical-records')
    expect(medicalAttachmentTarget('inc1', '')).toBeNull()
    expect(medicalAttachmentTarget('inc/1', 'EMP-104')).toBeNull()
    expect(medicalAttachmentTarget('inc1', '../EMP')).toBeNull()
  })

  it('writes the pointer on the injury and uploads under medical-records', async () => {
    const id = await addMedicalRecord(incident(), 'EMP-104', file)
    expect(id).toBeTruthy()
    expect(putFile).toHaveBeenCalledWith(
      'medical-records',
      file.dataUrl,
      file.name,
      { collection: 'injuries/records' },
    )
    const records = fake.writesUnder(`${INJURIES}/inc1__EMP-104/records`)
    expect(records).toHaveLength(1)
    const pointer = records[0].data
    expect(pointer.path).toBe('orgs/acme/medical-records/ab12-letter.pdf')
    expect(pointer.personId).toBe('EMP-104')
    expect(pointer.incidentId).toBe('inc1')
    expect(pointer.encKeyId).toBe('medical.1')
    expect(pointer.kind).toBeUndefined()
    expect(pointer.url).toBeUndefined()
    expect(fake.writes.some((w) => w.path.includes('/incidents/') && w.path.includes('/photos/'))).toBe(false)
  })

  it('does not clear a recycle-bin timestamp when the injury already exists', async () => {
    fake.store.set(`${INJURIES}/inc1__EMP-104`, {
      incidentId: 'inc1', personId: 'EMP-104', deletedAt: 'TS', status: 'verified', medication: 'kept',
    })
    await addMedicalRecord(incident(), 'EMP-104', file)
    const injury = fake.store.get(`${INJURIES}/inc1__EMP-104`)
    expect(injury.deletedAt).toBe('TS')
    expect(injury.status).toBe('verified')
    expect(injury.medication).toBe('kept')
  })

  it('refuses to file a medical record as an incident photo', async () => {
    await expect(addIncidentPhoto('inc1', { ...file, kind: 'medical_record' }))
      .rejects.toThrow(/injury report/)
    expect(putFile).not.toHaveBeenCalled()
    expect(fake.writes.some((w) => w.path.includes('/photos/'))).toBe(false)
  })
})

describe('purging an injury report', () => {
  const ID = 'inc1__EMP-104'
  const RECORDS = `${INJURIES}/${ID}/records`

  beforeEach(() => {
    fake.store.set(`${INJURIES}/${ID}`, {
      incidentId: 'inc1', incidentRefNo: 'IRA-2026-9001', deletedAt: 'TS',
    })
    fake.store.set(`${RECORDS}/r1`, { name: 'sealed', path: `files/medical-records/ab12-gp-letter.pdf` })
    fake.store.set(`${RECORDS}/r2`, { name: 'sealed', path: `files/medical-records/cd34-fit-note.pdf` })
  })

  it('destroys the clinical documents, their pointers and the record itself', async () => {
    await purgeInjury(ID, actor, 'IRA-2026-9001')

    expect(removeFile).toHaveBeenCalledTimes(2)
    expect(removeFile.mock.calls.map((c) => c[0]).sort()).toEqual([
      `files/medical-records/ab12-gp-letter.pdf`,
      `files/medical-records/cd34-fit-note.pdf`,
    ])
    expect(fake.store.has(`${RECORDS}/r1`)).toBe(false)
    expect(fake.store.has(`${RECORDS}/r2`)).toBe(false)
    expect(fake.store.has(`${INJURIES}/${ID}`)).toBe(false)
  })

  // A GP letter left in the bucket with nothing naming it is not deleted data;
  // it is data nobody can find and nobody can delete. The pointer going without
  // the object is the shape of a failed erasure request.
  it('never removes a pointer while leaving its object behind', async () => {
    await purgeInjury(ID, actor, 'IRA-2026-9001')
    const askedFor = removeFile.mock.calls.map((c) => c[0])
    for (const path of [
      `files/medical-records/ab12-gp-letter.pdf`,
      `files/medical-records/cd34-fit-note.pdf`,
    ]) expect(askedFor).toContain(path)
  })

  // An attachment small enough to inline is base64 on the pointer itself and
  // has no object behind it. Asking the bucket to delete '' is not a no-op
  // there, it is a request against the org prefix root.
  it('asks the bucket for nothing when a record is inlined', async () => {
    fake.store.set(`${RECORDS}/r3`, { name: 'sealed', dataUrl: 'data:application/pdf;base64,AAAA' })
    await purgeInjury(ID, actor, 'IRA-2026-9001')
    expect(removeFile.mock.calls.map((c) => c[0])).not.toContain('')
    expect(removeFile).toHaveBeenCalledTimes(2)
    expect(fake.store.has(`${RECORDS}/r3`)).toBe(false)
  })

  it('purges an injury that has no clinical documents at all', async () => {
    fake.store.delete(`${RECORDS}/r1`)
    fake.store.delete(`${RECORDS}/r2`)
    await purgeInjury(ID, actor, 'IRA-2026-9001')
    expect(removeFile).not.toHaveBeenCalled()
    expect(fake.store.has(`${INJURIES}/${ID}`)).toBe(false)
  })
})
