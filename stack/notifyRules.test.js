import { describe, expect, it } from 'vitest'
import { eventMessages } from './lib/notify.js'
import {
  equipmentDueItems,
  equipmentDueMessages,
  rcaMessages,
  rcaOpen,
  reviewDueItems,
  reviewMessages,
  uptimeByEntity,
  uptimeMessages,
  weatherMessages,
} from './lib/notifySchedule.js'

// The rules the organization asked for, one by one. Invented people and
// sites. "Managers" is the site's managers with every administrator.
const origin = 'https://ehs.example.com'
const person = (id, extra = {}) => ({
  id,
  status: 'approved',
  role: 'member',
  email: `${id}@example.com`,
  name: id,
  ...extra,
})
const sites = [
  { id: 's1', name: 'North Plant', region: 'North', entity: 'Alpha Ltd', lat: 12.9, lng: 77.6 },
  { id: 's2', name: 'South Plant', region: 'South', entity: 'Beta Ltd', lat: 13.1, lng: 80.2 },
]
const users = [
  person('admin', { role: 'admin' }),
  person('north', { role: 'manager', access: { sites: ['s1'] } }),
  person('south', { role: 'manager', access: { regions: ['South'] } }),
  person('worker', { siteId: 's1' }),
  person('other', { siteId: 's2' }),
  person('auditor', { role: 'auditor', siteId: 's1' }),
]
const ctx = (extra = {}) => ({ users, sites, org: {}, origin, actorUid: 'nobody', ...extra })
const to = (msgs) => [...new Set(msgs.map((m) => m.to.split('@')[0]))].sort()
const ev = (path, before, after, extra) =>
  eventMessages([{ path, id: 'x1', before, after }], ctx(extra))

describe('incidents', () => {
  const inc = { refNo: 'IRA-1', siteId: 's1', createdBy: 'worker', capa: [] }

  it('a new incident: the site’s managers, administrators and the reporter, who made it', () => {
    expect(to(ev('incidents', null, inc, { actorUid: 'worker' }))).toEqual([
      'admin',
      'north',
      'worker',
    ])
  })

  it('each new action: its owner, the site’s managers and administrators', () => {
    const after = { ...inc, capa: [{ id: 'a1', ownerUid: 'worker', dueDate: '2026-11-20' }] }
    const msgs = ev('incidents', inc, after, { actorUid: 'north' })
    expect(to(msgs)).toEqual(['admin', 'worker'])
    expect(msgs[0].subject).toBe('New action on IRA-1')
  })

  it('RCA due: open until the investigation is done or the incident closed', () => {
    expect(rcaOpen(inc)).toBe(true)
    expect(rcaOpen({ ...inc, stagesDone: { investigation: true } })).toBe(false)
    expect(rcaOpen({ ...inc, lifecycle: 'closed' })).toBe(false)
    expect(rcaOpen({ ...inc, deletedAt: '2026-11-01' })).toBe(false)
  })

  it('RCA due: one message per person, listing every incident', () => {
    const msgs = rcaMessages({
      incidents: [
        inc,
        { ...inc, refNo: 'IRA-2' },
        { ...inc, refNo: 'IRA-3', siteId: 's2', createdBy: 'other' },
      ],
      users,
      sites,
      origin,
    })
    expect(to(msgs)).toEqual(['admin', 'north', 'other', 'south', 'worker'])
    const admin = msgs.find((m) => m.to.startsWith('admin'))
    expect(admin.subject).toBe('RCA due on 3 incidents')
    const north = msgs.find((m) => m.to.startsWith('north'))
    expect(north.text).toContain('IRA-1 at North Plant')
    expect(north.text).not.toContain('IRA-3')
  })
})

