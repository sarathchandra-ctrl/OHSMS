import { describe, it, expect } from 'vitest'
import {
  auditPass, ticketClosure, extinguisherUptime, fasUptime, signageUptime, incidentCount,
  ragFor, targetFor, buildScorecard, breakdown, inScope, periodRange,
} from './kpis'

const N = { region: 'North', entity: 'Acme Mfg', siteId: 's1' }
const S = { region: 'South', entity: 'Acme Logistics', siteId: 's2' }

describe('inScope', () => {
  it('matches by level and entity', () => {
    expect(inScope(N, 'org', '')).toBe(true)
    expect(inScope(N, 'region', 'North')).toBe(true)
    expect(inScope(N, 'region', 'South')).toBe(false)
    expect(inScope(N, 'site', 's1')).toBe(true)
    expect(inScope(N, 'org', '', 'Acme Mfg')).toBe(true)
    expect(inScope(N, 'org', '', 'Acme Logistics')).toBe(false)
  })
})

describe('auditPass', () => {
  const reports = [
    { ...N, status: 'Closed', findings: [{ type: 'Observation' }, { type: 'OFI' }] }, // pass
    { ...N, status: 'Closed', findings: [{ type: 'Minor NC' }] },                     // fail
    { ...S, status: 'Closed', findings: [{ type: 'Major NC' }] },                     // fail
    { ...S, status: 'Closed', findings: [] },                                         // pass
    { ...S, status: 'Reported', findings: [] },        // not through to the end: not counted
  ]
  it('fails audits with any NC, org-wide', () => {
    expect(auditPass(reports, 'org')).toEqual({ value: 50, numerator: 2, denominator: 4 })
  })
  it('scopes by region', () => {
    expect(auditPass(reports, 'region', 'North').value).toBe(50)
    expect(auditPass(reports, 'region', 'South').value).toBe(50)
  })
  it('reads scope from taskDetails when not denormalised', () => {
    const r = [{ status: 'Closed', taskDetails: { region: 'North' }, findings: [] }]
    expect(auditPass(r, 'region', 'North')).toEqual({ value: 100, numerator: 1, denominator: 1 })
  })
  it('returns null with no audits', () => {
    expect(auditPass([], 'org').value).toBeNull()
  })
})

describe('ticketClosure', () => {
  const actions = [
    { ...N, status: 'done' }, { ...N, status: 'open' },
    { ...S, status: 'done' }, { ...S, status: 'in_progress' },
  ]
  it('counts done over total', () => {
    expect(ticketClosure(actions, 'org')).toEqual({ value: 50, numerator: 2, denominator: 4 })
  })
  it('filters by entity', () => {
    expect(ticketClosure(actions, 'org', '', 'Acme Mfg').value).toBe(50)
  })
})

describe('equipment uptime', () => {
  it('extinguishers with open defects are down', () => {
    const units = [
      { ...N, physicalDefects: [] },
      { ...N, physicalDefects: ['pin'] },
      { ...N, physicalDefects: [] },
      { ...N, physicalDefects: [], deletedAt: 1 }, // ignored
    ]
    expect(extinguisherUptime(units, 'org')).toEqual({ value: 66.7, numerator: 2, denominator: 3 })
  })
  it('FAS counts operational devices; missing status treated as operational', () => {
    const d = [{ ...N, status: 'operational' }, { ...N, status: 'faulty' }, { ...N }]
    expect(fasUptime(d, 'org').value).toBe(66.7)
  })
  it('signage counts Deployed status only', () => {
    const s = [{ ...N, status: 'Deployed' }, { ...N, status: 'Planned' }, { ...N }, { ...N, status: 'Deployed', condition: 'Missing' }]
    expect(signageUptime(s, 'org').value).toBe(50)
  })
})

describe('incidentCount', () => {
  it('counts injuries within scope, not near misses, property damage or deleted ones', () => {
    const inj = { type: 'first_aid' }
    const inc = [
      { ...N, ...inj },
      { ...N, type: 'lost_time' },
      { ...S, type: 'reportable' },
      { ...S, type: 'near_miss' },
      { ...S, type: 'property_damage' },
      { ...S, ...inj, deletedAt: '2026-11-01' },
    ]
    expect(incidentCount(inc, 'org').value).toBe(3)
    expect(incidentCount(inc, 'region', 'North').value).toBe(2)
    expect(incidentCount(inc, 'site', 's2').value).toBe(1)
  })
})

describe('ragFor', () => {
  it('higher-is-better KPIs', () => {
    expect(ragFor('auditPass', 95, 90).key).toBe('on_track')
    expect(ragFor('auditPass', 87, 90).key).toBe('at_risk')
    expect(ragFor('auditPass', 70, 90).key).toBe('off_track')
  })
  it('lower-is-better KPIs (incidents)', () => {
    expect(ragFor('incidents', 0, 0).key).toBe('on_track')
    expect(ragFor('incidents', 1, 0).key).toBe('at_risk')
    expect(ragFor('incidents', 5, 0).key).toBe('off_track')
    expect(ragFor('incidents', 11, 10).key).toBe('at_risk')
  })
  it('no data without a value or target', () => {
    expect(ragFor('auditPass', null, 90).key).toBe('no_data')
    expect(ragFor('auditPass', 90, null).key).toBe('no_data')
  })
})

