import { describe, it, expect, vi } from 'vitest'

// Importing the service pulls in Firebase and storage; the guard under test is
// a pure function, so they are stubbed to nothing.
vi.mock('../../../shared/data/client.js', () => ({
  collection: vi.fn(), doc: vi.fn(), getDoc: vi.fn(), getDocs: vi.fn(), onSnapshot: vi.fn(),
  query: vi.fn(), runTransaction: vi.fn(), serverTimestamp: vi.fn(), where: vi.fn(),
  writeBatch: vi.fn(), limit: vi.fn(),
}))
vi.mock('../../../shared/db', () => ({ db: {} }))
vi.mock('../../../shared/storage', () => ({ putFile: vi.fn(), removeFile: vi.fn(), fileUrl: vi.fn() }))
vi.mock('../../../shared/org/orgData', () => ({ COLLECTION_READ_CAP: 500 }))

const { assertNotHeldByPermit, deleteProcedure } = await import('./procedures')

describe('assertNotHeldByPermit', () => {
  it('lets a free procedure through', () => {
    expect(() => assertNotHeldByPermit({ id: 'p1' })).not.toThrow()
    expect(() => assertNotHeldByPermit(null)).not.toThrow()
  })

  it('names the permit that holds the equipment', () => {
    expect(() => assertNotHeldByPermit({ activePermit: { id: 'LP-2026-0003', permitNo: 'LP-2026-0003' } }))
      .toThrow(/isolated under permit LP-2026-0003/)
  })

  it('stops a held procedure being deleted, before anything is written', async () => {
    await expect(deleteProcedure({ id: 'p1', activePermit: { id: 'LP-2026-0003' } }))
      .rejects.toThrow(/Return or remove that permit first/)
  })
})