describe('risk assessments', () => {
  const site = { kind: 'site', name: 'Workshop', siteId: 's2', createdBy: 'other', activities: [] }
  const baseline = { kind: 'baseline', name: 'Warehouse baseline', activities: [] }

  it('a baseline, created or changed: every manager and administrator', () => {
    expect(to(ev('assessments', null, baseline, { actorUid: 'admin' }))).toEqual(['north', 'south'])
    expect(
      to(ev('assessments', baseline, { ...baseline, activities: [{ name: 'Lifting' }] }))
    ).toEqual(['admin', 'north', 'south'])
  })

  it('a site assessment, created or changed: its site’s managers, administrators and its author', () => {
    expect(to(ev('assessments', null, site, { actorUid: 'other' }))).toEqual([
      'admin',
      'other',
      'south',
    ])
    expect(
      to(ev('assessments', site, { ...site, name: 'Workshop v2' }, { actorUid: 'south' }))
    ).toEqual(['admin', 'other'])
  })

  it('a re-save that changed nothing is not news; a change carries an hourly throttle', () => {
    expect(ev('assessments', site, { ...site, updatedAt: 'later' })).toEqual([])
    const [m] = ev('assessments', site, { ...site, name: 'v2' })
    expect(m.throttle).toMatch(/^hira:x1:/)
  })

  it('the yearly review: once per year of the assessment’s life', () => {
    const a = {
      id: 'r1',
      kind: 'site',
      siteId: 's1',
      name: 'Yard',
      assessmentDate: '2025-11-10',
      status: 'ACTIVE',
    }
    expect(reviewDueItems({ assessments: [a], today: '2026-11-09' })).toEqual([])
    const [item] = reviewDueItems({ assessments: [a], today: '2026-11-10' })
    expect(item.claim).toBe('review:r1:1')
    expect(
      reviewDueItems({ assessments: [{ ...a, status: 'ARCHIVED' }], today: '2026-11-10' })
    ).toEqual([])
    expect(to(reviewMessages([item], { users, sites, origin }))).toEqual(['admin', 'north'])
  })
})

describe('emergency equipment', () => {
  it('a defect report: the unit’s site managers, administrators and the people at that site', () => {
    const report = { kind: 'defect', extId: 'e1', defectType: 'hose_pipe' }
    const msgs = ev('reports', null, report, {
      assets: { 'extinguishers/e1': { siteId: 's1', extId: 'EXT-9' } },
    })
    expect(to(msgs)).toEqual(['admin', 'north', 'worker'])
    expect(msgs[0].subject).toBe('Defect reported: Extinguisher EXT-9 at North Plant')
    expect(msgs[0].text).toContain('hose pipe')
  })

  it('an AED or FAS defect is joined to its unit the same way', () => {
    const report = {
      kind: 'asset_defect',
      assetKind: 'aed',
      assetRefId: 'a1',
      defect: 'Battery Expired',
    }
    expect(
      to(ev('reports', null, report, { assets: { 'aeds/a1': { siteId: 's2', assetId: 'AED-2' } } }))
    ).toEqual(['admin', 'other', 'south'])
  })

  it('refill and pressure test within 7 days, AED battery within 30, each date told once', () => {
    const items = equipmentDueItems({
      today: '2026-11-10',
      extinguishers: [
        {
          id: 'e1',
          extId: 'EXT-1',
          siteId: 's1',
          dateOfNextRefill: '2026-11-15',
          dateOfNextHPT: '2027-06-01',
        },
        { id: 'e2', extId: 'EXT-2', siteId: 's1', dateOfNextHPT: '2026-11-01' },
        { id: 'e3', extId: 'EXT-3', siteId: 's1', dateOfNextRefill: '2026-11-30' },
        { id: 'e4', extId: 'EXT-4', siteId: 's1', dateOfNextRefill: '2026-11-11', deletedAt: 'x' },
      ],
      aeds: [{ id: 'a1', assetId: 'AED-1', siteId: 's2', batteryExpiry: '2026-12-01' }],
    })
    expect(items.map((i) => i.claim)).toEqual([
      'due:ext:e1:dateOfNextRefill:2026-11-15',
      'due:ext:e2:dateOfNextHPT:2026-11-01',
      'due:aed:a1:battery:2026-12-01',
    ])
    const msgs = equipmentDueMessages(items, { users, sites, origin })
    const worker = msgs.find((m) => m.to.startsWith('worker'))
    expect(worker.text).toContain(
      'EXT-2: pressure test (HPT) overdue since 1 Nov 2026 at North Plant'
    )
    expect(worker.text).not.toContain('AED-1')
  })

  it('monthly uptime by entity: administrators all, managers their own entities', () => {
    const data = {
      extinguishers: [
        { siteId: 's1', entity: 'Alpha Ltd', physicalDefects: [] },
        { siteId: 's1', entity: 'Alpha Ltd', physicalDefects: ['pin'] },
      ],
      aeds: [{ siteId: 's2', entity: 'Beta Ltd', status: 'ready' }],
      fas: [{ siteId: 's2', entity: 'Beta Ltd', status: 'faulty' }],
      signages: [{ siteId: 's1', entity: 'Alpha Ltd', status: 'Deployed' }],
    }
    expect(uptimeByEntity({ ...data, sites })).toEqual({
      'Alpha Ltd': { Extinguishers: [1, 2], Signage: [1, 1] },
      'Beta Ltd': { AED: [1, 1], FAS: [0, 1] },
    })
    const msgs = uptimeMessages(data, { users, sites, origin, month: 'November 2026' })
    expect(to(msgs)).toEqual(['admin', 'north', 'south'])
    const north = msgs.find((m) => m.to.startsWith('north'))
    expect(north.text).toContain('Alpha Ltd: Extinguishers 50% (1/2) · Signage 100% (1/1)')
    expect(north.text).not.toContain('Beta Ltd')
  })
})

