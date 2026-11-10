import { describe, it, expect, vi } from 'vitest'

/**
 * The contract assertions. `open` returns an adapter. Anything asserted here
 * is asserted of every driver; the null-match flag is the one documented
 * SQL divergence (a missing field matches `== null`).
 */
export function defineDataContract(
  open,
  { tick, nullMatchesMissing = false, isolated = true } = {}
) {
  if (typeof tick !== 'function') throw new Error('defineDataContract needs a tick')
  const P = 'organizations/org1/incidents'

  describe('reads', () => {
    it('answers null for a document that is not there, and does not throw', async () => {
      // "Absent" and "refused" have to stay distinguishable: a page that turns a
      // read failure into an empty state tells someone a site has no equipment.
      const d = await open()
      expect(await d.get(P, 'nope')).toBeNull()
      expect(await d.list(P)).toEqual([])
      expect(await d.count(P)).toBe(0)
    })

    it('returns rows as {id, ...data}', async () => {
      const d = await open()
      const id = await d.create(P, { title: 'Cut hand' })
      expect(await d.get(P, id)).toEqual({ id, title: 'Cut hand' })
    })

    it('hands out copies, so a caller mutating a row cannot reach the store', async () => {
      const d = await open()
      const id = await d.create(P, { tags: ['a'], nested: { n: 1 } })
      const row = await d.get(P, id)
      row.tags.push('b')
      row.nested.n = 99
      expect(await d.get(P, id)).toEqual({ id, tags: ['a'], nested: { n: 1 } })
    })

    it('filters, orders and limits', async () => {
      const d = await open()
      await d.set(P, 'a', { site: 's1', n: 3 })
      await d.set(P, 'b', { site: 's2', n: 2 })
      await d.set(P, 'c', { site: 's1', n: 1 })

      const rows = await d.list(P, {
        where: [{ field: 'site', op: '==', value: 's1' }],
        orderBy: ['n', 'asc'],
      })
      expect(rows.map((r) => r.id)).toEqual(['c', 'a'])
      expect(await d.count(P, { where: [{ field: 'site', op: '==', value: 's1' }] })).toBe(2)
      expect((await d.list(P, { orderBy: ['n', 'desc'], limit: 2 })).map((r) => r.id)).toEqual([
        'a',
        'b',
      ])
    })

    it("supports the 'in' filter the documents read-scope emits", async () => {
      const d = await open()
      await d.set(P, 'a', { siteId: 's1' })
      await d.set(P, 'b', { siteId: 's2' })
      await d.set(P, 'c', { siteId: 's3' })
      const rows = await d.list(P, { where: [{ field: 'siteId', op: 'in', value: ['s1', 's3'] }] })
      expect(rows.map((r) => r.id)).toEqual(['a', 'c'])
    })

    it('compares a Date range against stored timestamps (the audit-log query)', async () => {
      const d = await open()
      await d.set(P, 'old', { at: new Date('2020-01-01') })
      await d.set(P, 'new', { at: new Date('2026-01-01') })
      const rows = await d.list(P, {
        where: [{ field: 'at', op: '>=', value: new Date('2025-01-01') }],
      })
      expect(rows.map((r) => r.id)).toEqual(['new'])
    })

    // Firestore parity, and the reason backfillDeletedAt exists: `== null` does
    // NOT match a document where the field is absent. A SQL adapter using IS NULL
    // will disagree — that difference belongs in its notes, not in this one.
    it(
      nullMatchesMissing
        ? 'matches a missing field with == null, which SQL does and Firestore does not'
        : 'does not match a MISSING field with == null',
      async () => {
        const d = await open()
        await d.set(P, 'explicit', { deletedAt: null })
        await d.set(P, 'legacy', {})
        const rows = await d.list(P, { where: [{ field: 'deletedAt', op: '==', value: null }] })
        const ids = rows.map((r) => r.id).sort()
        // Firestore does not match a missing field. SQL does. The flag is that
        // difference, named in the contract, not a second assertion invented here.
        if (nullMatchesMissing) expect(ids).toEqual(['explicit', 'legacy'])
        else expect(ids).toEqual(['explicit'])
      }
    )

    // A DELIBERATE divergence. Firestore drops documents missing the ordered
    // field; this driver keeps them, sorted last. Showing a row you did not expect
    // is a failure someone can see; hiding one is the failure orgData.js:275 and
    // cctv/lib/data.js:38 both warn about.
    it('keeps documents missing the ordered field, sorted last', async () => {
      const d = await open()
      await d.set(P, 'named', { name: 'Alpha' })
      await d.set(P, 'unnamed', {})
      for (const dir of ['asc', 'desc']) {
        const rows = await d.list(P, { orderBy: ['name', dir] })
        expect(rows.map((r) => r.id)).toEqual(['named', 'unnamed'])
      }
    })

    it('orders by document id when no orderBy is given, as Firestore does', async () => {
      const d = await open()
      await d.set(P, 'c', {})
      await d.set(P, 'a', {})
      await d.set(P, 'b', {})
      expect((await d.list(P)).map((r) => r.id)).toEqual(['a', 'b', 'c'])
    })

    // Silently ignoring a filter it did not understand would turn the documents
    // library's site-scoped read into an unscoped one.
    it('refuses a filter it cannot honour instead of dropping it', async () => {
      const d = await open()
      await expect(d.list(P, { where: [{ field: 'x', op: '~=', value: 1 }] })).rejects.toThrow(
        /unsupported/
      )
      await expect(d.list(P, { where: [{ field: null, op: '==', value: 1 }] })).rejects.toThrow(
        /field/
      )
      expect(() =>
        d.subscribe(P, { where: [{ field: 'x', op: '~=', value: 1 }] }, () => {})
      ).toThrow()
    })
  })

  describe('writes', () => {
    it('create assigns an id; set writes one the caller chose', async () => {
      const d = await open()
      const id = await d.create(P, { a: 1 })
      expect(typeof id).toBe('string')
      await d.set(P, 'chosen', { a: 2 })
      expect((await d.get(P, 'chosen')).a).toBe(2)
    })

    it('set replaces wholesale, and merges only the named fields with {merge:true}', async () => {
      const d = await open()
      await d.set(P, 'x', { a: 1, b: 2, nested: { p: 1, q: 2 } })
      await d.set(P, 'x', { a: 9 })
      expect(await d.get(P, 'x')).toEqual({ id: 'x', a: 9 })

      await d.set(P, 'y', { a: 1, nested: { p: 1, q: 2 } })
      await d.set(P, 'y', { nested: { q: 99 } }, { merge: true })
      expect(await d.get(P, 'y')).toEqual({ id: 'y', a: 1, nested: { p: 1, q: 99 } })
    })

    // Load-bearing: incidents' bumpStats seeds its stats document off this
    // rejection, deliberately without nextSeq. An adapter that upserted here would
    // rewind the reference-number counter and reissue a number already in use.
    it('update rejects when the document does not exist', async () => {
      const d = await open()
      await expect(d.update(P, 'ghost', { n: 1 })).rejects.toMatchObject({ code: 'not-found' })
      expect(await d.get(P, 'ghost')).toBeNull()
    })

    it('update addresses nested fields with dotted keys, leaving siblings alone', async () => {
      const d = await open()
      await d.set(P, 'stats', { byStatus: { active: 1, closed: 5 }, total: 6 })
      await d.update(P, 'stats', { 'byStatus.active': 2 })
      expect(await d.get(P, 'stats')).toEqual({
        id: 'stats',
        byStatus: { active: 2, closed: 5 },
        total: 6,
      })
    })

    it('update creates the intermediate map when the nested field is new', async () => {
      const d = await open()
      await d.set(P, 'stats', { total: 0 })
      await d.update(P, 'stats', { 'bySeverity.high': 1 })
      expect((await d.get(P, 'stats')).bySeverity).toEqual({ high: 1 })
    })

    it('removing a document that is not there is not an error', async () => {
      const d = await open()
      await expect(d.remove(P, 'ghost')).resolves.toBeUndefined()
    })

    it('refuses undefined as a field value, exactly as Firestore does', async () => {
      // A driver that accepts what production rejects lets the bug through.
      const d = await open()
      await expect(d.set(P, 'x', { a: undefined })).rejects.toThrow(/undefined/)
      await expect(d.set(P, 'x', { nested: { a: undefined } })).rejects.toThrow(/nested\.a/)
    })

    it('refuses a document path where a collection belongs, and an id with a slash', async () => {
      const d = await open()
      await expect(d.get('organizations/org1', 'x')).rejects.toThrow(/document path/)
      await expect(d.set(P, 'a/b', {})).rejects.toThrow(/document id/)
    })
  })

  describe('newId', () => {
    it('is synchronous, unique, and usable as the id of a later write', async () => {
      // The QR mirrors need the id BEFORE the write: it goes into the public
      // document in the same batch as the record it mirrors.
      const d = await open()
      const id = d.newId(P)
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(10)
      expect(new Set(Array.from({ length: 500 }, () => d.newId(P))).size).toBe(500)

      const b = d.batch()
      b.set(P, id, { title: 'Report' })
      b.set('qr', 'token1', { extId: id })
      await b.commit()
      expect((await d.get('qr', 'token1')).extId).toBe(id)
    })
  })

  describe('sentinels', () => {
    it('serverTimestamp resolves to something ordered and comparable', async () => {
      const d = await open()
      // Several writes inside one millisecond must still sort in write order —
      // equal timestamps make an ordered read a coin flip that looks correct.
      for (const id of ['a', 'b', 'c']) await d.set(P, id, { createdAt: d.serverTimestamp() })
      const rows = await d.list(P, { orderBy: ['createdAt', 'desc'] })
      expect(rows.map((r) => r.id)).toEqual(['c', 'b', 'a'])

      const t = (await d.get(P, 'a')).createdAt
      expect(typeof t.toMillis()).toBe('number')
      expect(t.toDate() instanceof Date).toBe(true)
      expect(typeof t.seconds).toBe('number') // the shape three sorts in the app read
    })

    it('increment adds atomically, without the caller reading first', async () => {
      const d = await open()
      await d.set(P, 'stats', { total: 5, byStatus: { active: 1 } })
      await d.update(P, 'stats', { total: d.increment(3), 'byStatus.active': d.increment(-1) })
      expect(await d.get(P, 'stats')).toEqual({ id: 'stats', total: 8, byStatus: { active: 0 } })
    })

    it('increment on a field that is absent or not a number starts from the delta', async () => {
      const d = await open()
      await d.set(P, 'x', { count: 'seven' })
      await d.update(P, 'x', { count: d.increment(2), fresh: d.increment(4) })
      expect(await d.get(P, 'x')).toEqual({ id: 'x', count: 2, fresh: 4 })
    })

    it('arrayUnion appends only what is absent, by value', async () => {
      const d = await open()
      await d.set(P, 'x', { keys: ['a'] })
      await d.update(P, 'x', { keys: d.arrayUnion('a', 'b') })
      expect((await d.get(P, 'x')).keys).toEqual(['a', 'b'])

      await d.set(P, 'p', { extension: { suggestions: [{ by: 'u1', n: 1 }] } })
      await d.update(P, 'p', {
        'extension.suggestions': d.arrayUnion({ by: 'u1', n: 1 }, { by: 'u2', n: 2 }),
      })
      expect((await d.get(P, 'p')).extension.suggestions).toEqual([
        { by: 'u1', n: 1 },
        { by: 'u2', n: 2 },
      ])
    })
  })

  describe('subscribe', () => {
    it('returns its unsubscribe synchronously and emits first asynchronously', async () => {
      const d = await open()
      await d.set(P, 'a', { n: 1 })
      const seen = []
      const stop = d.subscribe(P, {}, (rows) => seen.push(rows))
      // Both halves matter: a caller unsubscribes in a cleanup that cannot await,
      // and a caller that sets state in the callback must not have it run before
      // its own subscribe() call returned.
      expect(typeof stop).toBe('function')
      expect(seen).toEqual([])
      await tick()
      expect(seen.length).toBe(1)
      expect(seen[0].map((r) => r.id)).toEqual(['a'])
      stop()
    })

    it('emits on every later mutation to that path, and stops when unsubscribed', async () => {
      const d = await open()
      const seen = []
      const stop = d.subscribe(P, {}, (rows) => seen.push(rows.map((r) => r.id)))
      await tick()

      await d.set(P, 'a', { n: 1 })
      await tick()
      await d.update(P, 'a', { n: 2 })
      await tick()
      await d.remove(P, 'a')
      await tick()
      expect(seen).toEqual([[], ['a'], ['a'], []])

      stop()
      await d.set(P, 'b', {})
      await tick()
      expect(seen.length).toBe(4)
    })

    it('applies its query options to every emission, not just the first', async () => {
      const d = await open()
      const seen = []
      const stop = d.subscribe(P, { where: [{ field: 'site', op: '==', value: 's1' }] }, (rows) =>
        seen.push(rows.map((r) => r.id))
      )
      await tick()
      await d.set(P, 'a', { site: 's1' })
      await d.set(P, 'b', { site: 's2' })
      await tick()
      expect(seen.at(-1)).toEqual(['a'])
      stop()
    })

    it('does not wake a listener on another collection', async () => {
      const d = await open()
      const other = vi.fn()
      const stop = d.subscribe('organizations/org1/permits', {}, other)
      await tick()
      await d.set(P, 'a', {})
      await tick()
      expect(other).toHaveBeenCalledTimes(1) // the initial emission only
      stop()
    })

    it('subscribeDoc emits null for an absent document and follows it in and out', async () => {
      const d = await open()
      const seen = []
      const stop = d.subscribeDoc(P, 'x', (doc) => seen.push(doc))
      await tick()
      await d.set(P, 'x', { n: 1 })
      await tick()
      await d.remove(P, 'x')
      await tick()
      expect(seen).toEqual([null, { id: 'x', n: 1 }, null])
      stop()
    })

    it('one subscriber throwing does not silence the others, and is not swallowed', async () => {
      const d = await open()
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      const good = vi.fn()
      const stopBad = d.subscribe(P, {}, () => {
        throw new Error('render blew up')
      })
      const stopGood = d.subscribe(P, {}, good)
      await tick()
      expect(good).toHaveBeenCalled()
      expect(logged).toHaveBeenCalled()
      logged.mockRestore()
      stopBad()
      stopGood()
    })

    it('reports a refused read through onError instead of an empty list', async () => {
      // The distinction the whole contract turns on. Without it, "the read failed"
      // renders as "there is nothing here".
      const d = await open()
      const cb = vi.fn()
      const onError = vi.fn()
      const stop = d.subscribe(P, {}, cb, onError)
      await tick()
      expect(cb).toHaveBeenCalledTimes(1)

      d._refuse('organizations/org1')
      await tick()
      expect(onError).toHaveBeenCalledTimes(1)
      expect(d.isWriteRefused(onError.mock.calls[0][0])).toBe(true)
      expect(cb).toHaveBeenCalledTimes(1) // never told "empty"

      await expect(d.list(P)).rejects.toMatchObject({ code: 'permission-denied' })
      await expect(d.set(P, 'a', {})).rejects.toMatchObject({ code: 'permission-denied' })
      stop()
    })
  })

  describe('createExclusive', () => {
    it('rejects an id that already exists, and leaves the original alone', async () => {
      const d = await open()
      await d.createExclusive('defectLocks', 'ext1__gauge', { extId: 'ext1' })
      await expect(
        d.createExclusive('defectLocks', 'ext1__gauge', { extId: 'someone-else' })
      ).rejects.toMatchObject({ code: 'already-exists' })
      expect((await d.get('defectLocks', 'ext1__gauge')).extId).toBe('ext1')
    })

    it('is classified as a refused write, the way the collision is on Firestore', async () => {
      const d = await open()
      await d.createExclusive('defectLocks', 'l1', {})
      const e = await d.createExclusive('defectLocks', 'l1', {}).catch((err) => err)
      expect(d.isWriteRefused(e)).toBe(true)
      // Not every failure is a refusal — a missing update target is a different bug.
      expect(d.isWriteRefused(await d.update(P, 'ghost', {}).catch((err) => err))).toBe(false)
    })
  })

  describe('batch', () => {
    // The centrepiece. A check-then-set adapter passes everything else on a quiet
    // day; this is the case it cannot pass.
    it('applies nothing when an exclusive create in it collides', async () => {
      const d = await open()
      await d.createExclusive('defectLocks', 'ext1__gauge', { first: true })

      const b = d.batch()
      b.createExclusive('defectLocks', 'ext1__gauge', { second: true })
      b.set('organizations/org1/reports', 'r1', { defect: 'gauge' })
      await expect(b.commit()).rejects.toMatchObject({ code: 'already-exists' })

      // The report must NOT be there: the lock and the report are written together
      // precisely so a duplicate cannot slip in between them.
      expect(await d.get('organizations/org1/reports', 'r1')).toBeNull()
      expect(await d.get('defectLocks', 'ext1__gauge')).toEqual({ id: 'ext1__gauge', first: true })
    })

    it('applies nothing when an update in it targets a missing document', async () => {
      const d = await open()
      const b = d.batch()
      b.set(P, 'a', { n: 1 })
      b.update(P, 'ghost', { n: 2 })
      await expect(b.commit()).rejects.toMatchObject({ code: 'not-found' })
      expect(await d.get(P, 'a')).toBeNull()
    })

    it('commits writes across unrelated collections together', async () => {
      // The org record and its public mirror land as one, or a scanned page says
      // "isolated" about a machine whose lock is already off.
      const d = await open()
      const b = d.batch()
      b.set('organizations/org1/extinguishers', 'e1', { serial: 'A1' })
      b.set('qr', 'tok', { extId: 'e1' })
      b.remove(P, 'gone')
      await b.commit()
      expect(await d.get('organizations/org1/extinguishers', 'e1')).toMatchObject({ serial: 'A1' })
      expect(await d.get('qr', 'tok')).toMatchObject({ extId: 'e1' })
    })

    it('updates a document created earlier in the same batch', async () => {
      const d = await open()
      const b = d.batch()
      b.set(P, 'a', { n: 1 })
      b.update(P, 'a', { n: 2 })
      await b.commit()
      expect((await d.get(P, 'a')).n).toBe(2)
    })

    it('never lets a subscriber observe a half-applied batch', async () => {
      const d = await open()
      const seen = []
      const stop = d.subscribe(P, {}, (rows) => seen.push(rows.length))
      await tick()
      const b = d.batch()
      for (const id of ['a', 'b', 'c']) b.set(P, id, {})
      await b.commit()
      await tick()
      expect(seen).toEqual([0, 3]) // one emission, after everything landed
      stop()
    })
  })

  describe('runTransaction', () => {
    it('applies staged writes only when the body resolves', async () => {
      const d = await open()
      await d.set(P, 'x', { n: 1 })
      const out = await d.runTransaction(async (tx) => {
        const cur = await tx.get(P, 'x')
        tx.update(P, 'x', { n: cur.n + 1 })
        tx.set('qr', 'tok', { mirrored: true })
        return 'done'
      })
      expect(out).toBe('done')
      expect((await d.get(P, 'x')).n).toBe(2)
      expect(await d.get('qr', 'tok')).toMatchObject({ mirrored: true })
    })

    it('writes nothing when the body throws, and propagates the error unchanged', async () => {
      // LOTO throws its lockout rules from inside the body and expects no write.
      const d = await open()
      await d.set(P, 'x', { n: 1 })
      await expect(
        d.runTransaction(async (tx) => {
          await tx.get(P, 'x')
          tx.update(P, 'x', { n: 99 })
          throw new Error('Remove all group-lock technicians first')
        })
      ).rejects.toThrow('Remove all group-lock technicians first')
      expect((await d.get(P, 'x')).n).toBe(1)
      expect(await d.get('qr', 'tok')).toBeNull()
    })

    it('does not lose an update when two transactions interleave', async () => {
      // `await tx.get(...)` yields the thread, so this really can happen here —
      // the body is re-run rather than committed over stale reads.
      const d = await open()
      await d.set(P, 'x', { n: 0 })
      let runs = 0
      const bump = () =>
        d.runTransaction(async (tx) => {
          runs += 1
          const cur = await tx.get(P, 'x')
          await Promise.resolve() // widen the window the other one commits in
          tx.update(P, 'x', { n: cur.n + 1 })
        })
      await Promise.all([bump(), bump()])
      expect((await d.get(P, 'x')).n).toBe(2)
      expect(runs).toBeGreaterThan(2) // one of them ran again, as the contract allows
    })

    it('rejects a read issued after the first write', async () => {
      const d = await open()
      await d.set(P, 'x', { n: 1 })
      await expect(
        d.runTransaction(async (tx) => {
          tx.update(P, 'x', { n: 2 })
          await tx.get(P, 'x')
        })
      ).rejects.toThrow(/precede/)
      expect((await d.get(P, 'x')).n).toBe(1)
    })

    it('fails the whole transaction when a staged update has no document', async () => {
      const d = await open()
      await expect(
        d.runTransaction(async (tx) => {
          await tx.get(P, 'ghost')
          tx.set(P, 'real', { n: 1 })
          tx.update(P, 'ghost', { n: 1 })
        })
      ).rejects.toMatchObject({ code: 'not-found' })
      expect(await d.get(P, 'real')).toBeNull()
    })

    it('reserves an id under contention without issuing the same number twice', async () => {
      // The docSeq / reference-number shape: read the counter, hand out the next.
      const d = await open()
      await d.set('organizations/org1/meta', 'docSeq', { n: 0 })
      const take = () =>
        d.runTransaction(async (tx) => {
          const cur = await tx.get('organizations/org1/meta', 'docSeq')
          const next = (cur?.n || 0) + 1
          tx.update('organizations/org1/meta', 'docSeq', { n: next })
          return next
        })
      const issued = await Promise.all([take(), take(), take(), take()])
      expect(new Set(issued).size).toBe(4)
      expect((await d.get('organizations/org1/meta', 'docSeq')).n).toBe(4)
    })
  })

  const isolation = isolated ? describe : describe.skip
  isolation('isolation between instances', () => {
    it('two adapters share nothing, and _reset empties one', async () => {
      const a = await open()
      const b = await open()
      await a.set(P, 'x', { n: 1 })
      expect(await b.get(P, 'x')).toBeNull()
      await a._reset()
      expect(await a.get(P, 'x')).toBeNull()
    })
  })
}
