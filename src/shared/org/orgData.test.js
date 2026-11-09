import { describe, it, expect, vi } from 'vitest'
import {
  incompleteReadNotice,
  emptyCollections,
  COLLECTION_READ_CAP,
  readReady,
  readAnswered,
  collectionsReady,
  collectionsAnswered,
  orgFromIndex,
} from './orgData'

// Firestore faked at the module boundary. onSnapshot hands back the success and
// error callbacks so a test can drive either branch; `limit` and `query` are
// recorded so the cap being applied at all is observable.
const captured = { listeners: {}, unsubs: [] }

vi.mock('../firebase', () => ({ db: {}, default: {} }))
vi.mock('../data/client.js', () => ({
  collection: (_db, ...path) => ({ path: path.join('/') }),
  doc: () => ({}),
  query: (col, ...cs) => ({ ...col, constraints: cs }),
  limit: (n) => ({ type: 'limit', n }),
  orderBy: () => ({ type: 'orderBy' }),
  where: () => ({ type: 'where' }),
  onSnapshot: (q, onNext, onErr) => {
    const name = String(q.path || '')
      .split('/')
      .pop()
    const unsub = Object.assign(
      () => {
        unsub.called = true
      },
      { called: false }
    )
    captured.listeners[name] = {
      // A snapshot of n documents, shaped like the real one.
      next: (n) =>
        onNext({
          size: n,
          docs: Array.from({ length: n }, (_, i) => ({ id: `d${i}`, data: () => ({ n: i }) })),
        }),
      fail: (err) => onErr(err),
    }
    captured.unsubs.push(unsub)
    return unsub
  },
}))

/** Subscribe to `names` and expose the fake listeners driving each one. */
async function harness(names) {
  captured.listeners = {}
  captured.unsubs = []
  const { subscribeCollections } = await import('./orgData')
  const emit = vi.fn()
  const stop = subscribeCollections(names, emit)
  return { emit, stop, listeners: captured.listeners, unsubs: captured.unsubs }
}

describe('incompleteReadNotice', () => {
  it('says nothing when every collection came back whole', () => {
    expect(incompleteReadNotice({ incidents: 'ok', aeds: 'ok' })).toBeNull()
    expect(incompleteReadNotice({})).toBeNull()
    expect(incompleteReadNotice()).toBeNull()
  })

  it('names the capped collection and the cap', () => {
    const n = incompleteReadNotice({ incidents: 'capped', aeds: 'ok' }, 5000)
    expect(n.capped).toEqual(['incidents'])
    expect(n.failed).toEqual([])
    expect(n.message).toContain('first 5,000 records were loaded for incidents')
  })

  it('reads as a list when several are capped', () => {
    const n = incompleteReadNotice({ incidents: 'capped', mockDrills: 'capped', aeds: 'capped' })
    expect(n.message).toContain('incidents, mock drills and AEDs')
  })

  // The whole point of the change: a failed read must not read as an empty one.
  it('reports a failed read separately from a capped one', () => {
    const n = incompleteReadNotice({ incidents: 'failed', extinguishers: 'capped' })
    expect(n.failed).toEqual(['incidents'])
    expect(n.message).toContain('incidents could not be loaded at all')
    expect(n.message).toContain('fire extinguishers')
  })

  it('always warns that totals counting them are short', () => {
    for (const status of [{ a: 'capped' }, { a: 'failed' }]) {
      expect(incompleteReadNotice(status).message).toContain('lower than the real figure')
    }
  })

  it('falls back to the collection name when there is no label for it', () => {
    expect(incompleteReadNotice({ somethingNew: 'failed' }).message).toContain('somethingNew')
  })

  it('treats a denied read as empty, not incomplete', () => {
    expect(incompleteReadNotice({ incidents: 'denied', aeds: 'ok' })).toBeNull()
    expect(incompleteReadNotice({ incidents: 'denied', aeds: 'denied' })).toBeNull()
  })

  it('does not warn about collections that have not answered yet', () => {
    expect(incompleteReadNotice({ incidents: 'pending', aeds: 'ok' })).toBeNull()
    expect(incompleteReadNotice({ incidents: 'pending', aeds: 'pending' })).toBeNull()
  })

  it('still reports a real failure next to a denial', () => {
    const n = incompleteReadNotice({ incidents: 'denied', aeds: 'failed' })
    expect(n.failed).toEqual(['aeds'])
    expect(n.message).toContain('AEDs could not be loaded at all')
    expect(n.message).not.toContain('incidents')
  })
})