describe('mock drills and committee meetings', () => {
  const drill = { docId: 'MD-1', siteId: 's1', eventType: 'Fire', createdByUid: 'worker', capa: [] }

  it('a new drill: the person who logged it, the site’s managers and administrators', () => {
    expect(to(ev('mockDrills', null, drill, { actorUid: 'worker' }))).toEqual([
      'admin',
      'north',
      'worker',
    ])
  })

  it('each new drill action: its assignees, the site’s managers and administrators', () => {
    const after = {
      ...drill,
      capa: [
        { action: 'sealed', assignees: [{ uid: 'other' }], due: '2026-11-30', status: 'Open' },
      ],
    }
    const msgs = ev('mockDrills', drill, after, { actorUid: 'north' })
    expect(to(msgs)).toEqual(['admin', 'other'])
    expect(JSON.stringify(msgs)).not.toContain('sealed')
  })

  const meeting = {
    docId: 'MOM-1',
    siteId: 's2',
    type: 'HSE Committee Meeting',
    createdByUid: 'other',
    actions: [],
  }

  it('a new meeting: the person who recorded it, the site’s managers and administrators', () => {
    expect(to(ev('consultations', null, meeting, { actorUid: 'other' }))).toEqual([
      'admin',
      'other',
      'south',
    ])
  })

  it('each new meeting action: the person responsible, the site’s managers and administrators', () => {
    const after = {
      ...meeting,
      actions: [{ action: 'x', ownerUid: 'worker', due: '2026-12-01', status: 'Open' }],
    }
    expect(to(ev('consultations', meeting, after, { actorUid: 'admin' }))).toEqual([
      'south',
      'worker',
    ])
  })
})

describe('permits', () => {
  const permit = {
    permitNo: 'PTW-7',
    siteId: 's1',
    createdBy: 'worker',
    assignedEngineer: 'other',
    storedStatus: 'draft',
    engineering: { status: 'pending' },
  }

  it('a status change: the site’s managers, administrators and the people on the permit', () => {
    const after = { ...permit, storedStatus: 'approved', engineering: { status: 'approved' } }
    const msgs = ev('permits', permit, after, { actorUid: 'north' })
    expect(to(msgs)).toEqual(['admin', 'other', 'worker'])
    expect(msgs[0].subject).toBe('Permit PTW-7: approved')
  })

  it('a closure or extension asked for counts; an unrelated edit does not', () => {
    expect(ev('permits', permit, { ...permit, closure: { requestedAt: 'now' } })[0].text).toContain(
      'Closure was requested.'
    )
    expect(ev('permits', permit, { ...permit, typeOfWork: 'Hot work' })).toEqual([])
  })
})

describe('weather', () => {
  it('every 6 hours, sites at “take precautions” or worse, to their managers and administrators', () => {
    const observations = {
      s1: { tempC: 44, apparentTempC: 48 },
      s2: { tempC: 24, apparentTempC: 24 },
    }
    const msgs = weatherMessages({ observations, users, sites, origin })
    expect(to(msgs)).toEqual(['admin', 'north'])
    expect(msgs[0].text).toMatch(/North Plant: /)
    expect(msgs[0].text).not.toContain('South Plant')
  })
})

describe('switches', () => {
  it('each kind can be turned off on its own', () => {
    const org = { notifications: { permitStatus: false } }
    const permit = { permitNo: 'PTW-7', siteId: 's1', storedStatus: 'draft' }
    expect(ev('permits', permit, { ...permit, storedStatus: 'approved' }, { org })).toEqual([])
    expect(ev('permits', null, permit, { org }).length).toBeGreaterThan(0)
  })
})
