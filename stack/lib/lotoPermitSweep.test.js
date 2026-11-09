import { describe, it, expect } from 'vitest'
import {
  DUE_SOON_MS,
  OVERDUE_REPEAT_MS,
  LOTO_PERMIT_RETENTION_DAYS,
  MAX_PERMIT_PURGES_PER_RUN,
  planFlags,
  isPurgeable,
  ownedByOrg,
  sweepLotoPermits,
  purgeClosedLotoPermits,
} from './lotoPermitSweep.js'

const MIN = 60 * 1000
const DAY = 24 * 60 * MIN
const T = (iso) => Date.parse(iso)
const active = (end, flags) => ({ status: 'active', windowEnd: end, ...(flags ? { flags } : {}) })

describe('planFlags', () => {
  const end = T('2026-10-05T14:00:00Z')

  it('has nothing to say about a permit that is not active', () => {
    for (const status of ['requested', 'approved', 'returned', 'emergency_removed']) {
      expect(planFlags({ status, windowEnd: end }, end + DAY)).toBeNull()
    }
    expect(planFlags(null, 1)).toBeNull()
    expect(planFlags({ status: 'active' }, 1)).toBeNull()
  })

  it('writes nothing while the permit is comfortably inside its window', () => {
    expect(planFlags(active(end), end - DUE_SOON_MS - MIN)).toBeNull()
  })

  it('flags due inside the last 30 minutes, once', () => {
    const f = planFlags(active(end), end - 10 * MIN)
    expect(f).toMatchObject({ windowEnd: end, dueAt: end - 10 * MIN, overdueCount: 0 })
    expect(planFlags(active(end, f), end - 5 * MIN)).toBeNull()
  })

  it('flags overdue at the end, then repeats every 30 minutes, counting up', () => {
    const one = planFlags(active(end, { windowEnd: end, dueAt: 1 }), end + MIN)
    expect(one).toMatchObject({ overdueCount: 1, overdueSince: end, lastOverdueAt: end + MIN })
    expect(planFlags(active(end, one), end + 20 * MIN)).toBeNull()
    const two = planFlags(active(end, one), end + MIN + OVERDUE_REPEAT_MS)
    expect(two.overdueCount).toBe(2)
    const three = planFlags(active(end, two), two.lastOverdueAt + OVERDUE_REPEAT_MS)
    expect(three.overdueCount).toBe(3)
  })

  it('records the due notice as owed when the first look is already past the end', () => {
    expect(planFlags(active(end), end + 5 * MIN)).toMatchObject({
      overdueCount: 1,
      dueAt: end + 5 * MIN,
    })
  })

  it('restarts from zero when the window was extended', () => {
    const old = {
      windowEnd: end,
      dueAt: 1,
      overdueCount: 4,
      overdueSince: end,
      lastOverdueAt: end + DAY,
    }
    const extended = active(end + 2 * 60 * MIN, old)
    const f = planFlags(extended, end + 60 * MIN)
    expect(f).toMatchObject({ windowEnd: end + 120 * MIN, overdueCount: 0, dueAt: null })
  })

  describe('a shift that crosses midnight', () => {
    // 22:00 on the 5th to 06:00 on the 6th (IST), as absolute instants.
    const start = T('2026-10-05T16:30:00Z')
    const nightEnd = T('2026-10-05T16:30:00Z') + 8 * 60 * MIN // 06:00 IST on the 6th
    const permit = (flags) => ({
      status: 'active',
      windowStart: start,
      windowEnd: nightEnd,
      ...(flags ? { flags } : {}),
    })

    it('is neither due nor overdue at 01:00, which is inside the window', () => {
      const oneAm = T('2026-10-05T19:30:00Z')
      expect(planFlags(permit(), oneAm)).toBeNull()
    })

    it('becomes due at 05:40 and overdue at 06:01', () => {
      expect(planFlags(permit(), nightEnd - 20 * MIN)).toMatchObject({ dueAt: nightEnd - 20 * MIN })
      expect(planFlags(permit(), nightEnd + MIN)).toMatchObject({ overdueCount: 1 })
    })
  })

  it('accepts Firestore Timestamps as well as numbers', () => {
    const ts = { toMillis: () => end }
    expect(planFlags({ status: 'active', windowEnd: ts }, end + MIN)).toMatchObject({
      windowEnd: end,
      overdueCount: 1,
    })
  })
})