describe('emptyCollections', () => {
  it('gives every requested name an empty list, no warning, and pending status', () => {
    expect(emptyCollections(['incidents', 'aeds'])).toEqual({
      data: { incidents: [], aeds: [] },
      incomplete: null,
      status: { incidents: 'pending', aeds: 'pending' },
    })
  })

  it('is safe to call with nothing', () => {
    expect(emptyCollections()).toEqual({ data: {}, incomplete: null, status: {} })
  })
})

describe('readReady / collectionsReady', () => {
  it('treats only a successful snapshot as showable', () => {
    expect(readReady('ok')).toBe(true)
    expect(readReady('capped')).toBe(true)
    expect(readReady('pending')).toBe(false)
    expect(readReady('failed')).toBe(false)
    expect(readReady('denied')).toBe(false)
    expect(readReady(undefined)).toBe(false)
  })

  it('treats a denial as answered, not as a figure', () => {
    expect(readAnswered('denied')).toBe(true)
    expect(readAnswered('failed')).toBe(false)
    expect(readAnswered('pending')).toBe(false)
  })

  it('is ready only when every named collection has rows that can be shown', () => {
    expect(collectionsReady({ incidents: 'ok', aeds: 'capped' }, ['incidents', 'aeds'])).toBe(true)
    expect(collectionsReady({ incidents: 'ok', aeds: 'pending' }, ['incidents', 'aeds'])).toBe(
      false
    )
    expect(collectionsReady({ incidents: 'ok', aeds: 'denied' }, ['incidents', 'aeds'])).toBe(false)
    expect(collectionsReady({ incidents: 'ok', aeds: 'failed' }, ['incidents', 'aeds'])).toBe(false)
  })

  it('counts a denied source as answered so a mixed action list can still render', () => {
    // Illnesses are manager-only. Waiting for them to become 'ok' would keep a
    // member's portal home in loading forever; treating denial as answered lets
    // the sources they can see through, without showing an error.
    expect(
      collectionsAnswered({ incidents: 'ok', illnesses: 'denied' }, ['incidents', 'illnesses'])
    ).toBe(true)
    expect(
      collectionsAnswered({ incidents: 'ok', illnesses: 'failed' }, ['incidents', 'illnesses'])
    ).toBe(false)
    expect(
      collectionsAnswered({ incidents: 'ok', illnesses: 'pending' }, ['incidents', 'illnesses'])
    ).toBe(false)
  })
})

