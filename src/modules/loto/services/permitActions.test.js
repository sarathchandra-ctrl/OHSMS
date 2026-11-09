import { describe, it, expect, vi, beforeEach } from 'vitest'

// The Firestore seam. runTransaction runs the callback against an in-memory
// store and APPLIES the writes only if the callback resolves — the same
// all-or-nothing the real one gives. That is what these tests are about: not
// that each write is right, but that a refusal leaves no write behind and a
// success writes the permit AND the procedure through the same `tx`.
const h = vi.hoisted(() => ({ docs: new Map(), committed: [], txCount: 0, batches: [] }))

vi.mock('../../../shared/data/client.js', () => ({
  collection: (_db, ...p) => ({ __col: p.join('/') }),
  deleteField: () => '__delete__',
  doc: (first, ...p) =>
    first && first.__col ? { __path: `${first.__col}/auto${h.committed.length}` } : { __path: p.join('/') },
  runTransaction: async (_db, fn) => {
    h.txCount += 1
    const pending = []
    const tx = {
      get: async (r) => {
        const data = h.docs.get(r.__path)
        return { id: r.__path.split('/').pop(), exists: () => data !== undefined, data: () => data }
      },
      update: (r, data) => pending.push({ op: 'update', path: r.__path, data }),
      set: (r, data) => pending.push({ op: 'set', path: r.__path, data }),
      delete: (r) => pending.push({ op: 'delete', path: r.__path }),
    }
    const out = await fn(tx)
    h.committed.push(...pending)
    return out
  },
  serverTimestamp: () => '__now',
  Timestamp: { fromMillis: (ms) => ({ __ms: ms }) },
  writeBatch: () => {
    const ops = []
    const b = {
      update: (r, data) => ops.push({ op: 'update', path: r.__path, data }),
      set: (r, data) => ops.push({ op: 'set', path: r.__path, data }),
      commit: async () => { h.batches.push(ops) },
    }
    return b
  },
}))
vi.mock('../../../shared/db', () => ({ db: {} }))
vi.mock('../../../shared/crypto', () => ({
  sealDoc: vi.fn(async (_c, data) => data),
  openDoc: vi.fn(async (_c, data) => data),
}))
vi.mock('./procedures', () => ({
  publicRef: (id) => ({ __path: `procedureQr/${id}` }),
  publicBody: (p) => ({ __mirror: true, locked: p.lockSummary?.lockedCount, held: p.activePermit ?? null }),
}))

const A = await import('./permitActions')

const user = { id: 'u1', displayName: 'Req Uester' }
const admin = { id: 'adm', displayName: 'Ad Min' }
const NOW = Date.now()
const PERMIT = 'lotoPermits/LP-2026-0001'

const basePermit = (over = {}) => ({
  permitNo: 'LP-2026-0001', status: 'approved', requestedBy: 'u1',
  windowEnd: NOW + 3_600_000, procedureId: 'p1', procedureRevision: 2,
  pointKeys: ['k1', 'k2'], pointCount: 2,
  isolationPoints: [{ key: 'k1', pointId: 'E-1' }, { key: 'k2', pointId: 'H-1' }],
  locks: [
    { pointKey: 'k1', lockNo: 'D-1', lockType: 'department', techId: null, techName: '' },
    { pointKey: 'k2', lockNo: 'D-2', lockType: 'department', techId: null, techName: '' },
  ],
  ...over,
})
const baseProc = (over = {}) => ({
  status: 'approved', revision: 2, procedureCode: 'PUMP', equipment: 'Pump A', site: 'S1',
  isolationPoints: [
    { key: 'k1', energySource: 'electrical', lockState: { locked: false } },
    { key: 'k2', energySource: 'hydraulic', lockState: { locked: false } },
  ],
  lockSummary: { total: 2, lockedCount: 0, status: 'unlocked' },
  ...over,
})
const scans = { k1: { at: 1, method: 'camera' }, k2: { at: 2, method: 'manual' } }
const ready = {
  tryout: { zeroEnergy: true },
  lockPhoto: { path: 'orgs/o1/loto-photos/lock.jpg', at: Date.now() },
}
const seed = (permit = basePermit(), proc = baseProc()) => {
  h.docs.set(PERMIT, permit)
  if (proc) h.docs.set('procedures/p1', proc)
}
const wrote = (path) => h.committed.filter((w) => w.path === path)