describe('isPurgeable', () => {
  const now = T('2027-10-10T00:00:00Z')
  const closed = (status, closedAt) => ({ status, closedAt })

  it('purges a closed permit once it is a year old, whichever way it closed', () => {
    for (const status of ['returned', 'rejected', 'withdrawn', 'emergency_removed']) {
      expect(isPurgeable(closed(status, now - LOTO_PERMIT_RETENTION_DAYS * DAY), now)).toBe(true)
    }
  })

  it('keeps one closed less than a year ago', () => {
    expect(isPurgeable(closed('returned', now - (LOTO_PERMIT_RETENTION_DAYS - 1) * DAY), now)).toBe(
      false
    )
  })

  it('NEVER purges an open permit, however old', () => {
    for (const status of ['requested', 'approved', 'active']) {
      expect(isPurgeable({ status, closedAt: now - 5 * 365 * DAY, windowEnd: 1 }, now)).toBe(false)
    }
  })

  it('keeps a closed permit it cannot date', () => {
    expect(isPurgeable({ status: 'returned' }, now)).toBe(false)
    expect(isPurgeable(null, now)).toBe(false)
  })

  it('reads a Firestore Timestamp', () => {
    expect(
      isPurgeable({ status: 'returned', closedAt: { toMillis: () => now - 400 * DAY } }, now)
    ).toBe(true)
  })
})

describe('ownedByOrg', () => {
  it('confines a path to the org prefix and refuses traversal', () => {
    expect(ownedByOrg('orgs/a/permits/x.pdf', 'a')).toBe(true)
    expect(ownedByOrg('orgs/b/permits/x.pdf', 'a')).toBe(false)
    expect(ownedByOrg('orgs/a/../b/x.pdf', 'a')).toBe(false)
  })
})

// ── A small hierarchical fake: collection → doc → subcollection ──────────────
function fakeDb(seed) {
  const store = new Map(Object.entries(seed))
  const deleted = []
  const ref = (path) => ({
    path,
    id: path.split('/').pop(),
    collection: (name) => col(`${path}/${name}`),
    async update(patch) {
      store.set(path, { ...store.get(path), ...patch })
    },
    async delete() {
      deleted.push(path)
      store.delete(path)
    },
    async get() {
      const data = store.get(path)
      return { exists: data !== undefined, data: () => data }
    },
  })
  const rows = (prefix, filter = () => true) =>
    [...store.entries()]
      .filter(([p]) => p.startsWith(`${prefix}/`) && !p.slice(prefix.length + 1).includes('/'))
      .filter(([, d]) => filter(d))
      .map(([p, d]) => ({ id: p.split('/').pop(), data: () => d, ref: ref(p) }))
  const col = (prefix, filter) => ({
    doc: (id) => ref(`${prefix}/${id}`),
    where(field, op, value) {
      const cmp =
        op === '=='
          ? (a) => a === value
          : (a) => {
              const n = typeof a === 'number' ? a : (a?.toMillis?.() ?? NaN)
              return n <= value.getTime()
            }
      return col(prefix, (d) => cmp(d[field]))
    },
    limit: () => col(prefix, filter),
    async get() {
      const docs = rows(prefix, filter)
      return { docs, empty: !docs.length, size: docs.length }
    },
  })
  return { store, deleted, collection: (n) => col(n) }
}

describe('sweepLotoPermits', () => {
  const end = T('2026-10-05T14:00:00Z')
  const log = { info() {}, error() {} }

  it('flags active permits across organisations and leaves the rest alone', async () => {
    const db = fakeDb({
      'organizations/a': {},
      'organizations/b': {},
      'organizations/a/lotoPermits/LP-1': active(end),
      'organizations/a/lotoPermits/LP-2': { status: 'returned', windowEnd: end },
      'organizations/b/lotoPermits/LP-1': active(end + DAY),
    })
    const r = await sweepLotoPermits({ db, nowMs: end + MIN, logger: log })
    expect(r).toMatchObject({ checked: 2, flagged: 1, failures: [] })
    expect(db.store.get('organizations/a/lotoPermits/LP-1').flags.overdueCount).toBe(1)
    expect(db.store.get('organizations/a/lotoPermits/LP-2').flags).toBeUndefined()
    expect(db.store.get('organizations/b/lotoPermits/LP-1').flags).toBeUndefined()
  })

  it('is idempotent: a second pass writes nothing', async () => {
    const db = fakeDb({ 'organizations/a': {}, 'organizations/a/lotoPermits/LP-1': active(end) })
    await sweepLotoPermits({ db, nowMs: end + MIN, logger: log })
    const again = await sweepLotoPermits({ db, nowMs: end + 2 * MIN, logger: log })
    expect(again.flagged).toBe(0)
  })

  it('reports a permit it could not update and carries on', async () => {
    const db = fakeDb({
      'organizations/a': {},
      'organizations/a/lotoPermits/LP-1': active(end),
      'organizations/a/lotoPermits/LP-2': active(end),
    })
    const orig = db.collection('organizations').doc('a').collection('lotoPermits')
    expect(orig).toBeTruthy()
    const realGet = db.collection
    db.collection = (n) => {
      const c = realGet(n)
      if (n !== 'organizations') return c
      return {
        ...c,
        doc: (id) => ({
          ...c.doc(id),
          collection: (sub) => {
            const sc = c.doc(id).collection(sub)
            return {
              ...sc,
              where: (...a) => {
                const w = sc.where(...a)
                return {
                  async get() {
                    const s = await w.get()
                    s.docs[0].ref.update = async () => {
                      throw new Error('boom')
                    }
                    return s
                  },
                }
              },
            }
          },
        }),
      }
    }
    const r = await sweepLotoPermits({ db, nowMs: end + MIN, logger: log })
    expect(r.failures).toHaveLength(1)
    expect(r.failures[0].kind).toBe('flag-failed')
    expect(r.flagged).toBe(1)
  })
})

