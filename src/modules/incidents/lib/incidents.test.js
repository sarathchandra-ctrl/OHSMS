// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'

// A stand-in Firestore with the one behaviour this fix depends on: a
// transaction that commits after someone else wrote a document it read is
// rejected and re-run. Without that rule the concurrency test below would pass
// against the read-then-write bug it exists to catch.
function makeStore() {
  const docs = new Map() // path -> { data, version }
  let interleaved = null // runs between the next transaction's read and commit
  return {
    attempts: 0,
    read: (path) => docs.get(path)?.data ?? null,
    seed(path, data) { docs.set(path, { data, version: 1 }) },
    reset() { docs.clear(); interleaved = null; this.attempts = 0 },
    /** Let another writer in after the next transaction has read, before it commits. */
    interleave(fn) { interleaved = fn },
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        this.attempts += 1
        const seen = new Map()
        const writes = []
        const out = await fn({
          get: async (ref) => {
            const entry = docs.get(ref.path)
            seen.set(ref.path, entry ? entry.version : 0)
            return { exists: () => Boolean(entry), data: () => (entry ? { ...entry.data } : undefined) }
          },
          set: (ref, data, opts) => writes.push([ref.path, data, opts]),
        })
        if (interleaved) {
          const run = interleaved
          interleaved = null
          await run()
        }
        if ([...seen].some(([path, version]) => (docs.get(path)?.version ?? 0) !== version)) continue
        for (const [path, data, opts] of writes) {
          const current = docs.get(path)
          docs.set(path, {
            data: opts?.merge && current ? { ...current.data, ...data } : { ...data },
            version: (current?.version ?? 0) + 1,
          })
        }
        return out
      }
      throw new Error('transaction gave up')
    },
  }
}

const store = makeStore()

// The module reaches for the initialised Firebase app at import time, which a
// unit test has no business booting.
vi.mock('../db', () => ({ db: {} }))

// Everything else stays real; only the transaction runner is swapped for the
// fake store above, so the code under test is the code that ships.
vi.mock('../../../shared/data/client.js', async (importOriginal) => ({
  ...(await importOriginal()),
  runTransaction: (_db, fn) => store.runTransaction(fn),
}))

const { formatRefNo, nextRefSeq, reserveRefNo } = await import('./incidents')

const counter = { path: 'meta/stats' }
const YEAR = new Date().getFullYear()

beforeEach(() => {
  store.reset()
})

describe('formatRefNo', () => {
  // Existing records are quoted by these numbers in external paperwork. If this
  // test has to change, so does every document already printed.
  it('produces the format records already carry', () => {
    expect(formatRefNo('IRA', 2026, 7)).toBe('IRA-2026-0007')
    expect(formatRefNo('ILL', 2025, 143)).toBe('ILL-2025-0143')
  })

  it('grows past four digits rather than truncating', () => {
    expect(formatRefNo('IRA', 2026, 12345)).toBe('IRA-2026-12345')
  })
})

describe('nextRefSeq', () => {
  it('starts at one for an org that has never filed anything', () => {
    expect(nextRefSeq(null)).toBe(1)
    expect(nextRefSeq({})).toBe(1)
    expect(nextRefSeq({ nextSeq: 0 })).toBe(1)
  })

  it('continues the sequence', () => {
    expect(nextRefSeq({ nextSeq: 7 })).toBe(8)
  })

  it('adds to a numeric string instead of concatenating onto it', () => {
    // "7" + 1 is "71", which would print IRA-2026-0071 and skip 64 numbers.
    expect(nextRefSeq({ nextSeq: '7' })).toBe(8)
  })

  it('refuses to turn a corrupt counter into a reference number', () => {
    // String(NaN).padStart(4,'0') is "0NaN" — a reference nobody could act on.
    expect(nextRefSeq({ nextSeq: 'abc' })).toBe(1)
    expect(nextRefSeq({ nextSeq: null })).toBe(1)
    expect(nextRefSeq({ nextSeq: -5 })).toBe(1)
    expect(nextRefSeq({ nextSeq: 3.7 })).toBe(4)
  })
})

describe('reserveRefNo', () => {
  it('numbers the first record from one and creates the counter', async () => {
    // Nothing seeded: an org that has never filed has no counter document.
    expect(await reserveRefNo(counter, 'IRA')).toBe(`IRA-${YEAR}-0001`)
    expect(store.read(counter.path).nextSeq).toBe(1)
  })

  it('continues from the counter it finds', async () => {
    store.seed(counter.path, { nextSeq: 41 })
    expect(await reserveRefNo(counter, 'IRA')).toBe(`IRA-${YEAR}-0042`)
    expect(await reserveRefNo(counter, 'IRA')).toBe(`IRA-${YEAR}-0043`)
  })

  it('leaves the dashboard totals that share the document alone', async () => {
    store.seed(counter.path, { nextSeq: 4, total: 9, bySeverity: { high: 2 } })
    await reserveRefNo(counter, 'IRA')
    expect(store.read(counter.path)).toMatchObject({ nextSeq: 5, total: 9, bySeverity: { high: 2 } })
  })

  it('never issues the same number twice to two people filing at once', async () => {
    // The bug this closes: both callers read the counter, both computed the same
    // seq + 1, and two incidents went to the regulator under one reference.
    store.seed(counter.path, { nextSeq: 7 })
    let second
    store.interleave(async () => { second = await reserveRefNo(counter, 'IRA') })
    const first = await reserveRefNo(counter, 'IRA')

    expect(second).toBe(`IRA-${YEAR}-0008`)
    expect(first).toBe(`IRA-${YEAR}-0009`)
    expect(first).not.toBe(second)
    expect(store.read(counter.path).nextSeq).toBe(9)
    expect(store.attempts).toBeGreaterThan(2) // the loser was re-run, not accepted
  })

  it('is the same reserver for illnesses, on their own counter', async () => {
    const illCounter = { path: 'meta/illness' }
    store.seed(counter.path, { nextSeq: 100 })
    store.seed(illCounter.path, { nextSeq: 2 })
    expect(await reserveRefNo(illCounter, 'ILL')).toBe(`ILL-${YEAR}-0003`)
    // Incidents and illnesses number independently.
    expect(store.read(counter.path).nextSeq).toBe(100)
  })
})
