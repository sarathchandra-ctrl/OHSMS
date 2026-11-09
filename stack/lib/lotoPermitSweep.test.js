import { describe, it, expect } from 'vitest'
import {
  DUE_SOON_MS,
  OVERDUE_REPEAT_MS,
  LOTO_PERMIT_RETENTION_DAYS,
  MAX_PERMIT_PURGES_PER_RUN,
  planFlags,
  isPurgeable,
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