describe('COLLECTION_READ_CAP', () => {
  // Analytics opens eleven of these at once; the cap is what bounds that visit.
  it('is a generous but finite ceiling', () => {
    expect(COLLECTION_READ_CAP).toBe(5000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// subscribeCollections itself, not just the wording it produces.
//
// The detection is the load-bearing part: if snapshots stop being classified
// correctly, the notice never appears and every total on three screens goes
// back to being quietly wrong — which is the exact failure this work existed to
// fix. Firestore is faked at the module boundary so the branching is reachable.
// ─────────────────────────────────────────────────────────────────────────────
describe('subscribeCollections', () => {
  it('reports whole reads as complete', async () => {
    const { emit, listeners } = await harness(['incidents', 'aeds'])
    listeners.incidents.next(10)
    listeners.aeds.next(3)
    expect(emit.mock.calls.at(-1)[0].incomplete).toBeNull()
    expect(emit.mock.calls.at(-1)[0].data.incidents).toHaveLength(10)
  })

  // The only signal Firestore gives that more is behind the limit.
  it('flags a collection that exactly fills the cap', async () => {
    const { emit, listeners } = await harness(['incidents'])
    listeners.incidents.next(COLLECTION_READ_CAP)
    const { incomplete } = emit.mock.calls.at(-1)[0]
    expect(incomplete).not.toBeNull()
    expect(incomplete.capped).toEqual(['incidents'])
    expect(incomplete.message).toMatch(/must not be quoted as a count/)
  })

  it('does not flag one row below the cap', async () => {
    const { emit, listeners } = await harness(['incidents'])
    listeners.incidents.next(COLLECTION_READ_CAP - 1)
    expect(emit.mock.calls.at(-1)[0].incomplete).toBeNull()
  })

  // A failed read is not an empty collection — reporting [] is how a missing
  // index used to render as a confident zero. Permission-denied is the other
  // case: expected (module off, role), and must not raise the incomplete banner.
  it('separates a failed read from an empty one', async () => {
    const { emit, listeners } = await harness(['incidents', 'aeds'])
    listeners.incidents.next(0)
    listeners.aeds.fail(new Error('The query requires an index'))
    const { data, incomplete } = emit.mock.calls.at(-1)[0]
    expect(data.incidents).toEqual([])
    expect(data.aeds).toEqual([])
    expect(incomplete.failed).toEqual(['aeds'])
    expect(incomplete.capped).toEqual([])
  })

  it('treats permission-denied as empty, not failed', async () => {
    const { emit, listeners } = await harness(['incidents', 'aeds'])
    listeners.incidents.next(0)
    listeners.aeds.fail(
      Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied',
      })
    )
    const { data, incomplete } = emit.mock.calls.at(-1)[0]
    expect(data.aeds).toEqual([])
    expect(incomplete).toBeNull()
  })

  it('reports capped and failed together', async () => {
    const { emit, listeners } = await harness(['incidents', 'aeds'])
    listeners.incidents.next(COLLECTION_READ_CAP)
    listeners.aeds.fail(new Error('nope'))
    const { incomplete } = emit.mock.calls.at(-1)[0]
    expect(incomplete.capped).toEqual(['incidents'])
    expect(incomplete.failed).toEqual(['aeds'])
  })

  // A caller must never be able to reach rows without the reason they are short.
  it('always hands the rows and the reason over together', async () => {
    const { emit, listeners } = await harness(['incidents'])
    listeners.incidents.next(1)
    emit.mock.calls.forEach(([payload]) => {
      expect(payload).toHaveProperty('data')
      expect(payload).toHaveProperty('incomplete')
      expect(payload).toHaveProperty('status')
    })
  })

  it('keeps unread collections pending rather than pretending they loaded empty', async () => {
    const { emit, listeners } = await harness(['incidents', 'aeds'])
    listeners.incidents.next(2)
    const payload = emit.mock.calls.at(-1)[0]
    expect(payload.status.incidents).toBe('ok')
    expect(payload.status.aeds).toBe('pending')
    expect(payload.data.aeds).toEqual([])
    expect(payload.incomplete).toBeNull()
    expect(collectionsReady(payload.status, ['incidents', 'aeds'])).toBe(false)
  })

  it('marks a permission-denied collection denied, not ready', async () => {
    const { emit, listeners } = await harness(['incidents', 'aeds'])
    listeners.incidents.next(0)
    listeners.aeds.fail(
      Object.assign(new Error('Missing or insufficient permissions.'), {
        code: 'permission-denied',
      })
    )
    const { status } = emit.mock.calls.at(-1)[0]
    expect(status.aeds).toBe('denied')
    expect(collectionsReady(status, ['incidents', 'aeds'])).toBe(false)
    expect(collectionsAnswered(status, ['incidents', 'aeds'])).toBe(true)
  })

  it('recovers when a failed listener later succeeds', async () => {
    const { emit, listeners } = await harness(['incidents'])
    listeners.incidents.fail(new Error('offline'))
    expect(emit.mock.calls.at(-1)[0].incomplete.failed).toEqual(['incidents'])
    listeners.incidents.next(2)
    expect(emit.mock.calls.at(-1)[0].incomplete).toBeNull()
  })

  it('unsubscribes every listener it opened', async () => {
    const { stop, unsubs } = await harness(['incidents', 'aeds'])
    stop()
    expect(unsubs.filter((u) => u.called)).toHaveLength(2)
  })
})

describe('orgFromIndex', () => {
  it('reads a WEEHS organization as a joinable tenant', () => {
    expect(orgFromIndex({ name: 'Acme' })).toEqual({
      id: 'org-1',
      name: 'Acme',
      stack: 'weehs',
    })
  })

  it('reads an own-database reservation as a name with no tenant to join', () => {
    // A missing orgId used to look like "no such organization", and the next
    // person founded a WEEHS tenant under the reserved name.
    expect(orgFromIndex({ name: 'Northwind Metals', stack: 'own', requestId: 'req1' })).toEqual({
      id: null,
      name: 'Northwind Metals',
      stack: 'own',
      requestId: 'req1',
    })
  })

  it('returns null when the row is absent or has neither door', () => {
    expect(orgFromIndex(null)).toBeNull()
    expect(orgFromIndex({ name: 'Orphan' })).toBeNull()
  })
})