describe('purgeClosedLotoPermits', () => {
  const now = T('2027-10-10T00:00:00Z')
  const log = { info() {}, error() {} }
  const old = now - 400 * DAY
  const store = () => {
    const removed = []
    return {
      removed,
      file: (p) => ({
        delete: async () => {
          removed.push(p)
        },
      }),
    }
  }

  it('deletes closed permits past a year with their events, attachments and files — and keeps the rest', async () => {
    const db = fakeDb({
      'organizations/a': {},
      'organizations/a/lotoPermits/LP-OLD': { status: 'returned', closedAt: old },
      'organizations/a/lotoPermits/LP-OLD/events/e1': { type: 'started' },
      'organizations/a/lotoPermits/LP-OLD/attachments/f1': {
        path: 'orgs/a/lotoPermits/LP-OLD/photo.jpg',
      },
      'procedurePhotos/permitlock_LP-OLD': {
        orgId: 'a',
        photos: { lock: { path: 'orgs/a/loto-photos/lock.jpg' } },
      },
      'organizations/a/lotoPermits/LP-NEW': { status: 'returned', closedAt: now - 10 * DAY },
      'organizations/a/lotoPermits/LP-OPEN': { status: 'active', windowEnd: old },
      'organizations/a/lotoPermits/LP-OPEN/events/e1': { type: 'started' },
    })
    const s = store()
    const r = await purgeClosedLotoPermits({ db, store: s, nowMs: now, logger: log })
    expect(r).toMatchObject({ purged: 1, files: 2, failures: [] })
    expect(s.removed).toEqual([
      'orgs/a/lotoPermits/LP-OLD/photo.jpg',
      'orgs/a/loto-photos/lock.jpg',
    ])
    expect(db.store.has('organizations/a/lotoPermits/LP-OLD')).toBe(false)
    expect(db.store.has('organizations/a/lotoPermits/LP-OLD/events/e1')).toBe(false)
    expect(db.store.has('procedurePhotos/permitlock_LP-OLD')).toBe(false)
    expect(db.store.has('organizations/a/lotoPermits/LP-NEW')).toBe(true)
    expect(db.store.has('organizations/a/lotoPermits/LP-OPEN')).toBe(true)
    expect(db.store.has('organizations/a/lotoPermits/LP-OPEN/events/e1')).toBe(true)
  })

  it('never deletes a file outside the org’s own prefix, and says so', async () => {
    const db = fakeDb({
      'organizations/a': {},
      'organizations/a/lotoPermits/LP-OLD': { status: 'returned', closedAt: old },
      'organizations/a/lotoPermits/LP-OLD/attachments/f1': { path: 'orgs/b/secret.pdf' },
    })
    const s = store()
    const r = await purgeClosedLotoPermits({ db, store: s, nowMs: now, logger: log })
    expect(s.removed).toEqual([])
    expect(r.failures.map((f) => f.kind)).toEqual(['foreign-file-path'])
    expect(r.purged).toBe(1)
  })

  it('does not purge a permit whose file could not be deleted without saying so', async () => {
    const db = fakeDb({
      'organizations/a': {},
      'organizations/a/lotoPermits/LP-OLD': { status: 'returned', closedAt: old },
      'organizations/a/lotoPermits/LP-OLD/attachments/f1': { path: 'orgs/a/x.pdf' },
    })
    const bad = {
      file: () => ({
        delete: async () => {
          throw new Error('bucket down')
        },
      }),
    }
    const r = await purgeClosedLotoPermits({ db, store: bad, nowMs: now, logger: log })
    expect(r.failures.map((f) => f.kind)).toContain('file-left-behind')
  })

  it('caps one run', async () => {
    const seed = { 'organizations/a': {} }
    for (let i = 0; i < MAX_PERMIT_PURGES_PER_RUN + 5; i += 1) {
      seed[`organizations/a/lotoPermits/LP-${i}`] = { status: 'returned', closedAt: old }
    }
    const r = await purgeClosedLotoPermits({
      db: fakeDb(seed),
      store: store(),
      nowMs: now,
      logger: log,
    })
    expect(r.purged).toBe(MAX_PERMIT_PURGES_PER_RUN)
  })
})
