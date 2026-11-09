import { describe, it, expect } from 'vitest'
import { istDay, dayOf, summariseSites, appResolveSite } from './siteSummary.js'
import { packCounts, unpackCounts, packItems, unpackItems } from './whatsapp/store.js'

// The cross-package parity test lives at src/pages/admin/siteSummary.parity.test.js;
// these cover what only the server has: the IST calendar and the packed snapshot.
describe('IST calendar days', () => {
  it('takes today from Asia/Kolkata, not the runtime clock', () => {
    expect(istDay(new Date('2026-10-11T18:29:00Z'))).toBe('2026-10-11')
    expect(istDay(new Date('2026-10-11T18:31:00Z'))).toBe('2026-10-12')
  })
  it('reads dates in every stored shape', () => {
    expect(dayOf('2026-10-12')).toBe('2026-10-12')
    expect(dayOf('2026-10-12T23:00:00')).toBe('2026-10-12')
    expect(dayOf(new Date('2026-10-11T20:00:00Z'))).toBe('2026-10-12')
    expect(dayOf({ toDate: () => new Date('2026-10-11T20:00:00Z') })).toBe('2026-10-12')
    expect(
      dayOf({
        toDate: () => {
          throw new Error('corrupt')
        },
      })
    ).toBeNull()
    expect(dayOf('not a date')).toBeNull()
    expect(dayOf('')).toBeNull()
  })
})

describe('summariseSites', () => {
  it('counts AEDs and lists defect items per type', () => {
    const data = {
      sites: [{ id: 's1', name: 'A' }],
      extinguishers: [
        { id: 'e1', siteId: 's1', serialNo: 'FE-9', location: 'Lobby', physicalDefects: ['empty'] },
      ],
      aeds: [
        { id: 'a1', siteId: 's1', assetId: 'AED-1', location: 'Gym floor' },
        { id: 'a2', siteId: 's1', status: 'out_of_service' },
        { id: 'a3', siteId: 's1', deletedAt: 'x' },
      ],
      fas: [{ id: 'f1', siteId: 's1', deviceId: 'FAP-1' }],
      reports: [
        {
          kind: 'asset_defect',
          approvalStatus: 'pending',
          assetKind: 'aed',
          assetRefId: 'a1',
          defect: 'Pads Expired',
        },
        {
          kind: 'asset_defect',
          approvalStatus: 'pending',
          assetKind: 'fas',
          assetRefId: 'f1',
          defect: 'Panel fault',
        },
      ],
    }
    const c = summariseSites(data, { now: new Date('2026-10-12T00:00:00Z'), withItems: true }).s1
    expect(c.aeds).toBe(2)
    expect(c.aedsOutOfService).toBe(1)
    expect(c.defectItems.extinguisher).toEqual([{ label: 'FE-9', where: 'Lobby', defect: 'Empty' }])
    expect(c.defectItems.aed).toEqual([
      { label: 'AED-1', where: 'Gym floor', defect: 'Pads Expired' },
    ])
    expect(c.defectItems.fas).toEqual([{ label: 'FAP-1', where: '', defect: 'Panel fault' }])
    expect(summariseSites(data).s1.defectItems).toBeUndefined()
  })

  it('omits a closed HPT-due row from open defects and still counts the overdue date', () => {
    const data = {
      sites: [{ id: 's1', name: 'A' }],
      extinguishers: [
        {
          id: 'e',
          siteId: 's1',
          status: 'active',
          serialNo: 'FE-1',
          dateOfNextHPT: '2020-01-01',
          hptClosedFor: '2020-01-01',
          physicalDefects: [],
        },
      ],
    }
    const c = summariseSites(data, { now: new Date('2026-10-12T06:30:00Z') }).s1
    expect(c.hptOverdue).toBe(1)
    expect(c.openDefects).toBe(0)
    const reopened = {
      ...data,
      extinguishers: [{ ...data.extinguishers[0], dateOfNextHPT: '2026-01-01' }],
    }
    expect(summariseSites(reopened, { now: new Date('2026-10-12T06:30:00Z') }).s1.openDefects).toBe(
      1
    )
  })

  it('counts HPT due on the IST day, so 00:30 IST is already the next day', () => {
    const data = {
      sites: [{ id: 's1', name: 'A' }],
      extinguishers: [{ id: 'e', siteId: 's1', status: 'active', dateOfNextHPT: '2026-10-12' }],
    }
    expect(summariseSites(data, { now: new Date('2026-10-11T18:00:00Z') }).s1.hptOverdue).toBe(0)
    expect(summariseSites(data, { now: new Date('2026-10-11T19:00:00Z') }).s1.hptOverdue).toBe(1)
  })
  it('leaves out an action source whose module is switched off', () => {
    const data = {
      sites: [{ id: 's1', name: 'A' }],
      incidents: [{ id: 'i', siteId: 's1', capa: [{ id: 'c', status: 'open' }] }],
    }
    expect(summariseSites(data).s1.pendingActions).toBe(1)
    expect(summariseSites(data, { modules: { incidents: false } }).s1.pendingActions).toBe(0)
  })
  it('does not take an override for a centre named after an Object.prototype key', () => {
    expect(appResolveSite('constructor', [{ id: 's', name: 'X' }])).toBeNull()
  })
})

describe('packed snapshot rows', () => {
  it('round-trip', () => {
    const c = {
      extinguishers: 6,
      hptOverdue: 1,
      openDefects: 3,
      defectsByKind: { extinguisher: 2, aed: 1, fas: 0 },
      firstAidBoxes: 2,
      pendingActions: 4,
      overdueActions: 1,
      incidentsTotal: 7,
      incidentsOpen: 1,
      incidents90d: 2,
      aeds: 3,
      aedsOutOfService: 1,
    }
    expect(unpackCounts(packCounts(c))).toEqual(c)
  })
})

describe('snapshot items', () => {
  it('round-trips defect items without nested arrays', () => {
    const items = {
      extinguisher: [{ label: 'FE-1', where: 'Lobby', defect: 'HPT Due' }],
      aed: [],
      fas: [],
    }
    const packed = packItems(items)
    expect(Object.values(packed).every((v) => v.every((x) => !Array.isArray(x)))).toBe(true)
    expect(unpackItems(packed)).toEqual(items)
  })
})