describe('targetFor', () => {
  const objectives = [
    { kpi: 'incidents', level: 'org', scope: '', entity: 'all', target: 0 },
    { kpi: 'incidents', level: 'region', scope: 'North', entity: 'all', target: 2 },
  ]
  it('prefers the exact scope, falling back to org', () => {
    expect(targetFor(objectives, 'incidents', 'region', 'North').target).toBe(2)
    expect(targetFor(objectives, 'incidents', 'region', 'South').target).toBe(0)
    expect(targetFor(objectives, 'incidents', 'site', 's1').target).toBe(0)
  })
  it('returns null when nothing is set', () => {
    expect(targetFor(objectives, 'auditPass', 'org')).toBeNull()
  })
})

describe('buildScorecard / breakdown', () => {
  const data = {
    auditReports: [{ ...N, status: 'Closed', findings: [] }],
    actions: [{ ...N, status: 'done' }],
    extinguishers: [{ ...N, physicalDefects: [] }, { ...S, physicalDefects: ['pin'] }],
    fas: [{ ...N, status: 'operational' }],
    signages: [{ ...N, status: 'Deployed' }],
    incidents: [{ ...N, type: 'first_aid' }, { ...S, type: 'lost_time' }],
  }
  const objectives = [{ kpi: 'incidents', level: 'org', scope: '', entity: 'all', target: 0 }]

  it('includes only KPIs valid at the level', () => {
    const site = buildScorecard(data, objectives, 'site', 's1').map((r) => r.kpi.key)
    expect(site).not.toContain('auditPass')      // org/region only
    expect(site).toContain('extinguisherUptime')
    expect(buildScorecard(data, objectives, 'org', '').map((r) => r.kpi.key)).toContain('auditPass')
  })
  it('marks incidents off target against a zero target', () => {
    const row = buildScorecard(data, objectives, 'org', '').find((r) => r.kpi.key === 'incidents')
    expect(row.value).toBe(2)
    expect(row.rag.key).toBe('off_track')
  })
  it('breaks a KPI down across scopes', () => {
    const rows = breakdown(data, objectives, 'extinguisherUptime', 'region',
      [{ value: 'North', label: 'North' }, { value: 'South', label: 'South' }])
    expect(rows.map((r) => r.value)).toEqual([100, 0])
  })
})

describe('periods', () => {
  it('reads the labels people write', () => {
    expect(periodRange('2026')).toMatchObject({ from: Date.UTC(2026, 0, 1), to: Date.UTC(2027, 0, 1) })
    expect(periodRange('FY2026')).toMatchObject({ from: Date.UTC(2026, 3, 1), to: Date.UTC(2027, 3, 1), label: 'FY2026-27' })
    expect(periodRange('fy 2026-27').label).toBe('FY2026-27')
    expect(periodRange('FY2026-2027').label).toBe('FY2026-27')
    expect(periodRange('Q3 2026')).toMatchObject({ from: Date.UTC(2026, 6, 1), to: Date.UTC(2026, 9, 1) })
    expect(periodRange('FY2026-28')).toBeNull()
    expect(periodRange('next year')).toBeNull()
  })

  it('measures period KPIs over the target period, and says which', () => {
    const data = {
      auditReports: [],
      actions: [],
      extinguishers: [],
      fas: [],
      signages: [],
      incidents: [
        { ...N, type: 'first_aid', incidentDate: '2026-05-10' },
        { ...N, type: 'lost_time', incidentDate: '2025-05-10' },
      ],
    }
    const objectives = [{ kpi: 'incidents', level: 'org', scope: '', entity: 'all', target: 1, period: 'FY2026' }]
    const row = buildScorecard(data, objectives, 'org', '').find((r) => r.kpi.key === 'incidents')
    expect(row.value).toBe(1)
    expect(row.period).toBe('FY2026-27')
    const untimed = buildScorecard(data, [{ ...objectives[0], period: '' }], 'org', '').find((r) => r.kpi.key === 'incidents')
    expect(untimed.value).toBe(2)
    expect(untimed.period).toBe('all time')
  })

  it('picks the target whose period covers today over an older one', () => {
    const now = Date.UTC(2026, 10, 10)
    const objectives = [
      { kpi: 'incidents', level: 'org', scope: '', entity: 'all', target: 5, period: 'FY2025' },
      { kpi: 'incidents', level: 'org', scope: '', entity: 'all', target: 2, period: 'FY2026' },
    ]
    expect(targetFor(objectives, 'incidents', 'org', '', 'all', now).target).toBe(2)
  })
})
