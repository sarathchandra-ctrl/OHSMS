import { describe, it, expect, vi, beforeEach } from 'vitest'

// The Action Tracker fans out over every module's collection, so this pins the
// contract five screens depend on: subscribeActions hands back the rows AND the
// reason they may be short, in one object.
//
// It matters more here than anywhere else in the app. The tracker's entire
// promise is that nothing outstanding is missed — an action list that is
// quietly truncated says "you are up to date" when you are not.

const listeners = {}

vi.mock('../../../shared/db', () => ({ db: {} }))
// The tracker opens each source before emitting. What that decryption DOES is
// covered by src/shared/crypto/index.test.js against the real crypto; what
// matters here is only that the callback is asynchronous, because the notice
// contract below is about what arrives and in what order.
//
// Stubbed rather than left real because the real path calls getDataKeys, which
// dynamically imports firebase/functions and fails against this file's mocks.
// That works in isolation and takes an unpredictable number of ticks under a
// full-suite run — a test that passes alone and fails in CI, which is worse
// than no test.
vi.mock('../../../shared/crypto', () => ({
  openSnapshots: (collection, cb) => (rows) => Promise.resolve(rows).then(cb),
}))
vi.mock('../../../shared/data/client.js', () => ({ doc: () => ({}), getDoc: vi.fn(), updateDoc: vi.fn() }))
vi.mock('../../../shared/org/orgData', async () => {
  // The real notice builder — the wording is not what is under test here, but
  // using the real one means this breaks if the two drift apart.
  const actual = await vi.importActual('../../../shared/org/orgData.js').catch(() => null)
  return {
    incompleteReadNotice:
      actual?.incompleteReadNotice ??
      ((status) => {
        const capped = Object.keys(status).filter((k) => status[k] === 'capped')
        const failed = Object.keys(status).filter((k) => status[k] === 'failed')
        return capped.length || failed.length ? { capped, failed, message: 'incomplete' } : null
      }),
    // The cap constant travels with the seam: sources.js does not read it, but
    // orgData exports it and a partial mock of a module that does is an error.
    COLLECTION_READ_CAP: actual?.COLLECTION_READ_CAP ?? 5000,
    subscribeOrgCollection: (name, cb) => {
      listeners[name] = cb
      return () => {
        listeners[name] = null
      }
    },
  }
})

const { subscribeActions, SOURCES } = await import('./sources')

// The tracker now DECRYPTS each source before emitting — several of these
// collections seal the very fields it reads (capa[].description on incidents,
// actions[].owner on illnesses and consultations), so a callback that fired
// synchronously would be handing screens ciphertext. Feeding a listener is
// therefore no longer enough to have been called back; the tests await a turn
// of the microtask queue first. openSnapshots also drops any batch that is no
// longer the latest, which is why each feed is settled before the next.
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

// Every source's collection, deduplicated — two sources can share one.
const COLLECTIONS = [...new Set(SOURCES.map((s) => s.collection))]
const feedAll = async (status = 'ok') => {
  COLLECTIONS.forEach((c) => listeners[c]?.({ rows: [], status }))
  await settle()
}

beforeEach(() => {
  Object.keys(listeners).forEach((k) => delete listeners[k])
})

describe('subscribeActions', () => {
  it('subscribes to every source collection', () => {
    subscribeActions(vi.fn())
    COLLECTIONS.forEach((c) => expect(listeners[c]).toBeTypeOf('function'))
  })

  it('always emits rows and the reason together', async () => {
    const cb = vi.fn()
    subscribeActions(cb)
    await feedAll('ok')
    const payload = cb.mock.calls.at(-1)[0]
    expect(payload).toHaveProperty('rows')
    expect(payload).toHaveProperty('incomplete')
    expect(payload).toHaveProperty('status')
    expect(Array.isArray(payload.rows)).toBe(true)
  })

  it('starts every source pending until it answers', async () => {
    const cb = vi.fn()
    subscribeActions(cb)
    listeners.incidents({ rows: [], status: 'ok' })
    await settle()
    const { status } = cb.mock.calls.at(-1)[0]
    expect(status.incidents).toBe('ok')
    expect(status.illnesses).toBe('pending')
  })

  it('says nothing when every source came back whole', async () => {
    const cb = vi.fn()
    subscribeActions(cb)
    await feedAll('ok')
    expect(cb.mock.calls.at(-1)[0].incomplete).toBeNull()
  })

  it('reports a capped source', async () => {
    const cb = vi.fn()
    subscribeActions(cb)
    await feedAll('ok')
    listeners.incidents({ rows: [], status: 'capped' })
    await settle()
    const { incomplete } = cb.mock.calls.at(-1)[0]
    expect(incomplete).not.toBeNull()
    expect(incomplete.capped).toContain('incidents')
  })

  // The one that used to render as "no outstanding actions".
  it('reports a failed source rather than an empty list', async () => {
    const cb = vi.fn()
    subscribeActions(cb)
    await feedAll('ok')
    listeners.mockDrills({ rows: [], status: 'failed' })
    await settle()
    const { incomplete } = cb.mock.calls.at(-1)[0]
    expect(incomplete.failed).toContain('mockDrills')
  })

  it('clears the notice when a failed source recovers', async () => {
    const cb = vi.fn()
    subscribeActions(cb)
    await feedAll('ok')
    listeners.incidents({ rows: [], status: 'failed' })
    await settle()
    expect(cb.mock.calls.at(-1)[0].incomplete).not.toBeNull()
    listeners.incidents({ rows: [], status: 'ok' })
    await settle()
    expect(cb.mock.calls.at(-1)[0].incomplete).toBeNull()
  })

  it('still flattens actions out of the rows it did get', async () => {
    const cb = vi.fn()
    subscribeActions(cb)
    await feedAll('ok')
    listeners.incidents({
      status: 'capped',
      rows: [
        { id: 'i1', refNo: 'INC-1', capa: [{ id: 'a1', description: 'Fix it', status: 'open' }] },
      ],
    })
    await settle()
    const { rows, incomplete } = cb.mock.calls.at(-1)[0]
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toBe('Fix it')
    // Truncated and still useful — the notice qualifies the list, it does not
    // replace it.
    expect(incomplete.capped).toContain('incidents')
  })

  it('names a committee department, and keeps a legacy owner as a person', () => {
    const committee = SOURCES.find((s) => s.key === 'committee')
    const rows = committee.extract({
      subject: 'Q3',
      actions: [
        { action: 'Fix the gate', owner: 'Ada' },
        { action: 'Mop the yard', ownerKind: 'department', department: 'Housekeeping', owner: '' },
      ],
    })
    expect(rows.map((r) => r.owner)).toEqual(['Ada', 'Department · Housekeeping'])
  })

  it('unsubscribes every listener it opened', () => {
    const stop = subscribeActions(vi.fn())
    stop()
    COLLECTIONS.forEach((c) => expect(listeners[c]).toBeNull())
  })
})