beforeEach(() => {
  h.docs = new Map(); h.committed = []; h.txCount = 0; h.batches = []
})

describe('startIsolation — permit and procedure in ONE transaction', () => {
  it('flips the permit, locks every point, stamps the procedure, takes the claims and logs it, all in one commit', async () => {
    seed()
    await A.startIsolation({ permit: { id: 'LP-2026-0001' }, scans, user, ...ready })
    expect(h.txCount).toBe(1)

    expect(wrote(PERMIT)[0].data).toMatchObject({ status: 'active', startedAt: '__now' })
    expect(wrote(PERMIT)[0].data.isolation.scans.k2).toEqual({ at: 2, method: 'manual', by: 'u1' })

    const proc = wrote('procedures/p1')[0].data
    expect(proc.activePermit).toEqual({ id: 'LP-2026-0001', permitNo: 'LP-2026-0001' })
    expect(proc.lockSummary).toMatchObject({ total: 2, lockedCount: 2, status: 'locked' })
    expect(proc.isolationPoints.every((p) => p.lockState.locked)).toBe(true)

    // The public QR mirror says "locked, held" in the same commit.
    expect(wrote('procedureQr/p1')[0].data).toMatchObject({ locked: 2 })

    // One global padlock claim per lock, and an audit row per point, plus the timeline.
    expect(h.committed.filter((w) => w.path.startsWith('lockClaims/')).map((w) => w.path).sort())
      .toEqual(['lockClaims/org__D-1', 'lockClaims/org__D-2'])
    const events = h.committed.filter((w) => w.path.startsWith('lotoEvents/'))
    expect(events).toHaveLength(2)
    expect(events[0].data).toMatchObject({ action: 'lock', permitNo: 'LP-2026-0001', procedureId: 'p1', pointId: 'E-1' })
    expect(h.committed.some((w) => w.path.includes('/events/') && w.data.type === 'started')).toBe(true)
  })

  it('writes NOTHING when one tag has not been scanned', async () => {
    seed()
    await expect(A.startIsolation({ permit: { id: 'LP-2026-0001' }, scans: { k1: scans.k1 }, user, ...ready }))
      .rejects.toThrow(/Scan the tag on every isolation point/)
    expect(h.committed).toEqual([])
  })

  it('writes NOTHING when a padlock is already on other equipment', async () => {
    seed()
    h.docs.set('lockClaims/org__D-2', { procedureId: 'other', equipment: 'Press 4' })
    await expect(A.startIsolation({ permit: { id: 'LP-2026-0001' }, scans, user, ...ready }))
      .rejects.toThrow(/already applied on Press 4/)
    expect(h.committed).toEqual([])
  })

  it.each([
    ['the permit is no longer approved', () => seed(basePermit({ status: 'withdrawn' })), /not approved/],
    ['its window has ended', () => seed(basePermit({ windowEnd: NOW - 1000 })), /window has ended/],
    ['the procedure was revised', () => seed(basePermit(), baseProc({ revision: 3 })), /revised/],
    ['another permit holds the equipment', () => seed(basePermit(), baseProc({ activePermit: { id: 'LP-2026-0007' } })), /already isolated/],
    ['a point is already locked', () => seed(basePermit(), baseProc({ isolationPoints: [{ key: 'k1', lockState: { locked: true } }, { key: 'k2' }] })), /already locked/],
  ])('refuses and writes nothing when %s', async (_name, arrange, message) => {
    arrange()
    await expect(A.startIsolation({ permit: { id: 'LP-2026-0001' }, scans, user, ...ready })).rejects.toThrow(message)
    expect(h.committed).toEqual([])
  })

  it('refuses to start when zero energy was not confirmed', async () => {
    seed()
    await expect(A.startIsolation({
      permit: { id: 'LP-2026-0001' }, scans, user,
      tryout: { zeroEnergy: false }, lockPhoto: ready.lockPhoto,
    })).rejects.toThrow(/zero energy/)
    expect(h.committed).toEqual([])
  })

  it('starts a permit with nothing to isolate without touching any procedure', async () => {
    seed(basePermit({ pointKeys: [], pointCount: 0, procedureId: '', locks: [], isolationPoints: [] }), null)
    await A.startIsolation({ permit: { id: 'LP-2026-0001' }, scans: {}, user, ...ready })
    expect(wrote(PERMIT)[0].data.status).toBe('active')
    expect(h.committed.some((w) => w.path.startsWith('procedures/'))).toBe(false)
  })
})

