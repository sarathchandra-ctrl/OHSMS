import { describe, it, expect, vi, beforeEach } from 'vitest'

// logTraining wrote ONE writeBatch holding matching.length + employees.length
// operations. Firestore rejects a batch over 500 outright, so a site-wide
// induction — the exact case this screen exists for — failed wholesale, and
// failed harder the more people had attended. Both of its neighbours in the
// same file have chunked at 400 all along.

const commits = []
let commitShouldFail = null

function makeBatch() {
  const ops = []
  return {
    set: (...a) => ops.push(['set', ...a]),
    update: (...a) => ops.push(['update', ...a]),
    commit: async () => {
      if (ops.length > 500) throw new Error(`batch too large: ${ops.length}`)
      if (commitShouldFail && commitShouldFail(ops)) throw new Error('commit refused')
      commits.push(ops.length)
    },
  }
}

vi.mock('../../../shared/data/client.js', () => ({
  collection: (_db, ...p) => ({ path: p.join('/') }),
  doc: (...a) => ({ path: a.length > 1 ? a.slice(1).join('/') : 'auto' }),
  addDoc: vi.fn(async () => ({ id: 'x' })),
  setDoc: vi.fn(),
  updateDoc: vi.fn(),
  deleteDoc: vi.fn(),
  getDoc: vi.fn(async () => ({ exists: () => false, data: () => ({}) })),
  getDocs: vi.fn(async () => ({ docs: [] })),
  query: (c) => c,
  where: () => null,
  orderBy: () => null,
  limit: () => null,
  onSnapshot: () => () => {},
  serverTimestamp: () => 'TS',
  writeBatch: () => makeBatch(),
  runTransaction: vi.fn(),
}))
vi.mock('../../../shared/db', () => ({ db: {} }))
vi.mock('../../../shared/org/orgData', () => ({ logAudit: vi.fn(), COLLECTION_READ_CAP: 5000 }))
vi.mock('../../../shared/org/readError', () => ({ onReadError: () => () => {} }))
vi.mock('../../../shared/docId/reserve', () => ({ reserveDocId: async () => 'TRN-ACME_0001' }))

const { logTraining } = await import('./firestore')

const course = { id: 'c1', name: 'Induction', validityMonths: 12, category: 'Induction' }
const people = (n) => Array.from({ length: n }, (_, i) => ({ uid: `u${i}`, name: `P${i}` }))
const assignments = (n) => Array.from({ length: n }, (_, i) => ({
  id: `a${i}`, status: 'assigned', courseId: 'c1', employeeUid: `u${i}`,
}))

const run = (employees, open = []) =>
  logTraining({ course, employees, trainerName: 'T', completedOn: '2026-09-04', scope: {}, notes: '' },
    { uid: 'admin', name: 'Admin' }, open)

beforeEach(() => { commits.length = 0; commitShouldFail = null })

describe('logTraining chunking', () => {
  it('uses one batch for an ordinary toolbox talk', async () => {
    await run(people(12))
    expect(commits).toEqual([12])
  })

  it('SURVIVES a site-wide induction past the 500-operation limit', async () => {
    // 600 records + 600 assignment updates = 1200 operations. One batch is a
    // hard rejection, and this screen is exactly where that number comes from.
    await expect(run(people(600), assignments(600))).resolves.toBe(600)
  })

  it('splits that into batches no larger than 400', async () => {
    await run(people(600), assignments(600))
    expect(Math.max(...commits)).toBeLessThanOrEqual(400)
    expect(commits.reduce((a, b) => a + b, 0)) .toBe(1200)
  })

  it('counts assignment updates against the same limit as the records', async () => {
    // 300 + 300 is under 500 per kind but over it together, which is how a
    // per-kind split would still have failed.
    await run(people(300), assignments(300))
    expect(Math.max(...commits)).toBeLessThanOrEqual(400)
  })

  it('only closes assignments for THIS course and these people', async () => {
    const open = [
      { id: 'a0', status: 'assigned', courseId: 'c1', employeeUid: 'u0' },
      { id: 'aX', status: 'assigned', courseId: 'OTHER', employeeUid: 'u0' },
      { id: 'aY', status: 'assigned', courseId: 'c1', employeeUid: 'someone-else' },
      { id: 'aZ', status: 'completed', courseId: 'c1', employeeUid: 'u0' },
    ]
    await run(people(1), open)
    expect(commits).toEqual([2]) // one record + one assignment closed
  })

  it('returns the number of people logged, not the number of writes', async () => {
    expect(await run(people(5), assignments(5))).toBe(5)
  })

  it('logs nobody without failing', async () => {
    await expect(run([])).resolves.toBe(0)
  })
})
