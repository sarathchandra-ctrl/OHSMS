import { describe, it, expect, vi, beforeEach } from 'vitest'

// What a failed QR defect report TELLS the person holding the phone.
//
// This path misled a real diagnosis for a day: every permission-denied became
// "already reported", so a rule that was refusing every report looked like a
// duplicate, and the defectLocks collection was empty the whole time. The three
// outcomes below are the ones that matter, and none of them was pinned.

const getDoc = vi.fn()
const commit = vi.fn()
const reportError = vi.fn()

vi.mock('../../../shared/firebase', () => ({ db: {} }))
vi.mock('../../../shared/monitoring', () => ({ reportError: (...a) => reportError(...a) }))
vi.mock('../../../shared/storage', () => ({
  putFile: vi.fn(), removeFile: vi.fn(), MAX_INLINE_BYTES: 1, tooLargeForInline: () => false,
}))
vi.mock('../../../shared/docId/reserve', () => ({ reserveDocId: vi.fn(async () => 'DOC-1') }))
vi.mock('../../../shared/org/orgData', () => ({ logAudit: vi.fn(), subscribeSites: vi.fn(), COLLECTION_READ_CAP: 5000 }))
vi.mock('../../../shared/data/client.js', () => ({
  collection: () => ({}),
  doc: () => ({}),
  getDoc: (...a) => getDoc(...a),
  getDocs: vi.fn(async () => ({ docs: [] })),
  addDoc: vi.fn(async () => ({ id: 'r1' })),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
  setDoc: vi.fn(),
  onSnapshot: vi.fn(),
  query: () => ({}),
  where: () => ({}),
  orderBy: () => ({}),
  limit: () => ({}),
  serverTimestamp: () => 'ts',
  runTransaction: vi.fn(),
  writeBatch: () => ({ set: vi.fn(), delete: vi.fn(), commit }),
  increment: vi.fn(),
  arrayUnion: vi.fn(),
  arrayRemove: vi.fn(),
  documentId: vi.fn(),
}))

const { createReport } = await import('./firestore')

const denied = Object.assign(new Error('denied'), { code: 'permission-denied' })
const report = { kind: 'defect', extId: 'ext1', defectType: 'empty', token: 'tok1', source: 'qr' }

beforeEach(() => {
  vi.clearAllMocks()
  commit.mockRejectedValue(denied)
})

describe('a refused QR defect report', () => {
  // The reporter cannot read the lock collection, so a duplicate stays the
  // likeliest explanation — stated as probable, never as fact, because someone
  // told "it is handled" walks away from a discharged extinguisher.
  it('hedges when it cannot tell, for an anonymous scanner', async () => {
    getDoc.mockRejectedValue(denied)
    await expect(createReport(report)).rejects.toThrow(/looks like it has already been reported/)
  })

  it('is certain when it can see the lock is there', async () => {
    getDoc.mockResolvedValue({ exists: () => true })
    await expect(createReport(report)).rejects.toThrow(/already been reported/)
  })

  // The one that was impossible before: we KNOW there is no duplicate, so
  // claiming one would be a lie, and the reporter has to learn the defect is
  // not recorded.
  it('says it was refused when it can see there is no duplicate', async () => {
    getDoc.mockResolvedValue({ exists: () => false })
    await expect(createReport(report)).rejects.toThrow(/NOT been logged/)
  })

  it('never claims a duplicate when it knows there is none', async () => {
    getDoc.mockResolvedValue({ exists: () => false })
    await expect(createReport(report)).rejects.not.toThrow(/already been reported/)
  })

  // Whatever the wording, an operator has to find out. The whole cost of the
  // original bug was that this failure reached nobody.
  it('reports the underlying error every time, with enough to debug it', async () => {
    getDoc.mockRejectedValue(denied)
    await createReport(report).catch(() => {})
    expect(reportError).toHaveBeenCalledTimes(1)
    const [err, ctx] = reportError.mock.calls[0]
    expect(err.code).toBe('permission-denied')
    expect(ctx).toMatchObject({ where: 'createReport', extId: 'ext1', defectType: 'empty', hasToken: true })
  })

  // A network failure is not an authorisation failure and must not be dressed
  // up as a duplicate.
  it('lets a non-permission error through untouched', async () => {
    commit.mockRejectedValue(Object.assign(new Error('offline'), { code: 'unavailable' }))
    await expect(createReport(report)).rejects.toThrow('offline')
    expect(reportError).not.toHaveBeenCalled()
  })
})
