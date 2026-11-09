import { describe, it, expect, vi, beforeEach } from 'vitest'

// The Firestore seam. A transaction here is a recorder over an in-memory map, so
// the test can assert what a raise writes — counter, permit, inline lock — and
// that all of it goes through ONE transaction.
const state = vi.hoisted(() => ({ docs: new Map(), txCount: 0, writes: [] }))

vi.mock('../../../shared/data/client.js', () => {
  const ref = (path) => ({ __path: path })
  return {
    collection: (_db, ...p) => ({ __col: p.join('/') }),
    doc: (first, ...p) =>
      first && first.__col
        ? ref(`${first.__col}/auto${state.writes.length}`)
        : ref(p.join('/')),
    limit: (n) => n,
    onSnapshot: vi.fn(),
    orderBy: (f, d) => [f, d],
    query: (...parts) => parts,
    serverTimestamp: () => '__now',
    Timestamp: { fromMillis: (ms) => ({ __ms: ms }) },
    runTransaction: async (_db, fn) => {
      state.txCount += 1
      const tx = {
        get: async (r) => {
          const data = state.docs.get(r.__path)
          return { exists: () => data !== undefined, data: () => data }
        },
        set: (r, data) => state.writes.push({ path: r.__path, data }),
      }
      return fn(tx)
    },
  }
})
vi.mock('../../../shared/db', () => ({ db: {} }))
vi.mock('../../../shared/org/orgData', () => ({ COLLECTION_READ_CAP: 500 }))
vi.mock('../../../shared/crypto', () => ({
  // Sealing is its own suite; here it must only be CALLED, on the right path.
  sealDoc: vi.fn(async (col, data) => ({ ...data, __sealedAs: col })),
  openDoc: vi.fn(async (_col, data) => data),
  openSnapshots: vi.fn(() => () => {}),
}))

const { createPermit, toStoredPermit, inlineLockDoc } = await import('./permits')
const { sealDoc } = await import('../../../shared/crypto')

const YEAR = new Date().getUTCFullYear()
const permit = (over = {}) => ({
  workType: 'electrical_work', reason: 'Rewire the panel', requestedBy: 'u1',
  windowStartMs: 1000, windowEndMs: 5000, procedureId: 'p1',
  pointKeys: ['k1'], pointCount: 1, locks: [{ pointKey: 'k1', lockNo: 'D-1' }],
  ...over,
})

beforeEach(() => {
  state.docs = new Map()
  state.txCount = 0
  state.writes = []
  vi.mocked(sealDoc).mockClear()
})

describe('createPermit', () => {
  it('allocates the first number of the year and bumps the counter in the same transaction', async () => {
    const no = await createPermit({ user: { id: 'u1' }, permit: permit() })
    expect(no).toBe(`LP-${YEAR}-0001`)
    expect(state.txCount).toBe(1)
    const paths = state.writes.map((w) => w.path)
    expect(paths).toEqual([
      `docSeq/lotoPermit-${YEAR}`,
      `lotoPermits/LP-${YEAR}-0001`,
    ])
    expect(state.writes[0].data).toEqual({ n: 1 })
  })

  it('continues from the counter', async () => {
    state.docs.set(`docSeq/lotoPermit-${YEAR}`, { n: 41 })
    const no = await createPermit({ user: { id: 'u1' }, permit: permit() })
    expect(no).toBe(`LP-${YEAR}-0042`)
    expect(state.writes[0].data).toEqual({ n: 42 })
  })

  it('stores the window as Timestamps, starts as requested, and seals under the permit policy', async () => {
    await createPermit({ user: { id: 'u1' }, permit: permit() })
    const stored = state.writes[1].data
    expect(stored).toMatchObject({
      status: 'requested', permitSeq: 1, windowStart: { __ms: 1000 }, windowEnd: { __ms: 5000 },
      requestedAt: '__now', updatedAt: '__now', __sealedAs: 'lotoPermits',
    })
    expect(stored).not.toHaveProperty('windowStartMs')
  })

  it('registers an inline lock as a department lock in the same transaction', async () => {
    await createPermit({ user: { id: 'u1' }, permit: permit(), inlineLocks: [' D-1 '] })
    expect(state.txCount).toBe(1)
    const lock = state.writes.find((w) => w.path.startsWith('locks/'))
    expect(lock.data).toMatchObject({ lockNo: 'D-1', type: 'department', active: true, createdBy: 'u1' })
  })

  it('refuses a padlock that is already applied on other equipment, and writes nothing', async () => {
    state.docs.set('lockClaims/org__D-1', { procedureId: 'other', equipment: 'Press 4' })
    await expect(createPermit({ user: { id: 'u1' }, permit: permit() })).rejects.toThrow(
      /already applied on Press 4/,
    )
    expect(state.writes).toEqual([])
  })

  it('does not treat a claim held by the same procedure as a clash', async () => {
    state.docs.set('lockClaims/org__D-1', { procedureId: 'p1' })
    await expect(createPermit({ user: { id: 'u1' }, permit: permit() })).resolves.toMatch(/^LP-/)
  })

})

describe('stored shapes', () => {
  it('never lets the caller choose the status', () => {
    const s = toStoredPermit({ ...permit(), status: 'active' }, { permitNo: 'LP-2026-0001', permitSeq: 1 })
    expect(s.status).toBe('requested')
  })

  it('builds the register entry for an inline lock', () => {
    expect(inlineLockDoc({ lockNo: ' 7 ' }, { id: 'u' }, () => 't')).toEqual({
      lockNo: '7', type: 'department', active: true, createdBy: 'u', createdAt: 't',
    })
  })
})
