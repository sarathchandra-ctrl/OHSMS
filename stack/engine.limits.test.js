import { beforeEach, describe, expect, it } from 'vitest'
import { openSqlite } from './sqlite.mjs'
import { MAX_RECORD_BYTES, applySchema, createEngine } from './engine.mjs'

// D1 stores at most 2,000,000 bytes in one row, and a record over that used to
// fail inside D1 and come back as a bare 500. Node's SQLite has no such limit,
// so nothing in the test suite would ever have noticed: the engine has to
// refuse the record itself, on every backend, before any statement runs.

let engine
const set = (id, data) => ({ type: 'set', path: 'incidents', id, data, merge: false })
const get = (id) => engine.get(null, 'incidents', id)

beforeEach(async () => {
  const db = openSqlite()
  await applySchema(db)
  engine = createEngine(db)
})

describe('record size', () => {
  it('stores a record just under the limit', async () => {
    // {"note":"…"} adds 11 bytes of JSON around the text.
    await engine.commit(null, [set('a', { note: 'x'.repeat(MAX_RECORD_BYTES - 11) })])
    expect((await get('a')).note).toHaveLength(MAX_RECORD_BYTES - 11)
  })

  it('refuses a record one byte over, with a reason rather than a database error', async () => {
    const write = engine.commit(null, [set('a', { note: 'x'.repeat(MAX_RECORD_BYTES - 10) })])
    await expect(write).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringMatching(/record too large at incidents\/a/),
    })
    expect(await get('a')).toBeNull()
  })

  // A check on string length would pass this: 700,000 characters, but 2.1 MB
  // once encoded, which is what D1 counts.
  it('counts bytes, not characters', async () => {
    const write = engine.commit(null, [set('a', { note: '€'.repeat(700_000) })])
    await expect(write).rejects.toMatchObject({ code: 'invalid-argument' })
  })

  // An update that grows a stored record past the limit is the same row.
  it('refuses an update that grows a record past the limit, and keeps the stored one', async () => {
    await engine.commit(null, [set('a', { note: 'kept', big: '' })])
    const write = engine.commit(null, [
      { type: 'update', path: 'incidents', id: 'a', data: { big: 'x'.repeat(MAX_RECORD_BYTES) } },
    ])
    await expect(write).rejects.toMatchObject({ code: 'invalid-argument' })
    expect(await get('a')).toMatchObject({ note: 'kept', big: '' })
  })

  // A commit is all or nothing: the small record beside the oversized one must
  // not be written on its own.
  it('writes nothing from a batch that holds one oversized record', async () => {
    const write = engine.commit(null, [
      set('small', { note: 'fine' }),
      set('big', { note: 'x'.repeat(MAX_RECORD_BYTES) }),
    ])
    await expect(write).rejects.toMatchObject({ code: 'invalid-argument' })
    expect(await get('small')).toBeNull()
    expect(await get('big')).toBeNull()
  })
})
