import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it } from 'vitest'
import { openSqlite } from './sqlite.mjs'
import { applySchema, createEngine } from './engine.mjs'
import { FREQUENT_CRON, NIGHTLY_CRON, jobForCron, runNightly, startNodeSchedule } from './schedule.mjs'

const DAY = 24 * 3600 * 1000
const NOW = Date.parse('2026-11-10T22:15:00Z')
const iso = (ms) => new Date(ms).toISOString()
// How a server timestamp is stored (src/shared/data/adapters/postgresWire.js).
const ts = (ms) => ({ __ohsms: 'ts', s: Math.floor(ms / 1000), ns: 0 })
let engine

function fakeStore({ failOn = '' } = {}) {
  const removed = []
  return {
    removed,
    async remove(path) {
      if (path === failOn) throw new Error('bucket unavailable')
      removed.push(path)
      return true
    },
  }
}
const seed = (path, id, data) => engine.commit(null, [{ type: 'set', path, id, data, merge: false }])
const get = (path, id) => engine.get(null, path, id)

beforeEach(async () => {
  const db = openSqlite()
  await applySchema(db)
  engine = createEngine(db)
})

describe('the nightly jobs', () => {
  it('purges the Recycle Bin with what goes with each record, and keeps what is not due', async () => {
    await seed('incidents', 'old', { title: 'Old', deletedAt: ts(NOW - 40 * DAY), photo: { path: 'files/incident-photos/a.jpg' } })
    await seed('incidents/old/photos', 'p1', { path: 'files/incident-photos/b.jpg' })
    await seed('incidents', 'recent', { title: 'Recent', deletedAt: iso(NOW - 10 * DAY) })
    await seed('incidents', 'live', { title: 'Live', deletedAt: null })
    await seed('extinguishers', 'x1', { deletedAt: iso(NOW - 31 * DAY), qrToken: 'tok-x1' })
    await seed('qr', 'tok-x1', { extId: 'x1' })
    const store = fakeStore()
    const out = await runNightly(engine, { blobStore: store, now: NOW })
    expect(out.recycleBin.recyclePurged).toBe(2)
    expect(await get('incidents', 'old')).toBeNull()
    expect(await get('incidents/old/photos', 'p1')).toBeNull()
    expect(store.removed.sort()).toEqual(['files/incident-photos/a.jpg', 'files/incident-photos/b.jpg'])
    expect(await get('incidents', 'recent')).not.toBeNull()
    expect(await get('incidents', 'live')).not.toBeNull()
    expect(await get('extinguishers', 'x1')).toBeNull()
    expect(await get('qr', 'tok-x1')).toBeNull()
  })

  it('purges closed LOTO permits a year on, with their timeline and lock photo, and never an open one', async () => {
    await seed('lotoPermits', 'LP-1', { status: 'returned', closedAt: ts(NOW - 400 * DAY) })
    await seed('lotoPermits/LP-1/events', 'e1', { type: 'returned', by: 'u' })
    await seed('procedurePhotos', 'permitlock_LP-1', { path: 'files/permit-lock/LP-1.jpg' })
    await seed('lotoPermits', 'LP-2', { status: 'returned', closedAt: ts(NOW - 100 * DAY) })
    await seed('lotoPermits', 'LP-3', { status: 'active' })
    const store = fakeStore()
    const out = await runNightly(engine, { blobStore: store, now: NOW })
    expect(out.lotoPurge.purged).toBe(1)
    expect(await get('lotoPermits', 'LP-1')).toBeNull()
    expect(await get('lotoPermits/LP-1/events', 'e1')).toBeNull()
    expect(await get('procedurePhotos', 'permitlock_LP-1')).toBeNull()
    expect(store.removed).toContain('files/permit-lock/LP-1.jpg')
    expect(await get('lotoPermits', 'LP-2')).not.toBeNull()
    expect(await get('lotoPermits', 'LP-3')).not.toBeNull()
  })

  // An unattended deletion job that fails quietly looks exactly like one
  // with nothing to do.
  it('keeps a record whose file could not be deleted, finishes the other jobs, then fails loudly', async () => {
    await seed('incidents', 'stuck', { deletedAt: iso(NOW - 40 * DAY), photo: { path: 'files/x/stuck.jpg' } })
    await seed('lotoPermits', 'LP-9', { status: 'withdrawn', closedAt: ts(NOW - 400 * DAY) })
    const err = await runNightly(engine, { blobStore: fakeStore({ failOn: 'files/x/stuck.jpg' }), now: NOW }).catch((e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/recycleBin/)
    expect(await get('incidents', 'stuck')).not.toBeNull()
    expect(err.results.lotoPurge.purged).toBe(1)
  })
})

describe('the clocks', () => {
  it('names a job for each Cloudflare cron trigger, and only those', () => {
    const text = readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8')
    const crons = JSON.parse(text.match(/"crons":\s*(\[[^\]]*\])/)[1])
    expect(crons.sort()).toEqual([FREQUENT_CRON, NIGHTLY_CRON].sort())
    expect(jobForCron(FREQUENT_CRON)).toBe('frequent')
    expect(jobForCron(NIGHTLY_CRON)).toBe('nightly')
    expect(jobForCron('0 0 * * *')).toBe('')
  })

  it('runs the nightly jobs once a day on a self-hosted server, at or after 22:15 UTC', async () => {
    await seed('incidents', 'n1', { deletedAt: iso(NOW - 40 * DAY) })
    let clock = new Date('2026-11-10T21:00:00Z')
    const s = startNodeSchedule({ engine, clock: () => clock, log: () => {} })
    await s.tick()
    expect(await get('incidents', 'n1')).not.toBeNull()
    clock = new Date('2026-11-10T22:16:00Z')
    await s.tick()
    expect(await get('incidents', 'n1')).toBeNull()
    await seed('incidents', 'n2', { deletedAt: iso(NOW - 40 * DAY) })
    clock = new Date('2026-11-10T23:00:00Z')
    await s.tick()
    expect(await get('incidents', 'n2')).not.toBeNull()
    s.stop()
  })
})