describe('returning and removing — every lock off, permit closed, ONE transaction', () => {
  const heldProc = () => baseProc({
    activePermit: { id: 'LP-2026-0001', permitNo: 'LP-2026-0001' },
    lockSummary: { total: 2, lockedCount: 2, status: 'locked' },
    primaryTech: { lockNo: 'D-1' },
    isolationPoints: [
      { key: 'k1', lockState: { locked: true, lockedBy: 'u1', techLockNo: 'D-1', techName: 'Asha' } },
      { key: 'k2', lockState: { locked: true, lockedBy: 'u1', techLockNo: 'D-2' } },
    ],
  })
  const ticked = { toolsRemoved: true, guardsReplaced: true, personnelClear: true, affectedNotified: true }

  it('returns: unlocks all points, clears the marker, releases the claims, records checklist and per-lock confirmation', async () => {
    seed(basePermit({ status: 'active' }), heldProc())
    await A.returnPermit({ permit: { id: 'LP-2026-0001' }, user, ticked, confirmed: ['k1', 'k2'] })
    expect(h.txCount).toBe(1)

    expect(wrote(PERMIT)[0].data).toMatchObject({
      status: 'returned', closedAt: '__now', returnChecks: ticked,
    })
    expect(wrote(PERMIT)[0].data.returns.k1).toMatchObject({ lockNo: 'D-1', by: 'u1' })

    const proc = wrote('procedures/p1')[0].data
    expect(proc.activePermit).toBe('__delete__')
    expect(proc.lockSummary).toMatchObject({ lockedCount: 0, status: 'unlocked' })
    expect(proc.isolationPoints.every((p) => !p.lockState.locked)).toBe(true)
    expect(proc.primaryTech).toBeNull()
    expect(wrote('procedureQr/p1')[0].data).toMatchObject({ locked: 0, held: null })

    const released = h.committed.filter((w) => w.op === 'delete' && w.path.startsWith('lockClaims/')).map((w) => w.path)
    expect(new Set(released)).toEqual(new Set(['lockClaims/org__D-1', 'lockClaims/org__D-2']))
    const events = h.committed.filter((w) => w.path.startsWith('lotoEvents/'))
    expect(events.map((e) => e.data.action)).toEqual(['unlock', 'unlock'])
    expect(events[0].data.pointId).toBe('E-1')
  })

  it('refuses, writing nothing, with the checklist incomplete or a lock unconfirmed', async () => {
    seed(basePermit({ status: 'active' }), heldProc())
    await expect(A.returnPermit({ permit: { id: 'LP-2026-0001' }, user, ticked: { ...ticked, toolsRemoved: false }, confirmed: ['k1', 'k2'] }))
      .rejects.toThrow(/checklist/)
    await expect(A.returnPermit({ permit: { id: 'LP-2026-0001' }, user, ticked, confirmed: ['k1'] }))
      .rejects.toThrow(/Confirm each lock/)
    expect(h.committed).toEqual([])
  })

  it('refuses to return a permit that no longer holds the equipment', async () => {
    seed(basePermit({ status: 'active' }), baseProc({ activePermit: { id: 'LP-2026-0099' } }))
    await expect(A.returnPermit({ permit: { id: 'LP-2026-0001' }, user, ticked, confirmed: ['k1', 'k2'] }))
      .rejects.toThrow(/not held by this permit/)
    expect(h.committed).toEqual([])
  })

  it('emergency removal: same release, with the reason and attestations stored on the permit', async () => {
    seed(basePermit({ status: 'active' }), heldProc())
    const attest = { ownerUnavailable: true, equipmentInspected: true, ownerWillBeTold: true }
    await A.emergencyRemovePermit({ permit: { id: 'LP-2026-0001' }, user: admin, reason: 'Owner left site, line must clear', attest })
    expect(h.txCount).toBe(1)
    expect(wrote(PERMIT)[0].data).toMatchObject({ status: 'emergency_removed', emergency: { by: 'adm', attest } })
    expect(wrote('procedures/p1')[0].data.activePermit).toBe('__delete__')
    expect(h.committed.filter((w) => w.path.startsWith('lotoEvents/'))[0].data.emergency).toBe(true)
  })

  it('emergency removal needs a reason and every attestation', async () => {
    seed(basePermit({ status: 'active' }), heldProc())
    await expect(A.emergencyRemovePermit({ permit: { id: 'LP-2026-0001' }, user: admin, reason: 'ok', attest: {} }))
      .rejects.toThrow()
    expect(h.committed).toEqual([])
  })
})

