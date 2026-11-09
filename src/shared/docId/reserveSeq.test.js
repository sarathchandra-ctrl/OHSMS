import { describe, it, expect, vi, beforeEach } from 'vitest'

// reserveSeq is the transaction behind both reserveDocId and the asset
// registers. The registers used to compute their own numbers in the browser —
// highest-in-the-loaded-list plus one — so two people adding an AED at the same
// moment both got AED-0042, and that number goes on a QR label.

let store
let legacy

vi.mock('../data/client.js', () => ({
  collection: (_db, ...p) => ({ __path: p.join('/') }),
  doc: (_db, ...p) => ({ __path: p.join('/') }),
  getDoc: async (ref) => {
    const data = ref.__path === 'meta/docSeq' ? legacy : undefined
    return { exists: () => data !== undefined, data: () => data }
  },
  getDocs: async () => ({ docs: [] }),
  setDoc: async () => {},
  runTransaction: async (_db, fn) =>
    fn({
      get: async (ref) => {
        const data = store[ref.__path]
        return { exists: () => data !== undefined, data: () => data }
      },
      set: (ref, data) => { store[ref.__path] = data },
    }),
}))

const { reserveSeq, reserveDocId, _clearOrgCodeCache } = await import('./reserve')

const SEQ = 'docSeq/aed'

beforeEach(() => {
  store = {}
  legacy = undefined
  _clearOrgCodeCache()
})

describe('reserveSeq', () => {
  it('starts at 1 on a counter that does not exist yet', async () => {
    expect(await reserveSeq('aed')).toBe(1)
  })

  it('hands consecutive callers different numbers', async () => {
    expect(await reserveSeq('aed')).toBe(1)
    expect(await reserveSeq('aed')).toBe(2)
    expect(await reserveSeq('aed')).toBe(3)
  })

  it('leaves the counter at the last number it issued', async () => {
    await reserveSeq('aed')
    await reserveSeq('aed')
    expect(store[SEQ]).toEqual({ n: 2 })
  })

  it('reserves a whole block and returns its first number', async () => {
    // generateAll creates one asset per site. Reserving one at a time would let
    // another operator's unit land in the middle of the batch.
    expect(await reserveSeq('aed', { count: 5 })).toBe(1)
    expect(store[SEQ]).toEqual({ n: 5 })
    expect(await reserveSeq('aed')).toBe(6)
  })

  it('seeds from the floor when the register predates the counter', async () => {
    // An org with AED-0001..0041 already on the wall and no counter: without
    // the floor the first reservation would issue AED-0001 again.
    expect(await reserveSeq('aed', { floor: 41 })).toBe(42)
  })

  it('never moves backwards when the floor is stale', async () => {
    // The floor comes from a list capped at COLLECTION_READ_CAP, so it can
    // understate. The counter is the authority once it exists.
    await reserveSeq('aed', { floor: 41 })
    expect(await reserveSeq('aed', { floor: 10 })).toBe(43)
  })

  it('respects a legacy counter so ids continue past it', async () => {
    legacy = { aed: 77 }
    expect(await reserveSeq('aed')).toBe(78)
  })

  it('treats a count below one as one rather than rewinding the counter', async () => {
    expect(await reserveSeq('aed', { count: 0 })).toBe(1)
    expect(store[SEQ]).toEqual({ n: 1 })
  })

  it('keeps kinds independent', async () => {
    await reserveSeq('aed', { count: 9 })
    expect(await reserveSeq('fas')).toBe(1)
  })
})

describe('reserveDocId still rides on it', () => {
  it('formats the reserved number into the document reference', async () => {
    const id = await reserveDocId('incidents', { orgCode: 'ACME' })
    expect(id).toBe('INC-ACME_0001')
  })

  it('does not repeat a number under consecutive calls', async () => {
    const a = await reserveDocId('incidents', { orgCode: 'ACME' })
    const b = await reserveDocId('incidents', { orgCode: 'ACME' })
    expect(a).not.toBe(b)
  })
})