describe('extendPermit', () => {
  const H = 3_600_000
  it('appends one record and moves the end later', async () => {
    seed(basePermit({ status: 'active', extensions: [{ at: 1 }] }))
    await A.extendPermit({ permit: { id: 'LP-2026-0001' }, user: admin, newEndMs: NOW + 5 * H, reason: 'Bearing seized, needs longer' })
    const w = wrote(PERMIT)[0].data
    expect(w.windowEnd).toEqual({ __ms: NOW + 5 * H })
    expect(w.extensions).toHaveLength(2)
    expect(w.extensions[1]).toMatchObject({ by: 'adm', to: NOW + 5 * H })
  })

  it('refuses an earlier end, more than a day, a missing reason, or a permit that is not active', async () => {
    seed(basePermit({ status: 'active' }))
    const args = { permit: { id: 'LP-2026-0001' }, user: admin, reason: 'Bearing seized, needs longer' }
    await expect(A.extendPermit({ ...args, newEndMs: NOW })).rejects.toThrow(/later than/)
    await expect(A.extendPermit({ ...args, newEndMs: NOW + 30 * H })).rejects.toThrow(/at most/)
    await expect(A.extendPermit({ ...args, newEndMs: NOW + 5 * H, reason: 'x' })).rejects.toThrow(/Say why/)
    seed(basePermit({ status: 'returned' }))
    await expect(A.extendPermit({ ...args, newEndMs: NOW + 5 * H })).rejects.toThrow(/not active/)
    expect(h.committed).toEqual([])
  })
})

describe('decidePermit / withdrawPermit', () => {
  it('approves with the approval record and a timeline entry in one batch', async () => {
    await A.decidePermit({ permit: { id: 'LP-2026-0001', requestedBy: 'u1' }, user: admin, approve: true })
    expect(h.batches[0].map((o) => o.op)).toEqual(['update', 'set'])
    expect(h.batches[0][0].data).toMatchObject({ status: 'approved', approval: { by: 'adm', at: '__now' } })
  })

  it('will not let a requester approve their own request without saying why nobody else could', async () => {
    const p = { id: 'LP-2026-0001', requestedBy: 'adm' }
    await expect(A.decidePermit({ permit: p, user: admin, approve: true })).rejects.toThrow(/Another administrator/)
    await A.decidePermit({ permit: p, user: admin, approve: true, selfApprovalReason: 'Sole administrator on night shift' })
    expect(h.batches[0][0].data.approval).toMatchObject({ selfApproved: true, selfApprovalReason: 'Sole administrator on night shift' })
  })

  it('needs a reason to reject, and closes the permit', async () => {
    await expect(A.decidePermit({ permit: { id: 'x', requestedBy: 'u1' }, user: admin, approve: false })).rejects.toThrow(/Say why/)
    await A.decidePermit({ permit: { id: 'x', requestedBy: 'u1' }, user: admin, approve: false, note: 'Procedure needs revising first' })
    expect(h.batches[0][0].data).toMatchObject({ status: 'rejected', closedAt: '__now' })
  })

  it('withdraws with a closure record', async () => {
    await A.withdrawPermit({ permit: { id: 'LP-2026-0001' }, user, note: 'Job cancelled' })
    expect(h.batches[0][0].data).toMatchObject({ status: 'withdrawn', closure: { by: 'u1', note: 'Job cancelled' }, closedAt: '__now' })
  })
})
